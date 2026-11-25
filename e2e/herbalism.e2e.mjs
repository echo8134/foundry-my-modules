import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const roll = ".herbalism-roll [data-action=roll]";
const review = ".herbalism-review";

await run(async () => {
  const gm = await joinGamemaster("en");
  const f = await gm.evaluate(
    async (m, playerName) => {
      const player = game.users.getName(playerName);
      const previousCharacter = player.character?.id ?? null;
      const suffix = foundry.utils.randomID();
      const herb = await Item.create({
        name: `Silverleaf ${suffix}`,
        type: "loot",
        system: { price: { value: 2, denomination: "gp" } }
      });
      const extract = await Item.create({
        name: `Silverleaf extract ${suffix}`,
        type: "consumable",
        system: { uses: { max: "8", spent: 0 } }
      });
      const actor = await Actor.create({
        name: `Botanist ${suffix}`,
        type: "character",
        ownership: { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
        system: { tools: { herb: { value: 1 } }, abilities: { int: { value: 20 }, wis: { value: 20 } } }
      });
      const [kit] = await actor.createEmbeddedDocuments("Item", [
        {
          name: "Kräuterkundebesteck",
          type: "tool",
          system: { type: { baseItem: "herb" }, uses: { max: "10", spent: 0 } }
        }
      ]);
      const plant = await Actor.create({
        name: `Herb patch ${suffix}`,
        type: "npc",
        flags: {
          [m]: {
            herbalism: {
              identify: { skill: "nat", dc: 0 },
              components: [
                { id: "leaves", name: herb.name, item: herb.uuid, quantity: 2, dc: 0 },
                { id: "extract", name: extract.name, item: extract.uuid, quantity: 2, dc: 0, charges: "1d1 + 2" },
                { id: "root", name: "Root", item: herb.uuid, quantity: 1, dc: 90, danger: { text: "Stinging sap" } },
                { id: "bud", name: "Bud", item: herb.uuid, quantity: 1, dc: 0 }
              ]
            }
          }
        }
      });
      const token = await plant.getTokenDocument({
        x: 400,
        y: 400,
        actorLink: true,
        level: Scene.metadata.defaultLevelId
      });
      const scene = await Scene.create({
        name: `Herb test ${suffix}`,
        tokenVision: false,
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
        tokens: [token.toObject()]
      });
      await player.update({ character: actor.id });
      return {
        scene: scene.id,
        token: scene.tokens.contents[0].id,
        plant: plant.id,
        actor: actor.id,
        kit: kit.id,
        herb: herb.id,
        extract: extract.id,
        herbName: herb.name,
        previousCharacter
      };
    },
    MODULE_ID,
    PLAYER_NAME
  );
  try {
    const player = await join(PLAYER_NAME, "", "de");
    for (const page of [gm, player]) {
      await page.evaluate(async (id) => {
        await game.user.sheet.close({ animate: false });
        await game.scenes.get(id).view();
      }, f.scene);
      await waitFor(
        page,
        (id) => canvas.ready && canvas.scene.id === id && canvas.tokens.placeables.some((t) => t.visible),
        f.scene
      );
    }
    await player.bringToFront();
    const point = await player.evaluate((id) => {
      const { x, y } = canvas.tokens.get(id).center;
      canvas.pan({ x, y });
      const point = canvas.stage.toGlobal({ x, y });
      return { x: point.x, y: point.y };
    }, f.token);
    await player.mouse.move(point.x, point.y);
    await waitFor(player, (id) => canvas.tokens.hover?.id === id, f.token);
    await player.keyboard.press("t");
    await waitFor(player, (id) => game.user.targets.has(canvas.tokens.get(id)), f.token);
    const useTool = async (action, { resume = false } = {}) => {
      await player.bringToFront();
      await player.locator("#scene-controls-tools [data-tool=myHerbalism]").setTimeout(8000).click();
      await player.locator(`dialog[open] [data-action=${action}]`).click();
      if (resume) return;
      await player.locator(roll).click();
      await player.waitForSelector(roll, { hidden: true });
    };
    const inventory = () =>
      player.evaluate((f) => {
        const actor = game.actors.get(f.actor);
        return {
          spent: actor.items.get(f.kit).system.uses.spent,
          extracts: actor.items
            .filter((item) => item.type === "consumable")
            .map((item) => [item.system.quantity, item.system.uses.value])
            .sort((a, b) => a[1] - b[1]),
          herbs: actor.items
            .filter((item) => item.name === f.herbName)
            .map((item) => [item.system.quantity, item.system.price.value])
            .sort((a, b) => a[1] - b[1])
        };
      }, f);
    await check("the player identifies a living plant and learns its danger before gathering", async () => {
      await useTool("identify");
      await waitFor(
        player,
        (name) =>
          game.messages.some(
            (message) =>
              message.whisper.includes(game.user.id) &&
              message.content.includes(name) &&
              message.content.includes("Stinging sap")
          ),
        f.herbName
      );
      const state = await inventory();
      assert(state.spent === 0 && state.herbs.length === 0, "Identify used supplies or awarded specimens");
      const again = await player.evaluate((m) => game.modules.get(m).api.herbalism.request("identify"), MODULE_ID);
      assert(again === false, "plant accepted a second identification");
    });
    let firstResult;
    await check("the GM can defer a gather without spending a charge or awarding the plant", async () => {
      await useTool("gather");
      await gm.bringToFront();
      await gm.waitForSelector(`${review} [data-outcome=superior]`, { visible: true });
      firstResult = await gm.$eval(`${review} p`, (p) => p.textContent);
      await gm.locator(`${review} [data-action=cancel]`).click();
      await gm.waitForSelector(review, { hidden: true });
      const state = await inventory();
      assert(state.spent === 0 && state.herbs.length === 0, "cancelled review changed the inventory");
      await gm.evaluate(
        async (m, f) => {
          const plant = game.actors.get(f.plant);
          const table = foundry.utils.deepClone(plant.getFlag(m, "herbalism"));
          table.components.find((part) => part.id === "root").dc = 0;
          await plant.setFlag(m, "herbalism", table);
          await game.actors.get(f.actor).items.get(f.kit).update({ "system.bonus": "100" });
        },
        MODULE_ID,
        f
      );
      await gm.reload({ waitUntil: "domcontentloaded" });
      await gm.waitForFunction(() => globalThis.game?.ready && globalThis.canvas?.ready, { timeout: 180000 });
      await gm.evaluate(
        (id) =>
          game.scenes
            .get(id)
            .view()
            .then(() => true),
        f.scene
      );
    });
    await check(
      "resuming the same roll after reload awards separate specimens, spends one charge and reports the original failed component",
      async () => {
        await useTool("gather", { resume: true });
        await gm.bringToFront();
        await gm.waitForSelector(`${review} [data-outcome=danger]`, { visible: true });
        assert(
          (await gm.$eval(`${review} p`, (p) => p.textContent)) === firstResult,
          "gather was rerolled after deferral"
        );
        await gm.select(`${review} [data-part="0"] [name=bonus]`, "portion");
        await gm.select(`${review} [data-part="1"] [name=bonus]`, "charge");
        await gm.select(`${review} [data-part="3"] [name=bonus]`, "value");
        await gm.type(`${review} [data-part="3"] [name=price]`, "9");
        await gm.locator(`${review} [data-action=confirm]`).click();
        await waitFor(gm, (m, id) => canvas.scene.tokens.get(id).getFlag(m, "gathered"), MODULE_ID, f.token);
        await waitFor(player, () =>
          game.messages.some((message) => !message.whisper.length && message.content.includes("Stinging sap"))
        );
        const retry = await player.evaluate((m) => game.modules.get(m).api.herbalism.request("gather"), MODULE_ID);
        assert(retry === false, "plant accepted a second gather");
        const state = await inventory();
        assert(
          state.spent === 1 &&
            JSON.stringify(state.herbs) === "[[3,2],[1,9]]" &&
            JSON.stringify(state.extracts) === "[[1,3],[1,4]]",
          JSON.stringify(state)
        );
        const source = await gm.evaluate(
          (f) => ({
            price: game.items.get(f.herb).system.price.value,
            uses: game.items.get(f.extract).system.uses.value
          }),
          f
        );
        assert(source.price === 2 && source.uses === 8, "the award changed a world Item");
      }
    );
  } finally {
    await gm.evaluate(
      async (f, playerName) => {
        await game.users.getName(playerName).update({ character: f.previousCharacter });
        await game.scenes.active?.view();
        await game.scenes.get(f.scene)?.delete();
        await Actor.deleteDocuments([f.actor, f.plant]);
        await Item.deleteDocuments([f.herb, f.extract]);
      },
      f,
      PLAYER_NAME
    );
  }
});
