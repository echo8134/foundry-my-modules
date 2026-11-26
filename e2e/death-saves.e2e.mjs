import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const SETTING = "privateDeathSaves";
const JOURNAL_ID = "MyDeathSaveRules";
const ROLL_MODE = '.roll-configuration select[name="rollMode"]';
const ROLL_BUTTON = '.roll-configuration button[type="submit"][data-action="normal"]';
const TOTAL = ".dice-roll .total, .dice-roll .dice-total";
const chatRow = (id) => `#chat [data-message-id="${id}"]`;

function rulesJournals(gm) {
  return gm.evaluate(
    (moduleId, setting, id) =>
      game.journal
        .filter((entry) => entry.id === id || entry.getFlag(moduleId, setting))
        .map((entry) => entry.toObject()),
    MODULE_ID,
    SETTING,
    JOURNAL_ID
  );
}

async function setRecipient(gm, clients, recipient) {
  await gm.evaluate((m, key, value) => game.settings.set(m, key, value), MODULE_ID, SETTING, recipient);
  await Promise.all(
    clients.map((page) =>
      waitFor(page, (m, key, value) => game.settings.get(m, key) === value, MODULE_ID, SETTING, recipient)
    )
  );
}

async function assertSheetAudience(clients, actorId, viewers) {
  await Promise.all(
    clients.map((page) =>
      waitFor(
        page,
        (id, visible) => {
          const actor = game.actors.get(id);
          const sheet = actor.sheet.element;
          if (!sheet?.querySelector(".meter.hit-dice")) return false;
          const tray = sheet.querySelector(".death-tray");
          if (!visible) return !tray?.checkVisibility();
          return (
            tray?.checkVisibility() &&
            ["success", "failure"].every(
              (key) =>
                tray.querySelectorAll(`[data-prop="system.attributes.death.${key}"] .pip.filled`).length ===
                actor.system.attributes.death[key]
            )
          );
        },
        actorId,
        viewers.includes(page)
      )
    )
  );
}

async function rollWithDialog(player, button, mode, locked) {
  await player.locator(button).setTimeout(10000).click();
  await player.waitForSelector(ROLL_MODE, { visible: true });
  const actual = await player.$eval(ROLL_MODE, (select) => ({
    mode: select.value,
    locked: select.disabled || [...select.options].every((option) => option.disabled || option.value === select.value)
  }));
  assert(
    actual.mode === mode && actual.locked === locked,
    `expected a ${locked ? "locked" : "selectable"} ${mode} mode`
  );
  await player.locator(ROLL_BUTTON).setTimeout(10000).click();
  await player.waitForSelector(ROLL_MODE, { hidden: true });
}

async function nextRoll(gm, actorId, roll) {
  const existing = await gm.evaluate(
    (id) => game.messages.filter((message) => message.speaker.actor === id).map((message) => message.id),
    actorId
  );
  await roll();
  const message = await waitFor(
    gm,
    (id, previous) =>
      game.messages.find((entry) => entry.speaker.actor === id && entry.isRoll && !previous.includes(entry.id))?.id,
    actorId,
    existing
  );
  return message.jsonValue();
}

