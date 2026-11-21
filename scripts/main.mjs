import { setupActionHud } from "./action-hud/hud.mjs";
import { MODULE_ID } from "./constants.mjs";
import { setupCursors } from "./cursors.mjs";
import { setupDeathSaves } from "./death-saves.mjs";
import { setupDiceTray } from "./dice-tray.mjs";
import { setupHotbar } from "./hotbar.mjs";
import { setupLevels } from "./levels.mjs";
import { rollName, setupNames } from "./names.mjs";
import { setupQuestData } from "./quests/data.mjs";
import { quests, setupQuestLog } from "./quests/log.mjs";
import { setupQuestTracker } from "./quests/tracker.mjs";
import { setupSafetyTools } from "./safety/window.mjs";
import { setupSoundboard } from "./soundboard.mjs";
import { setupTiles } from "./tiles.mjs";
import { getVariants, setVariant } from "./variants.mjs";

setupActionHud();
setupCursors();
setupDeathSaves();
setupDiceTray();
setupHotbar();
setupLevels();
setupNames();
setupQuestData();
setupQuestLog();
setupQuestTracker();
setupSafetyTools();
setupSoundboard();
setupTiles();

Hooks.once("init", () => {
  game.modules.get(MODULE_ID).api = { getVariants, setVariant, rollName, quests };
});
