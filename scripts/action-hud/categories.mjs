import english from "../../lang/en.json" with { type: "json" };
import { MODULE_ID } from "../constants.mjs";
import { CATEGORY_ICONS } from "./groups.mjs";

export const HIDDEN_CATEGORIES = "actionHudHiddenCategories";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class HudCategories extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "my-action-hud-categories",
    tag: "form",
    window: { title: "MY_MODULES.ActionHud.categories", contentClasses: ["standard-form"] },
    position: { width: 340 },
    form: {
      closeOnSubmit: true,
      handler(_event, _form, data) {
        const hidden = Object.keys(CATEGORY_ICONS).filter((id) => !data.object[id]);
        return game.settings.set(MODULE_ID, HIDDEN_CATEGORIES, hidden);
      }
    }
  };

  static PARTS = {
    categories: { template: `modules/${MODULE_ID}/scripts/action-hud/categories.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  async _prepareContext() {
    const hidden = game.settings.get(MODULE_ID, HIDDEN_CATEGORIES);
    return {
      categories: Object.keys(CATEGORY_ICONS).map((id) => ({
        id,
        label: english[`MY_MODULES.ActionHud.${id}`],
        visible: !hidden.includes(id)
      })),
      buttons: [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "Save Changes" }]
    };
  }
}
