import { setupActionHud } from "./action-hud/hud.mjs";
import { setupCalendarTiles } from "./calendar-tile.mjs";
import { MODULE_ID } from "./constants.mjs";
import { setupCursors } from "./cursors.mjs";
import { localizeRulesJournal, setupDeathSaves } from "./death-saves.mjs";
import { setupDiceTray } from "./dice-tray.mjs";
import { setupHotbar } from "./hotbar.mjs";
import { setupLevels } from "./levels.mjs";
import { rollName, setupNames } from "./names.mjs";
import { localizeQuestJournal, setupQuestData } from "./quests/data.mjs";
import { quests, setupQuestLog } from "./quests/log.mjs";
import { setupQuestTracker } from "./quests/tracker.mjs";
import { setupSafetyTools } from "./safety/window.mjs";
import { setupSoundboard } from "./soundboard.mjs";
import { setupTiles } from "./tiles.mjs";
import { getVariants, setVariant } from "./variants.mjs";

setupActionHud();
setupCalendarTiles();
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
  // Native directories, sheets and links all read the prepared journal on the viewing client.
  const journal = CONFIG.JournalEntry.documentClass.prototype;
  const prepare = journal.prepareDerivedData;
  journal.prepareDerivedData = function (...args) {
    const result = prepare.apply(this, args);
    localizeQuestJournal(this);
    localizeRulesJournal(this);
    return result;
  };
  game.modules.get(MODULE_ID).api = { getVariants, setVariant, rollName, quests };
});
