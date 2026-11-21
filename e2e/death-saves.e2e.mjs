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

    await check("the unconscious character can roll a private death save from the skull tab", async () => {
      const previous = await player.evaluate(() => game.user.character?.id ?? null);
      try {
        await gm.evaluate((id, name) => game.users.getName(name).update({ character: id }), actorId, PLAYER_NAME);
        await player.evaluate(async (id) => {
          const actor = game.actors.get(id);
          await actor.sheet.close({ animate: false });
          await actor.update({ "system.attributes.hp.value": 1 });
          await actor.toggleStatusEffect("unconscious", { active: false });
        }, actorId);
        const bar = `#my-action-hud [data-actor="Actor.${actorId}"]`;
        const tab = `${bar} [data-group="deathSaves"]`;
        await player.waitForSelector(bar, { visible: true });
        assert(!(await player.$(tab)), "an awake character has a death saves tab");
        await reset(player, actorId, 2);
        await player.evaluate((id) => game.actors.get(id).toggleStatusEffect("unconscious", { active: true }), actorId);
        await player.locator(tab).setTimeout(10000).click();
        const id = await nextRoll(gm, actorId, () =>
          rollWithDialog(player, `${bar} [data-action="deathSave"]`, "gm", true)
        );
        const outcome = await terminalOutcome(gm, actorId, id);
        await assertAudience(clients, id, recipient, outcome);
        await player.evaluate(
          (id) => game.actors.get(id).toggleStatusEffect("unconscious", { active: false }),
          actorId
        );
        await player.waitForSelector(tab, { hidden: true });
        assert(
          !(await player.$(`${bar} [data-action="deathSave"]`)),
          "the awake character can still roll from the HUD"
        );
      } finally {
        await gm.evaluate((name, id) => game.users.getName(name).update({ character: id }), PLAYER_NAME, previous);
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
