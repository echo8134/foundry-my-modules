import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const LOG = ".my-quest-log";
const QUESTS_CONTROL = "#scene-controls-layers button[data-control=quests]";
const NAME = "MM Quest: Das Fieberkraut";
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
      await change(gm, `${sheet} [name=name]`, NAME);
      await waitFor(gm, (id, name) => game.journal.get(id).name === name, questId, NAME);

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

    await check("new quest pages have stable script identifiers and names", async () => {
      const pages = await gm.evaluate(
        (m, id) => game.journal.get(id).pages.map((page) => [page.getFlag(m, "questPage"), page.name]),
        MODULE_ID,
        questId
      );
      const names = Object.fromEntries(pages);
      assert(
        pages.length === 2 && names.description === "Beschreibung" && names.gmNotes === "SL-Notizen",
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
        const text = await player.$eval(sheet, (el) => el.textContent);
        assert(
          !text.includes(NOTES) && !text.includes("Schattenring"),
          "private notes or reward reached the player sheet"
        );
      }
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
        const label = game.i18n.localize("MY_MODULES.Quests.Status.available");
        items.find((item) => item.textContent.trim() === label).click();
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
