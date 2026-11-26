import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const SETTING = "partyGlance";
const STYLESHEET = "styles/party-glance.css";
const OVERLAY = "#my-party-glance";
const RING = `${OVERLAY} .my-party-glance-ring`;
const BADGES = `${RING} .my-party-glance-badge`;
const badge = (slot) => `${BADGES}[data-slot="${slot}"]`;
const DIALOG = "#my-party-glance-config";
const row = (index) => `${DIALOG} .slot[data-slot="${index}"]`;
const pill = (index) => `${DIALOG} .pill[data-slot="${index}"]`;

const SLOTS = ["ac", "pp", "hp", "", "conc", "ins", "save", "hd"].map((stat) =>
  stat === "save" ? { stat, sub: "dex" } : { stat }
);
const GLANCE = {
  count: 6,
  slots: SLOTS,
  trigger: "select",
  players: true,
  friendlyNpcs: false,
  labels: false,
  tempHp: true
};

async function ensureStylesheet(page) {
  const loaded = await page.evaluate(
    (path) =>
      [...document.styleSheets].some(
        (sheet) =>
          sheet.href?.endsWith(path) || [...sheet.cssRules].some((rule) => rule.styleSheet?.href?.endsWith(path))
      ),
    STYLESHEET
  );
  assert(loaded, `Foundry does not serve ${STYLESHEET}; relaunch the world after changing module.json`);
}

function setGlance(page, patch) {
  return page.evaluate((moduleId, key, value) => game.settings.set(moduleId, key, value), MODULE_ID, SETTING, {
    ...GLANCE,
    ...patch
  });
}

