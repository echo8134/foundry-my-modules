const identifySkills = new Set(["nat", "med"]);
const abilities = new Set(["str", "dex", "con", "int", "wis", "cha"]);
const rarityDCs = new Map([
  ["common", 12],
  ["uncommon", 15],
  ["rare", 18],
  ["veryRare", 21],
  ["legendary", 24]
]);
const legacyKitNames = new Set([
  "Herbalism Kit",
  "Kräuterkundebesteck",
  "Kräuterkunde-Ausrüstung",
  "Kräuterkunde-Ausrüstung (Herbalism Kit)"
]);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const validDC = (value) => Number.isSafeInteger(value) && value >= 0;
const proficiency = (trait) => trait?.effectValue ?? trait?.value ?? 0;

function validDanger(danger) {
  if (danger === undefined) return true;
  if (!text(danger?.text)) return false;
  const { save, damage } = danger;
  return (
    (save === undefined || (abilities.has(save?.ability) && validDC(save.dc))) &&
    (damage === undefined || (text(damage?.formula) && text(damage.type)))
  );
}

export function validHerbalismTable(table) {
  if (!identifySkills.has(table?.identify?.skill) || !Array.isArray(table.components) || !table.components.length)
    return false;
  if (table.identify.dc !== undefined && !validDC(table.identify.dc)) return false;
  const ids = new Set();
  for (const component of table.components) {
    if (!text(component?.id) || ids.has(component.id) || !text(component.name) || !text(component.item)) return false;
    if (!Number.isSafeInteger(component.quantity) || component.quantity < 1 || !validDC(gatherDC(component)))
      return false;
    if (component.charges !== undefined && !text(component.charges)) return false;
    if (!validDanger(component.danger)) return false;
    ids.add(component.id);
  }
  return true;
}

export function identifyDC(table, proficiencyBonus) {
  return table.identify.dc ?? 15 + proficiencyBonus;
}

export function gatherDC(component) {
  return component.dc === undefined ? rarityDCs.get(component.rarity) : component.dc;
}

export function previewGather(component, total, withKit) {
  const dc = gatherDC(component);
  const margin = total - dc;
  let outcome;
  if (margin >= 5) outcome = "superior";
  else if (margin >= 0) outcome = "gained";
  else if (withKit && margin >= -5) outcome = "lost";
  else outcome = "danger";
  return { component, dc, outcome };
}

export function isHerbalismKit(item) {
  if (item?.type !== "tool") return false;
  const base = item.system.type?.baseItem;
  return (
    base === "herb" || (!base && legacyKitNames.has(item.name) && !item.system.activities?.has("AppraiseCreature"))
  );
}

export function herbalismEquipment(actor, preferredId) {
  const kits = actor.items.filter((item) => isHerbalismKit(item) && item.system.quantity > 0);
  const preferred = kits.find((item) => item.id === preferredId);
  const charged = (kit) => kit?.system.uses?.value > 0;
  const kit = charged(preferred) ? preferred : kits.find(charged);
  return { kit, identifyKit: preferred ?? kit ?? kits[0], proficiency: proficiency(actor.system.tools?.herb) };
}

export function gatherMode({ withKit, identified, proficiency }) {
  if (!withKit) return "disadvantage";
  return identified && proficiency >= 1 ? "advantage" : "ordinary";
}
