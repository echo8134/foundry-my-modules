import { MODULE_ID } from "./constants.mjs";

const FORMAT = "tokenNameFormat";

// Names handed out to tokens that are still being created, so a batch of tokens created together stays unique.
const pending = new Map();

const flagOf = (actor) => actor?.getFlag(MODULE_ID, "randomName") ?? null;
// The world actor carries the flag; an unlinked token's own actor is only a synthetic copy of it.
const baseActorOf = (token) => game.actors.get(token.actorId);

const resultName = (result) => result.name?.trim() || (result.description ?? "").replace(/<[^>]*>/g, "").trim();

function weightedPick(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item;
  }
  return items.at(-1);
}

function namesTaken(scene) {
  const taken = new Set(scene?.tokens.map((t) => t.name) ?? []);
  for (const name of pending.get(scene?.id) ?? []) taken.add(name);
  return taken;
}

// Picks a name from one of the actor's tables, avoiding the names in `taken`. Synchronous, so it can run in preCreate.
function pickName(actor, taken = new Set()) {
  const tables = (flagOf(actor)?.tables ?? []).map((uuid) => fromUuidSync(uuid)).filter((t) => t?.results?.size);
  if (!tables.length) return null;
  // Every table is equally likely, so a guard with two cultures draws from both alike, however long each list is.
  const candidates = tables.flatMap((table) => {
    const total = table.results.reduce((sum, r) => sum + r.weight, 0);
    return table.results.map((result) => ({ name: resultName(result), weight: result.weight / total }));
  });
  const free = candidates.filter((c) => c.name && !taken.has(c.name) && !taken.has(formatName(c.name, actor)));
  return weightedPick(free.length ? free : candidates.filter((c) => c.name))?.name ?? null;
}

function formatName(name, actor) {
  return game.settings
    .get(MODULE_ID, FORMAT)
    .replaceAll("{name}", name)
    .replaceAll("{actor}", actor.prototypeToken.name || actor.name);
}

export function rollName(actor, scene = canvas.scene) {
  const name = pickName(actor, namesTaken(scene));
  return name ? formatName(name, actor) : null;
}

function reserve(scene, name) {
  const names = pending.get(scene.id) ?? new Set();
  names.add(name);
  pending.set(scene.id, names);
  setTimeout(() => {
    names.delete(name);
    if (!names.size) pending.delete(scene.id);
  }, 2000);
}

function onPreCreateToken(token, data) {
  const actor = baseActorOf(token);
  if (!game.user.isGM || token.actorLink || !flagOf(actor)) return;
  if (data.name && data.name !== actor.prototypeToken.name) return;
  const name = rollName(actor, token.parent);
  if (!name) return;
  token.updateSource({ name });
  reserve(token.parent, name);
}

async function reroll(token) {
  const name = rollName(baseActorOf(token), token.parent);
  if (name) await token.update({ name });
}

function addHudButton(hud, element) {
  const token = hud.document;
  if (!game.user.isGM || token.actorLink || !flagOf(baseActorOf(token))) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "control-icon my-reroll-name";
  button.dataset.tooltipText = game.i18n.localize("MY_MODULES.Names.Reroll");
  button.innerHTML = `<i class="fa-solid fa-dice" inert></i>`;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    reroll(token);
  });
  element.querySelector(".col.left")?.append(button);
}

export function setupNames() {
  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, FORMAT, {
      name: "MY_MODULES.Names.Format.Name",
      hint: "MY_MODULES.Names.Format.Hint",
      scope: "world",
      config: true,
      type: String,
      default: "{name}"
    });
  });
  Hooks.on("preCreateToken", onPreCreateToken);
  Hooks.on("renderTokenHUD", addHudButton);
}
