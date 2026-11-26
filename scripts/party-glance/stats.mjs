import { text } from "./text.mjs";

/**
 * A badge is a discriminated union on `kind`. Every badge also carries `stat`, `icon`, `abbr`, `labelled`
 * and `tooltip`; `missing` fades a badge that has nothing to show.
 * @typedef {{kind: "number", value: string, missing?: boolean}} NumberBadge
 * @typedef {{kind: "bar", value: number, max: number, tone: Tone, temp?: number}} BarBadge
 * @typedef {{kind: "marker", on: boolean, detail?: string}} MarkerBadge
 * @typedef {{kind: "pips", groups: {on: number, total: number, tone: Tone}[], missing?: boolean}} PipsBadge
 * @typedef {"good" | "warn" | "bad" | "neutral"} Tone
 */

export const GROUPS = ["defense", "passives", "combat", "conditions", "senses"];

const label = (id) => text(`stat.${id}`);
const attributes = (actor) => actor.system.attributes;
const signed = (value) => (value >= 0 ? `+${value}` : String(value));
const ordinal = (n) => `${n}${["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] ?? "th"}`;
const unit = (units, table) => table?.[units]?.abbreviation ?? units ?? "ft";

function absent(name, reason = text("tip.none")) {
  return { kind: "number", value: "—", missing: true, tooltip: text("tip.labelled", { label: name, reason }) };
}

function number(name, value, format = String) {
  if (!Number.isFinite(value)) return absent(name);
  return { kind: "number", value: format(value), tooltip: text("tip.value", { label: name, value: format(value) }) };
}

const PASSIVE_FALLBACK = "ste";
const SAVE_FALLBACK = "dex";
const passive = (stat, skill) => (actor) => number(label(stat), actor.system.skills?.[skill]?.passive);

function spellAbility(actor) {
  const key =
    attributes(actor).spellcasting ||
    (Object.keys(actor.spellcastingClasses ?? {}).length ? actor.spellcastingAbility : "");
  return actor.system.abilities?.[key];
}

function spellStat(stat, pick, format) {
  return (actor) => {
    const ability = spellAbility(actor);
    if (!ability) return absent(label(stat), text("tip.noSpellcasting"));
    return number(label(stat), pick(ability), format);
  };
}

function hitPoints(actor, _slot, options) {
  const hp = attributes(actor).hp;
  if (!hp) return absent(label("hp"));
  const max = hp.effectiveMax ?? hp.max;
  const ratio = max > 0 ? hp.value / max : 0;
  const temp = options.tempHp && hp.temp > 0 ? hp.temp : 0;
  return {
    kind: "bar",
    value: hp.value,
    max,
    temp,
    tone: ratio > 0.5 ? "good" : ratio > 0.25 ? "warn" : "bad",
    tooltip: text(temp ? "tip.hpTemp" : "tip.hp", { value: hp.value, max, temp })
  };
}

function hitDice(actor) {
  const hd = attributes(actor).hd;
  if (!hd || !(hd.max > 0)) return absent(label("hd"));
  return {
    kind: "bar",
    value: hd.value,
    max: hd.max,
    tone: "neutral",
    tooltip: text("tip.hd", { value: hd.value, max: hd.max })
  };
}

function passiveSkill(actor, slot) {
  const key = slot.sub || PASSIVE_FALLBACK;
  const skill = CONFIG.DND5E.skills[key]?.label ?? key;
  return number(text("tip.passive", { skill, value: "" }).trim(), actor.system.skills?.[key]?.passive);
}

function savingThrow(actor, slot) {
  const key = slot.sub || SAVE_FALLBACK;
  const ability = CONFIG.DND5E.abilities[key]?.label ?? key;
  const value = actor.system.abilities?.[key]?.save?.value;
  if (!Number.isFinite(value)) return absent(text("tip.save", { ability, value: "" }).trim());
  return {
    kind: "number",
    value: signed(value),
    tooltip: text("tip.save", { ability, value: signed(value) })
  };
}

