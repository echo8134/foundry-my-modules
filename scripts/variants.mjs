import { MODULE_ID } from "./constants.mjs";
import { setupVariantTokenControls } from "./variant-token-controls.mjs";
import {
  flagsAfter,
  prepareTokenCreate,
  prepareTokenEdit,
  refreshPlayerTokens,
  setupTokenVisibility,
  tokenUpdate,
  variantNames
} from "./variant-tokens.mjs";

const SWITCHED = {
  Tile: { alpha: 0 },
  AmbientLight: { hidden: true },
  AmbientSound: { hidden: true },
  Wall: { move: 0, sight: 0, light: 0, sound: 0 }
};
const TYPES = [...Object.keys(SWITCHED), "Token"];
const SWITCH_QUERY = `${MODULE_ID}.setVariant`;
const isActiveGM = () => game.users.activeGM?.isSelf === true;
const variantsOf = (doc) => variantNames(doc.getFlag(MODULE_ID, "variant"));

function levelIdsOf(scene, doc) {
  if (doc.documentName === "Token") return [doc._source.level];
  return doc.levels.size ? doc.levels : scene.levels.keys();
}

export const baseName = (scene, flags = scene.flags[MODULE_ID]) =>
  flags?.defaultName ?? game.i18n.localize("MY_MODULES.Variants.Default");

function* variantDocuments(scene) {
  for (const type of TYPES) yield* scene.getEmbeddedCollection(type);
}

export function getVariants(scene, flags = scene.flags[MODULE_ID]) {
  const base = baseName(scene, flags);
  const byLevel = new Map(scene.levels.map((level) => [level.id, new Set([base])]));
  for (const doc of variantDocuments(scene)) {
    const names = variantsOf(doc);
    if (!names.length) continue;
    for (const id of levelIdsOf(scene, doc)) {
      const offered = byLevel.get(id);
      for (const name of names) offered?.add(name);
    }
  }
  return scene.levels.contents.flatMap((level) => {
    const names = byLevel.get(level.id);
    if (names.size < 2) return [];
    const chosen = flags?.active?.[level.id];
    return [{ levelId: level.id, name: level.name, variants: [...names], active: names.has(chosen) ? chosen : base }];
  });
}

function documentUpdate(doc, on) {
  if (doc.documentName === "Token") return tokenUpdate(doc, on);
  const restore = doc.getFlag(MODULE_ID, "restore");
  const off = SWITCHED[doc.documentName];
  if (on) return restore ? { _id: doc.id, ...restore, [`flags.${MODULE_ID}.restore`]: _del } : null;
  const drift = Object.entries(off).filter(([field, value]) => doc[field] !== value);
  if (restore) return drift.length ? { _id: doc.id, ...Object.fromEntries(drift) } : null;
  const saved = Object.fromEntries(Object.keys(off).map((field) => [field, doc[field]]));
  return { _id: doc.id, ...off, [`flags.${MODULE_ID}.restore`]: saved };
}

function selections(levels, base) {
  return Object.fromEntries(levels.filter((l) => l.active !== base).map((l) => [l.levelId, l.active]));
}

function switchedOn(scene, doc, active, base) {
  const names = variantsOf(doc);
  if (!names.length) return true;
  for (const id of levelIdsOf(scene, doc)) if (names.includes(active[id] ?? base)) return true;
  return false;
}

const touchesCollections = (scene, changes) =>
  "levels" in changes || TYPES.some((type) => scene.constructor.metadata.embedded[type] in changes);

function addTokenPatch(edit, patch) {
  if ("hidden" in patch) edit.hidden = patch.hidden;
  if (patch.flags) {
    edit.flags ??= {};
    edit.flags[MODULE_ID] ??= {};
    Object.assign(edit.flags[MODULE_ID], patch.flags[MODULE_ID]);
  }
}

// Parent edits bypass embedded pre-update hooks. Project every changed collection before
// deciding which existing tokens have to be concealed in the same database transaction.
function prepareSceneEdit(scene, changes, options) {
  const edits = foundry.data.operators.DataFieldOperator.get(changes.tokens);
  const byId = new Map();
  for (const edit of edits ?? []) {
    edit._id ??= foundry.utils.randomID();
    byId.set(edit._id, edit);
    const token = scene.tokens.get(edit._id);
    if (token) prepareTokenEdit(token, edit, options);
  }

  const next = scene.clone({}, { keepId: true });
  next.updateSource(changes);
  const base = baseName(next);
  const active = selections(getVariants(next), base);
  for (const token of next.tokens) {
    let edit = byId.get(token.id);
    if (!scene.tokens.has(token.id) && edit) {
      const patch = prepareTokenCreate(token);
      if (patch) addTokenPatch(edit, patch);
    }
    if (!switchedOn(next, token, active, base)) {
      const patch = tokenUpdate(token, false);
      if (patch) {
        if (!edit) {
          edit = { _id: token.id };
          changes.tokens ??= [];
          foundry.data.operators.DataFieldOperator.get(changes.tokens).push(edit);
        }
        addTokenPatch(edit, patch);
      }
    }
    if (!edit || !("hidden" in edit) || !variantsOf(token).length) continue;
    // Parent writes also bypass TokenDocument's attached Region propagation.
    for (const region of token.attachments.regions) {
      changes.regions ??= [];
      const regions = foundry.data.operators.DataFieldOperator.get(changes.regions);
      const regionEdit = regions.find((r) => r._id === region.id);
      if (regionEdit) regionEdit.hidden = edit.hidden;
      else regions.push({ _id: region.id, hidden: edit.hidden });
    }
  }
}

