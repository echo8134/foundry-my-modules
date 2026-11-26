import { ringRadius, slotOffsets } from "./layout.mjs";
import { glanceSettings } from "./settings.mjs";
import { readBadge } from "./stats.mjs";

const ID = "my-party-glance";
const BADGE = ".my-party-glance-badge";
const HOVER_GRACE = 250;
const rings = new Map();
let hovered = null;
let releaseTimer;

const TARGETS = {
  select: () => canvas.tokens.controlled,
  hover: () => (hovered ? [hovered] : []),
  combat: () => {
    const combat = game.combats.viewed;
    if (!combat?.started) return TARGETS.select();
    return combat.combatants.map((combatant) => combatant.token?.object).filter(Boolean);
  }
};

function eligible(token, settings) {
  const actor = token.actor;
  if (!actor || token.destroyed) return false;
  if (actor.hasPlayerOwner) return settings.players;
  return settings.friendlyNpcs && token.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY;
}

function element(tag, className, children = []) {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}

const span = (className, content) => element("span", className, [String(content)]);

const CONTENT = {
  number: (badge) => [span("value", badge.value)],
  bar: (badge) => {
    const ratio = badge.max > 0 ? Math.clamp(badge.value / badge.max, 0, 1) : 0;
    const fill = element("span", "fill");
    fill.style.width = `${Math.round(ratio * 100)}%`;
    return [
      span("value", `${badge.value}/${badge.max}`),
      ...(badge.temp ? [span("temp", `+${badge.temp}`)] : []),
      element("span", "track", [fill])
    ];
  },
  marker: () => [],
  pips: (badge) => [
    element(
      "span",
      "pips",
      badge.groups.map((group) =>
        element(
          "span",
          "pip-group",
          Array.from({ length: group.total }, (_, i) => {
            const pip = element("span", `pip${i < group.on ? " on" : ""}`);
            pip.dataset.tone = group.tone;
            return pip;
          })
        )
      )
    )
  ]
};

function badgeElement(badge, number, settings) {
  const faded = badge.missing || (badge.kind === "marker" && !badge.on);
  const classes = ["my-party-glance-badge", badge.kind];
  if (faded) classes.push("faded");
  if (badge.kind === "marker" && badge.on) classes.push("on");
  const label = badge.labelled || settings.labels ? [span("label", badge.abbr)] : [];
  const node = element("div", classes.join(" "), [
    element("i", `fa-solid ${badge.icon}`),
    ...label,
    ...CONTENT[badge.kind](badge)
  ]);
  node.dataset.slot = number;
  node.dataset.stat = badge.stat;
  node.dataset.tone = badge.tone ?? "";
  node.dataset.tooltipText = badge.tooltip;
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", badge.tooltip);
  return node;
}

function overlay() {
  let root = document.getElementById(ID);
  if (root) return root;
  root = element("div", "");
  root.id = ID;
  // Directly before the canvas HUD container: above the board, below the interface and windows.
  document.getElementById("hud").before(root);
  root.addEventListener("pointerover", (event) => {
    if (event.target.closest(BADGE)) clearTimeout(releaseTimer);
  });
  root.addEventListener("pointerout", (event) => {
    if (event.target.closest(BADGE) && hovered) releaseHover();
  });
  return root;
}

function releaseHover() {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    hovered = null;
    refresh();
  }, HOVER_GRACE);
}

function ensureRing(token, settings) {
  let ring = rings.get(token.id);
  if (ring?.token !== token) {
    ring?.element.remove();
    ring = { token, element: element("div", "my-party-glance-ring"), signature: "", geometry: "" };
    ring.element.dataset.token = token.id;
    rings.set(token.id, ring);
    overlay().append(ring.element);
  }
  const options = { tempHp: settings.tempHp };
  const badges = settings.slots
    .slice(0, settings.count)
    .map((slot, i) => (slot.stat ? { number: i + 1, badge: readBadge(token.actor, slot, options) } : null));
  const signature = JSON.stringify([settings.labels, badges]);
  ring.distance = settings.distance;
  if (signature === ring.signature) return;
  ring.signature = signature;
  ring.geometry = "";
  ring.count = settings.count;
  ring.element.replaceChildren(
    ...badges.filter(Boolean).map(({ number, badge }) => badgeElement(badge, number, settings))
  );
}

function place(ring) {
  const { token } = ring;
  const view = canvas.app.view.getBoundingClientRect();
  const scale = canvas.stage.scale.x;
  const center = canvas.stage.worldTransform.apply(token.center);
  const x = Math.round(view.left + center.x);
  const y = Math.round(view.top + center.y);
  const diameter = Math.round(Math.min(token.w, token.h) * scale);
  const radius = ringRadius(diameter, ring.count, ring.distance);
  const geometry = `${x},${y},${radius}`;
  if (geometry === ring.geometry) return;
  if (!ring.geometry.endsWith(`,${radius}`)) {
    const offsets = slotOffsets(ring.count, radius);
    for (const badge of ring.element.children) {
      const { dx, dy } = offsets[badge.dataset.slot - 1];
      badge.style.setProperty("--dx", `${dx}px`);
      badge.style.setProperty("--dy", `${dy}px`);
    }
  }
  ring.geometry = geometry;
  ring.element.style.transform = `translate(${x}px, ${y}px)`;
}

function tick() {
  for (const ring of rings.values()) place(ring);
}

function clearRings() {
  clearTimeout(releaseTimer);
  hovered = null;
  rings.clear();
  document.getElementById(ID)?.remove();
}

function sync() {
  if (!game.user.isGM || !canvas?.ready) return;
  const settings = glanceSettings();
  const wanted = new Map(
    TARGETS[settings.trigger]()
      .filter((token) => eligible(token, settings))
      .map((token) => [token.id, token])
  );
  for (const [id, ring] of rings) {
    if (wanted.has(id)) continue;
    ring.element.remove();
    rings.delete(id);
  }
  for (const token of wanted.values()) ensureRing(token, settings);
  tick();
}

export const refresh = foundry.utils.debounce(sync, 25);

function showsActor(document) {
  for (let doc = document; doc; doc = doc.parent) {
    for (const { token } of rings.values()) {
      if (
        doc === token.document ||
        (doc.documentName === "Actor" && (doc === token.actor || doc.id === token.document.actorId))
      ) {
        return true;
      }
    }
  }
  return false;
}

export function watchRings() {
  const start = () => {
    canvas.app.ticker.add(tick);
    sync();
  };
  Hooks.on("canvasReady", start);
  Hooks.on("canvasTearDown", () => {
    canvas.app.ticker.remove(tick);
    clearRings();
  });
  Hooks.on("controlToken", refresh);
  Hooks.on("hoverToken", (token, isHovered) => {
    clearTimeout(releaseTimer);
    if (isHovered) {
      hovered = token;
      refresh();
    } else if (hovered === token) releaseHover();
  });
  for (const action of ["create", "update", "delete"]) {
    for (const type of ["Actor", "Item", "ActiveEffect"]) {
      Hooks.on(`${action}${type}`, (doc) => {
        if (showsActor(doc)) refresh();
      });
    }
    for (const type of ["Token", "Combat", "Combatant"]) Hooks.on(`${action}${type}`, refresh);
  }
  Hooks.on("updateUser", refresh);
  if (canvas?.ready) start();
}
