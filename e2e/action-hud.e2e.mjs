import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const HUD = "#my-action-hud";
const COMBINE_HOTBAR = "actionHudCombineHotbar";
const group = (name) => `${HUD} button[data-group="${name}"]`;
const entry = (action, id) => `${HUD} [data-action="${action}"][data-id="${id}"]`;

async function click(page, selector, options) {
  await page.locator(selector).setTimeout(10000).click(options);
}

async function buildEncounter(gm) {
  return gm.evaluate(async (playerName) => {
    const player = game.users.getName(playerName);
    const activity = (type) => {
      const id = foundry.utils.randomID();
      return { [id]: { _id: id, type } };
    };
    const spell = (name, level, prepared, method = "spell") => ({
      name,
      type: "spell",
      system: { level, prepared, method, activities: activity("utility") }
    });
    const wizard = await Actor.create({
      name: "Ilyra Ashford",
      type: "character",
      img: "systems/dnd5e/tokens/heroes/WizardTome.webp",
      prototypeToken: { actorLink: true, texture: { src: "systems/dnd5e/tokens/heroes/WizardTome.webp" } },
      ownership: { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
      system: {
        abilities: { int: { value: 18 }, dex: { value: 14 }, wis: { value: 12 } },
        skills: { arc: { value: 1 } },
        spells: { spell1: { value: 2, override: 3 }, pact: { value: 1, override: 2 } }
      },
      items: [
        {
          name: "Ashwood Staff",
          type: "weapon",
          img: "icons/weapons/staves/staff-blue-jewel.webp",
          system: { equipped: true, activities: activity("attack") }
        },
        {
          name: "Stowed Dagger",
          type: "weapon",
          system: { equipped: false, activities: activity("attack") }
        },
        spell("Light", 0, 1),
        spell("Mage Hand", 0, 1),
        spell("Shield", 1, 1),
        spell("Alarm", 1, 2),
        spell("Faerie Fire", 1, 0, "innate"),
        spell("Hex", 1, 0, "pact"),
        spell("Disguise Self", 1, 0),
        {
          name: "Arcane Ward",
          type: "feat",
          img: "icons/magic/defensive/shield-barrier-blue.webp",
          system: { uses: { max: "3", spent: 1 }, activities: activity("utility") }
        },
        {
          name: "Healing Draught",
          type: "consumable",
          img: "icons/consumables/potions/bottle-corked-red.webp",
          system: { quantity: 3, activities: activity("heal") }
        }
      ]
    });
    globalThis.hudTestDocuments.push(wizard);
    await wizard.items.getName("Mage Hand").update({ "system.prepared": 0 });
    const guard = await Actor.create({
      name: "Cellar Sentry",
      type: "npc",
      prototypeToken: { texture: { src: "systems/dnd5e/tokens/humanoid/Guard.webp" } },
      ownership: { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      items: [spell("Detect Magic", 1, 0, "atwill")]
    });
    hudTestDocuments.push(guard);
    const tokens = await Promise.all([
      wizard.getTokenDocument({ x: 500, y: 400 }),
      guard.getTokenDocument({ x: 750, y: 400 })
    ]);
    const scene = await Scene.create({
      name: "The Watchpost",
      width: 1600,
      height: 1000,
      padding: 0,
      initial: { x: 700, y: 450, scale: 1 },
      tokenVision: false,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      tokens: tokens.map((token) => token.toObject())
    });
    hudTestDocuments.push(scene);
    return {
      scene: scene.id,
      actor: wizard.id,
      hero: scene.tokens.find((token) => token.actorId === wizard.id).id,
      guard: scene.tokens.find((token) => token.actorId === guard.id).id,
      atWillSpell: guard.items.getName("Detect Magic").id,
      items: Object.fromEntries(wizard.items.map((item) => [item.name, item.id]))
    };
  }, PLAYER_NAME);
}

await run(async () => {
  const gm = await joinGamemaster();
  const player = await join(PLAYER_NAME);
  await gm.evaluate(() => {
    globalThis.hudTestDocuments = [];
  });
  try {
    let ids;
    await check("the GM and player view the wizard and sentry", async () => {
      ids = await buildEncounter(gm);
      for (const page of [gm, player]) {
        await waitFor(page, (id) => game.scenes.has(id), ids.scene);
        await page.evaluate(async (id) => {
          await game.user.sheet.close({ animate: false });
          await game.scenes.get(id).view();
        }, ids.scene);
        await waitFor(
          page,
          (id) => canvas.ready && canvas.scene.id === id && canvas.tokens.placeables.length === 2,
          ids.scene
        );
      }
      await player.bringToFront();
    });

    await check("the first token must be owned by the player and can be any token for a GM", async () => {
      await player.evaluate((id) => canvas.tokens.get(id).control(), ids.hero);
      await player.waitForSelector(group("attacks"), { visible: true });
      const first = await player.evaluate(({ hero, guard }) => {
        const sentry = canvas.tokens.get(guard);
        if (sentry.actor.isOwner) throw new Error("sentry is owned");
        // Core normally rejects this selection before the HUD sees it.
        sentry._canControl = () => true;
        try {
          sentry.control({ releaseOthers: false, force: true });
        } finally {
          delete sentry._canControl;
        }
        return canvas.tokens.controlled.map((token) => token.id).join(",") === [hero, guard].join(",");
      }, ids);
      assert(first, "expected the owned wizard first and the observed sentry second");
      await click(player, group("attacks"));
      await player.waitForSelector(entry("item", ids.items["Ashwood Staff"]), { visible: true });
      assert(!(await player.$(entry("item", ids.items["Stowed Dagger"]))), "unequipped dagger appeared in Attacks");
      await player.evaluate((id) => canvas.tokens.get(id).release(), ids.hero);
      await player.waitForSelector(HUD, { hidden: true });
      assert(await player.evaluate((id) => canvas.tokens.controlled[0]?.id === id, ids.guard), "sentry lost control");
      await gm.evaluate((id) => canvas.tokens.get(id).control(), ids.guard);
      await gm.waitForSelector(group("conditions"), { visible: true });
      assert(!(await gm.$(group("attacks"))), "empty attack group appeared");
      await gm.evaluate(() => canvas.tokens.releaseAll());
      await gm.waitForSelector(HUD, { hidden: true });
      await player.evaluate((id) => canvas.tokens.get(id).control(), ids.hero);
      await player.waitForSelector(group("attacks"), { visible: true });
    });

    await check("the sentry's at-will spell appears with prepared set to zero", async () => {
      await gm.evaluate((id) => canvas.tokens.get(id).control(), ids.guard);
      await gm.waitForSelector(group("conditions"), { visible: true });
      const prepared = await gm.evaluate(
        (id) => canvas.tokens.controlled[0].actor.items.get(id).system.prepared,
        ids.atWillSpell
      );
      assert(prepared === 0, `expected prepared 0, got ${prepared}`);
      assert(await gm.$(group("spells")), "missing Spells group for the at-will caster");
      await click(gm, group("spells"));
      await gm.waitForSelector(entry("item", ids.atWillSpell), { visible: true });
      await gm.evaluate(() => canvas.tokens.releaseAll());
    });

    await check("a player can dock their HUD and still use macro clicks, number keys and page controls", async () => {
      const marker = `HUD macro ${Date.now()}`;
      const peerName = `HUD player ${Date.now()}`;
      const macroId = await gm.evaluate(
        async (actorId, marker, name) => {
          const peer = await User.create({ name, role: CONST.USER_ROLES.PLAYER });
          hudTestDocuments.push(peer);
          await game.actors.get(actorId).update({ [`ownership.${peer.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
          const macro = await Macro.create({
            name: marker,
            type: "chat",
            command: marker,
            ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
          });
          hudTestDocuments.push(macro);
          return macro.id;
        },
        ids.actor,
        marker,
        peerName
      );
      const peer = await join(peerName);
      const originalSlot = await player.evaluate(() => game.user.hotbar[1] ?? null);
      const docked = `#hotbar > ${HUD}`;
      try {
        await peer.evaluate(async (id) => {
          await game.user.sheet.close({ animate: false });
          await game.scenes.get(id).view();
        }, ids.scene);
        await waitFor(peer, (id) => canvas.ready && canvas.tokens.get(id)?.actor.isOwner, ids.hero);
        await peer.evaluate((id) => canvas.tokens.get(id).control(), ids.hero);
        await peer.waitForSelector(group("attacks"), { visible: true });
        assert(!(await peer.$(docked)), "the second player's HUD was docked by default");

        await player.bringToFront();
        await waitFor(player, (id) => game.macros.has(id), macroId);
        await player.evaluate(
          async (m, key, id) => {
            await game.user.assignHotbarMacro(game.macros.get(id), 1);
            await game.settings.set(m, key, true);
          },
          MODULE_ID,
          COMBINE_HOTBAR,
          macroId
        );
        await player.waitForSelector(docked, { visible: true });
        const joined = await player.evaluate(() => {
          const bar = document.querySelector("#my-action-hud .hud-bar").getBoundingClientRect();
          const slots = document.querySelectorAll("#action-bar .slot");
          const first = slots[0].getBoundingClientRect();
          return slots.length === 10 && bar.bottom <= first.top && first.top - bar.bottom < 12;
        });
        assert(joined, "the HUD and ten macro slots did not form adjacent rows");
        await click(player, group("rolls"));
        await player.waitForSelector(entry("skill", "arc"), { visible: true });
        await click(player, '#hotbar .slot.full[data-slot="1"]');
        await player.keyboard.press("1");
        await waitFor(gm, (text) => game.messages.filter((msg) => msg.content.includes(text)).length === 2, marker);

        await click(player, "#hotbar .page-next");
        await player.waitForSelector('#action-bar [data-slot="11"]', { visible: true });
        await player.waitForSelector(`${docked} .hud-panel`, { visible: true });
        assert(!(await peer.$(docked)), "the second player's layout changed with the first player's setting");
        await player.evaluate((id, key) => game.settings.set(id, key, false), MODULE_ID, COMBINE_HOTBAR);
        await player.waitForSelector(`body > ${HUD} .hud-grip`, { visible: true });
      } finally {
        await peer.browserContext().close();
        await player.evaluate(
          async (m, key, previous) => {
            await game.settings.set(m, key, false);
            await game.user.assignHotbarMacro(game.macros.get(previous) ?? null, 1);
            await ui.hotbar.changePage(1);
          },
          MODULE_ID,
          COMBINE_HOTBAR,
          originalSlot
        );
        await gm.evaluate(async (text) => {
          const messages = game.messages.filter((entry) => entry.content.includes(text));
          await ChatMessage.deleteDocuments(messages.map((entry) => entry.id));
        }, marker);
      }
    });

    await check("only dragging pins the HUD and double-clicking restores hotbar following", async () => {
      const grip = `${HUD} .hud-grip`;
      const saved = () => player.evaluate((id) => game.settings.get(id, "actionHudPositions")[game.user.id], MODULE_ID);
      await click(player, grip);
      assert(!(await saved()), "clicking the grip pinned the HUD");
      const { x, y } = await player.$eval(grip, (el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await player.mouse.move(x, y);
      await player.mouse.down();
      await player.mouse.move(x + 2, y - 2);
      await player.mouse.up();
      assert(!(await saved()), "minor pointer movement pinned the HUD");
      const initialTop = await player.$eval(HUD, (el) => el.getBoundingClientRect().top);
      await player.mouse.down();
      await player.mouse.move(x + 2, y - 82, { steps: 5 });
      await player.mouse.up();
      const pinned = await saved();
      assert(Math.abs(pinned?.y - (initialTop - 80)) < 1, "drag did not save the new position");
      await player.evaluate((id, key) => game.settings.set(id, key, true), MODULE_ID, COMBINE_HOTBAR);
      await player.waitForSelector(`#hotbar > ${HUD}`, { visible: true });
      await player.evaluate((id, key) => game.settings.set(id, key, false), MODULE_ID, COMBINE_HOTBAR);
      await waitFor(
        player,
        (s, y) => Math.abs(document.querySelector(s).getBoundingClientRect().top - y) < 1,
        HUD,
        pinned.y
      );
      await click(player, grip, { count: 2 });
      assert(!(await saved()), "double-click left a saved position");
      const viewport = player.viewport();
      await player.setViewport({ ...viewport, height: viewport.height + 100 });
      await waitFor(
        player,
        (s, y) => Math.abs(document.querySelector(s).getBoundingClientRect().top - y) < 1,
        HUD,
        initialTop + 100
      );
      await player.setViewport(viewport);
    });

    await check("the condition button applies and removes the wizard's actual prone status", async () => {
      await click(player, group("conditions"));
      for (const active of [true, false]) {
        await click(player, entry("condition", "prone"));
        await waitFor(gm, (id, expected) => game.actors.get(id).statuses.has("prone") === expected, ids.actor, active);
      }
    });

    await check("left and right clicks raise and lower the wizard's exhaustion one level", async () => {
      for (const [button, level] of [
        ["left", 1],
        ["left", 2],
        ["right", 1],
        ["right", 0]
      ]) {
        await click(player, entry("condition", "exhaustion"), { button });
        await waitFor(
          gm,
          (id, expected) => game.actors.get(id).system.attributes.exhaustion === expected,
          ids.actor,
          level
        );
      }
    });

    await check("the wizard's staff and Arcana skill call dnd5e on the selected actor", async () => {
      await player.evaluate((id) => {
        const actor = canvas.tokens.controlled[0].actor;
        globalThis.hudTestCalls = [];
        actor.items.get(id).use = function () {
          hudTestCalls.push(this.id);
        };
        actor.rollSkill = function ({ skill, event }, dialog) {
          hudTestCalls.push([this.id, skill, event.shiftKey, dialog.configure]);
        };
      }, ids.items["Ashwood Staff"]);
      const staff = entry("item", ids.items["Ashwood Staff"]);
      if (!(await player.evaluate((s) => document.querySelector(s)?.checkVisibility(), staff))) {
        await click(player, group("attacks"));
      }
      await click(player, staff);
      await click(player, group("rolls"));
      await player.keyboard.down("Shift");
      try {
        await click(player, entry("skill", "arc"));
      } finally {
        await player.keyboard.up("Shift");
      }
      const calls = await player.evaluate(() => hudTestCalls);
      assert(
        calls[0] === ids.items["Ashwood Staff"] &&
          calls[1]?.[0] === ids.actor &&
          calls[1][1] === "arc" &&
          calls[1][2] &&
          calls[1][3] === false,
        JSON.stringify(calls)
      );
    });

    await check("cantrips lead the castable spells and slot counts follow the actor", async () => {
      await click(player, group("spells"));
      const level = `${HUD} [data-level="1"]`;
      await player.waitForSelector(level, { visible: true });
      const levels = await player.$$eval(`${HUD} [data-level]`, (sections) =>
        sections.map((section) => section.dataset.level)
      );
      assert(levels[0] === "0" && levels[1] === "1", `spell levels: ${levels}`);
      for (const name of ["Light", "Shield", "Alarm", "Faerie Fire", "Hex"]) {
        await player.waitForSelector(entry("item", ids.items[name]), { visible: true });
      }
      for (const name of ["Mage Hand", "Disguise Self"]) {
        assert(!(await player.$(entry("item", ids.items[name]))), `unprepared ${name} appeared`);
      }
      assert(await player.$eval(level, (s) => s.textContent.includes("1/2")), "pact slot pool missing");
      for (const value of [2, 1]) {
        if (value === 1)
          await gm.evaluate((id) => game.actors.get(id).update({ "system.spells.spell1.value": 1 }), ids.actor);
        await waitFor(
          player,
          (s, expected) => {
            const slots = canvas.tokens.controlled[0].actor.system.spells.spell1;
            return (
              slots.value === expected &&
              document.querySelector(s)?.textContent.includes(`${slots.value}/${slots.override ?? slots.max}`)
            );
          },
          level,
          value
        );
      }
    });

    await check("remaining feature uses and item quantities stay current while open", async () => {
      const ward = ids.items["Arcane Ward"];
      await click(player, group("features"));
      await waitFor(player, (s) => document.querySelector(s)?.textContent.includes("2/3"), entry("item", ward));
      await gm.evaluate(
        (actor, id) => game.actors.get(actor).items.get(id).update({ "system.uses.spent": 2 }),
        ids.actor,
        ward
      );
      await waitFor(player, (s) => document.querySelector(s)?.textContent.includes("1/3"), entry("item", ward));
      const potion = ids.items["Healing Draught"];
      await click(player, group("items"));
      await waitFor(player, (s) => document.querySelector(s)?.textContent.includes("×3"), entry("item", potion));
      await gm.evaluate(
        (actor, id) => game.actors.get(actor).items.get(id).update({ "system.quantity": 2 }),
        ids.actor,
        potion
      );
      await waitFor(player, (s) => document.querySelector(s)?.textContent.includes("×2"), entry("item", potion));
    });

    await check("the assigned character follows a fresh player client across tokenless scenes", async () => {
      const previousCharacter = await gm.evaluate(
        (name) => game.users.getName(name).character?.id ?? null,
        PLAYER_NAME
      );
      try {
        await gm.evaluate(
          async ({ scene, hero, actor }, name) => {
            await game.scenes.get(scene).tokens.get(hero).delete();
            await game.users.getName(name).update({ character: actor });
          },
          ids,
          PLAYER_NAME
        );
        await waitFor(
          player,
          (id) => game.user.character?.id === id && !canvas.scene.tokens.some((t) => t.actorId === id),
          ids.actor
        );
        const actorBar = `${HUD} [data-actor="Actor.${ids.actor}"]`;
        await player.waitForSelector(actorBar, { visible: true, timeout: 10000 });
        const emptySceneId = await gm.evaluate(async () => {
          const scene = await Scene.create({
            name: "Empty HUD test scene",
            ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
          });
          hudTestDocuments.push(scene);
          return scene.id;
        });
        for (const sceneId of [emptySceneId, ids.scene]) {
          await waitFor(player, (id) => game.scenes.has(id), sceneId);
          await player.evaluate((id) => game.scenes.get(id).view(), sceneId);
          await waitFor(player, (id) => canvas.ready && canvas.scene.id === id, sceneId);
          await player.waitForSelector(actorBar, { visible: true });
        }
        await player.evaluate((id) => game.settings.set(id, "actionHudAlwaysShowCharacter", false), MODULE_ID);
        await player.waitForSelector(HUD, { hidden: true });
        await player.evaluate((id) => game.settings.set(id, "actionHudAlwaysShowCharacter", true), MODULE_ID);
        await player.waitForSelector(actorBar, { visible: true });
        await click(player, group("conditions"));
        await click(player, entry("condition", "prone"));
        await waitFor(gm, (id) => game.actors.get(id).statuses.has("prone"), ids.actor);

        const potion = ids.items["Healing Draught"];
        await click(player, group("items"));
        await gm.evaluate(
          ({ actor, items }) =>
            game.actors.get(actor).items.get(items["Healing Draught"]).update({ "system.quantity": 4 }),
          ids
        );
        await waitFor(player, (s) => document.querySelector(s)?.textContent.includes("×4"), entry("item", potion));

        await gm.evaluate(
          ({ scene, guard }, name) =>
            game.scenes
              .get(scene)
              .tokens.get(guard)
              .baseActor.update({
                [`ownership.${game.users.getName(name).id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
              }),
          ids,
          PLAYER_NAME
        );
        await waitFor(player, (id) => canvas.tokens.get(id).actor.isOwner, ids.guard);
        await player.evaluate((id) => canvas.tokens.get(id).control(), ids.guard);
        await waitFor(
          player,
          (id, s) => document.querySelector(s)?.dataset.actor === canvas.tokens.get(id).actor.uuid,
          ids.guard,
          `${HUD} [data-actor]`
        );
        await player.evaluate(() => canvas.tokens.releaseAll());
        await player.waitForSelector(actorBar, { visible: true });
        await player.evaluate((id) => game.settings.set(id, "actionHudEnabled", false), MODULE_ID);
        await player.waitForSelector(HUD, { hidden: true });
        await player.evaluate((id) => game.settings.set(id, "actionHudEnabled", true), MODULE_ID);
        await player.waitForSelector(actorBar, { visible: true });
        await gm.evaluate(({ scene, guard }) => game.scenes.get(scene).tokens.get(guard).delete(), ids);
        await gm.evaluate((name) => game.users.getName(name).update({ character: null }), PLAYER_NAME);
        await player.waitForSelector(HUD, { hidden: true });
      } finally {
        await gm.evaluate(
          (name, character) => game.users.getName(name).update({ character }),
          PLAYER_NAME,
          previousCharacter
        );
      }
    });
  } finally {
    await gm.evaluate(async () => {
      await game.scenes.active?.view();
      for (const doc of hudTestDocuments.reverse()) await doc.delete();
    });
  }
});
