// Shared by the e2e tests: log in to a running Foundry world in separate browser contexts and report checks.
import puppeteer from "puppeteer-core";

export const MODULE_ID = "foundry-my-modules";
export const PLAYER_NAME = "My Modules Player";
const FOUNDRY_URL = (process.env.FOUNDRY_URL ?? "http://localhost:30000").replace(/\/+$/, "");
const TEST_WORLD = process.env.FOUNDRY_WORLD ?? "mcp-test";
const GM_NAME = process.env.FOUNDRY_USER ?? "Gamemaster";
const GM_PASSWORD = process.env.FOUNDRY_PASSWORD ?? "";
const CHROME_PATH = process.env.CHROME_PATH ?? "/usr/bin/chromium";

let failed = false;

export async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed = true;
    console.log(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export const waitFor = (page, fn, ...args) => page.waitForFunction(fn, { timeout: 10000 }, ...args);

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

export async function join(name, password = "") {
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

// Logs in the Gamemaster with the module enabled and the test player created, reloading once if it had to enable it.
export async function joinGamemaster() {
  let gm = await join(GM_NAME, GM_PASSWORD);
  await check("the module is enabled and the test player exists", async () => {
    const reload = await gm.evaluate(
      async (moduleId, playerName) => {
        if (!game.users.getName(playerName)) await User.create({ name: playerName, role: CONST.USER_ROLES.PLAYER });
        if (game.modules.get(moduleId)?.active) return false;
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
  return gm;
}

export async function run(body) {
  try {
    await body();
  } catch {
    failed = true;
  } finally {
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
}
