import { MODULE_ID } from "../constants.mjs";

const STABLE = "actionHudStable";
const STABLE_FLAG = `flags.${MODULE_ID}.${STABLE}`;

export function showsDeathSaves(actor) {
  const attributes = actor?.system.attributes;
  return (
    attributes?.hp?.value === 0 &&
    attributes.death?.success < 3 &&
    attributes.death?.failure < 3 &&
    !actor.statuses.has("stable") &&
    !actor.getFlag(MODULE_ID, STABLE)
  );
}

export function trackStabilization() {
  // dnd5e resets both counters on the third success. Only the roll outcome distinguishes it from a fresh drop to 0 HP.
  Hooks.on("dnd5e.rollDeathSave", (_rolls, { outcome, updates }) => {
    if (outcome === "stable") updates[STABLE_FLAG] = true;
  });
  Hooks.on("preUpdateActor", (actor, changes) => {
    const attributes = changes.system?.attributes;
    if (!attributes) return;
    // Legendary Resistance can turn a failed save into the third success without rolling again.
    if (
      attributes.death?.success === 0 &&
      actor.system.attributes.death?.success === 2 &&
      changes.system.resources?.legres?.spent > actor.system.resources?.legres?.spent
    ) {
      foundry.utils.setProperty(changes, STABLE_FLAG, true);
    } else if (
      actor.getFlag(MODULE_ID, STABLE) &&
      (attributes.hp?.value > 0 || attributes.death?.success > 0 || attributes.death?.failure > 0)
    ) {
      foundry.utils.setProperty(changes, STABLE_FLAG, _del);
    }
  });
  Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates) => {
    if (amount > 0 && actor.getFlag(MODULE_ID, STABLE)) updates[STABLE_FLAG] = _del;
  });
}
