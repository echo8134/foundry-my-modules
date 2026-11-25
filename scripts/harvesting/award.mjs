import { MODULE_ID } from "../constants.mjs";
import { harvestTable, isCorpse, sourceItem } from "./rules.mjs";
import { renderCard, t } from "./views.mjs";

const path = (flag) => `flags.${MODULE_ID}.${flag}`;
const id = () => foundry.utils.randomID();
const chargeSlot = (kit) => kit.getFlag(MODULE_ID, "nextHarvestCharge") ?? "HarvestKitCharge";

const actions = {
  appraise: { prefix: "Apr", claim: "corpseClaim", record: "appraisalRecord" },
  harvest: {
    prefix: "Hrv",
    claim: "corpseClaim",
    record: "harvestRecord",
    pending: "harvestPending",
    done: "harvested"
  },
  identify: { prefix: "Idn", claim: "plantClaim", record: "identificationRecord" },
  gather: { prefix: "Gth", claim: "plantClaim", record: "gatherRecord", pending: "gatherPending", done: "gathered" }
};

// Round zero uses the flags and claim IDs from existing worlds.
export function harvestRound(token) {
  return Object.keys(token.getFlag(MODULE_ID, "harvestRounds") ?? {}).length;
}

function roundFlag(name, round) {
  return round ? `harvestRounds.r${round}.${name}` : name;
}

export function harvested(token, round = harvestRound(token)) {
  return Boolean(token.getFlag(MODULE_ID, roundFlag("harvested", round)));
}

export function openHarvestRound(token, completed) {
  if (
    !game.user.isGM ||
    !isCorpse(token) ||
    !harvestTable(token) ||
    completed !== harvestRound(token) ||
    !harvested(token, completed)
  )
    return false;
  // Two GM tabs resetting the same round write the same leaf, preserving later awards.
  return token.update({ [path(roundFlag("opened", completed + 1))]: true });
}

// An embedded ID can be created once on the server, even from independent browsers of the same GM.
// Include the scene and token because linked tokens share their actor's effect collection.
function claimId(token, action, round) {
  let hash = 0xcbf29ce484222325n;
  const key = round ? `${token.uuid}:${round}` : token.uuid;
  for (const char of key) hash = BigInt.asUintN(64, (hash ^ BigInt(char.charCodeAt(0))) * 0x100000001b3n);
  return actions[action].prefix + hash.toString(36).padStart(13, "0");
}

// The private roll and the public claim live in different Foundry collections.
export const gatherRollId = (token) => claimId(token, "gather", 0);

export function corpseClaim(token, action, round = 0) {
  const effect = token.actor.effects.get(claimId(token, action, round));
  if (!effect) return;
  const claim = effect.getFlag(MODULE_ID, actions[action].claim);
  if (claim?.token !== token.uuid || claim.action !== action || (claim.round ?? 0) !== round)
    throw new Error(t("brokenReceipt"));
  return claim;
}

export async function claimCorpse(token, action, values, round = 0) {
  const claim = { ...values, action, token: token.uuid, round };
  const [effect] = await token.actor.createEmbeddedDocuments(
    "ActiveEffect",
    [
      {
        _id: claimId(token, action, round),
        name: t(actions[action].record, { target: token.name }),
        disabled: true,
        transfer: false,
        origin: token.uuid,
        flags: { [MODULE_ID]: { [actions[action].claim]: claim } }
      }
    ],
    { keepId: true }
  );
  if (effect?.getFlag(MODULE_ID, actions[action].claim)?.id !== claim.id) throw new Error(t("saveError"));
  return claim;
}

