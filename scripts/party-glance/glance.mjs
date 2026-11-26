import { MODULE_ID } from "../constants.mjs";
import { PartyGlanceConfig } from "./config.mjs";
import { refresh, watchRings } from "./ring.mjs";
import { DEFAULTS, SETTING } from "./settings.mjs";
import { text } from "./text.mjs";

export function setupPartyGlance() {
  Hooks.once("init", () => {
    if (game.system.id !== "dnd5e") return;
    game.settings.register(MODULE_ID, SETTING, {
      scope: "world",
      config: false,
      type: Object,
      default: foundry.utils.deepClone(DEFAULTS),
      onChange: refresh
    });
    game.settings.registerMenu(MODULE_ID, SETTING, {
      name: text("menuName"),
      hint: text("menuHint"),
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
