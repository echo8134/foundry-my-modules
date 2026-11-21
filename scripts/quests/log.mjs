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
import { refreshQuestTracker, toggleQuestTracker } from "./tracker.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const title = "MY_MODULES.Quests.Log";
const rowEntry = (target) => game.journal.get(target.closest("[data-quest-id]").dataset.questId);
const sheets = new WeakMap();
let log;

function showSheet(entry) {
  if (!questView(entry)) return null;
  if (!sheets.has(entry)) sheets.set(entry, new QuestSheet(entry, showSheet));
  return sheets.get(entry).render({ force: true });
}

// A parent from another status tab appears as a link above its children.
function questGroups(quests, status) {
  const children = Map.groupBy(quests, (quest) => quest.parent);
  const visited = new Set();
  function branch(quest, depth) {
    if (visited.has(quest.uuid)) return [];
    visited.add(quest.uuid);
    const nested = (children.get(quest.uuid) ?? []).flatMap((child) => branch(child, depth + 1));
    const contextOnly = quest.status !== status;
    if (contextOnly && !nested.length) return [];
    return [{ ...quest, depth, contextOnly }, ...nested];
  }

  const groups = [];
  // The second pass also reaches cycles in imported journals.
  for (const root of [...(children.get(null) ?? []), ...quests]) {
    if (visited.has(root.uuid)) continue;
    const rows = branch(root, 0);
    if (rows.length) groups.push(rows);
  }
  return groups;
}

class QuestLog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "my-quest-log",
    classes: ["my-quest-log"],
    position: { width: 580, height: 460 },
    window: { title, icon: "fa-solid fa-book-open", resizable: true },
    actions: {
      openQuest: (_event, target) => showSheet(rowEntry(target)),
      toggleTracker: toggleQuestTracker,
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
      groups: questGroups(quests, status)
    }));
    return { tabs, isGM: game.user.isGM };
  }

  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    if (game.user.isGM) {
      this._createContextMenu(this._statusOptions, ".quest-row", { fixed: true, classes: ["quest-status-menu"] });
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

function refreshSheet(sheet, deleted = false) {
  if (!sheet) return;
  if (deleted || !questView(sheet.entry)) sheet.close({ animate: false });
  else sheet.render();
}

function refreshOpenSheets(deletedEntry) {
  for (const app of foundry.applications.instances.values()) {
    if (app instanceof QuestSheet) refreshSheet(app, app.entry === deletedEntry);
  }
}

export function setupQuestLog() {
  Hooks.once("ready", () => {
    game.socket.on(`module.${MODULE_ID}`, (message, senderId) => {
      if (message?.action !== "showQuest" || game.user.isGM || !game.users.get(senderId)?.isGM) return;
      const entry = game.journal.get(message.questId);
      if (entry) showSheet(entry);
    });
  });
  Hooks.once("init", () => {
    game.keybindings.register(MODULE_ID, "primaryQuest", {
      name: "MY_MODULES.Quests.OpenPrimary",
      editable: [{ key: "KeyQ", modifiers: ["Control", "Shift"] }],
      onDown: () => {
        const primary = listQuests().find((quest) => quest.primary);
        if (primary) showSheet(game.journal.get(primary.id));
        return true;
      }
    });
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
    const precedingOrder = controls.notes
      ? (controls.notes.order ?? 0)
      : Math.max(0, ...Object.values(controls).map((group) => group.order ?? 0));
    controls.quests = {
      name: "quests",
      title: "MY_MODULES.Quests.Control",
      order: precedingOrder + 0.5,
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
  for (const action of ["createUser", "updateUser", "deleteUser"]) {
    Hooks.on(action, (_user, changes) => {
      if (game.user.isGM && (action !== "updateUser" || "name" in changes || "role" in changes)) refreshOpenSheets();
    });
  }
  for (const action of ["create", "update", "delete"]) {
    Hooks.on(`${action}JournalEntry`, (entry) => {
      if (entry.pack) return;
      log?.render();
      refreshQuestTracker();
      refreshOpenSheets(action === "delete" ? entry : null);
    });
    Hooks.on(`${action}JournalEntryPage`, (page) => {
      if (!page.pack) refreshSheet(sheets.get(page.parent));
    });
  }
}
