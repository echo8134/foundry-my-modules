import { MODULE_ID } from "./constants.mjs";

export const variantNames = (variant) => [variant ?? []].flat().filter(Boolean);

export function savedHidden(flags) {
  return flags?.gmHidden ?? flags?.releaseHidden ?? flags?.restore?.hidden;
}

export function flagsAfter(doc, changes) {
  if (!changes.flags) return doc._source.flags[MODULE_ID] ?? {};
  const merged = foundry.utils.mergeObject(
    { flags: doc._source.flags },
    { flags: changes.flags },
    { inplace: false, applyOperators: true }
  );
  return merged.flags?.[MODULE_ID] ?? {};
}

function setFlag(changes, key, value) {
  const { ForcedDeletion } = foundry.data.operators;
  if (changes.flags instanceof ForcedDeletion) changes.flags = _replace({});
  if (changes.flags?.[MODULE_ID] instanceof ForcedDeletion) changes.flags[MODULE_ID] = _replace({});
  foundry.utils.setProperty(changes, `flags.${MODULE_ID}.${key}`, value);
}

export function prepareTokenCreate(token) {
  const flags = token._source.flags[MODULE_ID] ?? {};
  if (!variantNames(flags.variant).length) return null;
  const changes = { hidden: true };
  setFlag(changes, "gmHidden", savedHidden(flags) ?? token._source.hidden);
  if (flags.restore) setFlag(changes, "restore", _del);
  if (flags.releaseHidden != null) setFlag(changes, "releaseHidden", _del);
  token.updateSource(changes);
  return changes;
}

export function prepareTokenEdit(token, changes, options = {}) {
  if (options[MODULE_ID]?.sync && game.users.activeGM?.isSelf) return;
  if (!("hidden" in changes || "flags" in changes || "level" in changes)) return;
  const previous = token._source.flags[MODULE_ID] ?? {};
  const flags = flagsAfter(token, changes);
  const tagged = variantNames(flags.variant).length > 0;
  if (!tagged && !variantNames(previous.variant).length && savedHidden(previous) == null) return;

  const saved = savedHidden(flags) ?? savedHidden(previous) ?? token._source.hidden;
  const suppliedIntent = tagged ? savedHidden(changes.flags?.[MODULE_ID]) : undefined;
  const intended = options.isPaste || typeof suppliedIntent === "boolean" ? saved : (changes.hidden ?? saved);
  const retagged = !foundry.utils.equals(flags.variant, previous.variant);
  const moved = "level" in changes && changes.level !== token._source.level;
  if (!retagged && !moved && !("hidden" in changes) && !changes.flags?.[MODULE_ID]) return;
  if (flags.restore) setFlag(changes, "restore", _del);
  if (!tagged) {
    // Cleanup may still be in flight when the token is retagged. Give that cleanup
    // its own key so it cannot delete a newer GM choice on the retagged token.
    if (flags.gmHidden != null) setFlag(changes, "gmHidden", _del);
    if (flags.releaseHidden !== intended) setFlag(changes, "releaseHidden", intended);
    changes.hidden = intended;
    return;
  }
  if (flags.releaseHidden != null) setFlag(changes, "releaseHidden", _del);
  if (flags.gmHidden !== intended) setFlag(changes, "gmHidden", intended);
  if (intended || retagged || moved) changes.hidden = true;
  else delete changes.hidden;
}

export function tokenUpdate(token, on) {
  const flags = token._source.flags[MODULE_ID] ?? {};
  const tagged = variantNames(flags.variant).length > 0;
  const saved = savedHidden(flags);
  if (!tagged && saved == null) return null;

  const changes = {};
  const intended = saved ?? token._source.hidden;
  const hidden = intended || (tagged && !on);
  if (token._source.hidden !== hidden) {
    changes.hidden = hidden;
    // Restore untagged tokens first. A concurrent manual hide must survive a delayed reveal.
    if (!tagged) return { _id: token.id, ...changes };
  }
  if (!tagged && flags.releaseHidden != null) setFlag(changes, "releaseHidden", _del);
  // A late migration must never replace a manual decision sent by another GM.
  if (tagged && saved == null) setFlag(changes, "restore", { hidden: intended });
  if (!tagged && flags.gmHidden != null) setFlag(changes, "gmHidden", _del);
  if ((!tagged || flags.gmHidden != null) && flags.restore) setFlag(changes, "restore", _del);
  return foundry.utils.isEmpty(changes) ? null : { _id: token.id, ...changes };
}

function inactiveVariant(token) {
  const names = variantNames(token?._source.flags[MODULE_ID]?.variant);
  if (!names.length || token.parent?.documentName !== "Scene") return false;
  const sceneFlags = token.parent._source.flags[MODULE_ID];
  // Only a shared base name can authorize a reveal on players using different languages.
  const selected = sceneFlags?.active?.[token._source.level] ?? sceneFlags?.defaultName;
  return !names.includes(selected);
}