function highestFreeSlot(actor) {
  const pools = Object.values(actor.system.spells ?? {}).filter((pool) => pool.max > 0);
  if (!pools.length) return absent(text("tip.slots"));
  const free = new Map();
  for (const { level, value } of pools) free.set(level, (free.get(level) ?? 0) + Math.max(0, value));
  const open = [...free].filter(([, left]) => left > 0).map(([level]) => level);
  if (!open.length) return { kind: "number", value: "0", tooltip: text("tip.slotsSpent") };
  const level = Math.max(...open);
  const left = free.get(level);
  return {
    kind: "number",
    value: `${ordinal(level)} ×${left}`,
    tooltip: text("tip.slot", { level: ordinal(level), left })
  };
}

function concentration(actor) {
  const on = actor.statuses.has(CONFIG.specialStatusEffects.CONCENTRATING);
  const detail = [...(actor.concentration?.items ?? [])].map((item) => item.name).join(", ");
  const tooltip = !on
    ? text("tip.notConcentrating")
    : detail
      ? text("tip.concentratingOn", { detail })
      : text("tip.concentrating");
  return { kind: "marker", on, detail, tooltip };
}

function exhaustion(actor) {
  const total = CONFIG.DND5E.conditionTypes.exhaustion?.levels ?? 6;
  const on = attributes(actor).exhaustion ?? 0;
  return {
    kind: "pips",
    missing: on === 0,
    groups: [{ on, total, tone: "warn" }],
    tooltip: text("tip.exhaustion", { value: on, max: total })
  };
}

function darkvision(actor) {
  const senses = attributes(actor).senses;
  const range = senses?.ranges?.darkvision;
  if (!(range > 0)) return absent(label("dv"));
  return number(label("dv"), range, (value) => `${value} ${unit(senses.units, CONFIG.DND5E.movementUnits)}`);
}

function walkingSpeed(actor) {
  const movement = attributes(actor).movement;
  return number(
    label("speed"),
    movement?.walk,
    (value) => `${value} ${unit(movement.units, CONFIG.DND5E.movementUnits)}`
  );
}

function customValue(actor, slot) {
  const name = slot.abbr || "?";
  const value = slot.path ? foundry.utils.getProperty(actor, slot.path) : undefined;
  if (typeof value === "boolean") {
    return {
      kind: "marker",
      on: value,
      tooltip: text("tip.labelled", { label: name, reason: text(value ? "tip.yes" : "tip.no") })
    };
  }
  if ((typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value !== "")) {
    return { kind: "number", value: String(value), tooltip: text("tip.value", { label: name, value }) };
  }
  return absent(name, text("tip.noValue"));
}

const fixed = (abbr) => () => abbr;
const abilities = () =>
  Object.fromEntries(Object.entries(CONFIG.DND5E.abilities).map(([key, { label }]) => [key, label]));
const skills = () => Object.fromEntries(Object.entries(CONFIG.DND5E.skills).map(([key, { label }]) => [key, label]));

/**
 * The single place that knows which stats exist. Dropdown order is the order below within each group.
 * `abbr` names the badge label, `sub` is a second dropdown, `labelled` keeps the label visible even
 * when short labels are off.
 */