export function awardPlan(actor, token, kit, rows, total, action = "harvest") {
  const gains = rows
    .filter((r) => ["gained", "superior"].includes(r.outcome))
    .map(({ component, bonus, price }) => {
      const source = sourceItem(component.item);
      if (!source) throw new Error(t("missingItem", { item: component.item }));
      const quantity = component.quantity + (bonus === "portion" ? 1 : 0);
      return {
        id: id(),
        source: source.id,
        name: component.name,
        quantity,
        ...(bonus && { bonus }),
        ...(price && { price }),
        ...(action === "gather" && component.charges && { chargeFormula: component.charges })
      };
    });
  const subject = { actor: actor.name, target: token.name, total };
  const cards = rows
    .filter((r) => r.outcome === "danger")
    .map(({ component }) => ({
      id: id(),
      type: "danger",
      ...(action === "gather" && { plant: true }),
      ...subject,
      actorUuid: actor.uuid,
      name: component.name,
      danger: component.danger
    }));
  cards.push({
    id: id(),
    type: action === "gather" ? "gatherSummary" : "summary",
    ...subject,
    parts: gains.map(({ name, quantity, bonus, price }) => ({
      name,
      quantity,
      ...(bonus && { bonus }),
      ...(price && { price })
    }))
  });
  return {
    ...(action === "gather" ? { action } : { round: harvestRound(token) }),
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

export function pendingAward(token, actor, action = "harvest") {
  const round = action === "harvest" ? harvestRound(token) : 0;
  let reference =
    corpseClaim(token, action, round)?.id ?? token.getFlag(MODULE_ID, roundFlag(actions[action].pending, round));
  if (!reference && actor) {
    // The GM may have disconnected between reserving the kit's next charge and claiming the corpse.
    for (const kit of actor.items) {
      const reservation = kit.effects.get(chargeSlot(kit))?.getFlag(MODULE_ID, "harvestReservation");
      if (
        reservation?.token === token.uuid &&
        (reservation.action ?? "harvest") === action &&
        (reservation.round ?? 0) === round
      ) {
        reference = reservation.receipt;
        break;
      }
    }
  }
  if (!reference) return;
  const receipt = game.messages.get(reference);
  const plan = receipt?.getFlag(MODULE_ID, "harvestAward");
  if (
    !receipt?.author?.isGM ||
    plan?.token !== token.uuid ||
    (plan.action ?? "harvest") !== action ||
    (plan.round ?? 0) !== round
  )
    throw new Error(t("brokenReceipt"));
  return { receipt, plan };
}

async function reserveCharge(kit, token, slot, receipt, action, round) {
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
    flags: {
      [MODULE_ID]: { harvestReservation: { action, token: token.uuid, receipt: receipt.id, round } }
    }
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

function checkAwardRound(token, plan) {
  if ((plan.action ?? "harvest") !== "harvest") return;
  if ((plan.round ?? 0) !== harvestRound(token)) throw new Error(t("changed"));
  if (harvested(token, plan.round ?? 0)) throw new Error(t("alreadyHarvested"));
}

async function reserveAward(token, actor, { plan, receipt }) {
  const action = plan.action ?? "harvest";
  checkAwardRound(token, plan);
  const round = plan.round ?? 0;
  const kit = plan.kit && actor.items.get(plan.kit);
  if (plan.kit && !kit) throw new Error(t("kitChanged"));
  const paid = kit?.getFlag(MODULE_ID, "harvestCharges")?.[receipt.id];
  const reservation =
    kit && !paid && (await reserveCharge(kit, token, plan.chargeSlot ?? chargeSlot(kit), receipt, action, round));
  try {
    checkAwardRound(token, plan);
    const claimed = corpseClaim(token, action, round);
    if (!claimed) await claimCorpse(token, action, { id: receipt.id }, round);
    else if (claimed.id !== receipt.id)
      throw new Error(t(action === "gather" ? "alreadyGathered" : "alreadyHarvested"));
  } catch (error) {
    const winner = corpseClaim(token, action, round);
    if (reservation && winner && winner.id !== receipt.id) await reservation.delete();
    throw error;
  }
  return kit;
}

export async function recordAward(token, plan) {
  const action = plan.action ?? "harvest";
  checkAwardRound(token, plan);
  const round = plan.round ?? 0;
  // The approved plan stays in a GM whisper. A token's flags are visible to players on the scene.
  const receipt = await ChatMessage.create({
    whisper: game.users.filter((user) => user.isGM).map((user) => user.id),
    content: t(action === "gather" ? "gatherApproved" : "approved", { target: foundry.utils.escapeHTML(token.name) }),
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
    if (corpseClaim(token, action, round)?.id !== receipt.id && reservation?.receipt !== receipt.id)
      await receipt.delete();
    throw error;
  }
  if (!(await token.update({ [path(roundFlag(actions[action].pending, round))]: receipt.id })))
    throw new Error(t("saveError"));
  return { receipt, plan };
}

export async function finishAward(token, actor, { receipt, plan }) {
  const checkGM = () => {
    if (!game.user.isActiveGM) throw new Error(t("needGM"));
    checkAwardRound(token, plan);
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
    if (gain.price) Object.assign(data.system.price, gain.price);
    if (gain.charges != null) {
      data.system.uses.max = String(gain.charges);
      data.system.uses.spent = 0;
    }
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
  const { done, pending } = actions[plan.action ?? "harvest"];
  const round = plan.round ?? 0;
  if (!(await token.update({ [path(roundFlag(done, round))]: true, [path(roundFlag(pending, round))]: _del })))
    throw new Error(t("saveError"));
}
