import { MODULE_ID } from "./constants.mjs";
import { setupVariantTokenControls } from "./variant-token-controls.mjs";

// The fields a variant switches per document type, and the values that switch it off.
const SWITCHED = {
  Tile: { alpha: 0 },
  AmbientLight: { hidden: true },
  AmbientSound: { hidden: true },
  Wall: { move: 0, sight: 0, light: 0, sound: 0 },
  Token: { hidden: true }
};

const isActiveGM = () => game.users.activeGM?.isSelf === true;
// The variants a document is on in: none means always on. The base state's name means on in the base state.
const variantNames = (variant) => [variant ?? []].flat().filter(Boolean);
const variantsOf = (doc) => variantNames(doc.getFlag(MODULE_ID, "variant"));
function levelIdsOf(scene, doc) {
  if (doc.documentName === "Token") return [doc.level];
  return doc.levels.size ? doc.levels : scene.levels.keys();
}

export const baseName = (scene, flags = scene.flags[MODULE_ID]) =>
  flags?.defaultName ?? game.i18n.localize("MY_MODULES.Variants.Default");

function* variantDocuments(scene) {
  for (const type of Object.keys(SWITCHED)) {
    for (const doc of scene.getEmbeddedCollection(type)) yield { type, doc };
  }
}

export function getVariants(scene, flags = scene.flags[MODULE_ID]) {
  const base = baseName(scene, flags);
  const active = flags?.active ?? {};
  const byLevel = new Map(scene.levels.map((l) => [l.id, [base]]));
  for (const { doc } of variantDocuments(scene)) {
    for (const name of variantsOf(doc)) {
      for (const id of levelIdsOf(scene, doc)) {
        const names = byLevel.get(id);
        if (names && !names.includes(name)) names.push(name);
      }
    }
  }
  return scene.levels.contents
    .filter((level) => byLevel.get(level.id).length > 1)
    .map((level) => {
      const variants = byLevel.get(level.id);
      const chosen = active[level.id];
      return { levelId: level.id, name: level.name, variants, active: variants.includes(chosen) ? chosen : base };
    });
}

function documentUpdate(type, doc, on) {
  const restore = doc.getFlag(MODULE_ID, "restore");
  const off = SWITCHED[type];
  if (on) return restore ? { _id: doc.id, ...restore, [`flags.${MODULE_ID}.restore`]: _del } : null;
  const drift = Object.entries(off).filter(([field, value]) => doc[field] !== value);
  if (restore) return drift.length ? { _id: doc.id, ...Object.fromEntries(drift) } : null;
  const saved = Object.fromEntries(Object.keys(off).map((field) => [field, doc[field]]));
  return { _id: doc.id, ...off, [`flags.${MODULE_ID}.restore`]: saved };
}

function flagsAfter(doc, changes) {
  if (!changes.flags) return doc.flags[MODULE_ID] ?? {};
  const { flags } = foundry.utils.mergeObject(
    { flags: doc.flags },
    { flags: changes.flags },
    {
      inplace: false,
      applyOperators: true
    }
  );
  return flags?.[MODULE_ID] ?? {};
}

function activeByLevel(scene, flags = scene.flags[MODULE_ID]) {
  return new Map(getVariants(scene, flags).map((v) => [v.levelId, v.active]));
}

// The same scene update publishes the selected variant and the corresponding token visibility to every client.
function sceneTokenUpdates(scene, flags = scene.flags[MODULE_ID]) {
  const updates = [];
  if (!scene.tokens.some((t) => variantsOf(t).length || t.getFlag(MODULE_ID, "restore"))) return updates;
  const active = activeByLevel(scene, flags);
  for (const token of scene.tokens) {
    const names = variantsOf(token);
    const on = !names.length || names.includes(active.get(token.level) ?? baseName(scene, flags));
    const update = documentUpdate("Token", token, on);
    if (update) updates.push(foundry.utils.expandObject(update));
  }
  return updates;
}

function preUpdateScene(scene, changes) {
  if (!changes.flags || !scene.tokens.size) return;
  const flags = flagsAfter(scene, changes);
  if (foundry.utils.equals(flags, scene.flags[MODULE_ID] ?? {})) return;
  const updates = sceneTokenUpdates(scene, flags);
  if (!updates.length) return;
  changes.tokens ??= [];
  for (const update of updates) {
    const existing = changes.tokens.find((t) => t._id === update._id);
    if (existing) foundry.utils.mergeObject(existing, update);
    else changes.tokens.push(update);
  }
}

