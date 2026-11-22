import { assert, check, join, joinGamemaster, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const tray = "#chat-message > .my-dice-tray";
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

async function checkBar(page, parent) {
  const selector = `${parent} > ${tray}`;
  await page.waitForSelector(selector, { visible: true });
  const { bar, field, controls, mode, die, nativeButton } = await page.$eval(selector, (element) => {
    const rect = (el) => el.getBoundingClientRect().toJSON();
    return {
      bar: rect(element),
      field: rect(element.parentElement.querySelector(".editor-container")),
      controls: Array.from(element.querySelectorAll(":scope > button, :scope > input, [data-mode]"), rect),
      mode: rect(element.querySelector("[data-mode]")),
      die: rect(element.querySelector("[data-faces]")),
      nativeButton: rect(document.querySelector("#message-modes button"))
    };
  });
  assert(Math.abs(field.bottom - bar.top) <= 1, "gap between the editor and dice bar");
  assert(Math.abs(field.left - bar.left) <= 1 && Math.abs(field.right - bar.right) <= 1, "bar edges are misaligned");
  assert(bar.height <= nativeButton.height + 1, "dice bar is taller than a native chat button");
  assert(mode.height < die.height, "ADV/DIS should be shorter than the dice controls");
  const center = (bar.top + bar.bottom) / 2;
  for (const control of controls) {
    assert(control.top < center && control.bottom > center, "control is outside the row");
    assert(control.left >= bar.left - 1 && control.right <= bar.right + 1, "control overflows the dice bar");
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
    await check("the sidebar dice bar sits flush against the editor in a single row", () =>
      checkBar(player, ".chat-form")
    );
    await check("toggling the sidebar keeps the chat field between its open and closed positions", async () => {
      const { open, closed, positions } = await player.evaluate(async () => {
        const field = document.getElementById("chat-message");
        const toggle = document.querySelector('#sidebar-tabs [data-action="toggleState"]');
        const left = () => field.getBoundingClientRect().left;
        const frame = () => new Promise(requestAnimationFrame);
        async function settle() {
          await frame();
          const animations = document.getElementById("ui-right").getAnimations({ subtree: true });
          await Promise.allSettled(
            animations.filter((a) => a.effect.getTiming().iterations !== Infinity).map((a) => a.finished)
          );
        }
        await settle();
        const open = left();
        toggle.click();
        const positions = [left()];
        await settle();
        const closed = left();
        for (let i = 0; i < 3; i++) {
          toggle.click();
          positions.push(left());
          await frame();
          positions.push(left());
        }
        await settle();
        ui.sidebar.changeTab("actors", "primary");
        toggle.click();
        await settle();
        document.querySelector('#sidebar-tabs [data-tab="chat"]').click();
        positions.push(left());
        await frame();
        positions.push(left());
        await settle();
        return { open, closed, positions };
      });
      const min = Math.min(open, closed) - 1;
      const max = Math.max(open, closed) + 1;
      assert(
        positions.every((x) => x >= min && x <= max),
        `chat left the range ${min}–${max}: ${positions}`
      );
      await player.waitForSelector(`#sidebar-content.expanded #chat.active ${tray}`, { visible: true });
    });
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
      await checkBar(player, "#chat-notifications");
      const fits = await player.$eval(tray, (element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
      });
      assert(fits, "notifications tray is outside the viewport");
      await player.click(`${tray} .my-dice-modifier`);
      assert(
        await player.$eval("#chat-message .menu-container", (menu) => !menu.getClientRects().length),
        "using the dice bar opened the text formatting controls"
      );
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

    await check("the chat popout keeps the attached bar and the current roll draft", async () => {
      await player.evaluate(() => {
        ui.chat.renderPopout();
      });
      await checkBar(player, "#chat-popout .chat-form");
      await waitForDraft("/r 2d4");
      await player.click(die(4));
      await waitForDraft("/r 3d4");
      await player.evaluate(() => ui.chat.popout.close({ animate: false }));
      await checkBar(player, "#sidebar-content .chat-form");
      await waitForDraft("/r 3d4");
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
