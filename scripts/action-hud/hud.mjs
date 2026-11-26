import english from "../../lang/en.json" with { type: "json" };
import { MODULE_ID } from "../constants.mjs";
import { HIDDEN_CATEGORIES, HudCategories } from "./categories.mjs";
import { showsDeathSaves, trackStabilization } from "./death-saves.mjs";
import { effectEntries, endHudEffect } from "./effects.mjs";
import { actionGroups } from "./groups.mjs";

const ENABLED = "actionHudEnabled";
const SHOW_EFFECTS = "actionHudShowEffects";
const ALWAYS_SHOW_CHARACTER = "actionHudAlwaysShowCharacter";
const DETACH_HOTBAR = "actionHudDetachHotbar";
const DESIGN = "actionHudDesign";
const POSITIONS = "actionHudPositions";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function controlledToken() {
  return canvas?.ready ? canvas.tokens?.controlled[0] : null;
}

function assignedCharacter() {
  if (game.user.isGM || !game.settings.get(MODULE_ID, ALWAYS_SHOW_CHARACTER)) return null;
  return game.user.character;
}

function resolveActor() {
  if (!game.settings.get(MODULE_ID, ENABLED)) return null;
  const actor = controlledToken()?.actor;
  if (actor?.isOwner) return actor;
  const character = assignedCharacter();
  return character?.isOwner ? character : null;
}

const dialogOptions = (event) => (event.shiftKey ? { configure: false } : {});

function onlyRecordsTokenMovement(changes) {
  if (!changes.flags?.dnd5e?.lastMovedToken) return false;
  return Object.keys(foundry.utils.flattenObject(changes)).every(
    (key) => key === "_id" || key === "flags.dnd5e.lastMovedToken"
  );
}

