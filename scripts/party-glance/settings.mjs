import { MODULE_ID } from "../constants.mjs";
import { STATS } from "./stats.mjs";

export const SETTING = "partyGlance";
export const MAX_SLOTS = 8;
export const TRIGGERS = ["select", "hover", "combat"];
const FLAGS = ["players", "friendlyNpcs", "labels", "deathSaves", "tempHp"];

export const DEFAULTS = Object.freeze({
  count: 6,
  slots: Object.freeze(
    ["ac", "pp", "hp", "dc", "conc", "ins", "save", "hd"].map((stat) =>
      Object.freeze(stat === "save" ? { stat, sub: "dex" } : { stat })
    )
  ),
  trigger: "select",
  players: true,
  friendlyNpcs: false,
  labels: false,
  deathSaves: true,
  tempHp: true
});

const text = (value) => (typeof value === "string" ? value : undefined);

function normalizeSlot(raw) {
  const stat = Object.hasOwn(STATS, raw?.stat) ? raw.stat : "";
  const slot = { stat };
  for (const key of ["sub", "abbr", "path"]) {
    if (text(raw?.[key]) !== undefined) slot[key] = raw[key];
  }
  return slot;
}

export function normalize(raw) {
  const count = Math.round(Number(raw?.count));
  const slots = Array.from({ length: MAX_SLOTS }, (_, i) =>
    normalizeSlot(Array.isArray(raw?.slots) ? raw.slots[i] : null)
  );
  const settings = {
    count: Number.isFinite(count) ? Math.clamp(count, 1, MAX_SLOTS) : DEFAULTS.count,
    slots,
    trigger: TRIGGERS.includes(raw?.trigger) ? raw.trigger : DEFAULTS.trigger
  };
  for (const flag of FLAGS) settings[flag] = typeof raw?.[flag] === "boolean" ? raw[flag] : DEFAULTS[flag];
  return settings;
}

export const glanceSettings = () => normalize(game.settings.get(MODULE_ID, SETTING));
