const skills = new Set(["arc", "nat", "inv", "med"]);
const abilities = new Set(["str", "dex", "con", "int", "wis", "cha"]);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const dc = (value) => Number.isInteger(value) && value >= 0;

export function validTable(table) {
  if (!skills.has(table?.appraise?.skill) || !dc(table.appraise.dc) || !Array.isArray(table.components)) return false;
  const ids = new Set();
  return (
    table.components.length > 0 &&
    table.components.every((part) => {
      if (!part || !text(part.id) || ids.has(part.id) || !text(part.name) || !text(part.item) || !dc(part.dc))
        return false;
      if (!Number.isInteger(part.quantity) || part.quantity < 1) return false;
      if (part.danger) {
        const { save, damage } = part.danger;
        if (!text(part.danger.text) || (save && (!abilities.has(save.ability) || !dc(save.dc)))) return false;
        if (damage && (!text(damage.formula) || !text(damage.type))) return false;
      }
      ids.add(part.id);
      return true;
    })
  );
}

export function previewHarvest(table, total, { condition = "normal", ruined = [], passed = [] } = {}, withKit = true) {
  const shift = { clean: -5, normal: 0, brutal: 5 }[condition] ?? 0;
  const chosen = new Map();
  const rows = table.components.map((component) => {
    const dc = component.dc + shift;
    let outcome = "lost";
    if (ruined.includes(component.id)) outcome = "ruined";
    else if (total >= dc) outcome = passed.includes(component.id) ? "passed" : "gained";
    else if (component.danger && dc - total > (withKit ? 5 : 0)) outcome = "danger";
    const row = { component, dc, outcome };
    if (component.exclusiveGroup && outcome === "gained") {
      const previous = chosen.get(component.exclusiveGroup);
      if (!previous || previous.dc < dc) {
        if (previous) previous.outcome = "alternative";
        chosen.set(component.exclusiveGroup, row);
      } else row.outcome = "alternative";
    }
    return row;
  });
  return rows;
}

export function isHarvestKit(item) {
  return (
    item?.type === "tool" &&
    (item.system.type?.baseItem === "harvest" ||
      ["Erntebesteck (Harvesting Kit)", "Harvesting Kit"].includes(item.name) ||
      (item.system.activities?.has("AppraiseCreature") && item.system.activities.has("CheckKitSupplies")))
  );
}

export function harvestEquipment(actor, preferredId) {
  const kits = actor.items.filter((item) => isHarvestKit(item) && item.system.quantity > 0);
  const charged = (item) => item?.system.uses.value > 0;
  const preferred = kits.find((item) => item.id === preferredId);
  const kit = charged(preferred) ? preferred : kits.find(charged);
  const training = actor.system.tools?.harvest;
  const proficiency = Math.max(
    training?.effectValue ?? training?.value ?? 0,
    ...kits.map((item) => item.system.proficient ?? 0)
  );
  return { kit, proficiency };
}

export function sourceItem(reference) {
  if (/^Item\.[a-zA-Z0-9]+$/.test(reference)) return game.items.get(reference.slice(5));
  const matches = game.items.filter((item) => item.name === reference);
  if (matches.length === 1) return matches[0];
}