async function assertAudience(clients, messageId, recipient, outcome = null) {
  const [gm, player] = clients;
  const { whisper, blind, total } = await gm.evaluate((id) => {
    const message = game.messages.get(id);
    return { whisper: message.whisper, blind: message.blind, total: message.rolls[0].total };
  }, messageId);
  assert(
    !blind && (recipient ? whisper.length === 1 && whisper[0] === recipient : whisper.length === 0),
    `unexpected whisper recipients ${JSON.stringify(whisper)} or blind flag ${blind}`
  );

  const selector = chatRow(messageId);
  await Promise.all(
    clients.map(async (page) => {
      const canSee = !recipient || page === gm || page === player;
      await waitFor(
        page,
        (id, expected) => {
          const message = game.messages.get(id);
          return message && (!expected || message.system.outcome === expected);
        },
        messageId,
        outcome
      );
      const visible = await page.evaluate((id) => game.messages.get(id).isContentVisible, messageId);
      assert(visible === canSee, "the message's content visibility did not match its audience");
      if (!canSee) {
        await page.evaluate((id) => ui.chat.updateMessage(game.messages.get(id)), messageId);
        const privateNotice = await page.$eval(selector, (row) => {
          const message = game.messages.get(row.dataset.messageId);
          const user = message.author.name;
          const notice =
            game.i18n.lang === "de" ? `${user} hat verdeckt gewürfelt.` : `${user} privately rolled some dice`;
          return row.querySelector(".message-content")?.textContent.trim() === notice && message.export() === notice;
        });
        assert(privateNotice, "a bystander saw more than the private-roll notice in chat or its export");
        return;
      }

      const roll = `${selector} :is(${TOTAL})`;
      await page.waitForSelector(roll, { visible: true, timeout: 10000 });
      const shown = await page.$eval(roll, (element) => element.textContent.trim());
      assert(shown === String(total), `the chat displayed ${shown} instead of ${total}`);
      if (outcome) {
        await waitFor(
          page,
          (selector, id, outcome) => {
            const name = game.messages.get(id).getAssociatedActor().name;
            const expected = game.i18n.format(`DND5E.DEATH.Outcome.${outcome}`, { name });
            return document.querySelector(selector)?.textContent.trim() === expected;
          },
          `${selector} .death-save .supplement`,
          messageId,
          outcome
        );
      }
    })
  );
}

async function terminalOutcome(gm, actorId, messageId) {
  const die = await gm.evaluate((id) => {
    const message = game.messages.get(id);
    return message.type === "save" && message.system.type === "death" ? message.rolls[0].d20.total : null;
  }, messageId);
  assert(Number.isInteger(die) && die >= 1 && die <= 20, "expected a native d20 death save");
  const outcome = die === 20 ? "revive" : die >= 10 ? "stable" : "death";
  const tally = outcome === "death" ? [0, 2, 3] : [Number(outcome === "revive"), 0, 0];
  await waitFor(
    gm,
    (actor, message, expected, outcome) => {
      const { hp, death } = game.actors.get(actor).system.attributes;
      return (
        [hp.value, death.success, death.failure].every((value, index) => value === expected[index]) &&
        game.messages.get(message).system.outcome === outcome
      );
    },
    actorId,
    messageId,
    tally,
    outcome
  );
  return outcome;
}

const reset = (player, actorId, marks = 0) =>
  player.evaluate(
    (id, marks) =>
      game.actors.get(id).update({
        "system.attributes.hp.value": 0,
        "system.attributes.death.success": marks,
        "system.attributes.death.failure": marks
      }),
    actorId,
    marks
  );

async function createTokenScene(gm, actorId) {
  return gm.evaluate(async (id) => {
    const token = await game.actors.get(id).getTokenDocument({
      actorLink: true,
      displayName: CONST.TOKEN_DISPLAY_MODES.ALWAYS,
      x: 400,
      y: 400
    });
    const scene = await Scene.create({
      name: "Death save counters",
      width: 1200,
      height: 1000,
      tokenVision: false,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      tokens: [token.toObject(), { name: "Other token", x: 700, y: 400 }]
    });
    return {
      scene: scene.id,
      dying: scene.tokens.find((t) => t.actorId === id).id,
      other: scene.tokens.find((t) => !t.actorId).id
    };
  }, actorId);
}

function assertMarks(page, selector, success, failure) {
  return waitFor(
    page,
    (sel, good, bad) => {
      const marks = document.querySelector(sel);
      const pips = (count) => "●".repeat(count) + "○".repeat(3 - count);
      return (
        marks?.checkVisibility() &&
        getComputedStyle(marks, "::before").content === `"✓ ${pips(good)}"` &&
        getComputedStyle(marks, "::after").content === `"× ${pips(bad)}"`
      );
    },
    selector,
    success,
    failure
  );
}

