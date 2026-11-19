import { assert, check, join, joinGamemaster, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const HUD = "#my-action-hud";
const group = (name) => `${HUD} button[data-group="${name}"]`;
const entry = (action, id) => `${HUD} [data-action="${action}"][data-id="${id}"]`;

async function click(page, selector) {
  await page.locator(selector).setTimeout(10000).click();
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
          system: { activities: activity("attack") }
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
      ownership: { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
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

    await check("the condition button applies and removes the wizard's actual prone status", async () => {
      await click(player, group("conditions"));
      for (const active of [true, false]) {
        await click(player, entry("condition", "prone"));
        await waitFor(gm, (id, expected) => game.actors.get(id).statuses.has("prone") === expected, ids.actor, active);
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
  } finally {
    await gm.evaluate(async () => {
      await game.scenes.active?.view();
      for (const doc of hudTestDocuments.reverse()) await doc.delete();
    });
  }
});
