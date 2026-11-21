import { mkdir } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const LOG = ".my-quest-log";
const QUESTS_CONTROL = "#scene-controls-layers button[data-control=quests]";
const NAME = "Das Fieberkraut";
const PUBLIC = "Finde das Fieberkraut";
const SECRET = "Befrage die Spionin";
const DESCRIPTION = "Carolyn braucht Hilfe.";
const NOTES = "Das Versteck liegt unter der Mühle.";

async function pressButton(page, selector) {
  await page.locator(selector).click();
}

const click = (page, selector) => page.$eval(selector, (button) => button.click());

const change = (page, selector, value) =>
  page.$eval(
    selector,
    (control, value) => {
      control.focus();
      control.value = value;
      if (control.matches("select")) control.dispatchEvent(new Event("change", { bubbles: true }));
      control.blur();
    },
    value
  );

async function shortcut(page, modifier) {
  await page.bringToFront();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.down("Control");
  await page.keyboard.down(modifier);
  try {
    await page.keyboard.press("KeyQ");
  } finally {
    await page.keyboard.up(modifier);
    await page.keyboard.up("Control");
  }
}

async function screenshot(page, name) {
  const directory = process.env.QUEST_SHOTS_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: joinPath(directory, name) });
}

async function checkTracker(gm, player, questId, sheet, visibleId, hiddenId) {
  const tracker = "#my-quest-tracker";
  const tracked = `${tracker} [data-quest-id="${questId}"]`;
  const toggle = `${tracked} [data-action=toggleObjectives]`;
  const goal = `${tracked} [data-objective-id="${visibleId}"]`;
  await click(player, `${LOG} [data-action=toggleTracker]`);
  await player.waitForSelector(goal, { visible: true });
  assert((await player.$eval(tracked, (node) => node.textContent)).includes(NAME), "active quest missing");
  assert((await player.$eval(goal, (node) => node.textContent)).includes(PUBLIC), "open objective missing");
  assert(!(await player.$(`${tracked} [data-objective-id="${hiddenId}"]`)), "hidden objective in tracker");
  await player.mouse.move(12, 740);
  await screenshot(player, "tracker.png");

  await click(player, toggle);
  await player.waitForSelector(`${toggle}[aria-expanded=false]`);
  await player.bringToFront();
  const header = `${tracker} .window-header`;
  const before = await (await player.$(header)).boundingBox();
  const grip = { x: before.x + 45, y: before.y + before.height / 2 };
  await player.mouse.move(grip.x, grip.y);
  await player.mouse.down();
  await player.mouse.move(grip.x - 80, grip.y + 96, { steps: 12 });
  await player.mouse.up();
  const moved = await (await player.$(header)).boundingBox();
  assert(moved.x < before.x - 20 && moved.y > before.y + 20, "tracker header did not move");

  await shortcut(player, "Alt");
  await player.waitForSelector(tracker, { hidden: true });
  await shortcut(player, "Alt");
  await player.waitForSelector(`${toggle}[aria-expanded=false]`, { visible: true });
  await player.waitForSelector(goal, { hidden: true });
  const reopened = await (await player.$(header)).boundingBox();
  assert(Math.abs(reopened.x - moved.x) <= 1 && Math.abs(reopened.y - moved.y) <= 1, "tracker lost its position");
  await click(player, toggle);
  await player.waitForSelector(goal, { visible: true });

  await change(gm, `${sheet} [name=status]`, "completed");
  await player.waitForSelector(tracked, { hidden: true });
  await change(gm, `${sheet} [name=status]`, "active");
  await player.waitForSelector(goal, { visible: true });
  await shortcut(player, "Alt");
  await player.waitForSelector(tracker, { hidden: true });
}

