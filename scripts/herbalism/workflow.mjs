import { MODULE_ID } from "../constants.mjs";
import { awardPlan, gatherRollId } from "../harvesting/award.mjs";
import { sourceItem } from "../harvesting/rules.mjs";
import { fail, t } from "../harvesting/views.mjs";
import {
  gatherMode,
  herbalismEquipment,
  identifyDC,
  isHerbalismKit,
  previewGather,
  validHerbalismTable
} from "./rules.mjs";
import { reviewGather } from "./views.mjs";

function gathererChoices(actor, token, user, table) {
  const actors = new Map([[actor.uuid, actor]]);
  for (const placed of token.parent.tokens) {
    if (placed.actor?.type !== "character" || (placed.hidden && !user.isGM)) continue;
    if (
      !user.isGM &&
      (!placed.actor.testUserPermission(user, "LIMITED") ||
        !game.users.some((owner) => owner.active && !owner.isGM && placed.actor.testUserPermission(owner, "OWNER")))
    )
      continue;
    actors.set(placed.actor.uuid, placed.actor);
  }
  return Array.from(actors.values(), (gatherer) => ({
    uuid: gatherer.uuid,
    name: gatherer.name,
    dc: identifyDC(table, gatherer.system.attributes.prof)
  }));
}

export function plantContext(data, actor, token, user) {
  const table = token.actor.getFlag(MODULE_ID, "herbalism");
  if (!validHerbalismTable(table)) fail("needPlant");
  const { kit, identifyKit, proficiency } = herbalismEquipment(actor, data.kitId);
  const identify = data.action === "identify";
  const gatherers = identify ? gathererChoices(actor, token, user, table) : [];
  const gatherer = gatherers.find((choice) => choice.uuid === (data.gathererUuid ?? actor.uuid));
  if (identify && !gatherer) fail("needGatherer");
  const methods = identify
    ? [...new Set([table.identify.skill, "nat", "med", ...(identifyKit ? ["herb"] : [])])]
    : ["sur", "nat"];
  const method = data.method ?? methods[0];
  if (!methods.includes(method)) fail("changed");
  const identified =
    token.getFlag(MODULE_ID, "identificationSuccess") && token.getFlag(MODULE_ID, "identifiedFor") === actor.uuid;
  const mode = identify ? "ordinary" : gatherMode({ withKit: Boolean(kit), identified, proficiency });
  return {
    actor,
    token,
    table,
    kit: identify ? identifyKit : kit,
    proficiency,
    mode,
    methods,
    method,
    gatherers,
    gathererUuid: gatherer?.uuid,
    dc: gatherer?.dc
  };
}

export async function rollPlant(action, { actor, kit, method, mode, dc }) {
  const config = mode === "ordinary" ? {} : { [mode]: true };
  const options = { configure: false };
  const message = { create: false };
  if (action === "identify") config.target = dc;
  if (method === "herb" || (action === "gather" && kit)) {
    const ability = method === "herb" ? kit.system.ability || "wis" : method === "sur" ? "wis" : "int";
    return (
      await actor.rollToolCheck({ ...config, tool: "herb", ability, bonus: kit.system.bonus }, options, message)
    )?.[0];
  }
  return (
    await actor.rollSkill({ ...config, skill: method, ability: CONFIG.DND5E.skills[method].ability }, options, message)
  )?.[0];
}

export function deferredGather(action, token, actor) {
  const reference = token.getFlag(MODULE_ID, "gatherRoll");
  const receipt = game.messages.get(reference ?? gatherRollId(token));
  if (!receipt && !reference) return;
  const attempt = receipt?.getFlag(MODULE_ID, "gatherRoll");
  if (!receipt?.author?.isGM || attempt?.token !== token.uuid) fail("brokenReceipt");
  if (action !== "gather" || attempt.actor !== actor.uuid) fail("gatherStarted");
  const kit = attempt.kit && actor.items.get(attempt.kit);
  if (attempt.kit && (!isHerbalismKit(kit) || kit.system.quantity < 1 || !kit.system.uses?.value)) fail("kitChanged");
  return { actor, token, table: attempt.table, kit, attempt };
}

export async function rememberGather({ token, actor, kit, table }, total) {
  const id = gatherRollId(token);
  const receipt = await ChatMessage.create(
    {
      _id: id,
      whisper: game.users.filter((user) => user.isGM).map((user) => user.id),
      content: t("gatherRolled", {
        actor: foundry.utils.escapeHTML(actor.name),
        target: foundry.utils.escapeHTML(token.name),
        total
      }),
      flags: {
        [MODULE_ID]: { gatherRoll: { token: token.uuid, actor: actor.uuid, kit: kit?.id ?? null, table, total } }
      }
    },
    { keepId: true }
  );
  if (receipt?.id !== id || !(await token.setFlag(MODULE_ID, "gatherRoll", id))) fail("saveError");
}

export function gatherRows(current, total) {
  return current.table.components.map((component) => previewGather(component, total, Boolean(current.kit)));
}

export function reviewPlant(current, total) {
  return reviewGather(current.actor, current.token, gatherRows(current, total), total);
}

export async function gatherPlan(current, total, selection) {
  const { actor, token, kit } = current;
  const rows = gatherRows(current, total);
  for (const [index, row] of rows.entries()) {
    if (row.outcome !== "superior") continue;
    const { bonus, price } = selection[index];
    if (!["portion", "charge", "value"].includes(bonus)) fail("changed");
    row.bonus = bonus;
    if (bonus === "value") {
      const base = sourceItem(row.component.item)?.system.price;
      if (!base || !Number.isFinite(price) || price <= base.value) fail("changed");
      row.price = { value: price, denomination: base.denomination };
    }
  }
  const plan = awardPlan(actor, token, kit, rows, total, "gather");
  const specimens = [];
  for (const gain of plan.gains) {
    const source = game.items.get(gain.source);
    if (gain.chargeFormula && !source.system.uses) fail("needItemUses", { name: source.name });
    const formula = gain.chargeFormula ?? source.toObject().system.uses?.max;
    if (!formula) {
      if (gain.bonus === "charge") fail("changed");
      specimens.push(gain);
      continue;
    }
    for (let i = 0; i < gain.quantity; i++) {
      const roll = await new Roll(String(formula), actor.getRollData()).evaluate();
      if (!Number.isSafeInteger(roll.total) || roll.total < 0) fail("invalidCharges", { name: source.name });
      const specimen = { ...gain, id: i === 0 ? gain.id : foundry.utils.randomID(), quantity: 1, charges: roll.total };
      if ((gain.bonus === "charge" && i !== 0) || (gain.bonus === "portion" && i !== gain.quantity - 1))
        delete specimen.bonus;
      if (specimen.bonus === "charge") specimen.charges++;
      specimens.push(specimen);
    }
  }
  plan.gains = specimens;
  plan.cards.at(-1).parts = specimens.map(({ name, quantity, bonus, price, charges }) => ({
    name,
    quantity,
    ...(bonus && { bonus }),
    ...(price && { price }),
    ...(charges != null && { charges })
  }));
  return plan;
}