function applyTokenVisibility(token, changes) {
  const flags = flagsAfter(token, changes);
  const names = variantNames(flags.variant);
  if (!names.length && !flags.restore) return;
  const scene = token.parent;
  const level = changes.level ?? token.level;
  const selected = scene.getFlag(MODULE_ID, "active")?.[level];
  const active = names.includes(selected) ? selected : (activeByLevel(scene).get(level) ?? baseName(scene));
  const hidden = changes.hidden ?? flags.restore?.hidden ?? token.hidden;
  if (names.length && !names.includes(active)) {
    changes.hidden = true;
    foundry.utils.setProperty(changes, `flags.${MODULE_ID}.restore`, { hidden });
  } else if (flags.restore) {
    changes.hidden = hidden;
    foundry.utils.setProperty(changes, `flags.${MODULE_ID}.restore`, _del);
  }
}

// Brings every variant-bound document of the scene to the state its levels' active variants ask for.
// Runs on the active GM only, so two clients never save each other's switched-off values as the ones to restore.
export async function syncVariants(scene) {
  if (!isActiveGM()) return;
  const activeOn = activeByLevel(scene);
  const updates = {};
  for (const { type, doc } of variantDocuments(scene)) {
    const names = variantsOf(doc);
    const on =
      !names.length ||
      Array.from(levelIdsOf(scene, doc)).some((id) => names.includes(activeOn.get(id) ?? baseName(scene)));
    const update = documentUpdate(type, doc, on);
    if (!update) continue;
    updates[type] ??= [];
    updates[type].push(update);
  }
  for (const [type, list] of Object.entries(updates)) {
    await scene.updateEmbeddedDocuments(type, list, { [MODULE_ID]: { sync: true } });
  }
}

const sceneQueues = new WeakMap();
function enqueue(scene, fn, ...args) {
  if (!sceneQueues.has(scene)) sceneQueues.set(scene, new foundry.utils.Semaphore());
  return sceneQueues.get(scene).add(fn, scene, ...args);
}

export function setVariant(scene, levelId, name, options) {
  return enqueue(scene, switchVariant, levelId, name, options);
}

async function switchVariant(scene, levelId, name, { linked = false } = {}) {
  if (!game.user.isGM) throw new Error(`${MODULE_ID} | only a Gamemaster can switch variants`);
  const levels = getVariants(scene);
  const active = { ...(scene.getFlag(MODULE_ID, "active") ?? {}) };
  const allLevels = linked || !levelId;
  if (name === baseName(scene)) {
    for (const level of levels) if (allLevels || level.levelId === levelId) delete active[level.levelId];
  } else {
    const targets = levels.filter((l) => l.variants.includes(name) && (allLevels || l.levelId === levelId));
    if (!targets.length) throw new Error(`${MODULE_ID} | no level offers the variant "${name}"`);
    for (const level of targets) active[level.levelId] = name;
  }
  await scene.update({ [`flags.${MODULE_ID}.active`]: _replace(active) }, { [MODULE_ID]: { variant: true } });
  if (isActiveGM()) await syncVariants(scene);
}

const touchesVariants = (changes) =>
  foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.variant`) ||
  foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.-=variant`) ||
  "levels" in changes ||
  "level" in changes;

export function setupVariants(onChange) {
  const pending = new Map();
  const queueSync = (scene) => {
    if (!isActiveGM()) return;
    clearTimeout(pending.get(scene.id));
    pending.set(
      scene.id,
      setTimeout(() => {
        pending.delete(scene.id);
        enqueue(scene, syncVariants);
      }, 100)
    );
  };

  setupVariantTokenControls();
  Hooks.on("preCreateScene", (scene) => {
    const tokens = sceneTokenUpdates(scene);
    if (tokens.length) scene.updateSource({ tokens });
  });
  Hooks.on("preUpdateScene", preUpdateScene);
  Hooks.on("preCreateToken", (token) => {
    const changes = {};
    applyTokenVisibility(token, changes);
    if ("hidden" in changes) token.updateSource(changes);
  });
  Hooks.on("preUpdateToken", (token, changes, options) => {
    if (!options[MODULE_ID]?.sync && ("hidden" in changes || "flags" in changes || "level" in changes)) {
      applyTokenVisibility(token, changes);
    }
  });
  Hooks.on("canvasReady", (canvas) => canvas.scene && queueSync(canvas.scene));
  Hooks.on("updateScene", (scene, changes, options, userId) => {
    const state = foundry.utils.getProperty(changes, `flags.${MODULE_ID}`);
    if (!state) return;
    onChange();
    const fromSetVariant = options[MODULE_ID]?.variant && userId === game.user.id;
    if (!fromSetVariant) queueSync(scene);
  });
  for (const type of Object.keys(SWITCHED)) {
    Hooks.on(`create${type}`, (doc) => {
      if (variantsOf(doc).length) {
        onChange();
        queueSync(doc.parent);
      }
    });
    Hooks.on(`update${type}`, (doc, changes) => {
      if (touchesVariants(changes)) {
        onChange();
        queueSync(doc.parent);
      }
    });
    Hooks.on(`delete${type}`, (doc) => variantsOf(doc).length && onChange());
  }
}