class ActionHud extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "my-action-hud",
    window: { frame: false, positioned: false },
    actions: {
      group(_event, target) {
        this.group = this.group === target.dataset.group ? null : target.dataset.group;
        this.render();
      },
      item(event, target) {
        this.currentActor(target)?.items.get(target.dataset.id)?.use({ event }, dialogOptions(event));
      },
      check(event, target) {
        this.currentActor(target)?.rollAbilityCheck({ ability: target.dataset.id, event }, dialogOptions(event));
      },
      save(event, target) {
        this.currentActor(target)?.rollSavingThrow({ ability: target.dataset.id, event }, dialogOptions(event));
      },
      skill(event, target) {
        this.currentActor(target)?.rollSkill({ skill: target.dataset.id, event }, dialogOptions(event));
      },
      condition(_event, target) {
        const actor = this.currentActor(target);
        const id = target.dataset.id;
        const level = id !== "exhaustion" && actor?.system.conditions?.[id];
        actor?.toggleStatusEffect(id, level ? { levels: -level } : {});
      },
      endConcentration(_event, target) {
        return endHudEffect(this.currentActor(target), target.dataset.effectUuid, true);
      },
      deathSave(event, target) {
        const actor = this.currentActor(target);
        if (showsDeathSaves(actor)) actor.rollDeathSave({ event }, dialogOptions(event));
      },
      shortRest(event, target) {
        this.currentActor(target)?.shortRest({ dialog: !event.shiftKey });
      },
      longRest(event, target) {
        this.currentActor(target)?.longRest({ dialog: !event.shiftKey });
      }
    }
  };

  static PARTS = {
    bar: { template: `modules/${MODULE_ID}/scripts/action-hud/hud.hbs`, scrollable: [".hud-panel"] }
  };

  currentActor(target) {
    const actor = resolveActor();
    return actor?.uuid === target.closest("[data-actor]")?.dataset.actor ? actor : null;
  }

  async _prepareContext() {
    const actor = resolveActor();
    if (!actor) return {};
    if (this.actorUuid !== actor.uuid) this.group = null;
    this.actorUuid = actor.uuid;
    const hidden = game.settings.get(MODULE_ID, HIDDEN_CATEGORIES);
    const groups = actionGroups(actor).filter((group) => !hidden.includes(group.id));
    const open = groups.find((g) => g.id === this.group);
    this.group = open?.id;
    const deathSave = !hidden.includes("deathSaves") && showsDeathSaves(actor);
    const effects = game.settings.get(MODULE_ID, SHOW_EFFECTS) ? await effectEntries(actor) : [];
    return { actor, groups, open, deathSave, effects, docked: !game.settings.get(MODULE_ID, DETACH_HOTBAR) };
  }

  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    this.saved = game.settings.get(MODULE_ID, POSITIONS)[game.user.id];
    this.element.addEventListener("focusin", ({ target }) => {
      if (target.matches("[data-tooltip-text]:focus-visible")) game.tooltip.activate(target);
    });
    this.element.addEventListener("focusout", ({ target }) => {
      if (game.tooltip.element === target) game.tooltip.deactivate();
    });
    this.element.addEventListener("pointerdown", (e) => {
      if (e.button === 0 && e.isPrimary && e.target.closest(".hud-grip")) this.drag(e);
    });
    this.element.addEventListener("dblclick", (e) => {
      // Pointer capture retargets grip clicks to the persistent application element.
      if (this.saved && document.elementFromPoint(e.clientX, e.clientY)?.closest("#my-action-hud .hud-grip")) {
        this.savePosition();
        this.layout();
      }
    });
    this.element.addEventListener("contextmenu", (e) => {
      const button = e.target.closest(
        '[data-effect-uuid], [data-action="item"], [data-action="condition"][data-id="exhaustion"]'
      );
      if (!button) return;
      e.preventDefault();
      const actor = this.currentActor(button);
      if (button.dataset.effectUuid) return endHudEffect(actor, button.dataset.effectUuid, false);
      if (button.dataset.action === "condition") actor?.toggleStatusEffect("exhaustion", { levels: -1, active: false });
      else actor?.items.get(button.dataset.id)?.sheet.render({ force: true });
    });
    this.observer = new ResizeObserver(() => this.layout());
    for (const id of ["interface", "ui-right", "ui-left-column-1", "hotbar"]) {
      const element = document.getElementById(id);
      if (element) this.observer.observe(element);
    }
    this.observer.observe(this.element);
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.element.classList.toggle("menu-design", game.settings.get(MODULE_ID, DESIGN) === "menu");
    this.layout();
  }

  _onClose(options) {
    this.observer?.disconnect();
    super._onClose(options);
  }

  layout(position = this.saved) {
    const el = this.element;
    if (!this.rendered) return;
    const hiddenHotbar = document.body.classList.contains("my-hide-macro-hotbar");
    const dock =
      !hiddenHotbar && !game.settings.get(MODULE_ID, DETACH_HOTBAR) && document.querySelector("aside#hotbar");
    if (dock) {
      if (el.parentElement !== dock) dock.prepend(el);
      el.classList.remove("opens-down");
      const top = el.getBoundingClientRect().top;
      const scale = game.settings.get("core", "uiConfig").uiScale ?? 1;
      el.style.setProperty("--hud-panel-height", `${Math.max(0, top / scale - 12)}px`);
      return;
    }
    if (el.parentElement !== document.body) document.body.append(el);

    const gap = 8;
    const bounds = (id) => document.getElementById(id)?.getBoundingClientRect();
    const hotbar = bounds("hotbar");
    const left = (bounds("ui-left-column-1")?.right ?? 0) + gap;
    const right = (bounds("ui-right")?.left ?? innerWidth) - gap;
    const bottom = hotbar?.width ? hotbar.top - (hotbar.height ? 16 : 0) : innerHeight - gap;
    el.style.setProperty("--hud-max-width", `${Math.max(0, right - left)}px`);
    const { width, height } = el.getBoundingClientRect();
    const center = hotbar?.width ? hotbar.left + hotbar.width / 2 : (left + right) / 2;
    const x = Math.clamp(position?.x ?? center - width / 2, left, Math.max(left, right - width));
    const y = Math.clamp(position?.y ?? bottom - height, gap, Math.max(gap, bottom - height));
    el.style.setProperty("--hud-left", `${x}px`);
    el.style.setProperty("--hud-top", `${y}px`);
    const above = y - 2 * gap;
    const below = bottom - y - height - gap;
    el.classList.toggle("opens-down", above < below);
    el.style.setProperty("--hud-panel-height", `${Math.max(0, above, below)}px`);
    return { x, y };
  }

  savePosition(position) {
    this.saved = position;
    const positions = { ...game.settings.get(MODULE_ID, POSITIONS) };
    if (position) positions[game.user.id] = position;
    else delete positions[game.user.id];
    game.settings.set(MODULE_ID, POSITIONS, positions);
  }

  drag(event) {
    const el = this.element;
    const { left, top } = el.getBoundingClientRect();
    const { pointerId, clientX, clientY } = event;
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    el.setPointerCapture(pointerId);
    let dragging = false;
    const move = (e) => {
      if (e.pointerId !== pointerId) return;
      const dx = e.clientX - clientX;
      const dy = e.clientY - clientY;
      if (!dragging && Math.hypot(dx, dy) <= 4) return;
      dragging = true;
      return this.layout({ x: left + dx, y: top + dy });
    };
    el.addEventListener("pointermove", move, options);
    el.addEventListener(
      "pointerup",
      (e) => {
        const position = move(e);
        if (position) this.savePosition(position);
      },
      options
    );
    el.addEventListener(
      "lostpointercapture",
      () => {
        listeners.abort();
        this.layout();
      },
      { once: true }
    );
  }
}