const sceneQueues = new WeakMap();
function enqueue(scene, fn, ...args) {
  if (!sceneQueues.has(scene)) sceneQueues.set(scene, new foundry.utils.Semaphore());
  return sceneQueues.get(scene).add(fn, scene, ...args);
}

function requireActiveGM() {
  if (!isActiveGM()) throw new Error(`${MODULE_ID} | the active Gamemaster changed`);
}

function writeBatch(scene, type, updates) {
  requireActiveGM();
  return scene.updateEmbeddedDocuments(type, updates, { animate: false, [MODULE_ID]: { sync: true } });
}

async function reconcile(scene, request) {
  requireActiveGM();
  const sceneFlags = scene.flags[MODULE_ID];
  const selectedFlags = request?.selection
    ? { ...sceneFlags, active: { ...(request.replace ? {} : sceneFlags?.active), ...request.selection } }
    : sceneFlags;
  const levels = getVariants(scene, selectedFlags);
  const base = baseName(scene);
  const active = selections(levels, base);
  if (request && !request.selection) {
    const { levelId, name, linked } = request;
    const targets = levels.filter((l) => (!levelId || linked || levelId === l.levelId) && l.variants.includes(name));
    if (name !== base && !targets.length) throw new Error(`${MODULE_ID} | no level offers the variant "${name}"`);
    for (const level of targets) {
      if (name === base) delete active[level.levelId];
      else active[level.levelId] = name;
    }
  }

  const flags = {};
  const previous = scene.getFlag(MODULE_ID, "active");
  if (request?.remove) {
    if (previous !== undefined) flags.active = _del;
  } else if (!foundry.utils.equals(active, previous ?? {}) || (request?.selection && previous == null)) {
    flags.active = _replace(active);
  }
  if (scene.getFlag(MODULE_ID, "defaultName") == null && scene.tokens.some((t) => variantsOf(t).length)) {
    flags.defaultName = base;
  }
  if (!foundry.utils.isEmpty(flags)) {
    const outgoing = [];
    for (const token of scene.tokens) {
      if (switchedOn(scene, token, active, base)) continue;
      const patch = tokenUpdate(token, false);
      if (patch) outgoing.push(patch);
    }
    if (outgoing.length) await writeBatch(scene, "Token", outgoing);
    requireActiveGM();
    await scene.update({ [`flags.${MODULE_ID}`]: flags }, { [MODULE_ID]: { variant: true } });
  }

  // Read intent after publishing. A GM may have edited it while the hide or selection was in flight.
  const selected = scene.getFlag(MODULE_ID, "active") ?? {};
  for (const type of ["Token", ...Object.keys(SWITCHED)]) {
    const updates = [];
    for (const doc of scene.getEmbeddedCollection(type)) {
      const patch = documentUpdate(doc, switchedOn(scene, doc, selected, base));
      if (patch) updates.push(patch);
    }
    if (updates.length) await writeBatch(scene, type, updates);
  }
  return !foundry.utils.isEmpty(flags);
}

async function requestSelection(scene, request) {
  if (!game.user.isGM) throw new Error(`${MODULE_ID} | only a Gamemaster can switch variants`);
  const gm = game.users.activeGM;
  if (gm?.isSelf) return enqueue(scene, reconcile, request);
  if (!gm) throw new Error(`${MODULE_ID} | no active Gamemaster`);
  return gm.query(SWITCH_QUERY, { sceneId: scene.id, ...request });
}

export async function setVariant(scene, levelId, name, { linked = false } = {}) {
  await requestSelection(scene, { levelId, name, linked });
}

