import { MODULE_ID } from "./constants.mjs";
import { setupCursors } from "./cursors.mjs";
import { setupLevels } from "./levels.mjs";
import { rollName, setupNames } from "./names.mjs";
import { setupQuestData } from "./quests/data.mjs";
import { quests, setupQuestLog } from "./quests/log.mjs";
import { getVariants, setVariant } from "./variants.mjs";

setupCursors();
setupLevels();
setupNames();
setupQuestData();
setupQuestLog();

Hooks.once("init", () => {
  game.modules.get(MODULE_ID).api = { getVariants, setVariant, rollName, quests };
});