export function setupActionHud() {
  Hooks.once("init", () => {
    if (game.system.id !== "dnd5e") return;
    trackStabilization();
    const hud = new ActionHud();
    const refresh = foundry.utils.debounce(() => {
      if (resolveActor()) hud.render({ force: true });
      else hud.close({ animate: false });
    }, 25);
    game.settings.register(MODULE_ID, ENABLED, {
      name: "MY_MODULES.ActionHud.enabled",
      hint: "MY_MODULES.ActionHud.hint",
      scope: "client",
      config: true,
      type: Boolean,
      default: true,
      onChange: refresh
    });
    game.settings.register(MODULE_ID, ALWAYS_SHOW_CHARACTER, {
      name: "MY_MODULES.ActionHud.alwaysShowCharacter",
      hint: "MY_MODULES.ActionHud.alwaysShowCharacterHint",
      scope: "client",
      config: true,
      type: Boolean,
      default: true,
      onChange: refresh
    });
    game.settings.register(MODULE_ID, SHOW_EFFECTS, {
      name: "MY_MODULES.ActionHud.showEffects",
      scope: "client",
      config: true,
      type: Boolean,
      default: false,
      onChange: refresh
    });
    game.settings.register(MODULE_ID, DETACH_HOTBAR, {
      name: "MY_MODULES.ActionHud.detachHotbar",
      hint: "MY_MODULES.ActionHud.detachHotbarHint",
      scope: "client",
      config: true,
      type: Boolean,
      default: false,
      onChange: refresh
    });
    game.settings.register(MODULE_ID, DESIGN, {
      name: "MY_MODULES.ActionHud.design",
      hint: "MY_MODULES.ActionHud.designHint",
      scope: "client",
      config: true,
      type: String,
      choices: { wood: "MY_MODULES.ActionHud.designWood", menu: "MY_MODULES.ActionHud.designMenu" },
      default: "wood",
      onChange: refresh
    });
    const storage = game.settings.storage.get("client");
    const legacy = storage.getItem(`${MODULE_ID}.actionHudCombineHotbar`);
    if (storage.getItem(`${MODULE_ID}.${DETACH_HOTBAR}`) === null && (legacy === "true" || legacy === "false")) {
      storage.setItem(`${MODULE_ID}.${DETACH_HOTBAR}`, JSON.stringify(legacy === "false"));
    }
    game.settings.register(MODULE_ID, HIDDEN_CATEGORIES, {
      scope: "user",
      config: false,
      type: Array,
      default: ["conditions", "rests"],
      onChange: refresh
    });
    game.settings.registerMenu(MODULE_ID, "actionHudCategories", {
      name: english["MY_MODULES.ActionHud.title"],
      label: "MY_MODULES.ActionHud.categories",
      icon: "fa-solid fa-list-check",
      type: HudCategories,
      restricted: false
    });
    // Foundry replaces the hotbar's children when paging or assigning a macro.
    Hooks.on("renderHotbar", () => hud.layout());
    Hooks.on(`${MODULE_ID}.hotbarVisibilityChanged`, () => hud.layout());
    game.settings.register(MODULE_ID, POSITIONS, { scope: "client", config: false, type: Object, default: {} });
    game.keybindings.register(MODULE_ID, "actionHud", {
      name: "MY_MODULES.ActionHud.toggle",
      editable: [{ key: "KeyH", modifiers: ["Alt"] }],
      onDown: () => {
        game.settings.set(MODULE_ID, ENABLED, !game.settings.get(MODULE_ID, ENABLED));
        return true;
      }
    });
    Hooks.once("ready", refresh);
    Hooks.on("canvasReady", refresh);
    Hooks.on("canvasTearDown", refresh);
    Hooks.on("controlToken", refresh);
    for (const hook of ["updateWorldTime", "combatTurnChange"]) {
      Hooks.on(hook, () => {
        if (hud.rendered && hud.element.querySelector(".hud-effects")) refresh();
      });
    }
    Hooks.on("updateUser", (user, changes) => {
      if (user.isSelf && ("role" in changes || "character" in changes)) refresh();
    });
    for (const action of ["create", "update", "delete"]) {
      for (const type of ["Actor", "Item", "ActiveEffect", "Token"]) {
        const hook = `${action}${type}`;
        Hooks.on(hook, (doc, changes) => {
          if (hook === "updateToken" && !("actorId" in changes || "actorLink" in changes || "delta" in changes)) return;
          if (hook === "updateActor" && onlyRecordsTokenMovement(changes)) return;
          const token = controlledToken()?.document;
          const character = assignedCharacter();
          for (let parent = doc; parent; parent = parent.parent) {
            if (
              parent === token ||
              (parent.documentName === "Actor" &&
                (parent.id === token?.actorId || parent === character || parent.uuid === hud.actorUuid))
            ) {
              refresh();
              break;
            }
          }
        });
      }
    }
  });
}
