// Drives a running Foundry world with two browsers, a Gamemaster and a player, and checks the cursor toggles.
// The test writes a player user, a scene activation and user flags, so it runs only in a world kept for it.
import puppeteer from "puppeteer-core";

const FOUNDRY_URL = (process.env.FOUNDRY_URL ?? "http://localhost:30000").replace(/\/+$/, "");
const TEST_WORLD = process.env.FOUNDRY_WORLD ?? "mcp-test";
const GM_NAME = process.env.FOUNDRY_USER ?? "Gamemaster";
const GM_PASSWORD = process.env.FOUNDRY_PASSWORD ?? "";
const PLAYER_NAME = "My Modules Player";
const CHROME_PATH = process.env.CHROME_PATH ?? "/usr/bin/chromium";
const MODULE_ID = "foundry-my-modules";

let failed = false;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed = true;
    console.log(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const status = await fetch(`${FOUNDRY_URL}/api/status`).then((r) => r.json());
if (status.world !== TEST_WORLD) {
  console.log(`INCONCLUSIVE the active world is "${status.world}", not "${TEST_WORLD}"`);
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
});

async function join(name, password) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    if (!error.message.includes("could not be found to register")) console.error(`[${name}] ${error.message}`);
  });
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(`${FOUNDRY_URL}/join`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('select[name="userId"] option[value]:not([value=""])', { timeout: 30000 });
  const joined = await page.evaluate(
    async (name, password) => {
      const option = [...document.querySelectorAll('select[name="userId"] option')].find(
        (o) => o.textContent.trim() === name
      );
      if (!option) return { ok: false, body: `no user "${name}"` };
      const response = await fetch("/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "join", userId: option.value, password })
      });
      return { ok: response.ok, body: await response.text() };
    },
    name,
    password
  );
  assert(joined.ok, `join as ${name} failed: ${joined.body}`);
  await page.goto(`${FOUNDRY_URL}/game`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => globalThis.game?.ready === true && globalThis.canvas?.ready === true, {
    timeout: 180000
  });
  return page;
}

// Wiggles the mouse over the canvas until the other client has drawn the cursor and its visibility settles.
async function cursorVisibleTo(viewer, mover, moverId) {
  for (let i = 0; i < 6; i++) {
    await mover.mouse.move(600 + i * 20, 400 + i * 10);
    await new Promise((r) => setTimeout(r, 250));
  }
  return viewer.evaluate((id) => canvas.controls.getCursorForUser(id)?.visible ?? null, moverId);
}

const clickToggle = (page, userId, modifiers = {}) =>
  page.evaluate(
    (id, shift) => {
      const button = document.querySelector(`#players li.player[data-user-id="${id}"] .my-cursor-toggle`);
      if (!button) throw new Error(`no toggle in the row of ${id}`);
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: shift }));
    },
    userId,
    modifiers.shift === true
  );

const waitFor = (page, fn, ...args) => page.waitForFunction(fn, { timeout: 10000 }, ...args);

