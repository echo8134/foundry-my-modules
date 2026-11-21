import english from "../../lang/en.json" with { type: "json" };
import { MODULE_ID } from "../constants.mjs";
import { listQuests } from "./data.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const SETTINGS = "questTrackerState";
const WIDTH = 275;
const userKey = () => `${game.world.id}/${game.user.id}`;
const preferences = () => game.settings.get(MODULE_ID, SETTINGS)[userKey()] ?? {};
let tracker;

function savePreferences(changes) {
  const settings = game.settings.get(MODULE_ID, SETTINGS);
  const key = userKey();
  settings[key] = { ...settings[key], ...changes };
  return game.settings.set(MODULE_ID, SETTINGS, settings);
}

function openObjectives(objectives) {
  return objectives.flatMap((root) => [
    ...(root.done ? [] : [root]),
    ...root.children.filter((child) => !child.done).map((child) => ({ ...child, indented: !root.done }))
  ]);
}

class QuestTracker extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "my-quest-tracker",
    position: { width: WIDTH },
    window: { title: "MY_MODULES.Quests.Tracker.Title", icon: "fa-solid fa-list-check" },
    actions: {
      async toggleObjectives(_event, button) {
        const id = button.closest("[data-quest-id]").dataset.questId;
        const collapsed = new Set(preferences().collapsed);
        if (collapsed.has(id)) collapsed.delete(id);
        else collapsed.add(id);
        await savePreferences({ collapsed: [...collapsed] });
        return this.render();
      }
    }
  };

  static PARTS = {
    tracker: { template: `modules/${MODULE_ID}/scripts/quests/tracker.hbs`, scrollable: [""] }
  };

  async _prepareContext() {
    const collapsed = new Set(preferences().collapsed);
    const quests = listQuests()
      .filter((quest) => quest.status === "active")
      .map((quest) => ({
        id: quest.id,
        name: quest.name,
        expanded: !collapsed.has(quest.id),
        objectives: openObjectives(quest.objectives)
      }));
    return { quests };
  }

  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    this.window.header.addEventListener("lostpointercapture", () => {
      const { left, top } = this.position;
      savePreferences({ position: { left, top } });
    });
  }
}

export function toggleQuestTracker() {
  tracker ??= new QuestTracker();
  if (tracker.rendered) return tracker.close();
  const right = document.getElementById("ui-right")?.getBoundingClientRect().left ?? window.innerWidth;
  const position = preferences().position ?? { left: right - WIDTH - 8, top: 16 };
  return tracker.render({ force: true, position });
}

export function refreshQuestTracker() {
  return tracker?.render();
}

export function setupQuestTracker() {
  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, SETTINGS, { scope: "client", config: false, type: Object, default: {} });
    game.keybindings.register(MODULE_ID, "questTracker", {
      name: english["MY_MODULES.Quests.Tracker.Toggle"],
      editable: [{ key: "KeyQ", modifiers: ["Control", "Alt"] }],
      onDown: () => {
        toggleQuestTracker();
        return true;
      }
    });
  });
}
