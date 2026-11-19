import { setupActionHud } from "./action-hud/hud.mjs";
import { MODULE_ID } from "./constants.mjs";
import { setupCursors } from "./cursors.mjs";
import { setupLevels } from "./levels.mjs";
import { rollName, setupNames } from "./names.mjs";
import { setupQuestData } from "./quests/data.mjs";
import { quests, setupQuestLog } from "./quests/log.mjs";
import { setupSafetyTools } from "./safety/window.mjs";
import { setupTiles } from "./tiles.mjs";
import { getVariants, setVariant } from "./variants.mjs";

setupActionHud();
setupCursors();
setupLevels();
setupNames();
setupQuestData();
setupQuestLog();
setupSafetyTools();
setupTiles();

Hooks.once("init", () => {
  game.modules.get(MODULE_ID).api = { getVariants, setVariant, rollName, quests };
});
