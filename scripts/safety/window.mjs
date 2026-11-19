import { MODULE_ID } from "../constants.mjs";
import { enabled, request, setupRelay } from "./relay.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class SafetyWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "my-safety-tools",
    window: { title: "MY_MODULES.Safety.Title", icon: "fa-solid fa-cards-blank" },
    position: { width: 510 },
    actions: {
      sendCard(_event, button) {
        const input = button.closest("section").querySelector("input");
        if (request({ action: "xCard", note: input.value.trim() })) input.value = "";
      },
      addEntry(_event, button) {
        const column = button.closest("[data-kind]");
        const input = column.querySelector(".safety-add input");
        const text = input.value.trim();
        if (text && request({ action: "add", kind: column.dataset.kind, text })) input.value = "";
      },
      editEntry(_event, button) {
        const row = button.closest("[data-entry]");
        const text = row.querySelector("input").value.trim();
        if (text) request({ action: "edit", id: row.dataset.entry, text });
      },
      removeEntry: (_event, button) => request({ action: "remove", id: button.closest("[data-entry]").dataset.entry }),
      openDoor() {
        if (!enabled("openDoor")) return;
        return ChatMessage.create(
          { style: CONST.CHAT_MESSAGE_STYLES.OOC, content: game.i18n.localize("MY_MODULES.Safety.Break") },
          { messageMode: "public" }
        );
      }
    }
  };

  static PARTS = {
    tools: { template: `modules/${MODULE_ID}/scripts/safety/window.hbs` }
  };

  tabGroups = { safety: "card" };

  async _prepareContext() {
    const card = enabled("xCard");
    const limits = enabled("linesVeils");
    if (!card) this.tabGroups.safety = "limits";
    else if (!limits) this.tabGroups.safety = "card";
    const entries = game.settings.get(MODULE_ID, "safetyBoundaries");
    return {
      card,
      limits,
      tabs: card && limits,
      showCard: this.tabGroups.safety === "card",
      door: enabled("openDoor"),
      gm: game.user.isGM,
      columns: ["line", "veil"].map((kind) => ({
        kind,
        title: `MY_MODULES.Safety.${kind}.Title`,
        hint: `MY_MODULES.Safety.${kind}.Hint`,
        add: `MY_MODULES.Safety.${kind}.Add`,
        entries: entries.filter((entry) => entry.kind === kind)
      }))
    };
  }

  _preSyncPartState(partId, element, prior, state) {
    super._preSyncPartState(partId, element, prior, state);
    // A boundary can arrive while someone is typing a note, an addition, or an edit.
    for (const input of prior.querySelectorAll("input[id]")) {
      if (input.value === input.defaultValue) continue;
      const next = element.querySelector(`#${CSS.escape(input.id)}`);
      if (next?.defaultValue !== input.defaultValue) continue;
      next.value = input.value;
      next.setSelectionRange(input.selectionStart, input.selectionEnd, input.selectionDirection);
    }
  }
}

let safetyWindow;
function open() {
  safetyWindow ??= new SafetyWindow();
  safetyWindow.tabGroups.safety = enabled("xCard") ? "card" : "limits";
  return safetyWindow.render({ force: true });
}
const refreshWindow = () => safetyWindow?.render();

function refreshTools() {
  if (["xCard", "linesVeils", "openDoor"].some(enabled)) refreshWindow();
  else safetyWindow?.close();
  ui.controls?.render({ reset: true });
}

export function setupSafetyTools() {
  setupRelay(refreshTools, refreshWindow);
  Hooks.on("getSceneControlButtons", (controls) => {
    if (!["xCard", "linesVeils", "openDoor"].some(enabled)) return;
    const title = "MY_MODULES.Safety.Title";
    const icon = "fa-solid fa-cards-blank";
    controls.safety = {
      name: "safety",
      title,
      icon,
      order: (controls.quests?.order ?? controls.notes?.order ?? 0) + 0.25,
      tools: { safety: { name: "safety", title, icon, order: 0, button: true, onChange: open } }
    };
  });
  Hooks.on("renderSceneControls", (_app, element) => {
    const button = element.querySelector('button[data-control="safety"][data-action="control"]');
    if (!button) return;
    delete button.dataset.action;
    button.classList.remove("layer");
    for (const attribute of ["role", "aria-controls", "aria-pressed"]) button.removeAttribute(attribute);
    button.addEventListener("click", open);
  });
}
