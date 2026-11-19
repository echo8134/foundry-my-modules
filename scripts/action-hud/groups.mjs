const key = (name) => `MY_MODULES.ActionHud.${name}`;
const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);
const section = (entries, label) => ({ entries, label });
const group = (id, icon, sections) => ({
  id,
  icon,
  label: key(id),
  sections: sections.filter((s) => s.entries.length || s.slots)
});

function itemEntry(item, activities) {
  const details = [];
  if (item.system.quantity != null) details.push(`×${item.system.quantity}`);
  for (const source of [item, ...activities]) {
    const uses = source === item ? item.system.uses : source.uses;
    if (uses?.max > 0) {
      const label = source === item ? game.i18n.localize("DND5E.Uses") : source.name;
      details.push(`${label} ${uses.value}/${uses.max}`);
    }
  }
  return { action: "item", id: item.id, img: item.img, name: item.name, detail: details.join(" · ") };
}

function spellSections(spells, slots) {
  if (!spells.size) return [];
  return Object.entries(CONFIG.DND5E.spellLevels).map(([level, label]) => {
    const pool = slots?.[`spell${level}`];
    const pact = slots?.pact;
    const counts = [];
    if (pool?.max > 0) {
      counts.push(game.i18n.format(key("slots"), pool));
    }
    if (pact?.level === Number(level) && pact.max > 0) {
      counts.push(game.i18n.format(key("pactSlots"), pact));
    }
    return { level, label, slots: counts.join(" · "), entries: spells.get(Number(level)) ?? [] };
  });
}

function rolls(actor) {
  const signed = new Intl.NumberFormat(game.i18n.lang, { signDisplay: "always" });
  const entries = (action, values, config, modifier) =>
    Object.entries(values ?? {})
      .filter(([id, data]) => config[id] && Number.isFinite(modifier(data)))
      .map(([id, data]) => ({
        action,
        id,
        name: config[id].label,
        detail: signed.format(modifier(data))
      }));
  const abilities = actor.system.abilities;
  const config = CONFIG.DND5E;
  return [
    section(
      entries("check", abilities, config.abilities, (a) => a.check?.value),
      key("checks")
    ),
    section(
      entries("save", abilities, config.abilities, (a) => a.save?.value),
      key("saves")
    ),
    section(entries("skill", actor.system.skills, config.skills, (s) => s.total).sort(byName), key("skills"))
  ];
}

export function actionGroups(actor) {
  const attacks = [];
  const spells = new Map();
  const features = [];
  const items = [];
  for (const item of [...actor.items].sort(byName)) {
    if (!item.canUse) continue;
    const activities = item.system.activities?.filter((a) => a.canUse) ?? [];
    const entry = itemEntry(item, activities);
    if (item.type === "spell") {
      const { level, prepared, method } = item.system;
      if (!prepared && method !== "innate" && method !== "pact") continue;
      if (!spells.has(level)) spells.set(level, []);
      spells.get(level).push(entry);
    } else if (item.type === "feat") {
      if (activities.length) features.push(entry);
    } else if (item.type !== "weapon" && (item.type === "consumable" || activities.length)) items.push(entry);
    if (item.type === "weapon" || activities.some((a) => a.type === "attack")) attacks.push(entry);
  }
  const conditions = Object.entries(CONFIG.DND5E.conditionTypes)
    .filter(([, status]) => !status.pseudo)
    .map(([id, { name, img }]) => ({ id, name, img, action: "condition", active: actor.statuses.has(id) }))
    .sort(byName);
  const rests = actor.system.isVehicle
    ? []
    : ["shortRest", "longRest"].map((action) => ({
        action,
        name: game.i18n.localize(key(action))
      }));
  return [
    group("attacks", "fa-crosshairs", [section(attacks)]),
    group("spells", "fa-wand-sparkles", spellSections(spells, actor.system.spells)),
    group("features", "fa-star", [section(features)]),
    group("items", "fa-flask", [section(items)]),
    group("rolls", "fa-dice-d20", rolls(actor)),
    group("conditions", "fa-person-falling", [section(conditions)]),
    group("rests", "fa-campground", [section(rests)])
  ].filter((g) => g.sections.length);
}