// A partial flag write changes only the supplied levels, including when another GM
// changes a different floor before this request reaches the queue.
function selectionRequest(update) {
  if (!Object.keys(update).every((k) => k === "_id" || k === "flags" || k.startsWith("flags."))) return;
  const { flags } = foundry.utils.expandObject(update);
  const scope = flags?.[MODULE_ID];
  if (!scope || Object.keys(flags).length !== 1 || Object.keys(scope).length !== 1 || !("active" in scope)) return;
  const { DataFieldOperator } = foundry.data.operators;
  if (flags instanceof DataFieldOperator || scope instanceof DataFieldOperator) return;
  const entries = Object.entries(DataFieldOperator.get(scope.active) ?? {});
  const selection = Object.fromEntries(
    entries.map(([id, name]) => [id.replace(/^-=/u, ""), DataFieldOperator.get(name) ?? null])
  );
  return {
    selection,
    replace: scope.active instanceof DataFieldOperator,
    remove: scope.active instanceof foundry.data.operators.ForcedDeletion
  };
}

// Raw, selection-only Scene.update/setFlag calls use the same queued transition as the UI.
// Keep Foundry in charge of batch, compendium, dry-run and custom operations.
function routeSelectionWrites() {
  const Scene = CONFIG.Scene.documentClass;
  const updateDocuments = Scene.updateDocuments;
  Scene.updateDocuments = async function (updates, options = {}) {
    if (
      updates?.length === 1 &&
      game.user.isGM &&
      !options.pack &&
      Object.keys(options).every((k) => k === "parent" || k === "pack")
    ) {
      const [update] = updates;
      const scene = game.scenes.get(update._id);
      const request = scene && selectionRequest(update);
      if (request) {
        const updated = await requestSelection(scene, request);
        return updated ? [scene] : [];
      }
    }
    return updateDocuments.call(this, updates, options);
  };
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
        if (isActiveGM() && game.scenes.has(scene.id)) {
          enqueue(scene, reconcile).catch((error) => ui.notifications.error(error.message));
        }
      }, 100)
    );
  };

  setupTokenVisibility();
  setupVariantTokenControls();
  Hooks.once("init", () => {
    routeSelectionWrites();
    CONFIG.queries[SWITCH_QUERY] = ({ sceneId, ...request }, { user }) => {
      if (!user.isGM || !isActiveGM()) throw new Error(`${MODULE_ID} | unauthorized variant switch`);
      return enqueue(game.scenes.get(sceneId, { strict: true }), reconcile, request);
    };
  });
  Hooks.on("preCreateScene", (scene) => {
    // Embedded documents are initialized again from the parent source before it is sent.
    const tokens = [];
    for (const token of scene.tokens) {
      const patch = prepareTokenCreate(token);
      if (patch) tokens.push({ _id: token.id, ...patch });
    }
    if (tokens.length) scene.updateSource({ tokens });
  });
  Hooks.on("preUpdateScene", (scene, changes, options) => {
    if (options[MODULE_ID]?.variant && isActiveGM()) return;
    const collectionEdit = touchesCollections(scene, changes);
    if ((!scene.tokens.size && !changes.tokens) || (!collectionEdit && !changes.flags)) return;
    const flags = flagsAfter(scene, changes);
    if (collectionEdit || !foundry.utils.equals(flags, scene.flags[MODULE_ID] ?? {})) {
      prepareSceneEdit(scene, changes, options);
    }
  });
  Hooks.on("canvasReady", (canvas) => canvas.scene && queueSync(canvas.scene));
  Hooks.on("createScene", (scene) => {
    if (scene.tokens.some((t) => variantsOf(t).length && t.getFlag(MODULE_ID, "gmHidden") != null)) queueSync(scene);
  });
  Hooks.on("updateScene", (scene, changes, options, userId) => {
    if (!changes.flags?.[MODULE_ID] && !touchesCollections(scene, changes)) return;
    refreshPlayerTokens(scene);
    onChange();
    if (!(options[MODULE_ID]?.variant && userId === game.user.id)) queueSync(scene);
  });
  for (const type of TYPES) {
    const membershipChanged = (doc) => {
      if (!variantsOf(doc).length) return;
      onChange();
      queueSync(doc.parent);
    };
    Hooks.on(`create${type}`, membershipChanged);
    Hooks.on(`delete${type}`, membershipChanged);
    Hooks.on(`update${type}`, (doc, changes, options, userId) => {
      if (options[MODULE_ID]?.sync && userId === game.users.activeGM?.id) {
        if (type === "Token" && doc.getFlag(MODULE_ID, "releaseHidden") != null) queueSync(doc.parent);
        return;
      }
      if (touchesVariants(changes)) {
        onChange();
        queueSync(doc.parent);
      } else if (
        type === "Token" &&
        (variantsOf(doc).length || doc.getFlag(MODULE_ID, "releaseHidden") != null) &&
        ("hidden" in changes || changes.flags?.[MODULE_ID])
      ) {
        queueSync(doc.parent);
      }
    });
  }
}
