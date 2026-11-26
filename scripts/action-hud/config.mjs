import english from "../../lang/en.json" with { type: "json" };
import { MODULE_ID } from "../constants.mjs";
import { CATEGORY_ICONS } from "./groups.mjs";

export const ALWAYS_SHOW_CHARACTER = "actionHudAlwaysShowCharacter";
export const SHOW_EFFECTS = "actionHudShowEffects";
export const DETACH_HOTBAR = "actionHudDetachHotbar";
export const DESIGN = "actionHudDesign";
export const HIDDEN_CATEGORIES = "actionHudHiddenCategories";

const OPTIONS = [ALWAYS_SHOW_CHARACTER, SHOW_EFFECTS, DETACH_HOTBAR, DESIGN];
const setting = (key) => game.settings.settings.get(`${MODULE_ID}.${key}`);
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class HudConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "my-action-hud-config",
    tag: "form",
    window: { title: "MY_MODULES.ActionHud.configure", contentClasses: ["standard-form"] },
    position: { width: 520 },
    actions: {
      reset() {
        for (const key of OPTIONS) {
          const input = this.form.elements[key];
          if (input.type === "checkbox") input.checked = setting(key).default;
          else input.value = setting(key).default;
        }
        for (const id of Object.keys(CATEGORY_ICONS)) {
          this.form.elements[id].checked = !setting(HIDDEN_CATEGORIES).default.includes(id);
        }
      }
    },
    form: {
      closeOnSubmit: true,
      async handler(_event, form, data) {
        for (const key of OPTIONS) {
          if (data.object[key] !== this.original[key]) await game.settings.set(MODULE_ID, key, data.object[key]);
        }
        const hidden = new Set(game.settings.get(MODULE_ID, HIDDEN_CATEGORIES));
        let changed = false;
        for (const id of Object.keys(CATEGORY_ICONS)) {
          if (data.object[id] === form.elements[id].defaultChecked) continue;
          changed = true;
          if (data.object[id]) hidden.delete(id);
          else hidden.add(id);
        }
        if (changed) await game.settings.set(MODULE_ID, HIDDEN_CATEGORIES, [...hidden]);
      }
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/scripts/action-hud/config.hbs`, scrollable: [""] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  async _prepareContext() {
    this.original = Object.fromEntries(OPTIONS.map((key) => [key, game.settings.get(MODULE_ID, key)]));
    const hidden = game.settings.get(MODULE_ID, HIDDEN_CATEGORIES);
    return {
      options: OPTIONS.map((key) => {
        const { name, hint, choices } = setting(key);
        return { key, name, hint, choices, value: this.original[key] };
      }),
      categories: Object.keys(CATEGORY_ICONS).map((id) => ({
        id,
        label: english[`MY_MODULES.ActionHud.${id}`],
        visible: !hidden.includes(id)
      })),
      buttons: [
        { type: "button", action: "reset", icon: "fa-solid fa-rotate-left", label: "Reset Defaults" },
        { type: "submit", icon: "fa-solid fa-floppy-disk", label: "Save Changes" }
      ]
    };
  }
}
