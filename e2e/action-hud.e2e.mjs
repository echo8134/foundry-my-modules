import { checkEffectStrip } from "./action-hud-effects.mjs";
import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const HUD = "#my-action-hud";
const DETACH_HOTBAR = "actionHudDetachHotbar";
const DESIGN = "actionHudDesign";
const HIDDEN = "actionHudHiddenCategories";
const group = (name) => `${HUD} button[data-group="${name}"]`;
const entry = (action, id) => `${HUD} [data-action="${action}"][data-id="${id}"]`;

async function click(page, selector, options) {
  await page.locator(selector).setTimeout(10000).click(options);
}

async function assertMenuDesign(page, frame) {
  const styles = await page.evaluate(
    (hud, surface, tab) => {
      const menu = document.createElement("nav");
      menu.id = "context-menu";
      menu.hidden = true;
      const highlight = menu.appendChild(document.createElement("span"));
      highlight.style.backgroundColor = "var(--hover-entry-background)";
      highlight.style.borderTopColor = "var(--hover-entry-border)";
      highlight.style.color = "var(--hover-text-color)";
      document.querySelector("#interface").append(menu);
      const appearance = (element) => {
        const { backgroundColor, borderTopColor, color } = getComputedStyle(element);
        return [backgroundColor, borderTopColor, color];
      };
      const chrome = (element) => {
        const { backgroundImage, borderRadius, boxShadow, fontFamily } = getComputedStyle(element);
        return [...appearance(element), backgroundImage, borderRadius, boxShadow, fontFamily];
      };
      const result = {
        native: chrome(menu),
        frame: chrome(document.querySelector(surface)),
        panel: chrome(document.querySelector(`${hud} .hud-panel`)),
        highlight: appearance(highlight),
        tabFont: getComputedStyle(document.querySelector(tab)).fontFamily
      };
      menu.remove();
      return result;
    },
    HUD,
    frame,
    group("attacks")
  );
  assert(
    JSON.stringify(styles.frame) === JSON.stringify(styles.native) &&
      JSON.stringify(styles.panel) === JSON.stringify(styles.native) &&
      styles.tabFont === styles.native.at(-1),
    JSON.stringify(styles)
  );
  return styles.highlight;
}

