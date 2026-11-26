import { MODULE_ID } from "../constants.mjs";
import { registerFeatureMenu } from "../feature-menu.mjs";
import { PartyGlanceConfig } from "./config.mjs";
import { refresh, watchRings } from "./ring.mjs";
import { DEFAULTS, ENABLED, SETTING } from "./settings.mjs";
import { text } from "./text.mjs";

export function setupPartyGlance() {
  Hooks.once("init", () => {
    if (game.system.id !== "dnd5e") return;
    game.settings.register(MODULE_ID, ENABLED, {
      name: text("enabled"),
      hint: text("menuHint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      onChange: refresh
    });
    game.settings.register(MODULE_ID, SETTING, {
      scope: "world",
      config: false,
      type: Object,
      default: foundry.utils.deepClone(DEFAULTS),
      onChange: refresh
    });
    registerFeatureMenu(SETTING, ENABLED, {
      name: text("menuName"),
      label: text("menuLabel"),
      icon: "fa-solid fa-circle-nodes",
      type: PartyGlanceConfig,
      restricted: true
    });
  });
  Hooks.once("ready", () => {
    if (game.system.id === "dnd5e" && game.user.isGM) watchRings();
  });
}
