import { MODULE_ID } from "../constants.mjs";
import { gatherDC, isHerbalismKit } from "../herbalism/rules.mjs";
import { choosePlantAction, confirmPlantRoll } from "../herbalism/views.mjs";
import {
  deferredGather,
  gatherPlan,
  plantContext,
  rememberGather,
  reviewPlant,
  rollPlant
} from "../herbalism/workflow.mjs";
import {
  awardPlan,
  cardData,
  claimCorpse,
  corpseClaim,
  finishAward,
  harvested,
  harvestRound,
  pendingAward,
  recordAward
} from "./award.mjs";
import { setupCorpseHUD } from "./hud.mjs";
import { harvestEquipment, harvestTable, isCorpse, isHarvestKit, previewHarvest } from "./rules.mjs";
import { chooseAction, confirmRoll, key, renderHarvestMessage, reviewHarvest, t } from "./views.mjs";

const plants = new Set(["identify", "gather"]);
const inspections = {
  appraise: {
    attempted: "appraisedBy",
    success: "appraisalSuccess",
    delivery: "appraisalDelivery",
    type: "appraisal",
    already: "alreadyAppraised"
  },
  identify: {
    attempted: "identifiedBy",
    success: "identificationSuccess",
    delivery: "identificationDelivery",
    type: "identification",
    already: "alreadyIdentified"
  }
};
const prepareQuery = `${MODULE_ID}.prepareHarvest`;
const executeQuery = `${MODULE_ID}.executeHarvest`;
const requests = new Map();
const busy = new Set();
const fail = (name, fields) => {
  throw new Error(t(name, fields));
};
const flag = (key) => `flags.${MODULE_ID}.${key}`;

function context(data, user) {
  if (!game.user.isActiveGM || !user?.active) fail("needGM");
  const plant = plants.has(data?.action);
  if (!plant && !["appraise", "harvest"].includes(data?.action)) fail("invalid");
  const scene = game.scenes.get(data.sceneId);
  const token = scene?.tokens.get(data.tokenId);
  if (!token || (!user.isGM && (scene.id !== user.viewedScene || token.hidden)))
    fail(plant ? "needPlantTarget" : "needTarget");
  const actor = game.actors.get(data.actorId);
  const actingToken = data.actingTokenId ? scene.tokens.get(data.actingTokenId) : null;
  const harvester = actingToken ? actingToken.actor : actor;
  if (!harvester || (data.actingTokenId && !actingToken) || !harvester.testUserPermission(user, "OWNER"))
    fail("needActor");
  if (!token.actor || token.actor.uuid === harvester.uuid) fail(plant ? "needPlant" : "needCorpse");
  if (!plant && !isCorpse(token)) fail("needCorpse");
  if (!plant && data.round !== undefined && data.round !== harvestRound(token)) fail("changed");
  if (plant ? token.getFlag(MODULE_ID, "gathered") : harvested(token))
    fail(plant ? "alreadyGathered" : "alreadyHarvested");
  const awardAction = plant ? "gather" : "harvest";
  const pending = pendingAward(token, harvester, awardAction);
  if (pending) {
    if (data.action !== awardAction || pending.plan.actor !== harvester.uuid) fail("otherHarvester");
    return { actor: harvester, token, pending };
  }
  if (plant) {
    const deferred = deferredGather(data.action, token, harvester);
    if (deferred) return deferred;
  }
  const inspection = inspections[data.action];
  if (inspection) {
    const claim = corpseClaim(token, data.action);
    const attempted = token.getFlag(MODULE_ID, inspection.attempted)?.length;
    if (
      claim &&
      (!attempted || token.getFlag(MODULE_ID, inspection.delivery)) &&
      claim.userId === user.id &&
      claim.actor === harvester.uuid
    )
      return {
        actor: harvester,
        token,
        table: token.actor.getFlag(MODULE_ID, plant ? "herbalism" : "harvest"),
        delivery: claim
      };
    if (claim || attempted) fail(inspection.already);
  }
  if (plant) return plantContext(data, harvester, token, user);
  const table = harvestTable(token);
  if (!table) fail("noTable");
  const trainedSkill = harvester.system.skills?.[table.appraise.skill];
  const trained = (trainedSkill?.effectValue ?? trainedSkill?.value ?? 0) >= 1;
  const { kit, proficiency } = harvestEquipment(harvester, data.kitId);
  const appraise = data.action === "appraise";
  if ((appraise || !kit) && !trained) fail("needSkill", { skill: CONFIG.DND5E.skills[table.appraise.skill].label });
  const advantage = appraise ? proficiency >= 1 : Boolean(kit) && Boolean(token.getFlag(MODULE_ID, "appraisalSuccess"));
  const mode = !appraise && !kit ? "disadvantage" : advantage ? "advantage" : "ordinary";
  return { actor: harvester, token, table, kit, proficiency, mode };
}

