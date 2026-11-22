import { MODULE_ID } from "./constants.mjs";
import { getVariants } from "./variants.mjs";

function variantViewKey(level) {
  const variant = level.parent.getFlag(MODULE_ID, "active")?.[level.id];
  if (typeof variant !== "string" || !variant) return null;
  const offered = getVariants(level.parent).find((row) => row.levelId === level.id);
  if (offered?.active !== variant || offered.variants[0] === variant) return null;
  // Foundry treats dots as flag path separators. Each variant needs an independent writable key.
  return `variantView_${variant.replaceAll("%", "%25").replaceAll(".", "%2E")}`;
}

function camera(view) {
  if (Number.isFinite(view?.x) && Number.isFinite(view.y) && Number.isFinite(view.scale) && view.scale > 0) {
    return { x: view.x, y: view.y, scale: view.scale };
  }
}

function menuKey(row, forVariant) {
  if (!game.user.isGM || !canvas.ready || canvas.loading || !canvas.level || row.dataset.sceneId !== canvas.scene.id)
    return null;
  const levelId = row.dataset.levelId;
  if (levelId ? levelId !== canvas.level.id : canvas.scene.availableLevels.size > 1) return null;
  return forVariant ? variantViewKey(canvas.level) : "levelView";
}

function viewAction(label, forVariant, clear) {
  return {
    label: `MY_MODULES.Levels.View.${label}`,
    icon: clear ? "fa-solid fa-eraser" : "fa-solid fa-camera",
    visible: (row) => {
      const key = menuKey(row, forVariant);
      return !!key && (!clear || canvas.level.getFlag(MODULE_ID, key) != null);
    },
    onClick: async (_event, row) => {
      const key = menuKey(row, forVariant);
      if (!key) return;
      try {
        if (clear) await canvas.level.unsetFlag(MODULE_ID, key);
        else {
          const { x, y } = canvas.stage.pivot;
          await canvas.level.setFlag(MODULE_ID, key, { x, y, scale: canvas.stage.scale.x });
        }
        ui.notifications.info(`MY_MODULES.Levels.View.${clear ? "Cleared" : "Saved"}`, { localize: true });
      } catch (error) {
        ui.notifications.error(error.message);
      }
    }
  };
}

export function setupLevelViews() {
  Hooks.on("getSceneContextOptions", (_app, options) => {
    options.push(
      viewAction("SaveLevel", false, false),
      viewAction("ClearLevel", false, true),
      viewAction("SaveVariant", true, false),
      viewAction("ClearVariant", true, true)
    );
  });

  let lastLevel;
  let lastVariant;
  function enterView(board) {
    const level = board.level;
    if (!level) return;
    const variant = variantViewKey(level);
    if (lastLevel === level && lastVariant === variant) return;
    lastLevel = level;
    lastVariant = variant;
    const view =
      (variant && camera(level.getFlag(MODULE_ID, variant))) ?? camera(level.getFlag(MODULE_ID, "levelView"));
    if (view) board.pan(view);
  }

  Hooks.on("canvasReady", enterView);
  Hooks.on("canvasTearDown", (_board, { nextLevel }) => {
    if (nextLevel !== lastLevel) lastLevel = null;
  });
  Hooks.on("updateScene", (scene, changes) => {
    if (changes.flags && canvas.ready && scene === canvas.scene && lastLevel === canvas.level) enterView(canvas);
  });
}
