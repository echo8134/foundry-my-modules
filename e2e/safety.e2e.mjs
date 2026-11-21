import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const control = 'button[data-control="safety"]';
const windowId = "#my-safety-tools";
const overlay = "#my-safety-overlay";
const limits = `${windowId} details[data-sync="limits"]`;
const card = `${windowId} details[data-sync="card"]`;
const action = (name) => `${windowId} [data-action="${name}"]`;
const signalButton = (id) => `${action("signal")}[data-signal="${id}"]`;
const announcement = (id) => `.my-safety-announcement[data-signal="${id}"]`;
const settings = ["xCard", "linesVeils", "openDoor", "signals"];
const line = "E2E line";
const veil = "E2E veil";
const privateNote = "Private note <b>for the GM</b>".padEnd(200, "!");

async function openWindow(page) {
  await page.click(control);
  await page.waitForSelector(windowId, { visible: true });
}

async function add(page, kind, text) {
  await page.type(`#safety-add-${kind}`, text);
  await page.$eval(`[data-kind="${kind}"] [data-action="addEntry"]`, (button) => button.click());
}

await run(async () => {
  const gm = await joinGamemaster();
  const original = await gm.evaluate(
    (id, keys) => Object.fromEntries([...keys, "safetyBoundaries"].map((key) => [key, game.settings.get(id, key)])),
    MODULE_ID,
    settings
  );
  const observerName = `Safety observer ${Date.now()}`;
  const observerId = await gm.evaluate(
    async (name) => (await User.create({ name, role: CONST.USER_ROLES.PLAYER })).id,
    observerName
  );
  const createdMessages = [];
  let characterId;
  try {
    await gm.evaluate(
      async (id, keys) => {
        for (const key of keys) await game.settings.set(id, key, true);
        await game.settings.set(id, "safetyBoundaries", []);
      },
      MODULE_ID,
      settings
    );
    const player = await join(PLAYER_NAME);
    const observer = await join(observerName);
    const gmDevice = await gm.browser().createBrowserContext();
    await gmDevice.setCookie(...(await gm.browserContext().cookies()));
    const secondGM = await gmDevice.newPage();
    await secondGM.setViewport(gm.viewport());
    await secondGM.goto(gm.url(), { waitUntil: "domcontentloaded" });
    await secondGM.waitForFunction(() => globalThis.game?.ready && globalThis.canvas?.ready, { timeout: 180000 });
    const gmTabs = [gm, secondGM];
    const clients = [...gmTabs, player, observer];
    const playerId = await player.evaluate(() => game.user.id);
    const gmId = await gm.evaluate(() => game.user.id);
    assert(await secondGM.evaluate((id) => game.user.id === id && game.users.activeGM.isSelf, gmId), "wrong second GM");
    await check("the card control below Quests opens for everyone and preserves the canvas tool", async () => {
      for (const client of clients) {
        const before = await client.evaluate(() => [ui.controls.control.name, ui.controls.tool.name]);
        await openWindow(client);
        assert(
          await client.evaluate((prior) => {
            const buttons = [...document.querySelectorAll("#scene-controls-layers [data-control]")];
            const idx = buttons.findIndex((el) => el.dataset.control === "quests");
            return (
              idx >= 0 &&
              buttons[idx + 1]?.dataset.control === "safety" &&
              ui.controls.control.name === prior[0] &&
              ui.controls.tool.name === prior[1]
            );
          }, before),
          "wrong control position or changed selection"
        );
      }
    });
    await check("the four actions share a row and both detail sections reopen collapsed", async () => {
      const originalLanguage = await player.evaluate(async () => {
        const previous = game.i18n.lang;
        await game.i18n.setLanguage("de");
        await foundry.applications.instances.get("my-safety-tools").render({ force: true });
        return previous;
      });
      const correctRow = await player.evaluate(() => {
        const labels = ["Pause", "Vorspulen", "Zurückspulen", "Ich brauche eine Pause"];
        const buttons = [...document.querySelectorAll("#my-safety-tools .safety-signals button")];
        return (
          buttons.length === labels.length &&
          buttons.every(
            (button, i) =>
              button.checkVisibility() &&
              button.getBoundingClientRect().top === buttons[0].getBoundingClientRect().top &&
              button.textContent.includes(labels[i])
          ) &&
          buttons.at(-1).querySelector("small")?.textContent === "Mit deinem Namen im Chat posten"
        );
      });
      assert(correctRow, "wrong action row or missing named break hint");
      await player.waitForSelector(`${card}[open] #safety-note`, { hidden: true });
      await player.waitForSelector(`${limits}[open] #safety-add-line`, { hidden: true });
      await player.click(`${card} > summary`);
      await player.click(`${limits} > summary`);
      await player.waitForSelector(`${card}[open] #safety-note`, { visible: true });
      await player.waitForSelector(`${limits}[open] #safety-add-line`, { visible: true });
      await player.click(`${card} > summary`);
      await player.waitForSelector(`${card}[open] #safety-note`, { hidden: true });
      await player.waitForSelector(`${limits}[open] #safety-add-line`, { visible: true });
      await player.evaluate(() => foundry.applications.instances.get("my-safety-tools").close({ animate: false }));
      await player.evaluate((lang) => game.i18n.setLanguage(lang), originalLanguage);
      await openWindow(player);
      await player.waitForSelector(`${card}[open] #safety-note`, { hidden: true });
      await player.waitForSelector(`${limits}[open] #safety-add-line`, { hidden: true });
    });
    for (const page of clients) {
      await page.evaluate(() => {
        const play = game.audio.play.bind(game.audio);
        window.safetyChimes = 0;
        game.audio.play = (src, options) => {
          if (src === CONFIG.sounds.notification && options?.context === game.audio.interface) window.safetyChimes++;
          return play(src, options);
        };
      });
    }
    await observer.evaluate((m) => game.settings.set(m, "safetySignalSound", false), MODULE_ID);
    await check("two GM tabs relay one public X-card and keep its note until the GM dismisses it", async () => {
      characterId = await gm.evaluate(async (user) => {
        const actor = await Actor.create({
          type: "character",
          name: "Safety signal reader",
          ownership: { [user]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
        });
        return actor.id;
      }, observerId);
      await waitFor(observer, (id) => game.actors.has(id), characterId);
      await observer.evaluate(async (id) => {
        await foundry.applications.instances.get("my-safety-tools").close({ animate: false });
        await game.actors.get(id).sheet.render({ force: true });
      }, characterId);
      await observer.waitForSelector(windowId, { hidden: true });
      for (const client of [...gmTabs, observer]) {
        await client.evaluate((id) => {
          window.safetyTraffic = [];
          game.socket.on(`module.${id}`, (...args) => window.safetyTraffic.push(args));
        }, MODULE_ID);
      }
      const previous = await gm.evaluate(() => game.messages.map((m) => m.id));
      await player.click(`${card} > summary`);
      assert((await player.$eval("#safety-note", (input) => input.maxLength)) === 200, "missing note limit");
      await player.$eval(
        "#safety-note",
        (input, note) => {
          input.value = `${note}excess`;
        },
        privateNote
      );
      await player.click(`${card} > summary`);
      await player.$eval(action("sendCard"), (button) => {
        button.click();
        button.click();
      });
      await Promise.all(clients.map((p) => p.waitForSelector(overlay, { visible: true })));
      const noteSelector = `${overlay} #my-safety-private-note`;
      await Promise.all(gmTabs.map((tab) => tab.waitForSelector(noteSelector, { visible: true })));
      for (const p of [player, observer]) {
        assert(!(await p.$eval(overlay, (el) => el.textContent)).includes(privateNote), "player saw the GM note");
        assert(
          !(await p.evaluate(
            (note) => document.querySelector("#my-safety-tools")?.textContent.includes(note),
            privateNote
          )),
          "note in player window"
        );
      }
      await player.click(overlay);
      await player.waitForSelector(overlay, { hidden: true });
      await observer.waitForSelector(overlay, { hidden: true, timeout: 15000 });
      for (const tab of gmTabs) {
        assert(
          await tab.$eval(
            noteSelector,
            (el, note) => el.textContent.includes(note) && getComputedStyle(el).userSelect === "text",
            privateNote
          ),
          "GM note did not outlast the public overlay or was not selectable"
        );
        await tab.click(noteSelector);
        await tab.waitForSelector(noteSelector, { visible: true });
        await tab.click(`${overlay} button`);
        await tab.waitForSelector(overlay, { hidden: true });
        const history = await tab.$$eval("#my-safety-session-notes li", (items) =>
          items.map((el) => el.textContent.trim())
        );
        assert(
          history.length === 1 && history[0] === privateNote,
          "dismissed GM note missing or duplicated in history"
        );
      }
      const gmRequests = await Promise.all(
        gmTabs.map((tab) => tab.evaluate(() => window.safetyTraffic.filter(([data]) => data.action === "xCard")))
      );
      const requestId = gmRequests[0][0]?.[0].requestId;
      assert(
        requestId &&
          gmRequests.every(
            (requests) => requests.length === 2 && requests[0][0].requestId === requestId && requests[0][1] === playerId
          ),
        "GM tabs did not receive the same stamped request"
      );
      for (const p of clients) {
        await waitFor(
          p,
          (ids) =>
            game.messages.some((m) => !ids.includes(m.id) && m.alias === game.i18n.localize("MY_MODULES.Safety.Card")),
          previous
        );
        const cards = await p.evaluate(
          (ids) =>
            game.messages
              .filter((m) => !ids.includes(m.id) && m.alias === game.i18n.localize("MY_MODULES.Safety.Card"))
              .map((m) => m.toObject()),
          previous
        );
        assert(
          cards.length === 1 && cards[0]._id === requestId,
          `expected one chat card with the request ID, found ${cards.length}`
        );
        const [msg] = cards;
        assert(
          msg.author === gmId && !msg.speaker.actor && !msg.speaker.token && !msg.speaker.scene,
          "wrong author or non-neutral speaker"
        );
        const json = JSON.stringify(msg);
        assert(
          ![playerId, PLAYER_NAME, privateNote].some((s) => json.includes(s)),
          "sender or GM note in ChatMessage data"
        );
        assert(!msg.whisper.length && !msg.blind, "card was not public");
        if (p === gm) createdMessages.push(msg._id);
        await waitFor(
          p,
          (id) => {
            const row = document.querySelector(`[data-message-id="${id}"]`);
            return (
              row?.textContent.includes(game.i18n.localize("MY_MODULES.Safety.Prompt")) &&
              // biome-ignore lint/performance/useDomNodeTextContent: The check needs the visible chat header.
              row.querySelector(".message-sender")?.innerText.trim() === game.i18n.localize("MY_MODULES.Safety.Card")
            );
          },
          msg._id
        );
      }
      for (const page of clients) {
        const sounds = await page.evaluate(() => window.safetyChimes);
        assert(sounds === (page === observer ? 0 : 1), `unexpected X-card chime count: ${sounds}`);
      }
      const traffic = await observer.evaluate(() => window.safetyTraffic);
      assert(
        traffic.length === 1 && traffic[0][0].action === "showCard" && traffic[0][1] === gmId,
        "observer received traffic besides the GM announcement"
      );
      assert(
        !JSON.stringify(traffic).includes(privateNote) && !JSON.stringify(traffic).includes(playerId),
        "private request reached observer"
      );
    });
    await check("fast-forward and rewind each reach the muted sheet reader and both GM tabs once", async () => {
      for (const id of ["fastForward", "rewind"]) {
        const selector = signalButton(id);
        const symbol = await player.$eval(
          selector,
          (button, id) => {
            const label = game.i18n.localize(`MY_MODULES.Safety.signals.${id}.Label`);
            if (!button.textContent.includes(label)) throw new Error(`missing label: ${label}`);
            return button.querySelector("i")?.className;
          },
          id
        );
        assert(symbol, `missing symbol on the ${id} button`);
        await player.focus(selector);
        await player.keyboard.press("Enter");
        await Promise.all(
          clients.map(async (page) => {
            const row = announcement(id);
            await page.waitForSelector(row, { visible: true, timeout: 10000 });
            const renderedOnce = await page.$$eval(
              row,
              (rows, id, symbol) => {
                const message = game.i18n.localize(`MY_MODULES.Safety.signals.${id}.Message`);
                return (
                  rows.length === 1 &&
                  rows[0].querySelector("i")?.className === symbol &&
                  rows[0].textContent.trim() === message
                );
              },
              id,
              symbol
            );
            assert(renderedOnce, `expected exactly one public ${id} symbol and message`);
          })
        );
      }
      for (const page of clients) {
        const sounds = await page.evaluate(() => window.safetyChimes);
        assert(sounds === (page === observer ? 0 : 3), `unexpected chime count after three signals: ${sounds}`);
      }
      await observer.evaluate((id) => game.actors.get(id).sheet.close({ animate: false }), characterId);
      await openWindow(observer);
    });
    await check("two GM tabs store concurrent line and veil requests once each, including a retried add", async () => {
      await Promise.all(clients.map((p) => p.click(`${limits} > summary`)));
      await Promise.all([add(player, "line", line), add(observer, "veil", veil)]);
      await waitFor(gm, () => window.safetyTraffic.filter(([data]) => data.action === "add").length === 2);
      const request = await gm.evaluate(
        () => window.safetyTraffic.find(([data]) => data.action === "add" && data.kind === "line")[0]
      );
      await waitFor(gm, () => document.querySelectorAll("#my-safety-tools [data-entry]").length === 2);
      await player.evaluate(
        (channel, data) => {
          game.socket.emit(channel, data, { recipients: [game.users.activeGM.id] });
        },
        `module.${MODULE_ID}`,
        request
      );
      for (const tab of gmTabs) {
        await waitFor(
          tab,
          (id) => window.safetyTraffic.filter(([data]) => data.action === "add" && data.requestId === id).length === 2,
          request.requestId
        );
      }
      for (const p of clients) {
        await waitFor(p, () => document.querySelectorAll("#my-safety-tools [data-entry]").length === 2);
        const entries = await p.evaluate((id) => game.settings.get(id, "safetyBoundaries"), MODULE_ID);
        assert(
          entries.length === 2 &&
            entries.some((e) => e.id === request.requestId && e.kind === "line" && e.text === line) &&
            entries.some((e) => e.kind === "veil" && e.text === veil),
          "missing line or veil"
        );
        assert(
          entries.every((e) => Object.keys(e).sort().join(",") === "id,kind,text"),
          "unexpected stored contributor data"
        );
      }
      assert(
        !(await player.$(action("removeEntry"))) && !(await player.$(action("editEntry"))),
        "player has moderation buttons"
      );
    });
    await check("only a GM can edit or delete shared boundaries", async () => {
      await player.evaluate((m) => {
        const opts = { recipients: [game.users.activeGM.id] };
        const id = game.settings.get(m, "safetyBoundaries").find((e) => e.kind === "line").id;
        game.socket.emit(
          `module.${m}`,
          { action: "edit", id, requestId: foundry.utils.randomID(), text: "player edit" },
          opts
        );
        game.socket.emit(`module.${m}`, { action: "remove", id, requestId: foundry.utils.randomID() }, opts);
      }, MODULE_ID);
      // A subsequent add on the same connection confirms the GM has processed the preceding requests.
      await add(player, "veil", "Second veil");
      await waitFor(gm, () => document.querySelectorAll("#my-safety-tools [data-entry]").length === 3);
      const row = '[data-kind="line"] [data-entry]';
      assert((await gm.$eval(`${row} input`, (input) => input.value)) === line, "player changed the line");
      const revised = "Revised line".padEnd(200, ".");
      await gm.$eval(
        `${row} input`,
        (input, text) => {
          input.value = `${text}excess`;
        },
        revised
      );
      await gm.click(`${row} [data-action="editEntry"]`);
      await waitFor(
        observer,
        (selector, text) => document.querySelector(selector)?.textContent.trim() === text,
        row,
        revised
      );
      await gm.click(`${row} [data-action="removeEntry"]`);
      await Promise.all(clients.map((p) => p.waitForSelector(row, { hidden: true })));
    });
    await check("open door posts a public break message in the player's name", async () => {
      const previous = await gm.evaluate(() => game.messages.map((m) => m.id));
      await player.click(action("openDoor"));
      await waitFor(
        observer,
        (ids, user) => game.messages.some((m) => !ids.includes(m.id) && m.author.id === user),
        previous,
        playerId
      );
      const msg = await observer.evaluate((ids) => {
        const m = game.messages.find((m) => !ids.includes(m.id));
        return { alias: m.alias, public: !m.whisper.length && !m.blind, content: m.content, id: m.id };
      }, previous);
      createdMessages.push(msg.id);
      assert(
        msg.alias === PLAYER_NAME &&
          msg.public &&
          msg.content.includes(await observer.evaluate(() => game.i18n.localize("MY_MODULES.Safety.Break"))),
        "wrong name, audience, or break text"
      );
    });
    await check("the GM can disable each tool independently and hide the last control", async () => {
      for (const [key, selector] of [
        ["linesVeils", limits],
        ["xCard", action("sendCard")],
        ["openDoor", action("openDoor")]
      ]) {
        await gm.evaluate((id, k) => game.settings.set(id, k, false), MODULE_ID, key);
        await observer.waitForSelector(selector, { hidden: true });
        if (key !== "openDoor") await observer.waitForSelector(action("openDoor"), { visible: true });
      }
      await observer.waitForSelector(signalButton("fastForward"), { visible: true });
      const before = await player.evaluate(() => window.safetyChimes);
      await gm.click(signalButton("rewind"));
      await waitFor(player, (n) => window.safetyChimes === n + 1, before);
      await observer.waitForSelector(announcement("rewind"), { visible: true });
      await gm.evaluate((m) => game.settings.set(m, "signals", false), MODULE_ID);
      await observer.waitForSelector(control, { hidden: true });
      await observer.waitForSelector(windowId, { hidden: true });
    });
    await check("a player gets a visible warning when there is no active GM", async () => {
      await gm.evaluate((m) => game.settings.set(m, "signals", true), MODULE_ID);
      await player.waitForSelector(control, { visible: true });
      await openWindow(player);
      const url = gm.url();
      try {
        await Promise.all(gmTabs.map((tab) => tab.goto("about:blank")));
        await player.waitForFunction(() => !game.users.activeGM, { timeout: 30000 });
        await player.click(signalButton("fastForward"));
        await waitFor(player, () =>
          [...document.querySelectorAll("#notifications .notification")].some(
            (el) => el.checkVisibility() && el.textContent.includes(game.i18n.localize("MY_MODULES.Safety.NeedGM"))
          )
        );
      } finally {
        await gm.goto(url, { waitUntil: "domcontentloaded" });
        await gm.waitForFunction(() => globalThis.game?.ready === true, { timeout: 180000 });
      }
    });
  } finally {
    await gm.evaluate(
      async (m, saved, messages, observer, actor) => {
        for (const [key, value] of Object.entries(saved)) await game.settings.set(m, key, value);
        await ChatMessage.deleteDocuments(messages);
        await game.actors.get(actor)?.delete();
        await game.users.get(observer)?.delete();
      },
      MODULE_ID,
      original,
      createdMessages,
      observerId,
      characterId
    );
  }
});
