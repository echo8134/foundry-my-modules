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

async function rollFromSheet(player, button, mode, locked) {
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
          const notice = game.i18n.format("CHAT.PrivateRollContent", { user: message.author.name });
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

await run(async () => {
  const gm = await joinGamemaster();
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
          ownership: { [game.users.getName(playerName).id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
        });
        return actor.id;
      },
      PLAYER_NAME,
      names
    );
    const player = await join(PLAYER_NAME);
    const observer = await join(names.observer);
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
      const choices = await gm.$eval(select, (el) => Array.from(el.options, (option) => option.value));
      assert(
        choices.includes("off") && choices.includes(recipient) && !choices.includes(observerId),
        "expected Off and named GM choices"
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
      await waitFor(observer, (id) => game.journal.get(id)?.testUserPermission(game.user, "OBSERVER"), rules._id);
      const [title, pageTitle] = await gm.evaluate(() =>
        game.i18n.lang === "de"
          ? ["Homebrew Regeln", "Verdeckte Todesrettungswürfe"]
          : ["House rules", "Private death saves"]
      );
      assert(
        rules.name === title && rules.pages.some((page) => page.name === pageTitle),
        "missing localized house rule"
      );
      await observer.evaluate(() => ui.sidebar.changeTab("journal", "primary"));
      await observer
        .locator(`#journal [data-entry-id="${rules._id}"] [data-action="activateEntry"]`)
        .setTimeout(10000)
        .click();
      const content = ".journal-entry-content .journal-page-content";
      await observer.waitForSelector(content, { visible: true, timeout: 10000 });
      const rule = await observer.$eval(content, (element) => element.textContent.trim());
      assert(rule && !/\bpublic(?:ly)?\b|öffentlich/i.test(rule), "the journal offers a public death save");
      await observer.evaluate(async (id) => {
        await game.journal.get(id).sheet.close();
        ui.sidebar.changeTab("chat", "primary");
      }, rules._id);
    });

    const button = await player.evaluate(async (id) => {
      const sheet = game.actors.get(id).sheet;
      await sheet.render({ force: true });
      if (!sheet.element.querySelector(".death-tray.open")) {
        sheet.element.querySelector('[data-action="toggleDeathTray"]').click();
      }
      return `#${CSS.escape(sheet.id)} [data-action="roll"][data-type="deathSave"]`;
    }, actorId);

    await check("the native dialog restricts player death saves to the chosen GM and their author", async () => {
      const id = await nextRoll(gm, actorId, () => rollFromSheet(player, button, "gm", true));
      await assertAudience(clients, id, recipient);
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
      await reset(player, actorId);
      const id = await nextRoll(gm, actorId, () => rollFromSheet(player, button, "public", false));
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
