import { MODULE_ID } from "./constants.mjs";

export function registerFeatureMenu(key, enabledKey, menu) {
  game.settings.registerMenu(MODULE_ID, key, menu);
  // Foundry renders all menus before any settings in the module tab.
  Hooks.on("renderSettingsConfig", (_app, element) => {
    const button = element.querySelector(`button[data-key="${MODULE_ID}.${key}"]`);
    const toggle = element.querySelector(`[name="${MODULE_ID}.${enabledKey}"]`);
    if (button && toggle) button.closest(".form-group").before(toggle.closest(".form-group"));
  });
}