async function checkStackedRows(player, actorId) {
  const original = await player.evaluate(
    (m) => ({
      design: game.settings.get(m, "actionHudDesign"),
      detached: game.settings.get(m, "actionHudDetachHotbar"),
      effects: game.settings.get(m, "actionHudShowEffects")
    }),
    MODULE_ID
  );
  const layout = (design, detached) =>
    player.evaluate(
      async (m, design, detached) => {
        if (game.settings.get(m, "actionHudDesign") !== design) await game.settings.set(m, "actionHudDesign", design);
        if (game.settings.get(m, "actionHudDetachHotbar") !== detached)
          await game.settings.set(m, "actionHudDetachHotbar", detached);
      },
      MODULE_ID,
      design,
      detached
    );
  const rolls = '#my-action-hud [data-group="rolls"]';
  const effectId = await player.evaluate(async (id) => {
    const [effect] = await game.actors
      .get(id)
      .createEmbeddedDocuments("ActiveEffect", [
        { name: "Death save layout test", duration: { value: 1, units: "minutes" } }
      ]);
    return effect.id;
  }, actorId);
  try {
    await player.evaluate((m) => game.settings.set(m, "actionHudShowEffects", false), MODULE_ID);
    await waitFor(player, () => {
      const body = document.querySelector("#my-action-hud .hud-body");
      const death = body?.querySelector(".hud-death-saves")?.getBoundingClientRect();
      const bar = body?.querySelector(".hud-bar")?.getBoundingClientRect();
      return !body?.querySelector(".hud-effects") && death?.height > 0 && bar && Math.abs(death.bottom - bar.top) <= 1;
    });
    await player.evaluate((m) => game.settings.set(m, "actionHudShowEffects", true), MODULE_ID);
    await player.locator(rolls).click();
    for (const design of ["wood", "menu"]) {
      for (const detached of [false, true]) {
        await layout(design, detached);
        const hud = `${detached ? "body" : "#hotbar"} > #my-action-hud${design === "menu" ? ".menu-design" : ":not(.menu-design)"}`;
        await waitFor(
          player,
          (selector) => {
            const body = document.querySelector(`${selector} .hud-body`);
            const death = body?.querySelector(".hud-death-saves");
            const panel = body?.querySelector(".hud-panel");
            const effects = body?.querySelector(".hud-effects");
            if (!death || !panel || !effects?.querySelector("[data-effect-uuid]")) return false;
            const rows = [effects, death, body.querySelector(".hud-bar")].map((row) => row.getBoundingClientRect());
            const popup = panel.getBoundingClientRect();
            const macros = document.querySelector("#action-bar").getBoundingClientRect();
            return (
              rows[0].height > 0 &&
              Math.abs(rows[0].bottom - rows[1].top) <= 1 &&
              Math.abs(rows[1].bottom - rows[2].top) <= 1 &&
              rows[2].bottom <= macros.top + 1 &&
              (popup.bottom <= rows[0].top + 1 || popup.top >= rows[2].bottom - 1)
            );
          },
          hud
        );
      }
    }
  } finally {
    await player.evaluate(
      async (m, id, effect, show) => {
        await game.actors.get(id).deleteEmbeddedDocuments("ActiveEffect", [effect]);
        await game.settings.set(m, "actionHudShowEffects", show);
      },
      MODULE_ID,
      actorId,
      effectId,
      original.effects
    );
    await layout(original.design, original.detached);
    await player.locator(rolls).click();
  }
}

function fixedDie(player, value) {
  return player.evaluate(async (face) => {
    CONFIG.Dice.fulfillment.methods.hudTest = { label: "HUD test d20", handler: () => face };
    const dice = game.settings.get("core", "diceConfiguration");
    await game.settings.set("core", "diceConfiguration", { ...dice, d20: "hudTest" });
  }, value);
}

