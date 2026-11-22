import { MODULE_ID } from "../constants.mjs";
import { sourceItem } from "./rules.mjs";
import { renderCard, t } from "./views.mjs";

const path = (flag) => `flags.${MODULE_ID}.${flag}`;
const id = () => foundry.utils.randomID();
const chargeSlot = (kit) => kit.getFlag(MODULE_ID, "nextHarvestCharge") ?? "HarvestKitCharge";

// An embedded ID can be created once on the server, even from independent browsers of the same GM.
// Include the scene and token because linked tokens share their actor's effect collection.
function claimId(token, action) {
  let hash = 0xcbf29ce484222325n;
  for (const char of token.uuid) hash = BigInt.asUintN(64, (hash ^ BigInt(char.charCodeAt(0))) * 0x100000001b3n);
  return (action === "harvest" ? "Hrv" : "Apr") + hash.toString(36).padStart(13, "0");
}

export function corpseClaim(token, action) {
  const effect = token.actor.effects.get(claimId(token, action));
  if (!effect) return;
  const claim = effect.getFlag(MODULE_ID, "corpseClaim");
  if (claim?.token !== token.uuid || claim.action !== action) throw new Error(t("brokenReceipt"));
  return claim;
}

export async function claimCorpse(token, action, values) {
  const claim = { ...values, action, token: token.uuid };
  const [effect] = await token.actor.createEmbeddedDocuments(
    "ActiveEffect",
    [
      {
        _id: claimId(token, action),
        name: t(action === "harvest" ? "harvestRecord" : "appraisalRecord", { target: token.name }),
        disabled: true,
        transfer: false,
        origin: token.uuid,
        flags: { [MODULE_ID]: { corpseClaim: claim } }
      }
    ],
    { keepId: true }
  );
  if (effect?.getFlag(MODULE_ID, "corpseClaim")?.id !== claim.id) throw new Error(t("saveError"));
  return claim;
}

export function awardPlan(actor, token, kit, rows, total) {
  const gains = rows
    .filter((r) => r.outcome === "gained")
    .map(({ component }) => {
      const source = sourceItem(component.item);
      if (!source) throw new Error(t("missingItem", { item: component.item }));
      return { id: id(), source: source.id, name: component.name, quantity: component.quantity };
    });
  const subject = { actor: actor.name, target: token.name, total };
  const cards = rows
    .filter((r) => r.outcome === "danger")
    .map(({ component }) => ({
      id: id(),
      type: "danger",
      ...subject,
      actorUuid: actor.uuid,
      name: component.name,
      danger: component.danger
    }));
  cards.push({ id: id(), type: "summary", ...subject, parts: gains.map(({ name, quantity }) => ({ name, quantity })) });
  return {
    token: token.uuid,
    actor: actor.uuid,
    kit: kit?.id ?? null,
    chargeSlot: kit ? chargeSlot(kit) : null,
    gains,
    cards
  };
}

export function cardData(card, actor, whisper = []) {
  return {
    _id: card.id,
    speaker: ChatMessage.getSpeaker({ actor }),
    content: renderCard(card),
    whisper,
    flags: { [MODULE_ID]: { harvestCard: card } }
  };
}

export function pendingAward(token, actor) {
  let reference = corpseClaim(token, "harvest")?.id ?? token.getFlag(MODULE_ID, "harvestPending");
  if (!reference && actor) {
    // The GM may have disconnected between reserving the kit's next charge and claiming the corpse.
    for (const kit of actor.items) {
      const reservation = kit.effects.get(chargeSlot(kit))?.getFlag(MODULE_ID, "harvestReservation");
      if (reservation?.token === token.uuid) {
        reference = reservation.receipt;
        break;
      }
    }
  }
  if (!reference) return;
  const receipt = game.messages.get(reference);
  const plan = receipt?.getFlag(MODULE_ID, "harvestAward");
  if (!receipt?.author?.isGM || plan?.token !== token.uuid) throw new Error(t("brokenReceipt"));
  return { receipt, plan };
}