try {
  let gm = await join(GM_NAME, GM_PASSWORD);

  await check("the module is enabled, a player exists and a scene is active", async () => {
    const reload = await gm.evaluate(
      async (moduleId, playerName) => {
        if (!game.users.getName(playerName)) await User.create({ name: playerName, role: CONST.USER_ROLES.PLAYER });
        const scene = game.scenes.active ?? game.scenes.contents[0];
        if (!scene.active) await scene.activate();
        if (!scene.isView) await scene.view();
        if (game.modules.get(moduleId)?.active) {
          await game.user.unsetFlag(moduleId, "hideOwnCursor");
          return false;
        }
        const config = game.settings.get("core", "moduleConfiguration");
        await game.settings.set("core", "moduleConfiguration", { ...config, [moduleId]: true });
        return true;
      },
      MODULE_ID,
      PLAYER_NAME
    );
    if (reload) {
      await gm.browserContext().close();
      gm = await join(GM_NAME, GM_PASSWORD);
    }
    assert(await gm.evaluate((id) => game.modules.get(id)?.active, MODULE_ID), "module is not active after enabling");
  });

  const player = await join(PLAYER_NAME, "");
  const gmId = await gm.evaluate(() => game.user.id);
  const playerId = await player.evaluate(() => game.user.id);
  await player.evaluate((id) => game.settings.set(id, "hiddenCursors", []), MODULE_ID);

  await check("every row of the player list carries a toggle", async () => {
    const rows = await player.$$eval("#players li.player", (lis) =>
      lis.map((li) => li.querySelector(".my-cursor-toggle") !== null)
    );
    assert(rows.length >= 2 && rows.every(Boolean), `rows with toggle: ${JSON.stringify(rows)}`);
  });

  await check("the toggle is invisible until the row is hovered", async () => {
    const selector = `#players li.player[data-user-id="${gmId}"] .my-cursor-toggle`;
    const opacity = () => player.$eval(selector, (b) => Number(getComputedStyle(b).opacity));
    assert((await opacity()) === 0, `opacity without hover is ${await opacity()}`);
    // Chromium updates :hover only on mouse movement, and the list may re-render under a still mouse.
    const row = await player.$eval(`#players li.player[data-user-id="${gmId}"]`, (li) => {
      const r = li.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    for (let i = 0; i < 10 && (await opacity()) === 0; i++) {
      await player.mouse.move(row.x + (i % 2), row.y);
      await new Promise((r) => setTimeout(r, 200));
    }
    assert((await opacity()) > 0, "opacity stays 0 on hover");
    await player.mouse.move(700, 450);
  });

  await check("by default the player sees the GM cursor and the GM sees the player cursor", async () => {
    assert((await cursorVisibleTo(player, gm, gmId)) === true, "player does not see the GM cursor");
    assert((await cursorVisibleTo(gm, player, playerId)) === true, "GM does not see the player cursor");
  });

  await check("the GM hides their own cursor from everyone with the toggle on their row", async () => {
    await clickToggle(gm, gmId);
    await waitFor(player, (id, m) => game.users.get(id).getFlag(m, "hideOwnCursor") === true, gmId, MODULE_ID);
    assert((await cursorVisibleTo(player, gm, gmId)) === false, "player still sees the GM cursor");
    assert((await cursorVisibleTo(gm, player, playerId)) === true, "GM lost the player cursor");
  });

  await check("the GM shows their cursor again", async () => {
    await clickToggle(gm, gmId);
    await waitFor(player, (id, m) => game.users.get(id).getFlag(m, "hideOwnCursor") === false, gmId, MODULE_ID);
    assert((await cursorVisibleTo(player, gm, gmId)) === true, "player does not see the GM cursor again");
  });

  await check("the player hides the GM cursor only for themselves", async () => {
    await clickToggle(player, gmId);
    await waitFor(player, (m, id) => game.settings.get(m, "hiddenCursors").includes(id), MODULE_ID, gmId);
    assert((await cursorVisibleTo(player, gm, gmId)) === false, "player still sees the GM cursor");
    const toggleOff = await player.$eval(`#players li.player[data-user-id="${gmId}"] .my-cursor-toggle`, (b) =>
      b.classList.contains("off")
    );
    assert(toggleOff, "the GM row does not show the hidden state");
    assert((await cursorVisibleTo(gm, player, playerId)) === true, "GM lost the player cursor");
  });

  await check("shift-click on a hidden row shows every cursor again", async () => {
    await clickToggle(player, gmId, { shift: true });
    await waitFor(player, (m) => game.settings.get(m, "hiddenCursors").length === 0, MODULE_ID);
    assert((await cursorVisibleTo(player, gm, gmId)) === true, "player does not see the GM cursor again");
  });

  await check("a ping still shows while the GM cursor is hidden", async () => {
    await clickToggle(gm, gmId);
    await waitFor(player, (id, m) => game.users.get(id).getFlag(m, "hideOwnCursor") === true, gmId, MODULE_ID);
    await player.evaluate(() => {
      globalThis.__pings = 0;
      const handlePing = canvas.controls.handlePing.bind(canvas.controls);
      canvas.controls.handlePing = (...args) => {
        globalThis.__pings++;
        return handlePing(...args);
      };
    });
    await gm.evaluate(() => canvas.ping({ x: canvas.dimensions.width / 2, y: canvas.dimensions.height / 2 }));
    await waitFor(player, () => globalThis.__pings > 0);
    await clickToggle(gm, gmId);
  });
} catch {
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
