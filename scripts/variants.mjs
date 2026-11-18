import { MODULE_ID } from "./constants.mjs";

// The fields a variant switches per document type, and the values that switch it off.
const SWITCHED = {
  Tile: { alpha: 0 },
  AmbientLight: { hidden: true },
  AmbientSound: { hidden: true },
  Wall: { move: 0, sight: 0, light: 0, sound: 0 }
};

const isActiveGM = () => game.users.activeGM?.isSelf === true;
// The variants a document is on in: none means always on. The base state's name means on in the base state.
const variantsOf = (doc) => [doc.getFlag(MODULE_ID, "variant") ?? []].flat().filter(Boolean);
const levelIdsOf = (scene, doc) => (doc.levels.size ? [...doc.levels] : scene.levels.map((l) => l.id));

export const baseName = (scene) =>
  scene.getFlag(MODULE_ID, "defaultName") ?? game.i18n.localize("MY_MODULES.Variants.Default");

function* variantDocuments(scene) {
  for (const type of Object.keys(SWITCHED)) {
    for (const doc of scene.getEmbeddedCollection(type)) yield { type, doc };
  }
}

export function getVariants(scene) {
  const base = baseName(scene);
  const active = scene.getFlag(MODULE_ID, "active") ?? {};
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

// Brings every variant-bound document of the scene to the state its levels' active variants ask for.
// Runs on the active GM only, so two clients never save each other's switched-off values as the ones to restore.
export async function syncVariants(scene) {
  if (!isActiveGM()) return;
  const activeOn = new Map(getVariants(scene).map((v) => [v.levelId, v.active]));
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
  for (const [type, list] of Object.entries(updates)) await scene.updateEmbeddedDocuments(type, list);
}

export async function setVariant(scene, levelId, name, { linked = false } = {}) {
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
  "levels" in changes;

export function setupVariants(onChange) {
  const pending = new Map();
  const queueSync = (scene) => {
    if (!isActiveGM()) return;
    clearTimeout(pending.get(scene.id));
    pending.set(
      scene.id,
      setTimeout(() => {
        pending.delete(scene.id);
        syncVariants(scene);
      }, 100)
    );
  };

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