async function reserveCharge(kit, token, slot, receipt) {
  const existing = kit.effects.get(slot);
  if (existing?.getFlag(MODULE_ID, "harvestReservation")?.receipt === receipt.id) return existing;
  if (chargeSlot(kit) !== slot || kit.system.uses.value < 1) throw new Error(t("kitChanged"));
  if (existing) throw new Error(t("busy"));
  // Only one receipt can claim this charge. Debiting moves the kit to a new slot even across manual refills.
  const data = {
    _id: slot,
    name: t("chargeRecord", { target: token.name }),
    disabled: true,
    transfer: false,
    origin: token.uuid,
    flags: { [MODULE_ID]: { harvestReservation: { token: token.uuid, receipt: receipt.id } } }
  };
  let reservation;
  try {
    [reservation] = await kit.createEmbeddedDocuments("ActiveEffect", [data], { keepId: true });
  } catch (error) {
    if (error.message?.includes(`_id [${slot}] already exists within the parent collection`))
      throw new Error(t("busy"), { cause: error });
    throw error;
  }
  if (reservation?.getFlag(MODULE_ID, "harvestReservation")?.receipt !== receipt.id) throw new Error(t("saveError"));
  return reservation;
}

async function reserveAward(token, actor, { plan, receipt }) {
  const kit = plan.kit && actor.items.get(plan.kit);
  if (plan.kit && !kit) throw new Error(t("kitChanged"));
  const paid = kit?.getFlag(MODULE_ID, "harvestCharges")?.[receipt.id];
  const reservation = kit && !paid && (await reserveCharge(kit, token, plan.chargeSlot ?? chargeSlot(kit), receipt));
  try {
    const claimed = corpseClaim(token, "harvest");
    if (!claimed) await claimCorpse(token, "harvest", { id: receipt.id });
    else if (claimed.id !== receipt.id) throw new Error(t("alreadyHarvested"));
  } catch (error) {
    const winner = corpseClaim(token, "harvest");
    if (reservation && winner && winner.id !== receipt.id) await reservation.delete();
    throw error;
  }
  return kit;
}

export async function recordAward(token, plan) {
  // The approved plan stays in a GM whisper. A token's flags are visible to players on the scene.
  const receipt = await ChatMessage.create({
    whisper: game.users.filter((user) => user.isGM).map((user) => user.id),
    content: t("approved", { target: foundry.utils.escapeHTML(token.name) }),
    flags: { [MODULE_ID]: { harvestAward: plan } }
  });
  if (!receipt) throw new Error(t("saveError"));
  const actor = fromUuidSync(plan.actor);
  try {
    await reserveAward(token, actor, { plan, receipt });
  } catch (error) {
    const reservation = actor?.items
      .get(plan.kit)
      ?.effects.get(plan.chargeSlot)
      ?.getFlag(MODULE_ID, "harvestReservation");
    if (corpseClaim(token, "harvest")?.id !== receipt.id && reservation?.receipt !== receipt.id) await receipt.delete();
    throw error;
  }
  if (!(await token.setFlag(MODULE_ID, "harvestPending", receipt.id))) throw new Error(t("saveError"));
  return { receipt, plan };
}

export async function finishAward(token, actor, { receipt, plan }) {
  const checkGM = () => {
    if (!game.user.isActiveGM) throw new Error(t("needGM"));
  };
  if (plan.actor !== actor.uuid || plan.token !== token.uuid) throw new Error(t("otherHarvester"));
  checkGM();
  const kit = await reserveAward(token, actor, { receipt, plan });
  const items = [];
  for (const gain of plan.gains) {
    const existing = actor.items.get(gain.id);
    if (existing?.getFlag(MODULE_ID, "harvestReceipt") === receipt.id) continue;
    const source = game.items.get(gain.source);
    if (existing || !source) throw new Error(t("missingItem", { item: gain.name }));
    const data = source.toObject();
    data._id = gain.id;
    data.folder = null;
    data.system.quantity = gain.quantity;
    foundry.utils.setProperty(data, path("harvestReceipt"), receipt.id);
    items.push(data);
  }
  if (kit && !kit.getFlag(MODULE_ID, "harvestCharges")?.[receipt.id]) {
    checkGM();
    if (kit.system.uses.value < 1) throw new Error(t("kitChanged"));
    if (
      !(await kit.update({
        "system.uses.spent": kit.system.uses.spent + 1,
        [path(`harvestCharges.${receipt.id}`)]: true,
        [path("nextHarvestCharge")]: receipt.id
      }))
    )
      throw new Error(t("saveError"));
  }
  checkGM();
  if (items.length) {
    const granted = await actor.createEmbeddedDocuments("Item", items, { keepId: true });
    if (granted.length !== items.length) throw new Error(t("saveError"));
  }
  for (const card of plan.cards) {
    if (game.messages.has(card.id)) continue;
    checkGM();
    if (!(await ChatMessage.create(cardData(card, actor), { keepId: true, messageMode: "public" })))
      throw new Error(t("saveError"));
  }
  checkGM();
  if (!(await token.update({ [path("harvested")]: true, [path("-=harvestPending")]: null })))
    throw new Error(t("saveError"));
}
