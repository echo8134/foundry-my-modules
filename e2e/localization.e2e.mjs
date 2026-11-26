import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run } from "./harness.mjs";

await run(async () => {
  const gm = await joinGamemaster("de");
  for (const [language, name, die, advantage, disadvantage] of [
    ["de", "Würfelleiste", "W20", "VT", "NT"],
    ["en", "Dice tray", "d20", "ADV", "DIS"]
  ]) {
    await check(`the ${language} player sees local dice labels and a working roll formula`, async () => {
      const player = await join(PLAYER_NAME, "", language);
      try {
        await player.evaluate(async () => {
          await game.user.sheet.close({ animate: false });
          ui.sidebar.expand();
          ui.sidebar.changeTab("chat", "primary");
        });
        const tray = ".my-dice-tray";
        await player.waitForSelector(tray, { visible: true });
        const labels = await player.$eval(tray, (el) => ({
          name: el.getAttribute("aria-label"),
          die: el.querySelector("[data-faces='20'] span").textContent,
          tooltip: el.querySelector("[data-faces='20']").title,
          modes: Array.from(el.querySelectorAll("[data-mode]"), (mode) => mode.textContent)
        }));
        assert(
          labels.name === name && labels.die === die && labels.tooltip.startsWith(`${die}:`),
          JSON.stringify(labels)
        );
        assert(labels.modes.join("/") === `${advantage}/${disadvantage}`, JSON.stringify(labels));
        await player.locator(`${tray} [data-faces='20']`).click();
        assert((await player.$eval("#chat-message .ProseMirror", (el) => el.textContent)) === "/r 1d20", "roll syntax");
      } finally {
        await player.browserContext().close();
      }
    });
  }

  await check("German Foundry displays English module settings, choices and HUD category labels", async () => {
    assert((await gm.evaluate(() => game.i18n.lang)) === "de", "GM locale");
    await gm.evaluate(() => game.settings.sheet.render({ force: true }));
    await gm.click(`#settings-config nav [data-tab="${MODULE_ID}"]`);
    const tab = `#settings-config .tab[data-tab="${MODULE_ID}"]`;
    await gm.waitForSelector(tab, { visible: true });
    const text = await gm.$eval(tab, (el) => el.textContent);
    for (const expected of [
      "Show action HUD",
      "Show active effects above the Action HUD",
      "Show the action HUD for this client.",
      "Visible action categories",
      "Arrows (◀ Burning ▶)",
      "Quest journal folder",
      "Safety alert sound",
      "Soundboard playlist name",
      "Format of random token names",
      "Choose the GM account that receives death saves rolled by players."
    ]) {
      assert(text.includes(expected), `Missing English setting: ${expected}`);
    }
    await gm.click(`${tab} [data-key="${MODULE_ID}.actionHudCategories"]`);
    const menu = "#my-action-hud-categories";
    await gm.waitForSelector(menu, { visible: true });
    const labels = await gm.$$eval(`${menu} .form-group label`, (items) => items.map((el) => el.textContent.trim()));
    assert(
      labels.join("/") === "Attacks/Spells/Features/Items/Checks/Saves/Conditions/Rests/Death Saves",
      labels.join("/")
    );
    assert((await gm.$eval(`${menu} [type=submit]`, (el) => el.textContent.trim())) === "Save Changes", "save button");
  });
});
