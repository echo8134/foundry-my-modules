import { MODULE_ID } from "./constants.mjs";

export function setupHotbar() {
  Hooks.once("init", () => {
    const setting = `hideMacroHotbar-${game.userId}`;
    const toggle = () => {
      game.settings.set(MODULE_ID, setting, !game.settings.get(MODULE_ID, setting));
      return true;
    };
    game.keybindings.register(MODULE_ID, "toggleMacroHotbar", {
      name: "MY_MODULES.Hotbar.Toggle",
      editable: [{ key: "KeyB", modifiers: ["Alt"] }],
      restricted: true,
      onDown: toggle
    });

    Hooks.once("setup", () => {
      if (!game.user.isGM) return;
      const apply = (hidden) => document.body.classList.toggle("my-hide-macro-hotbar", hidden);
      game.settings.register(MODULE_ID, setting, {
        name: "MY_MODULES.Hotbar.Hide",
        hint: "MY_MODULES.Hotbar.Hint",
        scope: "client",
        config: true,
        type: Boolean,
        default: false,
        onChange: apply
      });
      apply(game.settings.get(MODULE_ID, setting));

      Hooks.on("getSceneControlButtons", ({ tokens }) => {
        tokens.tools.myMacroHotbar = {
          name: "myMacroHotbar",
          title: "MY_MODULES.Hotbar.Toggle",
          icon: "fa-solid fa-keyboard",
          order: Object.keys(tokens.tools).length + 1,
          button: true,
          onChange: toggle
        };
      });
    });
  });
}