async function checkPersonalQuest(gm, player, questId, sheet, row) {
  const guest = await gm.evaluate(async () => {
    const user = await User.create({
      name: `Quest witness ${foundry.utils.randomID(6)}`,
      role: CONST.USER_ROLES.PLAYER
    });
    return { id: user.id, name: user.name };
  });
  let other;
  try {
    await gm.waitForSelector(`${sheet} [name=personal][value="${guest.id}"]`);
    other = await join(guest.name);
    await click(other, QUESTS_CONTROL);
    await other.waitForSelector(row, { visible: true });
    await click(other, `${row} [data-action=openQuest]`);
    await other.waitForSelector(sheet, { visible: true });
    const playerId = await player.evaluate(() => game.user.id);
    const recipient = `${sheet} [name=personal][value="${playerId}"]`;
    await click(gm, recipient);
    await other.waitForSelector(row, { hidden: true });
    await other.waitForSelector(sheet, { hidden: true });
    assert(
      await other.evaluate((id) => !game.journal.get(id)?.testUserPermission(game.user, "OBSERVER"), questId),
      "excluded player still has Observer permission"
    );
    await waitFor(
      player,
      (id) => game.journal.get(id)?.ownership[game.user.id] === CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
      questId
    );
    await player.waitForSelector(row, { visible: true });
    if (await player.$(sheet)) await click(player, `${sheet} [data-action=close]`);
    await player.waitForSelector(sheet, { hidden: true });
    await click(gm, `${sheet} [data-action=showToPlayers]`);
    await player.waitForSelector(sheet, { visible: true });
    const revealed = await player.$eval(sheet, (app) => app.textContent);
    assert(revealed.includes(PUBLIC) && !revealed.includes(SECRET) && !revealed.includes(NOTES), "wrong quest view");
    assert(!(await player.$(`${sheet} [data-action=showToPlayers]`)), "player has a broadcast button");
    assert(!(await other.$(sheet)), "personal quest opened for the excluded player");
    await click(gm, recipient);
    await other.waitForSelector(row, { visible: true });
  } finally {
    await other?.browserContext().close();
    await gm.evaluate((id) => game.users.get(id)?.delete(), guest.id);
  }
}

async function checkQuestLinks(gm, player, parentId) {
  const previous = await gm.evaluate(
    (m) => game.journal.find((entry) => entry.getFlag(m, "quest")?.primary)?.id,
    MODULE_ID
  );
  const childId = await gm.evaluate(async (m) => {
    const entry = await JournalEntry.create({
      name: "Liefere das Kraut aus den Bergen an die Apothekerin auf dem Alten Markt",
      flags: { [m]: { quest: { status: "active" } } }
    });
    return entry.id;
  }, MODULE_ID);
  const parent = `#my-quest-sheet-${parentId}`;
  const child = `#my-quest-sheet-${childId}`;
  try {
    await gm.evaluate((m, id) => game.modules.get(m).api.quests.openQuest(`JournalEntry.${id}`), MODULE_ID, childId);
    await change(gm, `${child} [name=parent]`, `JournalEntry.${parentId}`);
    const link = `${parent} [data-action=openSubquest][data-quest-id="${childId}"]`;
    await player.waitForSelector(link);
    await player.waitForSelector(`${LOG} .tab.active [data-quest-id="${childId}"][data-depth="1"]`);
    await click(player, link);
    await player.waitForSelector(child, { visible: true });
    await click(player, `${child} [data-action=close]`);
    await player.waitForSelector(child, { hidden: true });
    await click(gm, `${parent} [name=primary]`);
    await waitFor(player, (m, id) => game.journal.get(id)?.getFlag(m, "quest").primary, MODULE_ID, parentId);
    await click(gm, `${child} [name=primary]`);
    await waitFor(
      player,
      (m, id, old) =>
        game.journal.get(id)?.getFlag(m, "quest").primary && !game.journal.get(old)?.getFlag(m, "quest").primary,
      MODULE_ID,
      childId,
      parentId
    );
    await shortcut(player, "Shift");
    await player.waitForSelector(`${child} .quest-marks .fa-star`, { visible: true });
    const oneRow = await player.$eval(`${child} .quest-heading`, (heading) => {
      const title = heading.querySelector(".quest-title").getBoundingClientRect();
      const marks = heading.querySelector(".quest-marks").getBoundingClientRect();
      return (
        Math.abs(title.top - marks.top) < 2 &&
        title.right <= marks.left &&
        Math.abs(heading.getBoundingClientRect().right - marks.right) < 2
      );
    });
    assert(oneRow, "the long title and its status and primary star should occupy separate columns in one row");

    await change(gm, `${parent} [name=status]`, "available");
    const tab = `${LOG} [data-group=status].tab.active`;
    await player.waitForSelector(`${tab} .quest-ancestor [data-quest-id="${parentId}"]`);
    await change(gm, `${parent} [name=status]`, "hidden");
    await player.waitForSelector(`${tab} [data-quest-id="${childId}"][data-depth="0"]`);
    assert(!(await player.$(`${LOG} [data-quest-id="${parentId}"]`)), "board reveals the hidden parent");
    await change(gm, `${parent} [name=status]`, "active");
  } finally {
    await gm.evaluate(
      async (m, id, previous) => {
        await game.journal.get(id)?.delete();
        if (previous) await game.journal.get(previous)?.update({ [`flags.${m}.quest.primary`]: true });
      },
      MODULE_ID,
      childId,
      previous
    );
  }
}

