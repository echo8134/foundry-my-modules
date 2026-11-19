import { MODULE_ID } from "../constants.mjs";
import { actionGroups } from "./groups.mjs";

const ENABLED = "actionHudEnabled";
const POSITIONS = "actionHudPositions";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function selectedActor() {
  if (!canvas?.ready || !game.settings.get(MODULE_ID, ENABLED)) return null;
  const actor = canvas.tokens.controlled[0]?.actor;
  return actor?.isOwner ? actor : null;
}

const dialogOptions = (event) => (event.shiftKey ? { configure: false } : {});

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
    const actor = selectedActor();
    return actor?.uuid === target.closest("[data-actor]")?.dataset.actor ? actor : null;
  }

  async _prepareContext() {
    const actor = selectedActor();
    if (!actor) return {};
    if (this.actorId !== actor.uuid) this.group = null;
    this.actorId = actor.uuid;
    const groups = actionGroups(actor);
    return { actor, groups, open: groups.find((g) => g.id === this.group) };
  }

  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    this.saved = game.settings.get(MODULE_ID, POSITIONS)[game.user.id];
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
      const button = e.target.closest('[data-action="item"], [data-action="condition"][data-id="exhaustion"]');
      if (!button) return;
      e.preventDefault();
      const actor = this.currentActor(button);
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
    this.layout();
  }

  _onClose(options) {
    this.observer?.disconnect();
    super._onClose(options);
  }

  layout(position = this.saved) {
    const el = this.element;
    if (!el?.isConnected) return;
    const gap = 8;
    const bounds = (id) => document.getElementById(id)?.getBoundingClientRect();
    const hotbar = bounds("hotbar");
    const left = (bounds("ui-left-column-1")?.right ?? 0) + gap;
    const right = (bounds("ui-right")?.left ?? innerWidth) - gap;
    const bottom = hotbar?.height ? hotbar.top - 16 : innerHeight - gap;
    el.style.maxWidth = `${Math.max(0, right - left)}px`;
    const { width, height } = el.getBoundingClientRect();
    const center = hotbar?.width ? hotbar.left + hotbar.width / 2 : (left + right) / 2;
    const x = Math.clamp(position?.x ?? center - width / 2, left, Math.max(left, right - width));
    const y = Math.clamp(position?.y ?? bottom - height, gap, Math.max(gap, bottom - height));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
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
    const hud = new ActionHud();
    const refresh = foundry.utils.debounce(() => {
      if (selectedActor()) hud.render({ force: true });
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
    game.settings.register(MODULE_ID, POSITIONS, { scope: "client", config: false, type: Object, default: {} });
    game.keybindings.register(MODULE_ID, "actionHud", {
      name: "MY_MODULES.ActionHud.toggle",
      editable: [{ key: "KeyH", modifiers: ["Alt"] }],
      onDown: () => {
        game.settings.set(MODULE_ID, ENABLED, !game.settings.get(MODULE_ID, ENABLED));
        return true;
      }
    });
    Hooks.on("canvasReady", refresh);
    Hooks.on("controlToken", refresh);
    Hooks.on("updateUser", (user, changes) => {
      if (user.isSelf && "role" in changes) refresh();
    });
    Hooks.on("canvasTearDown", () => hud.close({ animate: false }));
    for (const action of ["create", "update", "delete"]) {
      for (const type of ["Actor", "Item", "ActiveEffect", "Token"]) {
        const hook = `${action}${type}`;
        Hooks.on(hook, (doc, changes) => {
          if (hook === "updateToken" && !("actorId" in changes || "actorLink" in changes || "delta" in changes)) return;
          const token = canvas?.tokens?.controlled[0];
          if (!token) return;
          for (let parent = doc; parent; parent = parent.parent) {
            if (
              parent === token.document ||
              (parent.documentName === "Actor" && parent.id === token.document.actorId)
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
