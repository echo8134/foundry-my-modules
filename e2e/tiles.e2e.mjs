import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const SOUND = "sounds/drums.wav";
const portrait = { x: 350, y: 450 };
const note = { x: 650, y: 450 };
const plain = { x: 800, y: 450 };

async function canvasPoint(page, point) {
  return page.evaluate((point) => {
    const { x, y } = canvas.clientCoordinatesFromCanvas(point);
    const target = document.elementFromPoint(x, y);
    if (target !== canvas.app.view)
      throw new Error(`canvas obscured at ${x}, ${y} by ${target?.outerHTML.slice(0, 180)}`);
    return { x, y };
  }, point);
}

async function clickAt(page, point) {
  await page.bringToFront();
  const { x, y } = await canvasPoint(page, point);
  await page.mouse.click(x, y);
}

async function watchAudio(page) {
  await page.evaluate((src) => {
    const helper = foundry.audio.AudioHelper;
    const play = helper.play;
    globalThis.tileSounds = [];
    helper.play = function (data, socketOptions) {
      const result = play.call(this, data, socketOptions);
      if (data.src === src) {
        const call = { broadcast: Boolean(socketOptions), loop: Boolean(data.loop) };
        tileSounds.push(call);
        Promise.resolve(result).then((sound) => {
          call.sound = sound;
        });
      }
      return result;
    };
  }, SOUND);
}

async function configureTile(gm, values) {
  const { x, y } = await canvasPoint(gm, plain);
  await gm.mouse.move(x, y);
  await waitFor(gm, () => canvas.tiles.hover?.document.name === "Plain tile");
  await gm.mouse.click(x, y, { button: "right", count: 2 });
  const picker = `.tile-config file-picker[type="audio"][name="flags.${MODULE_ID}.clickSound"]`;
  await gm.waitForSelector(picker);
  await gm.$eval(
    picker,
    (control, values) => {
      const form = control.closest("form");
      control.value = values.clickSound;
      form.elements.namedItem(control.name.replace(/clickSound$/, "quest")).value = values.quest;
      form.requestSubmit();
    },
    values
  );
  await waitFor(gm, () => !document.querySelector(".tile-config"));
}

