import { MODULE_ID } from "../constants.mjs";
import {
  createQuest,
  deleteQuest,
  ensureQuestFolder,
  listQuests,
  QUEST_STATUSES,
  questView,
  statusLabel,
  updateQuest
} from "./data.mjs";
import { QuestSheet } from "./sheet.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const title = "MY_MODULES.Quests.Log";
const rowEntry = (target) => game.journal.get(target.closest("[data-quest-id]").dataset.questId);
const sheets = new WeakMap();
let log;

function showSheet(entry) {
  if (!questView(entry)) return null;
  if (!sheets.has(entry)) sheets.set(entry, new QuestSheet(entry));
  return sheets.get(entry).render({ force: true });
}

class QuestLog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "my-quest-log",
    classes: ["my-quest-log"],
    position: { width: 580, height: 460 },
    window: { title, icon: "fa-solid fa-book-open", resizable: true },
    actions: {
      openQuest: (_event, target) => showSheet(rowEntry(target)),
      deleteQuest: (_event, target) => deleteQuest(rowEntry(target)),
      async createQuest() {
        const entry = await createQuest();
        this.changeTab("hidden", "status");
        await showSheet(entry);
      }
    }
  };

  static PARTS = {
    log: { template: `modules/${MODULE_ID}/scripts/quests/log.hbs`, scrollable: [".quest-lists"] }
  };

  tabGroups = { status: "active" };

  async _prepareContext() {
    const quests = listQuests().map((quest) => {
      const objectives = quest.objectives.flatMap((objective) => [objective, ...(objective.children ?? [])]);
      const seed = Array.from(quest.id).reduce((sum, char) => sum + char.charCodeAt(0), 0);
      const tilt = ((seed % 41) - 20) / 10;
      return { ...quest, tilt, done: objectives.filter((o) => o.done).length, total: objectives.length };
    });
    const tabs = QUEST_STATUSES.filter((status) => game.user.isGM || status !== "hidden").map((status) => ({
      status,
      active: this.tabGroups.status === status,
      label: statusLabel(status),
      quests: quests.filter((quest) => quest.status === status)
    }));
    return { tabs, isGM: game.user.isGM };
  }

  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    if (game.user.isGM) {
      this._createContextMenu(this._statusOptions, "[data-quest-id]", { fixed: true, classes: ["quest-status-menu"] });
    }
  }

  _statusOptions() {
    return QUEST_STATUSES.map((status) => ({
      label: statusLabel(status),
      visible: (row) => row.dataset.status !== status,
      onClick: (_event, row) => updateQuest(rowEntry(row), { status })
    }));
  }
}

export const quests = {
  async open() {
    if (game.user.isGM) await ensureQuestFolder();
    log ??= new QuestLog();
    return log.render({ force: true });
  },
  async openQuest(uuid) {
    const entry = await foundry.utils.fromUuid(uuid);
    return entry?.documentName === "JournalEntry" && game.journal.get(entry.id) === entry ? showSheet(entry) : null;
  },
  list: listQuests
};

function addDirectoryButton(_app, element) {
  const footer = element.querySelector(".directory-footer");
  if (!footer || footer.querySelector(".my-quest-directory")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "my-quest-directory";
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-book-open";
  icon.inert = true;
  button.append(icon, game.i18n.localize(title));
  button.addEventListener("click", () => quests.open());
  footer.append(button);
}

function refreshSheet(entry, deleted = false) {
  const sheet = sheets.get(entry);
  if (!sheet) return;
  if (deleted || !questView(entry)) sheet.close({ animate: false });
  else sheet.render();
}

export function setupQuestLog() {
  Hooks.once("init", () => {
    game.keybindings.register(MODULE_ID, "questLog", {
      name: title,
      editable: [{ key: "KeyQ", modifiers: ["Control"] }],
      onDown: () => {
        quests.open();
        return true;
      }
    });
  });
  Hooks.on("renderJournalDirectory", addDirectoryButton);
  Hooks.on("getSceneControlButtons", (controls) => {
    const icon = "fa-solid fa-scroll";
    const groups = Object.values(controls);
    const order = (controls.notes?.order ?? Math.max(0, ...groups.map((group) => group.order))) + 1;
    for (const group of groups) {
      if (group.order >= order) group.order++;
    }
    controls.quests = {
      name: "quests",
      title: "MY_MODULES.Quests.Control",
      order,
      icon,
      tools: {
        questLog: { name: "questLog", title, order: 0, icon, button: true, onChange: quests.open }
      }
    };
  });
  Hooks.on("renderSceneControls", (app, element) => {
    // Foundry renders every top-level control as a layer tab. Run the button tool directly to keep the active layer.
    const button = element.querySelector('button[data-control="quests"][data-action="control"]');
    if (!button) return;
    delete button.dataset.action;
    button.classList.remove("layer");
    button.removeAttribute("role");
    button.removeAttribute("aria-controls");
    button.removeAttribute("aria-pressed");
    button.addEventListener("click", app.controls.quests.tools.questLog.onChange);
  });
  for (const action of ["create", "update", "delete"]) {
    Hooks.on(`${action}JournalEntry`, (entry) => {
      if (entry.pack) return;
      log?.render();
      refreshSheet(entry, action === "delete");
    });
    Hooks.on(`${action}JournalEntryPage`, (page) => {
      if (!page.pack) refreshSheet(page.parent);
    });
  }
}
