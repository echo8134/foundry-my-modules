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
  return doc.levels.size ? [...doc.levels] : scene.levels.map((level) => level.id);
}

export const baseName = (scene, flags = scene.flags[MODULE_ID]) =>
  flags?.defaultName ?? game.i18n.localize("MY_MODULES.Variants.Default");

function needsBaseName(scene) {
  return scene.getFlag(MODULE_ID, "defaultName") == null && scene.tokens.some((token) => variantsOf(token).length);
}

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

function tokenVisibility(hidden, restore, on, intended) {
  const change = {};
  if (hidden !== (!on || intended)) change.hidden = !on || intended;
  if (!on && restore?.hidden !== intended)
    foundry.utils.setProperty(change, `flags.${MODULE_ID}.restore`, { hidden: intended });
  if (on && restore) foundry.utils.setProperty(change, `flags.${MODULE_ID}.restore`, _del);
  return change;
}

// The same scene update publishes the selected variant and the corresponding token visibility to every client.
function prepareSceneTokens(scene, changes) {
  const edits = foundry.data.operators.DataFieldOperator.get(changes.tokens);
  if ("tokens" in changes && !edits) return;
  const byId = new Map();
  for (const edit of edits ?? []) {
    edit._id ??= foundry.utils.randomID();
    byId.set(edit._id, edit);
  }

  // A parent update can retag, move or create tokens without running the embedded document hooks.
  let next = scene;
  if (edits) {
    next = scene.clone({}, { keepId: true });
    next.updateSource(changes);
  }
  if (!next.tokens.size) return;
  const flags = flagsAfter(scene, changes);
  const active = activeByLevel(next, flags);
  for (const token of next.tokens) {
    const names = variantsOf(token);
    const restore = token.getFlag(MODULE_ID, "restore");
    const previous = scene.tokens.get(token.id)?.getFlag(MODULE_ID, "restore");
    if (!names.length && !restore && !previous) continue;
    const edit = byId.get(token.id);
    const on = !names.length || names.includes(active.get(token.level) ?? baseName(next, flags));
    // A copied token's restore flag already carries its GM's choice, even when its source hidden field is true.
    const intended =
      edit?.flags?.[MODULE_ID]?.restore?.hidden ?? edit?.hidden ?? restore?.hidden ?? previous?.hidden ?? token.hidden;
    const patch = tokenVisibility(token.hidden, restore, on, intended);
    if (foundry.utils.isEmpty(patch)) continue;
    if (edit) foundry.utils.mergeObject(edit, patch);
    else {
      changes.tokens ??= [];
      changes.tokens.push({ _id: token.id, ...patch });
    }
  }
}

function applyTokenVisibility(token, changes) {
  const flags = flagsAfter(token, changes);
  const names = variantNames(flags.variant);
  const previous = token.getFlag(MODULE_ID, "restore");
  if (!names.length && !flags.restore && !previous) return;
  const scene = token.parent;
  const level = changes.level ?? token.level;
  const selected = scene.getFlag(MODULE_ID, "active")?.[level];
  const active = names.includes(selected) ? selected : (activeByLevel(scene).get(level) ?? baseName(scene));
  const on = !names.length || names.includes(active);
  const hidden = changes.hidden ?? token._source.hidden;
  const intended = changes.hidden ?? flags.restore?.hidden ?? previous?.hidden ?? token._source.hidden;
  foundry.utils.mergeObject(changes, tokenVisibility(hidden, flags.restore, on, intended));
}

function hideBeforeSync(token, levels) {
  const names = variantsOf(token);
  if (!names.length) return false;
  const flags = token.parent.flags[MODULE_ID];
  const selected = flags?.active?.[token.level];
  let active = flags?.defaultName;
  if (selected) {
    const level = (levels ?? getVariants(token.parent)).find((entry) => entry.levelId === token.level);
    if (level?.variants.includes(selected)) active = selected;
  }
  // Before the GM records the base name, its translation can differ on this client.
  return !names.includes(active);
}

// Old scenes may still contain visible source tokens until a GM opens them. Mask only the prepared player document.
let maskedScene;
function guardLegacyTokens({ scene }) {
  maskedScene = null;
  if (game.user.isGM || !scene.tokens.size) return;
  const levels = getVariants(scene);
  for (const token of scene.tokens) {
    if (token._source.hidden || !hideBeforeSync(token, levels)) continue;
    maskedScene = scene;
    if (token.hidden) continue;
    const prepare = token.prepareBaseData;
    token.prepareBaseData = function (...args) {
      if (!this._source.hidden && hideBeforeSync(this)) this.hidden = true;
      else delete this.prepareBaseData;
      return prepare.apply(this, args);
    };
    token.reset();
  }
}

// Brings every variant-bound document of the scene to the state its levels' active variants ask for.
// Runs on the active GM only, so two clients never save each other's switched-off values as the ones to restore.
export async function syncVariants(scene) {
  if (!isActiveGM()) return;
  const activeOn = activeByLevel(scene);
  const selected = scene.getFlag(MODULE_ID, "active") ?? {};
  const expired = Object.keys(selected).filter((id) => selected[id] !== activeOn.get(id));
  const flagChanges = {};
  // A localized base name becomes a shared data key once tokens use variants.
  if (needsBaseName(scene)) flagChanges.defaultName = baseName(scene);
  if (expired.length) {
    flagChanges.active = Object.fromEntries(expired.map((id) => [id, _del]));
  }
  if (!foundry.utils.isEmpty(flagChanges)) {
    await scene.update({ [`flags.${MODULE_ID}`]: flagChanges }, { [MODULE_ID]: { variant: true } });
  }
  const updates = {};
  for (const { type, doc } of variantDocuments(scene)) {
    const names = variantsOf(doc);
    const on =
      !names.length || levelIdsOf(scene, doc).some((id) => names.includes(activeOn.get(id) ?? baseName(scene)));
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
    const changes = {};
    if (needsBaseName(scene)) changes.flags = { [MODULE_ID]: { defaultName: baseName(scene) } };
    prepareSceneTokens(scene, changes);
    if (!foundry.utils.isEmpty(changes)) scene.updateSource(changes);
  });
  Hooks.on("preUpdateScene", (scene, changes) => {
    if (
      "tokens" in changes ||
      ("flags" in changes && !foundry.utils.equals(flagsAfter(scene, changes), scene.flags[MODULE_ID] ?? {}))
    )
      prepareSceneTokens(scene, changes);
  });
  Hooks.on("preCreateToken", (token) => {
    const changes = {};
    applyTokenVisibility(token, changes);
    if (!foundry.utils.isEmpty(changes)) token.updateSource(changes);
  });
  Hooks.on("preUpdateToken", (token, changes, options) => {
    if (!options[MODULE_ID]?.sync && ("hidden" in changes || "flags" in changes || "level" in changes)) {
      applyTokenVisibility(token, changes);
    }
  });
  Hooks.on("canvasInit", guardLegacyTokens);
  Hooks.on("canvasReady", (canvas) => canvas.scene && queueSync(canvas.scene));
  Hooks.on("updateScene", (scene, changes, options, userId) => {
    const state = foundry.utils.getProperty(changes, `flags.${MODULE_ID}`);
    if (!state) return;
    // A flag-only switch can release a legacy mask without Foundry redrawing the token layer.
    if (scene === maskedScene && scene === canvas.scene && !changes.tokens) canvas.draw();
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
    Hooks.on(`delete${type}`, (doc) => {
      if (variantsOf(doc).length) {
        onChange();
        queueSync(doc.parent);
      }
    });
  }
}