await run(async () => {
  const gm = await joinGamemaster();
  const player = await join(PLAYER_NAME);
  await player.evaluate(() => game.user.sheet.close({ animate: false }));
  let sceneId, questId, actorId;
  try {
    await check("the GM and player view a scene with a portrait, a quest note and a plain tile", async () => {
      questId = await gm.evaluate(
        async (m) =>
          (await JournalEntry.create({ name: "MM Tile Quest", flags: { [m]: { quest: { status: "active" } } } })).id,
        MODULE_ID
      );
      actorId = await gm.evaluate(
        async (name) =>
          (
            await Actor.create({
              name: "MM Tile Token",
              type: "npc",
              ownership: { [game.users.getName(name).id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
            })
          ).id,
        PLAYER_NAME
      );
      sceneId = await gm.evaluate(
        async (m, sound, quest, actorId) => {
          const tile = (name, x, width, flags = {}) => ({
            name,
            x,
            y: 400,
            width,
            height: 100,
            texture: { src: "ui/parchment.jpg", anchorX: 0, anchorY: 0 },
            flags: { [m]: flags }
          });
          const token = await game.actors.get(actorId).getTokenDocument({ x: 400, y: 400, width: 1, height: 1 });
          return (
            await Scene.create({
              name: "MM Clickable Tiles",
              width: 1400,
              height: 1000,
              padding: 0,
              tokenVision: false,
              ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
              initial: { x: 600, y: 450, scale: 1 },
              tokens: [token.toObject()],
              tiles: [
                tile("Portrait", 300, 200, { clickSound: sound }),
                tile("Quest note", 600, 100, { quest: `JournalEntry.${quest}` }),
                tile("Plain tile", 750, 100),
                { ...tile("Cover", 305, 25), sort: 1 },
                {
                  ...tile("Ring", 600, 200, { clickSound: sound }),
                  y: 650,
                  rotation: 90,
                  texture: { src: "icons/svg/circle.svg" }
                }
              ]
            })
          ).id;
        },
        MODULE_ID,
        SOUND,
        questId,
        actorId
      );
      for (const page of [gm, player]) {
        await waitFor(page, (id) => game.scenes.has(id), sceneId);
        await page.evaluate((id) => game.scenes.get(id).view(), sceneId);
        await waitFor(
          page,
          (id) => canvas.ready && canvas.scene.id === id && canvas.tiles.placeables.length === 5,
          sceneId
        );
        await watchAudio(page);
      }
      assert(await player.evaluate(() => canvas.activeLayer === canvas.tokens), "player is not on the token layer");
    });

    await check("the portrait shows a hand and each click plays once on the clicking player only", async () => {
      await player.bringToFront();
      const { x, y } = await canvasPoint(player, portrait);
      await player.mouse.move(x, y);
      await waitFor(player, () => getComputedStyle(canvas.app.view).cursor.includes("pointer"));
      await player.mouse.click(x, y);
      await waitFor(player, () => tileSounds[0]?.sound?.playing);
      await player.mouse.click(x, y);
      await waitFor(player, () => tileSounds[1]?.sound?.playing);
      const restarted = await player.evaluate(
        () =>
          tileSounds.length === 2 && !tileSounds[0].sound.playing && tileSounds.every((c) => !c.loop && !c.broadcast)
      );
      assert(restarted, "overlapping, repeated or broadcast sound");
      assert(await gm.evaluate(() => tileSounds.length === 0), "GM heard the player's click");
    });

    await check("a player's drag and a click on their token over the portrait keep native behavior", async () => {
      const { x, y } = await canvasPoint(player, portrait);
      await player.mouse.move(x, y);
      await player.mouse.down();
      await player.mouse.move(x + 20, y + 15, { steps: 5 });
      await player.mouse.up();
      const pivot = await player.evaluate(() => canvas.stage.pivot.x);
      await player.mouse.move(x, y);
      await player.mouse.down({ button: "right" });
      await player.mouse.move(x + 100, y + 10, { steps: 8 });
      await player.mouse.up({ button: "right" });
      await waitFor(player, (start) => canvas.stage.pivot.x !== start, pivot);
      await player.evaluate(() => canvas.tokens.releaseAll());
      await clickAt(player, { x: 450, y: 450 });
      await waitFor(player, (id) => canvas.tokens.controlled.some((t) => t.document.actorId === id), actorId);
      assert(await player.evaluate(() => tileSounds.length === 2), "drag or token selection played the portrait");
    });

    await check(
      "the player can open a visible quest from its tile, and loses access when the quest is hidden",
      async () => {
        const sheet = `#my-quest-sheet-${questId}`;
        await clickAt(player, note);
        await player.waitForSelector(sheet, { visible: true });
        assert(!(await gm.$(sheet)), "the player's click opened the GM's sheet");
        await gm.evaluate(
          (id, m) => game.journal.get(id).update({ [`flags.${m}.quest.status`]: "hidden" }),
          questId,
          MODULE_ID
        );
        await waitFor(
          player,
          (selector, id) =>
            !document.querySelector(selector) && !game.journal.get(id)?.testUserPermission(game.user, "OBSERVER"),
          sheet,
          questId
        );
        await clickAt(player, note);
        await player.waitForSelector(sheet, { visible: true, timeout: 500 }).then(
          () => {
            throw new Error("player opened a hidden quest");
          },
          (error) => {
            if (error.name !== "TimeoutError") throw error;
          }
        );
      }
    );

    await check("an unflagged tile has no click action for a player", async () => {
      await clickAt(player, plain);
      await clickAt(player, { x: 315, y: 450 });
      assert(
        await player.evaluate(
          () =>
            tileSounds.length === 2 &&
            !document.querySelector(".my-quest-sheet") &&
            !getComputedStyle(canvas.app.view).cursor.includes("pointer")
        ),
        "plain tile acted on the click"
      );
    });

    await check("only the painted edge of a rotated ring plays its sound", async () => {
      await clickAt(player, { x: 600, y: 650 });
      await clickAt(player, { x: 686, y: 650 });
      assert(await player.evaluate(() => tileSounds.length === 2), "the hole or the unrotated edge played a sound");
      await clickAt(player, { x: 600, y: 736 });
      await waitFor(player, () => tileSounds[2]?.sound?.playing);
      assert(await player.evaluate(() => tileSounds.length === 3), "the painted edge played more than once");
    });

    await check("the GM can click the portrait on the Tiles layer without selecting or moving it", async () => {
      await gm.evaluate(() => canvas.tiles.activate());
      await clickAt(gm, portrait);
      await waitFor(gm, () => tileSounds.length === 1);
      assert(
        await gm.evaluate(() => {
          const tile = canvas.scene.tiles.getName("Portrait");
          return !canvas.tiles.controlled.length && tile.x === 300 && tile.y === 400;
        }),
        "GM click changed the tile"
      );
      await gm.click("#scene-controls-layers [data-control=notes]");
      await gm.click("#scene-controls-tools [data-tool=journal]");
      await clickAt(gm, portrait);
      await waitFor(gm, () => tileSounds.length === 2);
      assert(
        await gm.evaluate(() => !document.querySelector("dialog [name=journal]")),
        "tile click started placing a note"
      );
      await gm.click("#scene-controls-layers [data-control=tiles]");
    });

    await check("TileConfig saves and clears the audio picker and quest UUID on the same tile", async () => {
      const quest = `JournalEntry.${questId}`;
      await configureTile(gm, { clickSound: SOUND, quest });
      await waitFor(
        player,
        (m, sound, uuid) => {
          const tile = canvas.scene.tiles.getName("Plain tile");
          return tile.getFlag(m, "clickSound") === sound && tile.getFlag(m, "quest") === uuid;
        },
        MODULE_ID,
        SOUND,
        quest
      );
      await configureTile(gm, { clickSound: "", quest: "" });
      await waitFor(
        player,
        (m) => {
          const tile = canvas.scene.tiles.getName("Plain tile");
          return !Object.hasOwn(tile.flags[m], "clickSound") && !Object.hasOwn(tile.flags[m], "quest");
        },
        MODULE_ID
      );
    });
  } finally {
    await gm.evaluate(
      async (scene, quest, actor) => {
        await game.scenes.active?.view();
        await game.scenes.get(scene)?.delete();
        await game.journal.get(quest)?.delete();
        await game.actors.get(actor)?.delete();
      },
      sceneId,
      questId,
      actorId
    );
  }
});