function playerMask(token) {
  return savedHidden(token._source.flags[MODULE_ID]) || inactiveVariant(token);
}

let concealedScene;
function presentConcealment(scene) {
  if (scene !== concealedScene) return;
  concealedScene = null;
  if (canvas.ready && canvas.scene === scene) canvas.app.render();
}

function queueConcealment(scene) {
  if (concealedScene === scene || !canvas.ready || canvas.scene !== scene) return;
  concealedScene = scene;
  // Foundry dispatches all updateToken hooks in a batch synchronously, possibly between two paints.
  queueMicrotask(() => presentConcealment(scene));
}

function managedToken(token) {
  const flags = token?._source.flags[MODULE_ID];
  return variantNames(flags?.variant).length > 0 || savedHidden(flags) != null;
}

function refreshRegion(region, token) {
  const inactive = inactiveVariant(token);
  if (!game.user.isGM) region.hidden = region._source.hidden || token._source.hidden || playerMask(token);
  if (inactive && region.rendered && region.object.controlled) region.object.release();
  const hidden = inactive || (!game.user.isGM && region.hidden);
  if (!region.rendered || (hidden && !region.object.visible)) return;
  if (hidden) queueConcealment(region.parent);
  region.object.renderFlags.set({ refreshVisibility: true });
  region.object.applyRenderFlags();
}

function refreshToken(token) {
  if (!managedToken(token)) return;
  if (!game.user.isGM && token.hidden !== (token._source.hidden || playerMask(token))) token.reset();
  for (const region of token.attachments.regions) refreshRegion(region, token);
  if (!token.rendered || !token.object.mesh) return;
  const object = token.object;
  const concealed = inactiveVariant(token) || (!game.user.isGM && token.hidden);
  if (concealed && object.controlled) object.release();
  if (concealed && object.isTargeted) object.setTarget(false);
  if (concealed && (object.visible || object.mesh.visible)) {
    queueConcealment(token.parent);
    object.visible = false;
    object.mesh.visible = false;
  }
  object.renderFlags.set({ refreshState: true });
}

export function refreshVariantTokens(scene) {
  if (!scene || (game.user.isGM && canvas.scene !== scene)) return;
  for (const token of scene.tokens) refreshToken(token);
  presentConcealment(scene);
}

export function setupTokenVisibility() {
  Hooks.on("preCreateToken", (token) => {
    prepareTokenCreate(token);
  });
  Hooks.on("preUpdateToken", prepareTokenEdit);
  Hooks.once("setup", () => {
    CONFIG.Token.objectClass = class extends CONFIG.Token.objectClass {
      get isVisible() {
        return !inactiveVariant(this.document) && super.isVisible;
      }

      get isInteractable() {
        return !inactiveVariant(this.document) && super.isInteractable;
      }

      // Foundry combines the paste-as-hidden option with effective visibility before firing pasteToken.
      _pasteObject(offset, options = {}) {
        const changes = super._pasteObject(offset, options);
        const flags = this.document._source.flags[MODULE_ID];
        if (variantNames(flags?.variant).length) {
          setFlag(changes, "gmHidden", !!options.hidden || (savedHidden(flags) ?? this.document._source.hidden));
        }
        return changes;
      }
    };
    CONFIG.Region.objectClass = class extends CONFIG.Region.objectClass {
      get isVisible() {
        return !inactiveVariant(this.document.attachment.token) && super.isVisible;
      }
    };

    Hooks.on("updateToken", (token, changes) => {
      if (!game.user.isGM && changes.hidden && token.rendered && token.getFlag(MODULE_ID, "variant")) {
        queueConcealment(token.parent);
      }
      if ("hidden" in changes || "flags" in changes || "level" in changes) refreshToken(token);
    });
    if (game.user.isGM) return;
    // Incoming documents and subsequent parent resets both prepare before Foundry draws their placeables.
    const prototype = CONFIG.Token.documentClass.prototype;
    const prepare = prototype.prepareBaseData;
    prototype.prepareBaseData = function (...args) {
      if (playerMask(this)) this.hidden = true;
      return prepare.apply(this, args);
    };
    const regionPrototype = CONFIG.Region.documentClass.prototype;
    const prepareRegion = regionPrototype.prepareBaseData;
    regionPrototype.prepareBaseData = function (...args) {
      const result = prepareRegion.apply(this, args);
      const token = this.attachment.token;
      if (managedToken(token) && (token._source.hidden || playerMask(token))) this.hidden = true;
      return result;
    };
    Hooks.on("canvasInit", ({ scene }) => refreshVariantTokens(scene));
    Hooks.on("updateRegion", (region, changes) => {
      const token = region.attachment.token;
      if ("hidden" in changes && managedToken(token)) refreshRegion(region, token);
    });
  });
}