async function buildEncounter(gm) {
  return gm.evaluate(async (playerName) => {
    const player = game.users.getName(playerName);
    const activity = (type, data = {}) => {
      const id = foundry.utils.randomID();
      return { [id]: { _id: id, type, ...data } };
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
        attributes: { hp: { value: 10, max: 10 } },
        abilities: { int: { value: 18 }, dex: { value: 14 }, wis: { value: 12 } },
        skills: { arc: { value: 1 } },
        spells: { spell1: { value: 2, override: 3 }, pact: { value: 1, override: 2 } }
      },
      items: [
        {
          name: "Ashwood Staff",
          type: "weapon",
          img: "icons/weapons/staves/staff-blue-jewel.webp",
          system: {
            type: { value: "simpleM" },
            equipped: true,
            range: { reach: 10, units: "ft" },
            damage: { base: { number: 1, denomination: 6, types: ["bludgeoning"] } },
            activities: {
              ...activity("attack", { name: "Strike", sort: 0 }),
              ...activity("damage", {
                name: "Flame burst",
                sort: 10,
                damage: { parts: [{ number: 2, denomination: 8, types: ["fire"] }] }
              })
            }
          }
        },
        {
          name: "Shortbow",
          type: "weapon",
          system: {
            type: { value: "simpleR" },
            equipped: true,
            range: { value: 80, long: 320, units: "ft" },
            activities: activity("attack")
          }
        },
        {
          name: "Freezing Breath",
          type: "feat",
          system: {
            activities: activity("save", {
              save: { ability: ["dex"], dc: { calculation: "", formula: "13" } },
              range: { value: 30, units: "ft" },
              target: { template: { size: "15", type: "cone", units: "ft" } },
              damage: { parts: [{ number: 2, denomination: 6, types: ["cold"] }] }
            })
          }
        },
        {
          name: "Stowed Dagger",
          type: "weapon",
          system: { equipped: false, activities: activity("attack") }
        },
        {
          name: "Cure Wounds",
          type: "spell",
          system: {
            level: 1,
            prepared: 1,
            activities: activity("heal", { healing: { number: 2, denomination: 8, types: ["healing"] } })
          }
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
          system: {
            quantity: 3,
            activities: activity("heal", { healing: { number: 1, denomination: 4, types: ["healing"] } })
          }
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
      wizard.getTokenDocument({ x: 500, y: 400, level: Scene.metadata.defaultLevelId }),
      guard.getTokenDocument({ x: 750, y: 400, level: Scene.metadata.defaultLevelId })
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
  const player = await join(PLAYER_NAME, "", "en");
  const previousCategories = await player.evaluate((m, key) => game.settings.get(m, key), MODULE_ID, HIDDEN);
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
      await gm.waitForSelector(group("spells"), { visible: true });
      assert(!(await gm.$(group("attacks"))), "empty attack group appeared");
      await gm.evaluate(() => canvas.tokens.releaseAll());
      await gm.waitForSelector(HUD, { hidden: true });
      await player.evaluate((id) => canvas.tokens.get(id).control(), ids.hero);
      await player.waitForSelector(group("attacks"), { visible: true });
    });

    await checkEffectStrip(gm, player, ids);

    await check(
      "the GM can hide and restore the macro hotbar while the HUD follows and the player's bar stays visible",
      async () => {
        const toggle = '[data-tool="myMacroHotbar"]';
        await gm.bringToFront();
        await gm.evaluate((id) => canvas.tokens.get(id).control(), ids.hero);
        await gm.waitForSelector(HUD, { visible: true });
        await gm.waitForSelector(toggle, { visible: true });
        assert(!(await player.$(toggle)), "player has a GM hotbar toggle");
        const top = await gm.$eval(HUD, (el) => el.getBoundingClientRect().top);
        const barTop = await gm.$eval("#hotbar", (el) => el.getBoundingClientRect().top);
        await gm.keyboard.down("Alt");
        try {
          await gm.keyboard.press("KeyB");
        } finally {
          await gm.keyboard.up("Alt");
        }
        await gm.waitForSelector("#hotbar", { hidden: true });
        await waitFor(
          gm,
          (selector, y) => document.querySelector(selector).getBoundingClientRect().bottom > y,
          HUD,
          barTop
        );
        await player.waitForSelector("#hotbar", { visible: true });
        await click(gm, toggle);
        await gm.waitForSelector("#hotbar", { visible: true });
        await waitFor(
          gm,
          (selector, y) => Math.abs(document.querySelector(selector).getBoundingClientRect().top - y) < 1,
          HUD,
          top
        );
        await gm.evaluate(() => canvas.tokens.releaseAll());
        await player.bringToFront();
      }
    );

    await check("the sentry's at-will spell appears with prepared set to zero", async () => {
      await gm.evaluate((id) => canvas.tokens.get(id).control(), ids.guard);
      await gm.waitForSelector(group("spells"), { visible: true });
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

    await check("the sentry's fixed attack bonus appears in the HUD", async () => {
      await gm.evaluate((id) => canvas.tokens.get(id).control(), ids.guard);
      const weapon = await gm.evaluate(async () => {
        const id = foundry.utils.randomID();
        const [item] = await canvas.tokens.controlled[0].actor.createEmbeddedDocuments("Item", [
          {
            name: "Sentry spear",
            type: "weapon",
            system: {
              equipped: true,
              activities: { [id]: { _id: id, type: "attack", attack: { flat: true, bonus: "8" } } }
            }
          }
        ]);
        return item.id;
      });
      await click(gm, group("attacks"));
      const button = await gm.waitForSelector(entry("item", weapon), { visible: true });
      assert((await button.evaluate((el) => el.textContent)).includes("+8"), "missing fixed +8 attack bonus");
      await gm.evaluate(() => canvas.tokens.releaseAll());
    });

    await check("Legendary Resistance can stabilize a dying sentry until it takes damage", async () => {
      const result = await gm.evaluate(async (id) => {
        const sentry = canvas.tokens.get(id).document.baseActor;
        await sentry.update({
          "system.attributes.hp.value": 0,
          "system.attributes.death.success": 2,
          "system.attributes.death.failure": 1,
          "system.resources.legres.max": 1
        });
        const card = await ChatMessage.create({
          type: "save",
          speaker: ChatMessage.getSpeaker({ actor: sentry }),
          system: { type: "death", deltas: { actor: [{ keyPath: "system.attributes.death.failure", delta: 1 }] } }
        });
        hudTestDocuments.push(card);
        await sentry.system.resistSave(card);
        const { showsDeathSaves } = await import("/modules/foundry-my-modules/scripts/action-hud/death-saves.mjs");
        const stable = card.system.outcome === "stable" && !showsDeathSaves(sentry);
        await sentry.applyDamage(1);
        return stable && showsDeathSaves(sentry);
      }, ids.guard);
      assert(result, "sentry should need a new death save only after taking damage");
    });

    await check("the personal HUD design follows Foundry themes, docking and reload", async () => {
      const attacks = group("attacks");
      const staff = entry("item", ids.items["Ashwood Staff"]);
      const detached = `body > ${HUD}`;
      const form = "#my-action-hud-config";
      const select = `${form} select[name="${DESIGN}"]`;
      const openAttacks = async (page) => {
        await page.waitForSelector(`${HUD} [data-actor="Actor.${ids.actor}"] [data-group="attacks"]`, {
          visible: true
        });
        if (!(await page.$(`${attacks}[aria-expanded="true"]`))) await click(page, attacks);
        await page.waitForSelector(staff, { visible: true });
      };
      const theme = (uiTheme) =>
        player.evaluate((uid) => {
          const config = game.settings.get("core", "uiConfig");
          game.configureUI({ ...config, colorScheme: { applications: "dark", interface: uid } });
        }, uiTheme);
      await gm.bringToFront();
      await gm.evaluate((id) => canvas.tokens.get(id).control(), ids.hero);
      await openAttacks(gm);
      await player.bringToFront();
      try {
        await player.evaluate(() => game.settings.sheet.render({ force: true }));
        await click(player, `#settings-config nav [data-tab="${MODULE_ID}"]`);
        assert(!(await player.$(`#settings-config [data-key="${MODULE_ID}.partyGlance"]`)), "player sees GM ring menu");
        assert(
          !(await player.$(`#settings-config [name="${MODULE_ID}.partyGlanceEnabled"]`)),
          "player sees GM ring toggle"
        );
        await click(player, `#settings-config [data-key="${MODULE_ID}.actionHudCategories"]`);
        await player.waitForSelector(select, { visible: true });
        assert((await player.$eval(select, (el) => el.value)) === "wood", "wood and parchment is the default");
        assert(
          await player.evaluate((key) => game.settings.settings.get(key).scope === "client", `${MODULE_ID}.${DESIGN}`),
          "HUD design must be stored per client"
        );
        await player.select(select, "menu");
        await click(player, `${form} button[type="submit"]`);
        await player.waitForSelector(form, { hidden: true });
        await player.evaluate(() => game.settings.sheet.close());
        await player.waitForSelector("#settings-config", { hidden: true });
        await openAttacks(player);

        for (const palette of ["dark", "light"]) {
          await theme(palette);
          const highlight = await assertMenuDesign(player, "#hotbar");
          const spells = group("spells");
          await player.hover(spells);
          // Tab cycles the controlled token in Foundry. Shift puts the browser in keyboard focus mode.
          await player.keyboard.press("Shift");
          await player.focus(staff);
          await waitFor(
            player,
            (selectors, expected) =>
              selectors.every((selector) => {
                const el = document.querySelector(selector);
                if (!el) return false;
                const { backgroundColor, borderTopColor, color } = getComputedStyle(el);
                return [backgroundColor, borderTopColor, color].join() === expected.join();
              }),
            [attacks, spells, staff],
            highlight
          );
          assert(
            await player.$eval(
              staff,
              (el) => el.matches(":focus-visible") && getComputedStyle(el).outlineWidth === "2px"
            ),
            "keyboard focus has a visible outline"
          );
        }
        await player.evaluate((m, key) => game.settings.set(m, key, true), MODULE_ID, DETACH_HOTBAR);
        await player.waitForSelector(`${detached} .hud-grip`, { visible: true });
        await assertMenuDesign(player, `${detached} .hud-bar`);

        await player.reload({ waitUntil: "domcontentloaded" });
        await player.waitForFunction(() => globalThis.game?.ready && globalThis.canvas?.ready, { timeout: 180000 });
        await player.evaluate(async (id) => {
          await game.user.sheet.close({ animate: false });
          await game.scenes.get(id).view();
        }, ids.scene);
        await waitFor(player, (id) => canvas.ready && canvas.tokens.get(id)?.actor.isOwner, ids.hero);
        await player.evaluate((id) => canvas.tokens.get(id).control(), ids.hero);
        await openAttacks(player);
        await player.waitForSelector(`${detached} .hud-grip`, { visible: true });
        await assertMenuDesign(player, `${detached} .hud-bar`);

        for (const [selector, texture] of [
          ["#hotbar", "board.webp"],
          [`${HUD} .hud-panel`, "parchment.webp"]
        ]) {
          assert(
            await gm.$eval(selector, (el, image) => getComputedStyle(el).backgroundImage.includes(image), texture),
            `the other client lost its ${texture} background`
          );
        }
      } finally {
        await player.evaluate(
          async (m, design, detach) => {
            await game.settings.set(m, design, "wood");
            await game.settings.set(m, detach, false);
          },
          MODULE_ID,
          DESIGN,
          DETACH_HOTBAR
        );
        await gm.evaluate(() => canvas.tokens.releaseAll());
      }
    });

    await check("the skull and activity details fit a narrow HUD in both layouts and designs", async () => {
      const viewport = player.viewport();
      const hp = await gm.evaluate((id) => game.actors.get(id).system.attributes.hp.value, ids.actor);
      await player.setViewport({ ...viewport, width: 900 });
      await gm.evaluate((id) => game.actors.get(id).update({ "system.attributes.hp.value": 0 }), ids.actor);
      await click(player, group("features"));
      const row = entry("item", ids.items["Freezing Breath"]);
      try {
        for (const design of ["wood", "menu"]) {
          await player.evaluate((m, key, value) => game.settings.set(m, key, value), MODULE_ID, DESIGN, design);
          for (const detached of [false, true]) {
            await player.evaluate(
              (m, key, value) => game.settings.set(m, key, value),
              MODULE_ID,
              DETACH_HOTBAR,
              detached
            );
            const hud = `${detached ? "body" : "#hotbar"} > ${HUD}${design === "menu" ? ".menu-design" : ":not(.menu-design)"}`;
            await player.waitForSelector(`${hud} .hud-bar [data-action="deathSave"] .fa-skull`, { visible: true });
            const fits = await player.$eval(row, (button) => {
              const panel = button.closest(".hud-panel");
              const skull = button.closest(".hud-body").querySelector('[data-action="deathSave"]');
              return (
                panel.scrollWidth <= panel.clientWidth + 1 &&
                [...button.querySelectorAll("span, small")].every(
                  (label) => label.scrollWidth <= label.clientWidth + 1
                ) &&
                /2d6.*cold/i.test(button.textContent) &&
                parseFloat(getComputedStyle(skull).borderTopWidth) > 0
              );
            });
            assert(fits, `clipped activity details or missing skull border in ${design}, detached=${detached}`);
          }
        }
      } finally {
        await player.setViewport(viewport);
        await gm.evaluate((id, hp) => game.actors.get(id).update({ "system.attributes.hp.value": hp }), ids.actor, hp);
        await player.evaluate(
          async (m, design, detach) => {
            await game.settings.set(m, design, "wood");
            await game.settings.set(m, detach, false);
          },
          MODULE_ID,
          DESIGN,
          DETACH_HOTBAR
        );
      }
    });

    await check("players can choose their tabs and layout and use native macros", async () => {
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
      const peer = await join(peerName, "", "de");
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
        assert((await peer.$eval(group("attacks"), (el) => el.textContent.trim())) === "Angriffe", "German HUD tab");
        assert(await peer.$(docked), "a new player starts detached");
        assert(!(await peer.$(group("conditions"))) && !(await peer.$(group("rests"))), "unexpected default tabs");
        await peer.evaluate(() => game.settings.sheet.render({ force: true }));
        await click(peer, `#settings-config nav [data-tab="${MODULE_ID}"]`);
        await click(peer, `#settings-config [data-action="openSubmenu"][data-key="${MODULE_ID}.actionHudCategories"]`);
        const form = "#my-action-hud-config";
        await peer.waitForSelector(`${form} label[for="my-action-category-attacks"]`, { visible: true });
        assert(
          (await peer.$eval(`${form} label[for="my-action-category-attacks"]`, (el) => el.textContent.trim())) ===
            "Attacks",
          "English category setting"
        );
        await peer.waitForSelector(`${form} [name="attacks"]`, { visible: true });
        const checks = await peer.$$eval(`${form} input[id^="my-action-category-"]`, (inputs) =>
          Object.fromEntries(inputs.map((input) => [input.name, input.checked]))
        );
        assert(
          Object.keys(checks).length === 8 &&
            ["attacks", "spells", "features", "items", "rolls", "deathSaves"].every((id) => checks[id]) &&
            checks.conditions === false &&
            checks.rests === false,
          JSON.stringify(checks)
        );
        await click(peer, `${form} [name="rests"]`);
        await click(peer, `${form} [name="rolls"]`);
        await click(peer, `${form} button[type="submit"]`);
        await peer.waitForSelector(group("rests"), { visible: true });
        assert(!(await peer.$(group("rolls"))) && !(await peer.$(group("conditions"))), "unexpected saved tabs");

        await peer.evaluate((id) => localStorage.setItem(`${id}.actionHudCombineHotbar`, "false"), MODULE_ID);
        await peer.reload({ waitUntil: "domcontentloaded" });
        await peer.waitForFunction(() => globalThis.game?.ready && globalThis.canvas?.ready, { timeout: 180000 });
        await peer.evaluate(async (id) => {
          await game.user.sheet.close({ animate: false });
          await game.scenes.get(id).view();
        }, ids.scene);
        await waitFor(peer, (id) => canvas.ready && canvas.tokens.get(id)?.actor.isOwner, ids.hero);
        await peer.evaluate((id) => canvas.tokens.get(id).control(), ids.hero);
        await peer.waitForSelector(`body > ${HUD} .hud-grip`, { visible: true });
        assert(await peer.$(group("rests")), "Rests did not persist");
        assert(!(await peer.$(group("rolls"))) && !(await peer.$(group("conditions"))), "hidden tabs returned");

        await player.bringToFront();
        await waitFor(player, (id) => game.macros.has(id), macroId);
        await player.evaluate(
          async (m, key, id) => {
            await game.user.assignHotbarMacro(game.macros.get(id), 1);
            await game.settings.set(m, key, []);
          },
          MODULE_ID,
          HIDDEN,
          macroId
        );
        await player.waitForSelector(docked, { visible: true });
        await player.waitForSelector(group("rests"), { visible: true });
        await player.waitForSelector(group("rolls"), { visible: true });
        const viewport = player.viewport();
        for (const [width, shouldWrap] of [
          [1920, false],
          [900, true],
          [1920, false]
        ]) {
          await player.setViewport({ ...viewport, width });
          await waitFor(
            player,
            (wrap) => {
              const tabs = [...document.querySelectorAll("#my-action-hud .hud-bar > *")];
              if (tabs.length !== 8) return false;
              const first = tabs[0].getBoundingClientRect();
              return tabs.some((tab) => tab.getBoundingClientRect().top >= first.bottom) === wrap;
            },
            shouldWrap
          );
        }
        await player.setViewport(viewport);
        const joined = await player.evaluate(() => {
          const bar = document.querySelector("#my-action-hud .hud-bar").getBoundingClientRect();
          const slots = document.querySelectorAll("#action-bar .slot");
          const first = slots[0].getBoundingClientRect();
          return slots.length === 10 && bar.bottom <= first.top && first.top - bar.bottom < 12;
        });
        assert(joined, "the HUD and ten macro slots did not form adjacent rows");
        await click(player, group("rolls"));
        for (const [action, id] of [
          ["check", "int"],
          ["save", "wis"],
          ["skill", "arc"]
        ]) {
          await player.waitForSelector(entry(action, id), { visible: true });
        }
        if ((await player.evaluate(() => game.i18n.lang)) === "en") {
          assert(
            (await player.$eval(group("rolls"), (tab) => tab.textContent.trim())) === "Checks/Saves",
            "wrong roll label"
          );
        }
        await click(player, '#hotbar .slot.full[data-slot="1"]');
        await player.keyboard.press("1");
        await waitFor(gm, (text) => game.messages.filter((msg) => msg.content.includes(text)).length === 2, marker);

        await click(player, "#hotbar .page-next");
        await player.waitForSelector('#action-bar [data-slot="11"]', { visible: true });
        await player.waitForSelector(`${docked} .hud-panel`, { visible: true });
        assert(!(await peer.$(docked)), "the second player's layout changed with the first player's setting");
        await player.evaluate((id, key) => game.settings.set(id, key, true), MODULE_ID, DETACH_HOTBAR);
        await player.waitForSelector(`body > ${HUD} .hud-grip`, { visible: true });
      } finally {
        await peer.browserContext().close();
        await player.evaluate(
          async (m, key, previous) => {
            await game.settings.set(m, key, true);
            await game.user.assignHotbarMacro(game.macros.get(previous) ?? null, 1);
            await ui.hotbar.changePage(1);
          },
          MODULE_ID,
          DETACH_HOTBAR,
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
      await player.evaluate((id, key) => game.settings.set(id, key, false), MODULE_ID, DETACH_HOTBAR);
      await player.waitForSelector(`#hotbar > ${HUD}`, { visible: true });
      await player.evaluate((id, key) => game.settings.set(id, key, true), MODULE_ID, DETACH_HOTBAR);
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

    await check("attacks show their modifiers, damage and range, and list alternate activities on hover", async () => {
      await click(player, group("attacks"));
      const staff = entry("item", ids.items["Ashwood Staff"]);
      await player.waitForSelector(staff, { visible: true });
      const expected = await player.evaluate((id) => {
        const item = canvas.tokens.controlled[0].actor.items.get(id);
        const { labels } = item.system.activities.getName("Strike");
        return [labels.toHit, labels.damages[0].label, item.labels.reach];
      }, ids.items["Ashwood Staff"]);
      const summary = await player.$eval(staff, (el) => el.textContent);
      assert(
        expected.every((label) => label && summary.includes(label)),
        JSON.stringify({ summary, expected })
      );
      assert(!summary.includes("2d8"), "secondary damage appeared on the row");
      await player.hover(staff);
      await waitFor(player, () => {
        const tooltip = document.querySelector("#tooltip.active");
        return tooltip?.textContent.includes("Flame burst") && /2d8.*fire/i.test(tooltip.textContent);
      });
      const bow = await player.$eval(entry("item", ids.items.Shortbow), (el) => el.textContent);
      assert(bow.includes("80/320"), bow);
      await gm.evaluate(
        (id) =>
          game.actors.get(id).items.getName("Ashwood Staff").update({
            "system.damage.base.denomination": 12
          }),
        ids.actor
      );
      await waitFor(player, (s) => document.querySelector(s)?.textContent.includes("1d12"), staff);
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
      const healingSpell = await player.$eval(entry("item", ids.items["Cure Wounds"]), (el) => el.textContent);
      assert(/2d8 Hit Points/i.test(healingSpell), healingSpell);
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
      const cone = await player.waitForSelector(entry("item", ids.items["Freezing Breath"]), { visible: true });
      const details = await cone.evaluate((el) => el.textContent);
      for (const pattern of [/13/, /dex/i, /2d6.*cold/i, /30/, /15/, /cone/i]) {
        assert(pattern.test(details), `expected ${pattern} in ${details}`);
      }
      await waitFor(player, (s) => document.querySelector(s)?.textContent.includes("2/3"), entry("item", ward));
      const utility = await player.$eval(entry("item", ward), (el) => el.textContent);
      assert(!/damage|undefined|null|NaN/i.test(utility), utility);
      await gm.evaluate(
        (actor, id) => game.actors.get(actor).items.get(id).update({ "system.uses.spent": 2 }),
        ids.actor,
        ward
      );
      await waitFor(player, (s) => document.querySelector(s)?.textContent.includes("1/3"), entry("item", ward));
      const potion = ids.items["Healing Draught"];
      await click(player, group("items"));
      await waitFor(player, (s) => document.querySelector(s)?.textContent.includes("×3"), entry("item", potion));
      const heal = await player.$eval(entry("item", potion), (el) => el.textContent);
      assert(/1d4 Hit Points/i.test(heal), heal);
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
    await player.evaluate((m, key, value) => game.settings.set(m, key, value), MODULE_ID, HIDDEN, previousCategories);
    await gm.evaluate(async () => {
      await game.scenes.active?.view();
      for (const doc of hudTestDocuments.reverse()) await doc.delete();
    });
  }
});