await run(async () => {
  const gm = await joinGamemaster("de");
  const setting = await gm.evaluate(
    (m, key) => {
      const registration = game.settings.settings.get(`${m}.${key}`);
      return {
        worldOption: registration?.scope === "world" && registration.config && registration.type === String,
        default: registration?.default,
        recipient: game.settings.get(m, key)
      };
    },
    MODULE_ID,
    SETTING
  );
  await check("private death saves are a world setting off by default", async () => {
    assert(setting.worldOption && setting.default === "off", "expected an off-by-default world recipient setting");
  });
  const before = await rulesJournals(gm);
  const suffix = Date.now();
  const names = {
    actor: `Death save character ${suffix}`,
    observer: `Death save observer ${suffix}`,
    otherGM: `Death save other GM ${suffix}`
  };
  const originalModes = new Map();
  try {
    const actorId = await gm.evaluate(
      async (playerName, names) => {
        await User.create({ name: names.observer, role: CONST.USER_ROLES.PLAYER });
        await User.create({ name: names.otherGM, role: CONST.USER_ROLES.GAMEMASTER });
        const actor = await Actor.create({
          name: names.actor,
          type: "character",
          system: { attributes: { hp: { value: 0, max: 10 } } },
          ownership: {
            [game.users.getName(playerName).id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
            [game.users.getName(names.observer).id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER
          }
        });
        return actor.id;
      },
      PLAYER_NAME,
      names
    );
    const player = await join(PLAYER_NAME, "", "en");
    const observer = await join(names.observer, "", "de");
    const otherGM = await join(names.otherGM);
    const clients = [gm, player, observer, otherGM];
    const recipient = await gm.evaluate(() => game.user.id);
    const observerId = await observer.evaluate(() => game.user.id);
    for (const page of [gm, player]) {
      originalModes.set(page, await page.evaluate(() => game.settings.get("core", "messageMode")));
      await page.evaluate(() => game.settings.set("core", "messageMode", "public"));
    }
    await Promise.all(
      clients.map((page) =>
        page.evaluate(async () => {
          await game.user.sheet.close({ animate: false });
          ui.sidebar.expand();
          ui.sidebar.changeTab("chat", "primary");
        })
      )
    );

    let rules;
    await check("choosing a GM creates a player-readable House rules journal", async () => {
      await gm.evaluate(async () => {
        await game.settings.sheet.render({ force: true });
      });
      await gm.locator(`#settings-config button[data-tab="${MODULE_ID}"]`).click();
      const select = `#settings-config select[name="${MODULE_ID}.${SETTING}"]`;
      const choices = await gm.$eval(select, (el) => Object.fromEntries([...el.options].map((o) => [o.value, o.text])));
      assert(
        choices.off === "Off" && choices[recipient] && !(observerId in choices),
        "expected English Off and named GM choices on the German client"
      );
      await gm.select(select, recipient);
      await gm.locator('#settings-config button[type="submit"]').click();
      await waitFor(player, (m, key, id) => game.settings.get(m, key) === id, MODULE_ID, SETTING, recipient);
      await waitFor(
        gm,
        (m, key, id) => game.journal.some((entry) => entry.id === id || entry.getFlag(m, key)),
        MODULE_ID,
        SETTING,
        JOURNAL_ID
      );
      const entries = await rulesJournals(gm);
      assert(entries.length === 1, `expected one rules journal, got ${entries.length}`);
      [rules] = entries;
    });

    await check("German and English players read the same house rule in their own language", async () => {
      for (const [client, title, heading, intro] of [
        [player, "House rules", "Private death saves", "Make death saving throws"],
        [observer, "Homebrew Regeln", "Verdeckte Todesrettungswürfe", "Todesrettungswürfe würfelst du"]
      ]) {
        await waitFor(client, (id) => game.journal.get(id)?.testUserPermission(game.user, "OBSERVER"), rules._id);
        await client.evaluate(() => ui.sidebar.changeTab("journal", "primary"));
        const link = `#journal [data-entry-id="${rules._id}"] [data-action="activateEntry"]`;
        await client.waitForSelector(link, { visible: true });
        assert((await client.$eval(link, (el) => el.textContent.trim())) === title, "wrong journal directory title");
        await client.locator(link).click();
        const content = ".journal-entry-content .journal-page-content";
        await client.waitForSelector(content, { visible: true });
        const rule = await client.$eval(content, (el) => ({
          text: el.textContent.trim(),
          heading: el.parentElement.querySelector(".journal-page-header")?.textContent.trim()
        }));
        assert(rule.heading === heading && rule.text.startsWith(intro), `unexpected house rule: ${rule.heading}`);
        assert(!/\bpublic(?:ly)?\b|öffentlich/i.test(rule.text), "the journal offers a public death save");
        await client.evaluate(async (id) => {
          await game.journal.get(id).sheet.close();
          ui.sidebar.changeTab("chat", "primary");
        }, rules._id);
      }
    });

    await check("only the owner and selected GM see the counters on a player character's sheet", async () => {
      await Promise.all(
        clients.map((page) =>
          page.evaluate(async (id) => {
            await game.actors.get(id).sheet.render({ force: true });
          }, actorId)
        )
      );
      await assertSheetAudience(clients, actorId, [gm, player]);
      const alternate = await otherGM.evaluate(() => game.user.id);
      await setRecipient(gm, clients, alternate);
      await assertSheetAudience(clients, actorId, [otherGM, player]);
      await setRecipient(gm, clients, recipient);
      await assertSheetAudience(clients, actorId, [gm, player]);
    });

    await check("assigning a shared character hides its counters from the other owner", async () => {
      await gm.evaluate(
        async (id, user) => {
          await game.actors.get(id).update({ [`ownership.${user}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
          await game.users.get(user).update({ character: id });
        },
        actorId,
        observerId
      );
      await assertSheetAudience(clients, actorId, [gm, observer]);
      await gm.evaluate(
        async (id, user) => {
          await game.users.get(user).update({ character: null });
          await game.actors.get(id).update({ [`ownership.${user}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER });
        },
        actorId,
        observerId
      );
      await assertSheetAudience(clients, actorId, [gm, player]);
    });

    const button = await player.evaluate((id) => {
      const sheet = game.actors.get(id).sheet;
      if (!sheet.element.querySelector(".death-tray.open")) {
        sheet.element.querySelector('[data-action="toggleDeathTray"]').click();
      }
      return `#${CSS.escape(sheet.id)} [data-action="roll"][data-type="deathSave"]`;
    }, actorId);

    await check("the native dialog restricts player death saves to the chosen GM and their author", async () => {
      const id = await nextRoll(gm, actorId, () => rollWithDialog(player, button, "gm", true));
      await assertAudience(clients, id, recipient);
      await assertSheetAudience(clients, actorId, [gm, player]);
      await player.evaluate(async (id) => {
        await game.messages.get(id).update({ whisper: [], blind: false });
      }, id);
      await assertAudience(clients, id, recipient);
    });

    await check("skipping the dialog cannot give a death save or its outcome a different audience", async () => {
      await reset(player, actorId, 2);
      const id = await nextRoll(gm, actorId, () =>
        player.evaluate(
          async (actor, bystander) => {
            await game.actors
              .get(actor)
              .rollDeathSave({}, { configure: false }, { rollMode: "public", data: { whisper: [bystander] } });
          },
          actorId,
          observerId
        )
      );
      const outcome = await terminalOutcome(gm, actorId, id);
      await assertAudience(clients, id, recipient, outcome);
    });

    await check("ordinary player saves keep the normal roll mode", async () => {
      const id = await nextRoll(gm, actorId, () =>
        player.evaluate(async (actor) => {
          await game.actors.get(actor).rollSavingThrow({ ability: "con" }, { configure: false });
        }, actorId)
      );
      await assertAudience(clients, id);
    });

    await check("the HUD skull rolls private saves at zero HP and disappears after each terminal outcome", async () => {
      const hiddenKey = "actionHudHiddenCategories";
      const previous = await player.evaluate(
        (m, key) => ({
          character: game.user.character?.id ?? null,
          categories: game.settings.get(m, key),
          dice: game.settings.get("core", "diceConfiguration")
        }),
        MODULE_ID,
        hiddenKey
      );
      const body = `#my-action-hud [data-actor="Actor.${actorId}"]`;
      const bar = `${body} .hud-bar`;
      const strip = `${body} .hud-death-saves`;
      const skull = `${body} button[data-action="deathSave"]`;
      const displays = (value) =>
        gm.evaluate((m, on) => game.settings.set(m, "showDeathSaveCounters", on), MODULE_ID, value);
      const originalDisplay = await gm.evaluate((m) => game.settings.get(m, "showDeathSaveCounters"), MODULE_ID);
      const tokens = await createTokenScene(gm, actorId);
      const badge = `#my-token-death-saves-${tokens.dying}`;
      const heal = () =>
        player.evaluate((id) => game.actors.get(id).update({ "system.attributes.hp.value": 1 }), actorId);
      const categories = (value) =>
        player.evaluate((m, key, list) => game.settings.set(m, key, list), MODULE_ID, hiddenKey, value);
      try {
        await displays(false);
        await Promise.all(
          clients.map(async (page) => {
            await waitFor(page, (id) => game.scenes.has(id), tokens.scene);
            await page.evaluate(async (id) => {
              await game.scenes.get(id).view();
            }, tokens.scene);
            await waitFor(page, (id) => canvas.ready && canvas.tokens.get(id)?.mesh, tokens.dying);
          })
        );
        await gm.evaluate((id) => canvas.tokens.get(id).control(), tokens.other);
        await gm.evaluate((id, name) => game.users.getName(name).update({ character: id }), actorId, PLAYER_NAME);
        await player.evaluate((id) => game.actors.get(id).sheet.close({ animate: false }), actorId);
        await categories(previous.categories.filter((id) => id !== "deathSaves"));
        await heal();
        await player.evaluate((id) => game.actors.get(id).toggleStatusEffect("sleeping", { active: true }), actorId);
        await player.waitForSelector(bar, { visible: true });
        await player.waitForSelector(skull, { hidden: true });
        await player.evaluate((id) => game.actors.get(id).toggleStatusEffect("sleeping", { active: false }), actorId);
        await reset(player, actorId);
        await player.waitForSelector(`${skull} .fa-skull`, { visible: true });
        assert(
          !(await player.evaluate((id) => game.actors.get(id).statuses.has("unconscious"), actorId)),
          "fixture is already unconscious at zero HP"
        );
        assert(!(await player.$(strip)) && !(await gm.$(badge)), "disabled counters are visible");
        await displays(true);
        await assertMarks(player, `${strip} .my-death-save-marks`, 0, 0);
        await assertMarks(gm, badge, 0, 0);
        assert(
          await gm.evaluate(
            (selector, id) => {
              const token = canvas.tokens.get(id);
              const below = canvas.stage.worldTransform.apply({ x: token.center.x, y: token.bounds.bottom });
              const rect = document.querySelector(selector).getBoundingClientRect();
              const name = token.nameplate.getBounds();
              return (
                !token.controlled &&
                rect.top >= Math.max(name.bottom, below.y) - 1 &&
                Math.abs(rect.left + rect.width / 2 - below.x) < 2
              );
            },
            badge,
            tokens.dying
          ),
          "badge is not directly below the unselected token"
        );
        for (const page of [gm, player]) await page.evaluate((id) => canvas.tokens.get(id).control(), tokens.dying);
        await gm.waitForSelector(`${bar} [data-action="deathSave"]`, { visible: true });
        assert(!(await gm.$(strip)), "the GM saw the player's death save strip");
        await assertMarks(gm, badge, 0, 0);
        assert(
          (await player.$$(skull)).length === 1 && (await player.$(`${strip} [data-action="deathSave"]`)),
          "expected one skull in the strip"
        );
        await checkStackedRows(player, actorId);
        await player.evaluate(() => canvas.tokens.releaseAll());
        for (const page of [player, observer, otherGM]) assert(!(await page.$(badge)), "unexpected map counters");
        const alternate = await otherGM.evaluate(() => game.user.id);
        await setRecipient(gm, clients, alternate);
        await assertMarks(otherGM, badge, 0, 0);
        await gm.waitForSelector(badge, { hidden: true });
        await setRecipient(gm, clients, recipient);
        await otherGM.waitForSelector(badge, { hidden: true });

        await gm.evaluate(
          (id, user) => game.actors.get(id).update({ [`ownership.${user}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }),
          actorId,
          observerId
        );
        await waitFor(observer, (id) => game.actors.get(id).isOwner, actorId);
        await observer.evaluate((id) => canvas.tokens.get(id).control(), tokens.dying);
        await observer.waitForSelector(bar);
        assert(!(await observer.$(strip)) && !(await observer.$(skull)), "another owner saw private death saves");
        await gm.evaluate(
          (id, user) => game.actors.get(id).update({ [`ownership.${user}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }),
          actorId,
          observerId
        );

        for (const [face, success, failure] of [
          [14, 1, 0],
          [5, 1, 1]
        ]) {
          await fixedDie(player, face);
          const id = await nextRoll(gm, actorId, () => rollWithDialog(player, skull, "gm", true));
          await assertAudience(clients, id, recipient);
          await assertMarks(player, `${strip} .my-death-save-marks`, success, failure);
          await assertMarks(gm, badge, success, failure);
          await player.evaluate(async (id) => {
            await game.actors.get(id).sheet.render({ force: true });
          }, actorId);
          await assertSheetAudience(clients, actorId, [gm, player]);
          await player.evaluate((id) => game.actors.get(id).sheet.close({ animate: false }), actorId);
        }

        await setRecipient(gm, clients, "off");
        await assertMarks(otherGM, badge, 1, 1);
        await fixedDie(player, 14);
        const publicRoll = await nextRoll(gm, actorId, () => rollWithDialog(player, skull, "public", false));
        await assertAudience(clients, publicRoll);
        await assertMarks(player, `${strip} .my-death-save-marks`, 2, 1);
        await setRecipient(gm, clients, recipient);
        await displays(false);
        await gm.waitForSelector(badge, { hidden: true });
        await player.waitForSelector(`${bar} [data-action="deathSave"]`, { visible: true });
        assert(!(await player.$(strip)), "the disabled strip is still present");
        await displays(true);
        await assertMarks(gm, badge, 2, 1);
        await assertMarks(player, `${strip} .my-death-save-marks`, 2, 1);
        await heal();
        await player.waitForSelector(skull, { hidden: true });
        await player.waitForSelector(strip, { hidden: true });
        await gm.waitForSelector(badge, { hidden: true });
        await reset(player, actorId, 2);
        await player.waitForSelector(skull, { visible: true });
        await categories([...new Set([...previous.categories, "deathSaves"])]);
        await player.waitForSelector(skull, { hidden: true });
        await categories(previous.categories.filter((id) => id !== "deathSaves"));

        for (const [face, terminal] of [
          [14, "stable"],
          [5, "death"]
        ]) {
          await player.waitForSelector(skull, { visible: true });
          await fixedDie(player, face);
          const id = await nextRoll(gm, actorId, async () => {
            if (terminal === "stable") return rollWithDialog(player, skull, "gm", true);
            await player.keyboard.down("Shift");
            try {
              await player.locator(skull).setTimeout(10000).click();
            } finally {
              await player.keyboard.up("Shift");
            }
          });
          assert((await terminalOutcome(gm, actorId, id)) === terminal, `expected ${terminal}`);
          await player.waitForSelector(skull, { hidden: true });
          await player.waitForSelector(strip, { hidden: true });
          await gm.waitForSelector(badge, { hidden: true });
          await assertAudience(clients, id, recipient, terminal);
          if (terminal === "stable") {
            await heal();
            await reset(player, actorId, 2);
          }
        }
      } finally {
        await displays(originalDisplay);
        await Promise.all(clients.map((page) => page.evaluate(() => game.scenes.active?.view().then(() => true))));
        await gm.evaluate(async (id) => {
          await game.scenes.get(id).delete();
        }, tokens.scene);
        await player.evaluate(async (dice) => {
          await game.settings.set("core", "diceConfiguration", dice);
          delete CONFIG.Dice.fulfillment.methods.hudTest;
        }, previous.dice);
        await categories(previous.categories);
        await gm.evaluate(
          (name, id) => game.users.getName(name).update({ character: id }),
          PLAYER_NAME,
          previous.character
        );
        await player.evaluate((id) => game.actors.get(id).sheet.render({ force: true }), actorId);
      }
    });

    await check("GM-initiated death saves keep the normal roll mode", async () => {
      await reset(gm, actorId);
      const id = await nextRoll(gm, actorId, () =>
        gm.evaluate(async (actor) => {
          await game.actors.get(actor).rollDeathSave({}, { configure: false });
        }, actorId)
      );
      await assertAudience(clients, id);
    });

    await check("turning off the rule restores the normal death save dialog", async () => {
      await setRecipient(gm, clients, "off");
      await assertSheetAudience(clients, actorId, clients);
      await reset(player, actorId);
      const id = await nextRoll(gm, actorId, () => rollWithDialog(player, button, "public", false));
      await assertAudience(clients, id);
    });

    await check("turning the rule back on preserves the journal and both rollers' normal roll modes", async () => {
      await setRecipient(gm, clients, recipient);
      const original = before.find((entry) => entry._id === rules._id) ?? rules;
      const entries = await rulesJournals(gm);
      assert(
        entries.length === 1 && JSON.stringify(entries[0]) === JSON.stringify(original),
        "rules journal changed or duplicated"
      );
      for (const page of [gm, player]) {
        assert(
          await page.evaluate(() => game.settings.get("core", "messageMode") === "public"),
          "global roll mode changed"
        );
      }
    });
    if (!before.length) {
      await check("players see the GM's own house rule wording in both languages", async () => {
        const text = "<p>Würfelt erst auf mein Zeichen.</p>";
        await gm.evaluate(
          async (id, content) => {
            const entry = game.journal.get(id);
            await entry.update({ name: "Unsere Hausregeln" });
            await entry.pages.get("MyDeathSavePage1").update({ name: "Am Spieltisch", "text.content": content });
          },
          rules._id,
          text
        );
        for (const client of [player, observer]) {
          await waitFor(
            client,
            (id, content) => {
              const entry = game.journal.get(id);
              const page = entry.pages.get("MyDeathSavePage1");
              return (
                entry.name === "Unsere Hausregeln" && page.name === "Am Spieltisch" && page.text.content === content
              );
            },
            rules._id,
            text
          );
        }
      });
    }
  } finally {
    await Promise.allSettled(
      [...originalModes].map(([page, mode]) =>
        page.evaluate((value) => game.settings.set("core", "messageMode", value), mode)
      )
    );
    await gm.evaluate(
      async (m, key, recipient, journalId, originalIds, names) => {
        await game.settings.set(m, key, recipient);
        const actor = game.actors.getName(names.actor);
        if (actor) {
          const messages = game.messages
            .filter((message) => message.speaker.actor === actor.id)
            .map((message) => message.id);
          if (messages.length) await ChatMessage.deleteDocuments(messages);
          await actor.delete();
        }
        await game.users.getName(names.observer)?.delete();
        await game.users.getName(names.otherGM)?.delete();
        const created = game.journal.filter(
          (entry) => !originalIds.includes(entry.id) && (entry.id === journalId || entry.getFlag(m, key))
        );
        for (const entry of created) await entry.delete();
      },
      MODULE_ID,
      SETTING,
      setting.recipient,
      JOURNAL_ID,
      before.map((entry) => entry._id),
      names
    );
  }
});
