import { showsDeathSaves } from "./action-hud/death-saves.mjs";
import { MODULE_ID } from "./constants.mjs";
import { canViewDeathTray, canViewOwnDeathSaves } from "./death-saves.mjs";

const SETTING = "showDeathSaveCounters";
const BADGE = "my-token-death-saves";

export function deathSaveMarks(actor) {
  if (!game.settings.get(MODULE_ID, SETTING) || !showsDeathSaves(actor)) return null;
  if (!(game.user.isGM ? canViewDeathTray(actor) : canViewOwnDeathSaves(actor))) return null;
  if (actor.type === "npc" && !actor.system.traits.important && !Object.keys(actor.classes).length) return null;
  const { success, failure } = actor.system.attributes.death;
  const pips = (count) => "●".repeat(count) + "○".repeat(3 - count);
  return {
    success: pips(success),
    failure: pips(failure),
    label: game.i18n.format("MY_MODULES.DeathSaves.Counters", { success, failure })
  };
}

function positionBadge(token, badge) {
  const { nameplate, bounds } = token;
  const bottom = nameplate?.visible ? bounds.y + nameplate.y + nameplate.height : bounds.bottom;
  badge.style.left = `${token.center.x}px`;
  badge.style.top = `${bottom}px`;
  badge.hidden = !token.visible || !token.renderable || token.document.alpha === 0;
}

function clearBadges() {
  for (const badge of document.querySelectorAll(`#hud > .${BADGE}`)) badge.remove();
}

function refreshBadges() {
  if (!canvas?.ready || !canvas.hud.rendered) return;
  const hud = canvas.hud.element;
  const badges = document.createDocumentFragment();
  if (game.user.isGM && game.settings.get(MODULE_ID, SETTING)) {
    for (const token of canvas.tokens.placeables) {
      const marks = deathSaveMarks(token.actor);
      if (!marks) continue;
      const badge = document.createElement("div");
      badge.id = `${BADGE}-${token.id}`;
      badge.className = `${BADGE} my-death-save-marks`;
      badge.dataset.success = marks.success;
      badge.dataset.failure = marks.failure;
      badge.setAttribute("role", "img");
      badge.setAttribute("aria-label", marks.label);
      const skull = document.createElement("i");
      skull.className = "fa-solid fa-skull";
      badge.append(skull);
      positionBadge(token, badge);
      badges.append(badge);
    }
  }
  clearBadges();
  hud.append(badges);
}

export function setupDeathSaveDisplays() {
  Hooks.once("init", () => {
    if (game.system.id !== "dnd5e") return;
    const changed = `${MODULE_ID}.deathSaveVisibilityChanged`;
    game.settings.register(MODULE_ID, SETTING, {
      name: "MY_MODULES.DeathSaves.ShowCounters",
      hint: "MY_MODULES.DeathSaves.ShowCountersHint",
      scope: "world",
      config: true,
      type: Boolean,
      default: false,
      onChange: () => Hooks.callAll(changed)
    });
    const refresh = foundry.utils.debounce(refreshBadges, 25);
    Hooks.on(changed, refresh);
    Hooks.on("canvasReady", refresh);
    Hooks.on("canvasTearDown", clearBadges);
    Hooks.on("renderHeadsUpDisplayContainer", refresh);
    for (const type of ["Actor", "Token", "ActiveEffect", "Item"]) {
      for (const action of ["create", "update", "delete"]) {
        Hooks.on(`${action}${type}`, () => {
          if (game.user.isGM && game.settings.get(MODULE_ID, SETTING)) refresh();
        });
      }
    }
    Hooks.on("refreshToken", (token) => {
      if (!game.user.isGM || token.isPreview) return;
      const badge = document.getElementById(`${BADGE}-${token.id}`);
      if (badge) positionBadge(token, badge);
    });
  });
}
