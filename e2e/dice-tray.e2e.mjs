import { assert, check, join, joinGamemaster, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const tray = "#chat-message + .my-dice-tray";
const editor = "#chat-message .ProseMirror";
const die = (faces) => `${tray} [data-faces="${faces}"]`;

async function typeDraft(page, value) {
  await page.click(editor);
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  if (value) await page.keyboard.type(value);
}

async function clickWith(page, key, selector) {
  await page.keyboard.down(key);
  try {
    await page.click(selector);
  } finally {
    await page.keyboard.up(key);
  }
}

await run(async () => {
  const gm = await joinGamemaster();
  const player = await join(PLAYER_NAME);
  const created = [];
  await player.evaluate(async () => {
    await game.user.sheet.close({ animate: false });
    ui.sidebar.expand();
    ui.sidebar.changeTab("chat", "primary");
  });

  const waitForDraft = (value) =>
    waitFor(player, (selector, expected) => document.querySelector(selector)?.textContent === expected, editor, value);
  const checkRoll = async (click, expected) => {
    const ids = await player.evaluate(() => Array.from(game.messages.keys()));
    await click();
    const handle = await player.waitForFunction(
      (ids, expected) =>
        game.messages.find(
          (message) =>
            !ids.includes(message.id) &&
            message.author?.id === game.user.id &&
            message.rolls[0]?.formula.replaceAll(/\s/g, "") === expected
        )?.id,
      { timeout: 10000 },
      ids,
      expected
    );
    created.push(await handle.jsonValue());
    await handle.dispose();
  };

  try {
    await check("clicking dice builds an editable roll and updates its counters", async () => {
      await player.waitForSelector(tray, { visible: true });
      for (const faces of [6, 6, 6, 8]) await player.locator(die(faces)).click();
      await waitForDraft("/r 3d6+1d8");
      assert(await player.$eval(`${die(6)} b`, (b) => !b.hidden && b.textContent === "3"), "wrong d6 count");
      assert(await player.$eval(`${die(8)} b`, (b) => !b.hidden && b.textContent === "1"), "wrong d8 count");
      await typeDraft(player, "");
      await waitFor(player, (selector) => document.querySelector(selector).hidden, `${die(6)} b`);
    });

    await check("choosing a quantity prepares four d12s; a quick d20 roll keeps this draft", async () => {
      await clickWith(player, "Shift", die(12));
      await player.keyboard.type("4");
      await player.keyboard.press("Enter");
      await waitForDraft("/r 4d12");
      await checkRoll(() => clickWith(player, "Control", die(20)), "1d20");
      await waitForDraft("/r 4d12");
      await checkRoll(() => player.click(`${tray} .my-dice-roll`), "4d12");
      await waitForDraft("");
    });

    await check("the tray rolls the edited self roll with its modifier and selected d20 mode", async () => {
      await typeDraft(player, "/sr 1d20+1");
      await player.click(`${tray} [data-mode=kl]`);
      await player.click(`${tray} [data-mode=kh]`);
      assert(
        await player.$eval(`${tray} [data-mode=kl]`, (el) => el.getAttribute("aria-pressed") === "false"),
        "both modes selected"
      );
      await player.click(`${tray} .my-dice-modifier`, { clickCount: 3 });
      await player.keyboard.type("2");
      await checkRoll(() => player.click(`${tray} .my-dice-roll`), "2d20kh+1+2");
      assert(
        await player.evaluate((id) => game.messages.get(id).whisper.includes(game.user.id), created.at(-1)),
        "lost self-roll privacy"
      );
      await waitForDraft("");
    });

    await check("the same tray works below the editor in notifications and back in the sidebar", async () => {
      await player.evaluate(() => ui.sidebar.collapse());
      await player.waitForSelector(`#chat-notifications > ${tray}`, { visible: true });
      const fits = await player.$eval(tray, (element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
      });
      assert(fits, "notifications tray is outside the viewport");
      await player.click(die(4));
      await waitForDraft("/r 1d4");
      await player.evaluate(() => {
        ui.sidebar.expand();
        ui.sidebar.changeTab("chat", "primary");
      });
      await player.waitForSelector(`.chat-form > ${tray}`, { visible: true });
      await player.click(die(4));
      await waitForDraft("/r 2d4");
      assert(await player.$$eval(".my-dice-tray", (elements) => elements.length === 1), "duplicate dice trays");
    });

    await check("dice added to an edited keep-highest roll count separately from dice inside other terms", async () => {
      await typeDraft(player, "/r 2d6kh1+(1d8+1)*2");
      await player.click(die(8));
      await player.click(die(8));
      await waitForDraft("/r 2d6kh1+(1d8+1)*2+2d8");
      assert(await player.$eval(`${die(8)} b`, (b) => !b.hidden && b.textContent === "2"), "wrong added d8 count");
    });

    await check("ordinary chat text survives a die click", async () => {
      await typeDraft(player, "Keep this draft");
      await player.click(die(8));
      await waitForDraft("Keep this draft");
      assert(await player.$eval(`${tray} .my-dice-roll`, (el) => el.disabled), "plain chat can be sent as a roll");
    });
  } finally {
    await gm.evaluate(async (ids) => {
      if (ids.length) await ChatMessage.deleteDocuments(ids);
    }, created);
  }
});