async function roll(action, { actor, table, kit, proficiency, mode }) {
  const options = { configure: false };
  const message = { create: false };
  const config = mode === "ordinary" ? {} : { [mode]: true };
  if (action === "appraise")
    return (
      await actor.rollSkill({ ...config, skill: table.appraise.skill, target: table.appraise.dc }, options, message)
    )?.[0];
  if (kit) {
    const learned = actor.system.tools?.harvest?.effectValue ?? 0;
    if (proficiency > learned) {
      // Use the system's proficiency term so legacy item training respects expertise and proficiency dice too.
      options.options = {
        buildConfig: (...args) => {
          actor._buildSkillToolConfig("tool", null, ...args);
          const [process, roll] = args;
          const prof = actor.system.calculateToolProficiency(proficiency, "dex", process);
          if (!roll.parts.includes("@prof")) roll.parts.push("@prof");
          roll.data.prof = prof.term;
        }
      };
    }
    return (
      await actor.rollToolCheck(
        { ...config, tool: "harvest", ability: "dex", bonus: kit.system.bonus },
        options,
        message
      )
    )?.[0];
  }
  // Keep the actor's normal Dexterity check modifiers, but exclude proficiency, including Jack of All Trades.
  options.options = {
    buildConfig: (_process, roll) => {
      roll.parts = roll.parts.filter((part) => part !== "@prof");
    }
  };
  return (await actor.rollAbilityCheck({ ...config, ability: "dex" }, options, message))?.[0];
}

async function deliverInspection({ token, actor, table }, user, delivery) {
  const { action, success, gathererUuid } = delivery;
  const inspection = inspections[action];
  if (
    !token.getFlag(MODULE_ID, inspection.attempted)?.length &&
    !(await token.update({
      [flag(inspection.attempted)]: [user.id],
      [flag(inspection.success)]: success,
      [flag(inspection.delivery)]: delivery.id,
      ...(gathererUuid && { [flag("identifiedFor")]: gathererUuid })
    }))
  )
    fail("saveError");
  if (!game.messages.has(delivery.id)) {
    const card = {
      id: delivery.id,
      type: inspection.type,
      actor: actor.name,
      target: token.name,
      total: delivery.total,
      success,
      parts: success
        ? table.components.map((part) => ({
            name: part.name,
            dc: action === "identify" ? gatherDC(part) : part.dc,
            edible: part.edible,
            danger: part.danger
          }))
        : []
    };
    const gatherer = gathererUuid && fromUuidSync(gathererUuid);
    const recipients = new Set([user.id, game.user.id]);
    if (gatherer)
      for (const owner of game.users) if (gatherer.testUserPermission(owner, "OWNER")) recipients.add(owner.id);
    if (!(await ChatMessage.create(cardData(card, actor, [...recipients]), { keepId: true }))) fail("saveError");
  }
  if (!(await token.unsetFlag(MODULE_ID, inspection.delivery))) fail("saveError");
}

async function inspect(action, current, user, result) {
  const dc = action === "identify" ? current.dc : current.table.appraise.dc;
  const delivery = await claimCorpse(current.token, action, {
    id: foundry.utils.randomID(),
    total: result.total,
    userId: user.id,
    actor: current.actor.uuid,
    ...(current.gathererUuid && { gathererUuid: current.gathererUuid }),
    success: result.total >= dc
  });
  return deliverInspection(current, user, delivery);
}

async function perform(data, user) {
  let before = context(data, user);
  if (before.delivery) return deliverInspection(before, user, before.delivery);
  if (before.pending) return finishAward(before.token, before.actor, before.pending);
  const plant = plants.has(data.action);
  const result = before.attempt ?? (await (plant ? rollPlant : roll)(data.action, before));
  if (!result) return false;
  if (inspections[data.action]) return inspect(data.action, context(data, user), user, result);
  if (data.action === "gather" && !before.attempt) {
    await rememberGather(before, result.total);
    before = context(data, user);
  }
  const selection = plant
    ? await reviewPlant(before, result.total)
    : await reviewHarvest(before.actor, before.token, before.table, result.total, Boolean(before.kit));
  if (!selection) return false;
  const current = context(data, user);
  if (
    current.pending ||
    current.kit?.id !== before.kit?.id ||
    current.proficiency !== before.proficiency ||
    current.mode !== before.mode ||
    !foundry.utils.equals(current.table, before.table)
  )
    fail("changed");
  let plan;
  try {
    if (plant) plan = await gatherPlan(current, result.total, selection);
    else {
      const rows = previewHarvest(current.table, result.total, selection, Boolean(current.kit));
      plan = awardPlan(current.actor, current.token, current.kit, rows, result.total);
    }
  } catch (error) {
    ui.notifications.error(foundry.utils.escapeHTML(error.message));
    fail("awardError");
  }
  const award = await recordAward(current.token, plan);
  return finishAward(current.token, current.actor, award);
}

