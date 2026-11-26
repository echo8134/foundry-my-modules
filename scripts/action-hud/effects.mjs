function visibleEffects(actor) {
  // Foundry treats dnd5e conditions without an expiry, including Prone, as indefinite.
  return actor.appliedEffects.filter(
    (effect) =>
      !effect.isConcealed &&
      (effect.isTemporary || effect.type === "condition" || actor.concentration.effects.has(effect))
  );
}

export async function effectEntries(actor) {
  const concentration = actor.concentration.effects;
  const effects = visibleEffects(actor).sort((a, b) => Number(concentration.has(b)) - Number(concentration.has(a)));
  return Promise.all(
    effects.map(async (effect) => {
      const concentrating = concentration.has(effect);
      const source = await effect.getSource();
      const sourceName = source?.item?.name ?? source?.name ?? (effect.origin && effect.sourceName);
      const hint = concentrating ? "endConcentration" : effect.system.hasLevels ? "reduceEffect" : "endEffect";
      const tooltip = [
        effect.name,
        sourceName && game.i18n.format("MY_MODULES.ActionHud.effectSource", { name: sourceName }),
        ...effect.getDurationParts(),
        game.i18n.localize(`MY_MODULES.ActionHud.${hint}`)
      ]
        .filter(Boolean)
        .join("\n");
      return { uuid: effect.uuid, name: effect.name, img: effect.img, concentrating, tooltip };
    })
  );
}

export function endHudEffect(actor, uuid, concentration) {
  const effect = actor && visibleEffects(actor).find((effect) => effect.uuid === uuid);
  if (!effect || actor.concentration.effects.has(effect) !== concentration) return;
  if (concentration) return actor.endConcentration(effect);
  if (effect.system.hasLevels && effect.system.level > 1) return effect.system.decrease();
  if (effect.item && effect.transfer) return effect.update({ disabled: true });
  return effect.delete();
}