async function buildScene(gm) {
  return gm.evaluate(async (playerName) => {
    const player = game.users.getName(playerName);
    const hero = await Actor.create({
      name: "Glance Hero",
      type: "character",
      img: "systems/dnd5e/tokens/heroes/WizardTome.webp",
      prototypeToken: { actorLink: true, texture: { src: "systems/dnd5e/tokens/heroes/WizardTome.webp" } },
      ownership: { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
      system: {
        attributes: { hp: { value: 31, max: 38, temp: 5 }, death: { success: 1, failure: 2 } },
        abilities: { int: { value: 18 }, dex: { value: 14 }, wis: { value: 12 } },
        skills: { prc: { value: 1 } }
      },
      items: [
        {
          name: "Wizard",
          type: "class",
          system: {
            levels: 5,
            hd: { denomination: "d6", spent: 2 },
            spellcasting: { progression: "full", ability: "int" }
          }
        },
        {
          name: "Bless",
          type: "spell",
          system: {
            level: 1,
            duration: { value: "1", units: "minute" },
            properties: ["concentration"],
            activities: { blessActivity000: { _id: "blessActivity000", type: "utility" } }
          }
        }
      ]
    });
    const foe = await Actor.create({
      name: "Glance Foe",
      type: "npc",
      prototypeToken: {
        disposition: CONST.TOKEN_DISPOSITIONS.HOSTILE,
        texture: { src: "systems/dnd5e/tokens/humanoid/Guard.webp" }
      }
    });
    const tokens = await Promise.all([
      hero.getTokenDocument({ x: 700, y: 500 }),
      foe.getTokenDocument({ x: 1100, y: 500 })
    ]);
    const scene = await Scene.create({
      name: "Glance Hall",
      width: 1600,
      height: 1000,
      padding: 0,
      initial: { x: 800, y: 500, scale: 1 },
      tokenVision: false,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      tokens: tokens.map((token) => token.toObject())
    });
    globalThis.glanceDocuments = [hero, foe, scene];
    return {
      scene: scene.id,
      hero: hero.id,
      heroToken: scene.tokens.find((token) => token.actorId === hero.id).id,
      foeToken: scene.tokens.find((token) => token.actorId === foe.id).id
    };
  }, PLAYER_NAME);
}

function geometry(page, tokenId) {
  return page.evaluate((id) => {
    const center = canvas.stage.worldTransform.apply(canvas.tokens.get(id).center);
    return [
      ...document.querySelectorAll(`#my-party-glance .my-party-glance-ring[data-token="${id}"] .my-party-glance-badge`)
    ].map((el) => {
      const box = el.getBoundingClientRect();
      const dx = box.x + box.width / 2 - center.x;
      const dy = box.y + box.height / 2 - center.y;
      return {
        slot: Number(el.dataset.slot),
        angle: ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360,
        distance: Math.hypot(dx, dy),
        height: box.height
      };
    });
  }, tokenId);
}

const text = (page, selector) => page.$eval(selector, (el) => el.textContent.trim());
const count = (page, selector) => page.$$eval(selector, (els) => els.length);
const waitForCount = (page, selector, n) =>
  waitFor(page, (sel, expected) => document.querySelectorAll(sel).length === expected, selector, n);

async function openDialog(gm) {
  await gm.evaluate(() => game.settings.sheet.render({ force: true }));
  await gm.click(`#settings-config nav [data-tab="${MODULE_ID}"]`);
  await gm.locator(`#settings-config .tab[data-tab="${MODULE_ID}"] [data-key="${MODULE_ID}.${SETTING}"]`).click();
  await gm.waitForSelector(DIALOG, { visible: true });
}

await run(async () => {
  const gm = await joinGamemaster();
  await ensureStylesheet(gm);
  const player = await join(PLAYER_NAME, "", "en");
  const keys = [SETTING];
  const previous = await gm.evaluate(
    (moduleId, settings) => ({
      settings: settings.map((key) => ({
        key,
        existed: Boolean(game.settings.storage.get("world").getSetting(`${moduleId}.${key}`)),
        value: foundry.utils.deepClone(game.settings.get(moduleId, key))
      })),
      paused: game.paused
    }),
    MODULE_ID,
    keys
  );
  let ids;
  try {
    await check("the GM views a scene with a player character and a hostile creature", async () => {
      ids = await buildScene(gm);
      await setGlance(gm, {});
      await gm.evaluate(async (id) => {
        await game.user.sheet.close({ animate: false });
        await game.scenes.get(id).view();
        game.togglePause(false);
      }, ids.scene);
      await waitFor(
        gm,
        (id) => canvas.ready && canvas.scene.id === id && canvas.tokens.placeables.length === 2,
        ids.scene
      );
      await waitFor(player, (id) => game.scenes.has(id), ids.scene);
      await player.evaluate(async (id) => {
        await game.user.sheet.close({ animate: false });
        await game.scenes.get(id).view();
      }, ids.scene);
      await waitFor(
        player,
        (id) => canvas.ready && canvas.scene.id === id && canvas.tokens.placeables.length === 2,
        ids.scene
      );
      assert(!(await gm.$(OVERLAY)), "a ring exists before any token is selected");
    });

    await check(
      "selecting the player's token shows the configured badges in clockwise order from the top",
      async () => {
        await gm.evaluate((id) => canvas.tokens.get(id).control(), ids.heroToken);
        await waitForCount(gm, BADGES, 5);
        const slots = await gm.$$eval(BADGES, (els) => els.map((el) => el.dataset.slot).join(","));
        assert(slots === "1,2,3,5,6", `the empty fourth slot must leave a gap, got ${slots}`);
        const placed = await geometry(gm, ids.heroToken);
        for (const { slot, angle } of placed) {
          const expected = ((slot - 1) * 360) / 6;
          const off = Math.min(Math.abs(angle - expected), 360 - Math.abs(angle - expected));
          assert(off < 3, `slot ${slot} sits at ${angle.toFixed(1)} degrees, expected ${expected}`);
        }
        assert(
          placed.every(({ height }) => Math.abs(height - 28) < 1),
          "badges must keep a fixed pixel size"
        );
      }
    );

    await check("the badges show the actor's armor class, passive Perception and hit points", async () => {
      const actor = await gm.evaluate((id) => {
        const system = game.actors.get(id).system;
        return { ac: system.attributes.ac.value, pp: system.skills.prc.passive, ins: system.skills.ins.passive };
      }, ids.hero);
      assert((await text(gm, `${badge(1)} .value`)) === String(actor.ac), "armor class");
      assert((await text(gm, `${badge(2)} .value`)) === String(actor.pp), "passive Perception");
      assert((await text(gm, `${badge(6)} .value`)) === String(actor.ins), "passive Insight");
      assert((await text(gm, `${badge(3)} .value`)) === "31/38", "hit points");
      assert((await text(gm, `${badge(3)} .temp`)) === "+5", "temporary hit points");
      const tooltips = await gm.$$eval(BADGES, (els) => els.map((el) => el.dataset.tooltipText));
      assert(tooltips[0] === `Armor Class ${actor.ac}`, tooltips[0]);
      assert(tooltips[1] === `Passive Perception ${actor.pp}`, tooltips[1]);
      assert(tooltips[2] === "Hit Points 31 / 38 (+5 temporary)", tooltips[2]);
      await gm.evaluate((id) => game.actors.get(id).update({ "system.attributes.hp.value": 12 }), ids.hero);
      await waitFor(gm, (s) => document.querySelector(s)?.textContent === "12/38", `${badge(3)} .value`);
      assert((await gm.$eval(`${badge(3)} .fill`, (el) => el.style.width)) === "32%", "hit point bar fill");
      await gm.evaluate((id) => game.actors.get(id).update({ "system.attributes.hp.value": 31 }), ids.hero);
      await waitFor(gm, (s) => document.querySelector(s)?.textContent === "31/38", `${badge(3)} .value`);
    });

    await check("temporary hit points disappear when the setting is off", async () => {
      await setGlance(gm, { tempHp: false });
      await waitFor(gm, (s) => !document.querySelector(s), `${badge(3)} .temp`);
      await setGlance(gm, {});
      await gm.waitForSelector(`${badge(3)} .temp`);
    });

    await check("the hit point badge keeps showing HP at zero", async () => {
      await gm.evaluate((id) => game.actors.get(id).update({ "system.attributes.hp.value": 0 }), ids.hero);
      await waitFor(gm, (s) => document.querySelector(s)?.textContent === "0/38", `${badge(3)}.bar .value`);
      await gm.evaluate((id) => game.actors.get(id).update({ "system.attributes.hp.value": 31 }), ids.hero);
    });

    await check("the concentration marker lights up when the actor starts concentrating", async () => {
      assert(
        await gm.$eval(badge(5), (el) => el.classList.contains("faded") && !el.classList.contains("on")),
        "idle marker"
      );
      await gm.evaluate((id) => game.actors.get(id).toggleStatusEffect("concentrating", { active: true }), ids.hero);
      await gm.waitForSelector(`${badge(5)}.on`);
      assert(!(await gm.$eval(badge(5), (el) => el.classList.contains("faded"))), "active marker must not fade");
      assert((await gm.$eval(badge(5), (el) => el.dataset.tooltipText)).startsWith("Concentrating"), "tooltip");
      await gm.evaluate((id) => game.actors.get(id).toggleStatusEffect("concentrating", { active: false }), ids.hero);
      await gm.waitForSelector(`${badge(5)}.faded`);
      await gm.evaluate((id) => {
        const actor = game.actors.get(id);
        return actor.beginConcentrating(actor.items.getName("Bless").system.activities.get("blessActivity000"));
      }, ids.hero);
      await waitFor(gm, (s) => document.querySelector(s)?.dataset.tooltipText === "Concentrating: Bless", badge(5));
      await gm.evaluate((id) => game.actors.get(id).endConcentration(), ids.hero);
      await gm.waitForSelector(`${badge(5)}.faded`);
    });

    await check("the ring grows with the token on screen while the badges keep their size", async () => {
      const before = await geometry(gm, ids.heroToken);
      await gm.evaluate(() => canvas.animatePan({ scale: canvas.stage.scale.x * 2, duration: 0 }));
      await waitFor(
        gm,
        (distance) => {
          const ring = document.querySelector("#my-party-glance .my-party-glance-badge");
          const token = canvas.tokens.controlled[0];
          const center = canvas.stage.worldTransform.apply(token.center);
          const box = ring.getBoundingClientRect();
          return Math.hypot(box.x + box.width / 2 - center.x, box.y + box.height / 2 - center.y) > distance;
        },
        before[0].distance
      );
      const after = await geometry(gm, ids.heroToken);
      assert(
        after.every(({ height }) => Math.abs(height - 28) < 1),
        "badge size changed with zoom"
      );
      await gm.evaluate(() => canvas.animatePan({ scale: canvas.stage.scale.x / 2, duration: 0 }));
    });

    await check("only eligible tokens get a ring", async () => {
      await gm.evaluate(({ foe }) => canvas.tokens.get(foe).control({ releaseOthers: true }), { foe: ids.foeToken });
      await waitFor(gm, () => !document.querySelector("#my-party-glance .my-party-glance-ring"));
      await setGlance(gm, { players: false });
      await gm.evaluate((id) => canvas.tokens.get(id).control({ releaseOthers: true }), ids.heroToken);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert(!(await gm.$(BADGES)), "player characters must follow the setting");
      await setGlance(gm, {});
      await gm.waitForSelector(BADGES);
      await gm.evaluate(
        ({ foe }) => {
          const token = canvas.scene.tokens.get(foe);
          return token.update({ disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY });
        },
        { foe: ids.foeToken }
      );
      await gm.evaluate((id) => canvas.tokens.get(id).control({ releaseOthers: true }), ids.foeToken);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert(!(await gm.$(BADGES)), "friendly NPCs are off by default");
      await setGlance(gm, { friendlyNpcs: true });
      await gm.waitForSelector(`${RING}[data-token="${ids.foeToken}"] .my-party-glance-badge`);
      await setGlance(gm, {});
      await gm.evaluate((id) => canvas.tokens.get(id).control({ releaseOthers: true }), ids.heroToken);
      await gm.waitForSelector(`${RING}[data-token="${ids.heroToken}"]`);
    });

    await check("a player has no ring even with the token controlled", async () => {
      await player.evaluate((id) => canvas.tokens.get(id).control(), ids.heroToken);
      await waitFor(player, (id) => canvas.tokens.controlled[0]?.id === id, ids.heroToken);
      await setGlance(gm, { count: 5 });
      await waitFor(player, (m, key) => game.settings.get(m, key).count === 5, MODULE_ID, SETTING);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert(!(await player.$(OVERLAY)) && !(await player.$(".my-party-glance-ring")), "the player client has a ring");
      await player.evaluate(() => canvas.tokens.releaseAll());
      await setGlance(gm, {});
    });

    await check("the hover trigger follows the pointer onto a badge and goes away after it leaves", async () => {
      await setGlance(gm, { trigger: "hover" });
      await waitFor(gm, () => !document.querySelector("#my-party-glance .my-party-glance-ring"));
      const point = await gm.evaluate(
        (id) => canvas.stage.worldTransform.apply(canvas.tokens.get(id).center),
        ids.heroToken
      );
      await gm.mouse.move(point.x - 200, point.y + 200);
      await gm.mouse.move(point.x, point.y, { steps: 4 });
      await gm.waitForSelector(BADGES);
      const box = await (await gm.$(badge(2))).boundingBox();
      await gm.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert(await gm.$(BADGES), "the ring vanished while the pointer was on a badge");
      await gm.mouse.move(point.x + 300, point.y + 300, { steps: 6 });
      await waitFor(gm, () => !document.querySelector("#my-party-glance .my-party-glance-badge"));
    });

    await check("the combat trigger rings every eligible combatant once combat has started", async () => {
      await setGlance(gm, { trigger: "combat" });
      await gm.evaluate(() => canvas.tokens.releaseAll());
      await gm.evaluate(async ({ scene, heroToken, foeToken, hero }) => {
        const combat = await Combat.create({ scene, active: true });
        await combat.createEmbeddedDocuments("Combatant", [
          { tokenId: heroToken, sceneId: scene, actorId: hero },
          { tokenId: foeToken, sceneId: scene }
        ]);
        globalThis.glanceDocuments.push(combat);
      }, ids);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert(!(await gm.$(BADGES)), "a ring appeared before combat started");
      await gm.evaluate(() => game.combat.startCombat());
      await gm.waitForSelector(`${RING}[data-token="${ids.heroToken}"]`);
      await gm.evaluate(() => game.combat.delete());
      await waitFor(gm, () => !document.querySelector("#my-party-glance .my-party-glance-ring"));
      await setGlance(gm, {});
    });

    await check("the settings dialog previews the layout, keeps focus and saves the world setting", async () => {
      await gm.evaluate((id) => canvas.tokens.get(id).control({ releaseOthers: true }), ids.heroToken);
      await gm.waitForSelector(BADGES);
      await openDialog(gm);
      assert(
        (await count(gm, `${DIALOG} .pill`)) === 6 && (await count(gm, `${DIALOG} .slot`)) === 6,
        "initial six slots"
      );
      assert(await gm.$eval(pill(3), (el) => el.classList.contains("empty")), "the empty slot is dashed");

      await gm.select(`${DIALOG} select[name="count"]`, "4");
      await waitForCount(gm, `${DIALOG} .pill`, 4);
      assert((await count(gm, `${DIALOG} .slot`)) === 4, "rows follow the slot count");
      assert((await gm.evaluate(() => document.activeElement?.name)) === "count", "focus stayed on the slot count");

      await gm.select(`${row(3)} select[name="slots.3.stat"]`, "custom");
      await gm.waitForSelector(`${row(3)} input[name="slots.3.path"]`);
      assert(
        (await gm.evaluate(() => document.activeElement?.name)) === "slots.3.stat",
        "focus stayed on the slot's stat"
      );
      await gm.locator(`${row(3)} input[name="slots.3.abbr"]`).fill("INT");
      await gm.locator(`${row(3)} input[name="slots.3.path"]`).fill("system.abilities.int.value");

      await gm.select(`${row(0)} select[name="slots.0.stat"]`, "save");
      await gm.waitForSelector(`${row(0)} select[name="slots.0.sub"]`);
      await gm.select(`${row(0)} select[name="slots.0.sub"]`, "wis");
      await waitFor(gm, (s) => document.querySelector(s)?.textContent.trim().endsWith("WIS"), pill(0));
      assert((await text(gm, `${row(0)} .kind`)) === "Number", "kind chip");
      assert((await text(gm, `${row(2)} .kind`)) === "Bar", "hit points use a bar");

      await gm.click(pill(2));
      await waitFor(gm, (s) => document.activeElement === document.querySelector(s), `${row(2)} select`);
      assert(await gm.$eval(row(2), (el) => el.classList.contains("active")), "the clicked slot's row is highlighted");

      await gm.click(`${DIALOG} button[type="submit"]`);
      await waitFor(gm, () => !document.querySelector("#my-party-glance-config"));
      const saved = await gm.evaluate((m, key) => game.settings.get(m, key), MODULE_ID, SETTING);
      assert(saved.count === 4, `count ${saved.count}`);
      assert(saved.slots[0].stat === "save" && saved.slots[0].sub === "wis", JSON.stringify(saved.slots[0]));
      assert(
        saved.slots[3].stat === "custom" && saved.slots[3].path === "system.abilities.int.value",
        JSON.stringify(saved.slots[3])
      );
      assert(saved.slots[5].stat === "ins" && saved.slots[7].stat === "hd", "hidden slots keep their values");
      await waitForCount(gm, BADGES, 4);
      assert((await gm.$eval(badge(1), (el) => el.dataset.stat)) === "save", "ring slot 1");
      assert((await gm.$eval(badge(4), (el) => el.dataset.tooltipText)) === "INT 18", "custom value");
      const hero = await gm.evaluate((id) => game.actors.get(id).system.abilities.wis.save.value, ids.hero);
      assert((await text(gm, `${badge(1)} .value`)) === `${hero >= 0 ? "+" : ""}${hero}`, "saving throw bonus");
      assert(await gm.$eval(badge(1), (el) => el.textContent.includes("WIS")), "saving throws keep their label");
    });

    await check("reset to defaults restores the default layout in the dialog", async () => {
      await openDialog(gm);
      await gm.click(`${DIALOG} button[data-action="reset"]`);
      await waitForCount(gm, `${DIALOG} .pill`, 6);
      assert((await text(gm, pill(0))).endsWith("AC"), "slot 1 is armor class again");
      await gm.evaluate(() => foundry.applications.instances.get("my-party-glance-config").close());
      const saved = await gm.evaluate((m, key) => game.settings.get(m, key).count, MODULE_ID, SETTING);
      assert(saved === 4, "closing without saving must not change the world setting");
    });
  } finally {
    await gm.evaluate(
      async ({ moduleId, settings, paused }) => {
        canvas.tokens?.releaseAll();
        for (const { key, existed, value } of settings) {
          if (existed) await game.settings.set(moduleId, key, value);
          else await game.settings.storage.get("world").getSetting(`${moduleId}.${key}`)?.delete();
        }
        await game.scenes.active?.view();
        for (const doc of (globalThis.glanceDocuments ?? []).reverse()) {
          if (doc.collection?.has(doc.id)) await doc.delete();
        }
        if (game.paused !== paused) game.togglePause(paused);
      },
      { moduleId: MODULE_ID, ...previous }
    );
  }
});
