import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const control = 'button[data-control="safety"]';
const windowId = "#my-safety-tools";
const overlay = "#my-safety-overlay";
const limitsTab = `${windowId} [data-action="tab"][data-tab="limits"]`;
const action = (name) => `${windowId} [data-action="${name}"]`;
const settings = ["xCard", "linesVeils", "openDoor"];
const line = "E2E line";
const veil = "E2E veil";
const privateNote = "Private note <b>for the GM</b>";

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
    const secondGM = await gm.browserContext().newPage();
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
    await check("two GM tabs relay one public X-card and keep its note until the GM dismisses it", async () => {
      for (const client of [...gmTabs, observer]) {
        await client.evaluate((id) => {
          window.safetyTraffic = [];
          game.socket.on(`module.${id}`, (...args) => window.safetyTraffic.push(args));
        }, MODULE_ID);
      }
      const previous = await gm.evaluate(() => game.messages.map((m) => m.id));
      await player.type("#safety-note", privateNote);
      await player.click(action("sendCard"));
      await Promise.all(clients.map((p) => p.waitForSelector(overlay, { visible: true })));
      const noteSelector = `${overlay} #my-safety-private-note`;
      const noteTabs = [];
      for (const tab of gmTabs) {
        if (await tab.$(noteSelector)) noteTabs.push(tab);
      }
      assert(noteTabs.length > 0, "neither GM tab received the private note");
      for (const p of [player, observer]) {
        assert(!(await p.$eval(overlay, (el) => el.textContent)).includes(privateNote), "player saw the GM note");
        assert(!(await p.$eval(windowId, (el) => el.textContent)).includes(privateNote), "note in player window");
      }
      await player.click(overlay);
      await player.waitForSelector(overlay, { hidden: true });
      await observer.waitForSelector(overlay, { hidden: true, timeout: 15000 });
      for (const tab of noteTabs) {
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
            (requests) => requests.length === 1 && requests[0][0].requestId === requestId && requests[0][1] === playerId
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
    await check("two GM tabs store concurrent line and veil requests once each, including a retried add", async () => {
      await Promise.all(clients.map((p) => p.click(limitsTab)));
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
        game.socket.emit(`module.${m}`, { action: "edit", id, text: "player edit" }, opts);
        game.socket.emit(`module.${m}`, { action: "remove", id }, opts);
      }, MODULE_ID);
      // A subsequent add on the same connection confirms the GM has processed the preceding requests.
      await add(player, "veil", "Second veil");
      await waitFor(gm, () => document.querySelectorAll("#my-safety-tools [data-entry]").length === 3);
      const row = '[data-kind="line"] [data-entry]';
      assert((await gm.$eval(`${row} input`, (input) => input.value)) === line, "player changed the line");
      await gm.$eval(`${row} input`, (input) => {
        input.value = "Revised line";
      });
      await gm.click(`${row} [data-action="editEntry"]`);
      await waitFor(
        observer,
        (selector) => document.querySelector(selector)?.textContent.trim() === "Revised line",
        row
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
        ["linesVeils", ".safety-limits"],
        ["xCard", action("sendCard")],
        ["openDoor", control]
      ]) {
        await gm.evaluate((id, k) => game.settings.set(id, k, false), MODULE_ID, key);
        await observer.waitForSelector(selector, { hidden: true });
        if (key !== "openDoor") await observer.waitForSelector(action("openDoor"), { visible: true });
      }
      await observer.waitForSelector(windowId, { hidden: true });
    });
  } finally {
    await gm.evaluate(
      async (m, saved, messages, observer) => {
        for (const [key, value] of Object.entries(saved)) await game.settings.set(m, key, value);
        await ChatMessage.deleteDocuments(messages);
        await game.users.get(observer)?.delete();
      },
      MODULE_ID,
      original,
      createdMessages,
      observerId
    );
  }
});