async function checkRewardDrag(gm, player, questId, sheet) {
  const itemName = "Carolyns Silberring";
  const playerId = await player.evaluate(() => game.user.id);
  const actorId = await gm.evaluate(
    async (id) =>
      (
        await Actor.create({
          name: "Mira",
          img: "systems/dnd5e/tokens/heroes/WizardTome.webp",
          type: "character",
          ownership: { [id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
        })
      ).id,
    playerId
  );
  let itemId;
  try {
    itemId = await gm.evaluate(
      async (name) =>
        (
          await Item.create({
            name,
            type: "loot",
            img: "icons/equipment/finger/ring-ball-silver.webp",
            ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
          })
        ).id,
      itemName
    );
    await gm.$eval(
      `${sheet} .quest-rewards`,
      (target, id) => {
        const transfer = new DataTransfer();
        transfer.setData("text/plain", JSON.stringify(game.items.get(id).toDragData()));
        target.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
      },
      itemId
    );
    await waitFor(
      player,
      (s, name) => [...document.querySelectorAll(`${s} [data-reward-id]`)].some((r) => r.textContent.includes(name)),
      sheet,
      itemName
    );
    const rewardId = await player.$$eval(
      `${sheet} [data-reward-id]`,
      (rows, name) => rows.find((r) => r.textContent.includes(name)).dataset.rewardId,
      itemName
    );
    const reward = `${sheet} [data-reward-id="${rewardId}"]`;
    await player.setViewport({ width: 1640, height: 940 });
    const actorSheet = await player.evaluate(
      async (id, questId) => {
        const app = game.actors.get(id).sheet;
        await app.render({ force: true });
        app.setPosition({ left: 665, top: 45 });
        app.changeTab("inventory", "primary");
        foundry.applications.instances.get(`my-quest-sheet-${questId}`).setPosition({ left: 40, top: 55 });
        return `#${CSS.escape(app.id)}`;
      },
      actorId,
      questId
    );
    const target = await player.waitForSelector(`${actorSheet} .tab.active[data-tab=inventory] .encumbrance`, {
      visible: true
    });
    const locked = await player.waitForSelector(reward, { visible: true });
    assert(!(await locked.evaluate((node) => node.draggable)), "locked reward offers a drag");
    await target.drop(locked);
    assert(
      await player.evaluate((id, name) => !game.actors.get(id).items.getName(name), actorId, itemName),
      "locked item landed"
    );

    await click(gm, `${reward} [data-action=toggleRewardLock]`);
    const unlocked = await player.waitForSelector(`${reward}[draggable=true]`, { visible: true });
    await player.bringToFront();
    await unlocked.drag(target);
    await screenshot(player, "reward-drag.png");
    await target.drop(unlocked);
    await waitFor(player, (id, name) => game.actors.get(id)?.items.getName(name)?.type === "loot", actorId, itemName);
    await waitFor(
      gm,
      (id, name) => game.actors.get(id)?.items.filter((item) => item.name === name).length === 1,
      actorId,
      itemName
    );
    const ownedId = await player.evaluate((id, name) => game.actors.get(id).items.getName(name).id, actorId, itemName);
    await player.waitForSelector(`${actorSheet} [data-item-id="${ownedId}"]`, { visible: true });
    await screenshot(player, "reward-inventory.png");
  } finally {
    await gm.evaluate(
      async (actor, item) => {
        await game.actors.get(actor)?.delete();
        if (item) await game.items.get(item)?.delete();
      },
      actorId,
      itemId
    );
  }
}

async function addObjective(gm, sheet, questId, index, text) {
  await click(gm, `${sheet} [data-action=addObjective]`);
  await waitFor(gm, (s, i) => document.querySelectorAll(`${s} [data-objective-id]`).length === i + 1, sheet, index);
  const id = await gm.$$eval(`${sheet} [data-objective-id]`, (rows, i) => rows[i].dataset.objectiveId, index);
  await change(gm, `${sheet} [data-objective-id="${id}"] [name=objectiveText]`, text);
  await waitFor(
    gm,
    (m, q, id, t) =>
      game.journal
        .get(q)
        .getFlag(m, "quest")
        .objectives.some((o) => o.id === id && o.text === t),
    MODULE_ID,
    questId,
    id,
    text
  );
  return id;
}

await run(async () => {
  const gm = await joinGamemaster();
  let player, questId, sheet, row, visibleId, hiddenId;

  try {
    await check("Quests directly follows Notes in the rendered top-level controls", async () => {
      const controls = await gm.$$eval("#scene-controls-layers button[data-control]", (buttons) =>
        buttons.map((button) => button.dataset.control)
      );
      const notes = controls.indexOf("notes");
      assert(notes >= 0 && controls[notes + 1] === "quests", `unexpected control order: ${controls.join(", ")}`);
    });

    await check("the GM opens the log from the Journal and from Quests while using a Notes tool", async () => {
      await pressButton(gm, "#sidebar-tabs [data-tab=journal]");
      await pressButton(gm, "#journal .my-quest-directory");
      await pressButton(gm, `${LOG} [data-action=close]`);
      await waitFor(gm, (s) => !document.querySelector(s), LOG);
      await pressButton(gm, "[data-action=control][data-control=notes]");
      await pressButton(gm, "[data-action=tool][data-tool=journal]");
      await pressButton(gm, QUESTS_CONTROL);
      await gm.waitForSelector(`${LOG} [data-action=createQuest]`, { visible: true });
      assert(
        await gm.evaluate(
          () =>
            ui.controls.control.name === "notes" &&
            ui.controls.tool.name === "journal" &&
            canvas.activeLayer === canvas.notes
        ),
        "opening the log changed the GM's Notes control, tool, or layer"
      );
    });

    await check("the player opens the log with one click on the top-level Quests control", async () => {
      player = await join(PLAYER_NAME);
      await player.evaluate(async () => {
        await game.user.sheet.close({ animate: false });
        ui.notifications.clear();
      });
      await player.waitForSelector(QUESTS_CONTROL, { visible: true });
      assert((await player.$eval(QUESTS_CONTROL, (el) => el.getAttribute("aria-label"))) === "Quests", "control label");
      await pressButton(player, QUESTS_CONTROL);
      await player.waitForSelector(LOG, { visible: true });
      await pressButton(player, `${LOG} [data-action=close]`);
      await waitFor(player, (s) => !document.querySelector(s), LOG);
    });

    await check("the GM creates a hidden quest that the player cannot find with Ctrl+Q", async () => {
      await gm.evaluate((m) => {
        Hooks.once("createJournalEntry", (entry, _options, userId) => {
          if (userId === game.user.id && entry.getFlag(m, "quest")) globalThis.testQuestId = entry.id;
        });
      }, MODULE_ID);
      await click(gm, `${LOG} [data-action=createQuest]`);
      await waitFor(gm, () => Boolean(globalThis.testQuestId));
      questId = await gm.evaluate(() => globalThis.testQuestId);
      sheet = `#my-quest-sheet-${questId}`;
      row = `${LOG} [data-quest-id="${questId}"]`;
      await gm.waitForSelector(`${sheet} [name=status]`);
      assert((await gm.$eval(`${sheet} [name=status]`, (field) => field.value)) === "hidden", "new status");

      await player.bringToFront();
      await player.keyboard.down("Control");
      try {
        await player.keyboard.press("KeyQ");
      } finally {
        await player.keyboard.up("Control");
      }
      await player.waitForSelector(LOG, { visible: true });
      await click(player, `${LOG} [data-action=tab][data-status=active]`);
      const hidden = await player.evaluate(
        (m, id) =>
          game.modules
            .get(m)
            .api.quests.list()
            .some((q) => q.id === id),
        MODULE_ID,
        questId
      );
      assert(!hidden && !(await player.$(row)), "hidden quest in the player's list");
      assert(!(await player.$(`${LOG} [data-status=hidden]`)), "the player has a hidden tab");
    });

    await check("quest defaults follow the player’s language until the GM writes their own text", async () => {
      const previousGM = await gm.evaluate(() => game.i18n.lang);
      const previousPlayer = await player.evaluate(() => game.i18n.lang);
      try {
        await gm.evaluate(async (id) => {
          await game.i18n.setLanguage("de");
          await game.modules.get("foundry-my-modules").api.quests.openQuest(game.journal.get(id).uuid);
        }, questId);
        assert(
          (await gm.$eval(`${sheet} [data-action=addObjective]`, (el) => el.textContent.trim())) === "Add objective",
          "German GM's editing controls"
        );
        await change(gm, `${sheet} [name=status]`, "available");
        await waitFor(
          player,
          (id, m) => game.journal.get(id)?.getFlag(m, "quest")?.status === "available",
          questId,
          MODULE_ID
        );
        await click(gm, `${sheet} [data-action=addObjective]`);
        await gm.waitForSelector(`${sheet} [name=objectiveText]`);
        await click(gm, `${sheet} [data-action=addReward]`);
        await waitFor(
          player,
          (m, id) => {
            const quest = game.journal.get(id)?.getFlag(m, "quest");
            return quest?.status === "available" && quest.objectives.length && quest.rewards.length;
          },
          MODULE_ID,
          questId
        );
        for (const [language, expected] of [
          ["en", ["New quest", "New objective", "New reward"]],
          ["de", ["Neue Quest", "Neues Ziel", "Neue Belohnung"]]
        ]) {
          const native = await player.evaluate(
            async (id, language, m) => {
              await game.i18n.setLanguage(language);
              const entry = game.journal.get(id);
              entry.reset();
              await game.modules.get(m).api.quests.openQuest(entry.uuid);
              return [entry.name, entry.pages.find((page) => page.getFlag(m, "questPage") === "description").name];
            },
            questId,
            language,
            MODULE_ID
          );
          assert(
            native[0] === expected[0] && native[1] === (language === "de" ? "Beschreibung" : "Description"),
            native.join("/")
          );
          const labels = await player.$eval(sheet, (el) =>
            [".quest-title", ".objective-text", ".reward-label"].map((s) => el.querySelector(s).textContent.trim())
          );
          assert(JSON.stringify(labels) === JSON.stringify(expected), `${language}: ${JSON.stringify(labels)}`);
        }
        await change(gm, `${sheet} [name=name]`, "New quest");
        await waitFor(gm, (id, m) => !game.journal.get(id).getFlag(m, "quest").untitled, questId, MODULE_ID);
        await change(gm, `${sheet} [name=objectiveText]`, "New objective");
        await waitFor(
          gm,
          (id, m) => game.journal.get(id).getFlag(m, "quest").objectives[0].text === "New objective",
          questId,
          MODULE_ID
        );
        await change(gm, `${sheet} [name=rewardText]`, "New reward");
        await waitFor(
          player,
          (s) =>
            ["New quest", "New objective", "New reward"].every((value) =>
              document.querySelector(s)?.textContent.includes(value)
            ),
          sheet
        );
      } finally {
        await gm.evaluate((lang) => game.i18n.setLanguage(lang), previousGM);
        await player.evaluate((lang) => game.i18n.setLanguage(lang), previousPlayer);
      }
      await click(player, `${sheet} [data-action=close]`);
      await click(gm, `${sheet} [data-action=deleteObjective]`);
      await gm.waitForSelector(`${sheet} [data-objective-id]`, { hidden: true });
      await click(gm, `${sheet} [data-action=deleteReward]`);
      await gm.waitForSelector(`${sheet} [data-reward-id]`, { hidden: true });
      await change(gm, `${sheet} [name=name]`, NAME);
      await waitFor(gm, (id, name) => game.journal.get(id).name === name, questId, NAME);
    });

    await check("new quest pages have stable script identifiers and names", async () => {
      const pages = await gm.evaluate(
        (m, id) => game.journal.get(id).pages.map((page) => [page.getFlag(m, "questPage"), page.name]),
        MODULE_ID,
        questId
      );
      const names = Object.fromEntries(pages);
      assert(
        pages.length === 2 && names.description === "Description" && names.gmNotes === "GM notes",
        `unexpected quest pages: ${JSON.stringify(pages)}`
      );
    });

    await check("a quest with null objectives appears in the API and the log", async () => {
      const count = await gm.evaluate(
        async (m, id) => {
          await game.journal.get(id).update({
            [`flags.${m}.quest.objectives`]: null,
            [`flags.${m}.quest.status`]: "available"
          });
          return game.modules
            .get(m)
            .api.quests.list()
            .find((quest) => quest.id === id)?.objectives.length;
        },
        MODULE_ID,
        questId
      );
      assert(count === 0, "quest missing or returned invalid objectives");
      await waitFor(
        player,
        (r) => /0\s*\/\s*0/.test(document.querySelector(`${r}[data-status=available]`)?.textContent),
        row
      );
    });

    await check("the GM adds two objectives, hides one and makes the quest active", async () => {
      visibleId = await addObjective(gm, sheet, questId, 0, PUBLIC);
      hiddenId = await addObjective(gm, sheet, questId, 1, SECRET);
      await click(gm, `${sheet} [data-objective-id="${hiddenId}"] [data-action=toggleHidden]`);
      await waitFor(
        gm,
        (m, id, o) =>
          game.journal
            .get(id)
            .getFlag(m, "quest")
            .objectives.find((x) => x.id === o)?.hidden,
        MODULE_ID,
        questId,
        hiddenId
      );
      await change(gm, `${sheet} [name=status]`, "active");
      await waitFor(
        player,
        (r) => {
          const quest = document.querySelector(r);
          return quest?.closest(".tab.active[data-tab=active]") && /0\s*\/\s*1/.test(quest.textContent);
        },
        row
      );
      assert((await player.$eval(row, (r) => r.textContent)).includes(NAME), "quest name missing from active tab");
    });

    await check("the tracker remembers collapsed quests and removes completed quests", () =>
      checkTracker(gm, player, questId, sheet, visibleId, hiddenId)
    );
    await check("only the player selected on the quest sheet can read the personal quest", () =>
      checkPersonalQuest(gm, player, questId, sheet, row)
    );
    await check("sub-quests nest under their parent and Ctrl+Shift+Q opens the current primary quest", () =>
      checkQuestLinks(gm, player, questId)
    );

    await check("the player opens the active quest and sees only the public objective", async () => {
      await click(player, `${row} [data-action=openQuest]`);
      await player.waitForSelector(`${sheet} [data-objective-id="${visibleId}"]`);
      const texts = await player.$$eval(`${sheet} [data-objective-id] .objective-text`, (items) =>
        items.map((item) => item.textContent.trim())
      );
      assert(texts.length === 1 && texts[0] === PUBLIC, `player objectives: ${JSON.stringify(texts)}`);
      assert(!(await player.$(`${sheet} [data-action=toggleDone]`)), "the player has GM objective controls");
      const observer = await player.evaluate(
        (id) => game.journal.get(id).testUserPermission(game.user, "OBSERVER", { exact: true }),
        questId
      );
      assert(observer, "the player did not receive observer ownership");
    });

    await check("an unrelated bridge update preserves the giver name the GM is typing", async () => {
      const giver = `${sheet} input[name=giver]`;
      await gm.bringToFront();
      await gm.focus(giver);
      await gm.keyboard.type("Carolyn");
      await gm.evaluate(
        async (m, id) => {
          const app = foundry.applications.instances.get(`my-quest-sheet-${id}`);
          const rendered = new Promise((resolve) => app.addEventListener("render", resolve, { once: true }));
          await game.journal.get(id).update({ [`flags.${m}.quest.giver.uuid`]: "Actor.previousGiver" });
          await rendered;
        },
        MODULE_ID,
        questId
      );
      assert(
        await gm.$eval(giver, (field) => field === document.activeElement && field.value === "Carolyn"),
        "lost draft"
      );
      await gm.keyboard.press("Tab");
      await waitFor(player, (s) => document.querySelector(`${s} .quest-giver`)?.textContent.includes("Carolyn"), sheet);
      const uuid = await player.evaluate(
        (m, id) => game.journal.get(id).getFlag(m, "quest").giver.uuid,
        MODULE_ID,
        questId
      );
      assert(uuid === null, `renamed giver UUID: ${uuid}`);
    });

    await check("the giver portrait appears beside the status, title and localized byline", async () => {
      await gm.evaluate(
        (m, id) => game.journal.get(id).update({ [`flags.${m}.quest.giver.img`]: "icons/svg/mystery-man.svg" }),
        MODULE_ID,
        questId
      );
      await player.waitForSelector(`${sheet} .giver-portrait`, { visible: true });
      const grouped = await player.$eval(`${sheet} .quest-header`, (header) => {
        const portrait = header.querySelector(".giver-portrait").getBoundingClientRect();
        const status = header.querySelector(".quest-marks").getBoundingClientRect();
        const title = header.querySelector(".quest-title").getBoundingClientRect();
        const byline = header.querySelector(".quest-byline");
        return (
          portrait.right <= title.left &&
          status.bottom <= title.top &&
          title.bottom <= byline.getBoundingClientRect().top &&
          byline.textContent.trim() === `${game.i18n.localize("MY_MODULES.Quests.Giver")} · Carolyn`
        );
      });
      assert(grouped, "expected the portrait beside a stacked status, title and byline");
    });

    await check("the GM nests, promotes and drags an objective without changing its ID", async () => {
      const second = `${sheet} [data-objective-id="${hiddenId}"]`;
      const first = `${sheet} [data-objective-id="${visibleId}"]`;
      await click(gm, `${second} [data-action=indent]`);
      await gm.waitForSelector(`${second}[data-parent-id="${visibleId}"]`);
      await click(gm, `${second} [data-action=outdent]`);
      await gm.waitForSelector(`${second}[data-parent-id=""]`);
      await gm.evaluate(
        (source, destination) => {
          const grip = document.querySelector(`${source} [draggable=true]`);
          const target = document.querySelector(destination);
          const dataTransfer = new DataTransfer();
          const options = {
            bubbles: true,
            cancelable: true,
            dataTransfer,
            clientY: target.getBoundingClientRect().top + 1
          };
          grip.dispatchEvent(new DragEvent("dragstart", options));
          target.dispatchEvent(new DragEvent("dragover", options));
          target.dispatchEvent(new DragEvent("drop", options));
        },
        second,
        first
      );
      await waitFor(
        gm,
        (m, id, first, second) => {
          const objectives = game.journal.get(id).getFlag(m, "quest").objectives;
          return (
            objectives.length === 2 && objectives[0].id === second && objectives[0].hidden && objectives[1].id === first
          );
        },
        MODULE_ID,
        questId,
        visibleId,
        hiddenId
      );
    });

    await check("ticking the objective updates the player's open sheet and log", async () => {
      await click(gm, `${sheet} [data-objective-id="${visibleId}"] [data-action=toggleDone]`);
      await waitFor(
        player,
        (s, text) => [...document.querySelectorAll(`${s} s`)].some((el) => el.textContent.trim() === text),
        sheet,
        PUBLIC
      );
      await waitFor(player, (r) => /1\s*\/\s*1/.test(document.querySelector(r)?.textContent), row);
    });

    await check("a bridge rewrite preserves the GM's ticks and visibility by objective ID", async () => {
      const rewritten = await gm.evaluate(
        async (m, id, visible, hidden) => {
          const entry = game.journal.get(id);
          await entry.update({
            [`flags.${m}.quest.objectives`]: [
              { id: visible, text: "Updated objective", children: [{ id: hidden, text: "Updated child" }] }
            ]
          });
          return entry.getFlag(m, "quest").objectives[0];
        },
        MODULE_ID,
        questId,
        visibleId,
        hiddenId
      );
      assert(rewritten.done === true && rewritten.children[0].hidden === true, "GM objective state lost");
      await waitFor(player, (s) => document.querySelector(`${s} s`)?.textContent.trim() === "Updated objective", sheet);
      assert(!(await player.$(`${sheet} [data-objective-id="${hiddenId}"]`)), "hidden child visible after rewrite");
    });

    await check(
      "bridge edits show the description and public reward, with GM notes and hidden rewards kept off the player's sheet",
      async () => {
        await gm.evaluate(
          async (m, id, description, notes) => {
            const entry = game.journal.get(id);
            const pages = entry.pages.contents.toSorted((a, b) => a.sort - b.sort);
            await entry.updateEmbeddedDocuments(
              "JournalEntryPage",
              pages.map((p, i) => ({
                _id: p.id,
                ...(i === 0 ? { name: "Prologue" } : {}),
                "text.content": `<p>${i === 0 ? description : notes}</p>`
              }))
            );
            await entry.update({
              [`flags.${m}.quest.rewards`]: [
                { id: "gold", uuid: null, text: "50 Gold", hidden: false, locked: true },
                { id: "ring", uuid: null, text: "Schattenring", hidden: true, locked: true }
              ]
            });
          },
          MODULE_ID,
          questId,
          DESCRIPTION,
          NOTES
        );
        await waitFor(gm, (s, notes) => document.querySelector(s)?.textContent.includes(notes), sheet, NOTES);
        await waitFor(
          player,
          (s, desc) => {
            const text = document.querySelector(s)?.textContent;
            return text?.includes(desc) && text.includes("50 Gold");
          },
          sheet,
          DESCRIPTION
        );
        const intro = await player.$eval(`${sheet} .quest-header + .quest-intro`, (article) => ({
          text: article.textContent.trim(),
          heading: Boolean(article.querySelector("h2")),
          objectivesNext: article.nextElementSibling.matches(".quest-objectives"),
          rewardsNext: article.nextElementSibling.nextElementSibling.matches(".quest-rewards")
        }));
        assert(
          intro.text === DESCRIPTION && !intro.heading && intro.objectivesNext && intro.rewardsNext,
          `unexpected description placement: ${JSON.stringify(intro)}`
        );
        assert(await gm.$(`${sheet} .quest-intro [data-action=editPage]`), "the GM cannot edit the introduction");
        const text = await player.$eval(sheet, (el) => el.textContent);
        assert(text.split(DESCRIPTION).length === 2, "the description should appear once");
        assert(
          !text.includes(NOTES) && !text.includes("Schattenring"),
          "private notes or reward reached the player sheet"
        );
      }
    );

    await check("a German player sees Ziele, Belohnungen and Questgeber on the quest sheet", async () => {
      const previous = await player.evaluate(() => game.i18n.lang);
      try {
        await player.evaluate(async (id) => {
          await game.i18n.setLanguage("de");
          await game.modules.get("foundry-my-modules").api.quests.openQuest(game.journal.get(id).uuid);
        }, questId);
        const labels = await player.$eval(sheet, (el) =>
          [".quest-objectives h2", ".quest-rewards h2", ".quest-byline"].map((s) =>
            el.querySelector(s).textContent.trim()
          )
        );
        assert(labels.join(" / ") === "Ziele / Belohnungen / Questgeber · Carolyn", labels.join(" / "));
      } finally {
        await player.evaluate((lang) => game.i18n.setLanguage(lang), previous);
      }
    });

    await check("an unflagged description from an older quest also introduces the sheet", async () => {
      await gm.evaluate(
        async (m, id) => {
          const page = game.journal.get(id).pages.find((page) => page.getFlag(m, "questPage") === "description");
          await page.unsetFlag(m, "questPage");
          await page.update({ name: "Beschreibung", "text.content": "<p>Legacy introduction</p>" });
        },
        MODULE_ID,
        questId
      );
      await waitFor(
        player,
        (s) =>
          document.querySelector(`${s} .quest-header + .quest-intro`)?.textContent.trim() === "Legacy introduction",
        sheet
      );
    });

    await check("text rewards stay on the sheet and retain their visibility across imports", async () => {
      await click(gm, `${sheet} [data-action=addReward]`);
      const label = await gm.evaluate(() => game.i18n.localize("MY_MODULES.Quests.NewReward"));
      const field = await gm.waitForSelector(`${sheet} [name=rewardText][value="${label}"]`);
      const id = await field.evaluate((input) => input.closest("[data-reward-id]").dataset.rewardId);
      const reward = `${sheet} [data-reward-id="${id}"]`;
      await change(gm, `${reward} [name=rewardText]`, "A favour from Carolyn");
      await waitFor(player, (s) => document.querySelector(s)?.textContent.includes("A favour from Carolyn"), reward);
      await click(gm, `${reward} [data-action=toggleRewardLock]`);
      await gm.waitForSelector(`${reward} [data-action=toggleRewardLock][aria-pressed=false]`);
      assert(!(await player.$eval(reward, (element) => element.draggable)), "text reward became draggable");
      await click(gm, `${reward} [data-action=toggleRewardHidden]`);
      await player.waitForSelector(reward, { hidden: true });
      await gm.evaluate(
        async (m, q, id) => {
          const entry = game.journal.get(q);
          const rewards = entry
            .getFlag(m, "quest")
            .rewards.map((r) => (r.id === id ? { id, text: "Updated favour" } : r));
          await entry.update({ [`flags.${m}.quest.rewards`]: rewards });
        },
        MODULE_ID,
        questId,
        id
      );
      await gm.waitForSelector(`${reward} input[value="Updated favour"]`);
      assert(await gm.$(`${reward} [data-action=toggleRewardHidden][aria-pressed=true]`), "import revealed reward");
      assert(await gm.$(`${reward} [data-action=toggleRewardLock][aria-pressed=false]`), "import relocked reward");
      await click(gm, `${reward} [data-action=deleteReward]`);
      await gm.waitForSelector(reward, { hidden: true });
    });

    await check("the player can drag only an unlocked item reward to their dnd5e character", () =>
      checkRewardDrag(gm, player, questId, sheet)
    );

    await check("hiding the quest through the bridge revokes access and closes the player's sheet", async () => {
      await gm.evaluate(
        async (m, id) => {
          await game.journal.get(id).update({ [`flags.${m}.quest.status`]: "hidden" });
        },
        MODULE_ID,
        questId
      );
      await waitFor(player, (s, r) => !document.querySelector(s) && !document.querySelector(r), sheet, row);
      const denied = await player.evaluate(
        (m, id) => {
          const entry = game.journal.get(id);
          return (
            !entry?.testUserPermission(game.user, "OBSERVER") &&
            !game.modules
              .get(m)
              .api.quests.list()
              .some((q) => q.id === id)
          );
        },
        MODULE_ID,
        questId
      );
      assert(denied, "the player kept access after the quest was hidden");
    });
    await check("the GM changes status from a row's context menu", async () => {
      await pressButton(gm, `${sheet} [data-action=close]`);
      await pressButton(gm, `${LOG} [data-action=tab][data-status=hidden]`);
      await gm.click(row, { button: "right" });
      await gm.waitForSelector("#context-menu .context-item", { visible: true });
      await gm.$$eval("#context-menu .context-item", (items) => {
        items.find((item) => item.textContent.trim() === "Available").click();
      });
      await pressButton(player, `${LOG} [data-action=tab][data-status=available]`);
      await waitFor(player, (r) => document.querySelector(r)?.closest(".tab.active[data-tab=available]"), row);
    });

    await check("cancelling keeps the quest and confirming deletion removes it for both users", async () => {
      await pressButton(gm, `${LOG} [data-action=tab][data-status=available]`);
      const remove = `${row} [data-action=deleteQuest]`;
      await pressButton(gm, remove);
      await pressButton(gm, "dialog [data-action=no]");
      await waitFor(gm, () => !document.querySelector("dialog [data-action=no]"));
      assert(await gm.evaluate((id) => game.journal.has(id), questId), "cancel deleted the quest");
      await pressButton(gm, remove);
      await pressButton(gm, "dialog [data-action=yes]");
      await waitFor(gm, (id) => !game.journal.has(id), questId);
      await waitFor(player, (r) => !document.querySelector(r), row);
    });
  } finally {
    await gm.evaluate(async () => {
      if (globalThis.testQuestId) await game.journal.get(globalThis.testQuestId)?.delete();
    });
  }
});