export const STATS = {
  ac: {
    group: "defense",
    label: label("ac"),
    abbr: fixed("AC"),
    icon: "fa-shield-halved",
    kinds: ["number"],
    read: (actor) => number(label("ac"), attributes(actor).ac?.value)
  },
  hp: {
    group: "defense",
    label: label("hp"),
    abbr: fixed("HP"),
    icon: "fa-heart",
    kinds: ["bar"],
    read: hitPoints
  },
  hd: { group: "defense", label: label("hd"), abbr: fixed("HD"), icon: "fa-dice-d20", kinds: ["bar"], read: hitDice },
  pp: {
    group: "passives",
    label: label("pp"),
    abbr: fixed("PP"),
    icon: "fa-eye",
    kinds: ["number"],
    read: passive("pp", "prc")
  },
  ins: {
    group: "passives",
    label: label("ins"),
    abbr: fixed("INS"),
    icon: "fa-lightbulb",
    kinds: ["number"],
    read: passive("ins", "ins")
  },
  inv: {
    group: "passives",
    label: label("inv"),
    abbr: fixed("INV"),
    icon: "fa-magnifying-glass",
    kinds: ["number"],
    read: passive("inv", "inv")
  },
  passive: {
    group: "passives",
    label: label("passive"),
    abbr: (slot) => `P·${(slot.sub || PASSIVE_FALLBACK).toUpperCase()}`,
    icon: "fa-binoculars",
    kinds: ["number"],
    labelled: true,
    sub: { choices: skills, fallback: PASSIVE_FALLBACK },
    read: passiveSkill
  },
  dc: {
    group: "combat",
    label: label("dc"),
    abbr: fixed("DC"),
    icon: "fa-star",
    kinds: ["number"],
    read: spellStat("dc", (ability) => ability.dc)
  },
  atk: {
    group: "combat",
    label: label("atk"),
    abbr: fixed("ATK"),
    icon: "fa-crosshairs",
    kinds: ["number"],
    read: spellStat("atk", (ability) => ability.attack?.value, signed)
  },
  slot: {
    group: "combat",
    label: label("slot"),
    abbr: fixed("SLOT"),
    icon: "fa-fire",
    kinds: ["number"],
    read: highestFreeSlot
  },
  conc: {
    group: "combat",
    label: label("conc"),
    abbr: fixed("CONC"),
    icon: "fa-bullseye",
    kinds: ["marker"],
    read: concentration
  },
  save: {
    group: "combat",
    label: label("save"),
    abbr: (slot) => (slot.sub || SAVE_FALLBACK).toUpperCase(),
    icon: "fa-shield-check",
    kinds: ["number"],
    labelled: true,
    sub: { choices: abilities, fallback: SAVE_FALLBACK },
    read: savingThrow
  },
  init: {
    group: "combat",
    label: label("init"),
    abbr: fixed("INI"),
    icon: "fa-bolt",
    kinds: ["number"],
    read: (actor) => number(label("init"), attributes(actor).init?.total, signed)
  },
  insp: {
    group: "conditions",
    label: label("insp"),
    abbr: fixed("INSP"),
    icon: "fa-sun",
    kinds: ["marker"],
    read: (actor) => {
      const on = Boolean(attributes(actor).inspiration);
      return { kind: "marker", on, tooltip: text(on ? "tip.inspiration" : "tip.noInspiration") };
    }
  },
  exh: {
    group: "conditions",
    label: label("exh"),
    abbr: fixed("EXH"),
    icon: "fa-hourglass-half",
    kinds: ["pips"],
    read: exhaustion
  },
  dv: { group: "senses", label: label("dv"), abbr: fixed("DV"), icon: "fa-moon", kinds: ["number"], read: darkvision },
  speed: {
    group: "senses",
    label: label("speed"),
    abbr: fixed("FT"),
    icon: "fa-angles-right",
    kinds: ["number"],
    read: walkingSpeed
  },
  custom: {
    group: null,
    label: label("custom"),
    abbr: (slot) => slot.abbr || "?",
    icon: "fa-hashtag",
    kinds: ["number", "marker"],
    labelled: true,
    read: customValue
  }
};

export const slotAbbr = (slot) => STATS[slot.stat].abbr(slot);

export function readBadge(actor, slot, options) {
  const stat = STATS[slot.stat];
  return {
    stat: slot.stat,
    icon: stat.icon,
    abbr: stat.abbr(slot),
    labelled: stat.labelled ?? false,
    ...stat.read(actor, slot, options)
  };
}