function prepare(data, { user }) {
  const current = context(data, user);
  const ticket = foundry.utils.randomID();
  // User.query broadcasts to every tab of the active GM. Only the tab whose answer reached the player owns this ticket.
  requests.set(ticket, {
    data: {
      ...foundry.utils.deepClone(data),
      round: plants.has(data.action) ? undefined : harvestRound(current.token)
    },
    userId: user.id,
    expires: Date.now() + 300000
  });
  for (const [id, entry] of requests) if (entry.expires < Date.now()) requests.delete(id);
  return {
    ticket,
    tab: game.socket.id,
    target: current.token.name,
    resume: Boolean(current.pending || current.delivery || current.attempt),
    skill: current.table?.appraise?.skill,
    dc: current.dc ?? current.table?.appraise?.dc,
    methods: current.methods,
    gatherers: current.gatherers,
    mode: current.mode,
    withKit: Boolean(current.kit)
  };
}

async function execute({ ticket, tab, method, gathererUuid }, { user }) {
  // Only the addressed tab acknowledges. The server uses the first response across all sessions of the GM account.
  if (tab !== game.socket.id) return new Promise(() => {});
  const entry = requests.get(ticket);
  if (!entry || entry.userId !== user.id || entry.expires < Date.now()) fail("expired");
  requests.delete(ticket);
  const data = { ...entry.data, method, gathererUuid };
  const { token, actor } = context(data, user);
  const keys = [token.uuid, actor.uuid].sort();
  const run = async () => {
    if (keys.some((id) => busy.has(id))) fail("busy");
    for (const id of keys) busy.add(id);
    try {
      return await perform(data, user);
    } finally {
      for (const id of keys) busy.delete(id);
    }
  };
  const lock = (i) => {
    if (!navigator.locks || i === keys.length) return run();
    return navigator.locks.request(`${MODULE_ID}.harvest.${game.world.id}.${keys[i]}`, { ifAvailable: true }, (held) =>
      held ? lock(i + 1) : fail("busy")
    );
  };
  return lock(0);
}

async function request(action, actor, kitId) {
  const plant = plants.has(action);
  const gm = game.users.activeGM;
  if (!gm) fail("needGM");
  actor ??= canvas.tokens.controlled.length === 1 ? canvas.tokens.controlled[0].actor : game.user.character;
  if (!actor?.isOwner) fail("needActor");
  if (game.user.targets.size !== 1) fail(plant ? "needPlantTarget" : "needTarget");
  const [target] = game.user.targets;
  const data = {
    action,
    sceneId: target.document.parent.id,
    tokenId: target.id,
    actorId: actor.id,
    actingTokenId: actor.isToken ? actor.token.id : null,
    kitId
  };
  const info = await gm.query(prepareQuery, data, { timeout: 10000 });
  let selection;
  if (!info.resume) {
    selection = plant ? await confirmPlantRoll(action, actor, info) : await confirmRoll(action, actor, info);
    if (!selection || selection === "cancel") return false;
  }
  return (
    (await gm.query(
      executeQuery,
      { ticket: info.ticket, tab: info.tab, ...(plant && selection) },
      { timeout: 600000 }
    )) !== false
  );
}

function notifyRequest(action, actor, kitId) {
  return request(action, actor, kitId).catch((error) => {
    ui.notifications.warn(foundry.utils.escapeHTML(error.message));
    return false;
  });
}

export const harvesting = {
  request: (action, actor, kitId) =>
    ["appraise", "harvest"].includes(action) ? notifyRequest(action, actor, kitId) : Promise.resolve(false)
};
export const herbalism = {
  request: (action, actor, kitId) => (plants.has(action) ? notifyRequest(action, actor, kitId) : Promise.resolve(false))
};

export function setupHarvesting() {
  Hooks.once("init", () => {
    if (game.system.id !== "dnd5e") return;
    setupCorpseHUD();
    CONFIG.DND5E.tools.harvest = { id: "", ability: "dex", label: key("kit") };
    CONFIG.DND5E.toolProficiencies.harvest = key("kit");
    Hooks.once("i18nInit", () => {
      CONFIG.DND5E.tools.harvest.label = t("kit");
    });
    CONFIG.queries[prepareQuery] = prepare;
    CONFIG.queries[executeQuery] = execute;
    Hooks.on("dnd5e.preUseActivity", (activity) => {
      const actions = isHerbalismKit(activity.item)
        ? { IdentifyHerb0001: "identify", CheckKitSupplies: "gather" }
        : isHarvestKit(activity.item)
          ? { AppraiseCreature: "appraise", CheckKitSupplies: "harvest" }
          : {};
      const action = actions[activity.id];
      if (!action) return;
      notifyRequest(action, activity.actor, activity.item.id);
      return false;
    });
    Hooks.on("getSceneControlButtons", ({ tokens }) => {
      tokens.tools.myHerbalism = {
        name: "myHerbalism",
        title: key("herbalism"),
        icon: "fa-solid fa-seedling",
        order: Object.keys(tokens.tools).length + 1,
        button: true,
        onChange: async () => {
          const action = await choosePlantAction();
          if (action) await notifyRequest(action);
        }
      };
      tokens.tools.myHarvest = {
        name: "myHarvest",
        title: key("title"),
        icon: "fa-solid fa-sickle",
        order: Object.keys(tokens.tools).length + 1,
        button: true,
        onChange: async () => {
          const action = await chooseAction();
          if (action) await notifyRequest(action);
        }
      };
    });
    Hooks.on("renderChatMessageHTML", renderHarvestMessage);
  });
}
