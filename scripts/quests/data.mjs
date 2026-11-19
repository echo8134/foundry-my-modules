import { MODULE_ID } from "../constants.mjs";

export const QUEST_STATUSES = ["active", "available", "completed", "failed", "hidden"];
export const statusLabel = (status) => `MY_MODULES.Quests.Status.${status}`;
const FLAG = `flags.${MODULE_ID}.quest`;
const localize = (key) => game.i18n.localize(`MY_MODULES.Quests.${key}`);
const asArray = (value) => (Array.isArray(value) ? value : []);
const questItems = (value) => asArray(value).filter((item) => foundry.utils.isPlainObject(item));

function emptyQuest() {
  return {
    status: "hidden",
    giver: { name: "", img: "", uuid: null },
    objectives: [],
    rewards: [],
    parent: null,
    personal: [],
    primary: false,
    source: null,
    sort: 0
  };
}

function flagOf(entry) {
  if (entry?.documentName !== "JournalEntry" || entry.inCompendium) return null;
  const flag = entry.getFlag(MODULE_ID, "quest");
  return foundry.utils.isPlainObject(flag) ? flag : null;
}

function requireGM() {
  if (!game.user.isGM) throw new Error(`${MODULE_ID} | only a Gamemaster can edit quests`);
}

function requireQuest(entry) {
  requireGM();
  const flag = flagOf(entry);
  if (!flag) throw new Error(`${MODULE_ID} | expected a quest journal`);
  return flag;
}

const statusOf = (quest) => (QUEST_STATUSES.includes(quest.status) ? quest.status : "hidden");

function questOwnership(quest) {
  const { NONE, OBSERVER } = CONST.DOCUMENT_OWNERSHIP_LEVELS;
  if (statusOf(quest) === "hidden") return { default: NONE };
  const personal = asArray(quest.personal);
  if (!personal.length) return { default: OBSERVER };
  const users = personal.filter((id) => game.users.has(id));
  return { default: NONE, ...Object.fromEntries(users.map((id) => [id, OBSERVER])) };
}

export function questView(entry) {
  const flag = flagOf(entry);
  if (!flag) return null;
  const status = statusOf(flag);
  const gm = game.user.isGM;
  const personal = asArray(flag.personal);
  if (!gm && (status === "hidden" || (personal.length && !personal.includes(game.user.id)))) return null;
  if (!entry.testUserPermission(game.user, "OBSERVER")) return null;

  const visible = (items) => questItems(items).filter((item) => gm || !item.hidden);
  const objectives = visible(flag.objectives).map((objective) => ({
    ...objective,
    children: visible(objective.children)
  }));
  return foundry.utils.deepClone({
    id: entry.id,
    uuid: entry.uuid,
    name: entry.name,
    status,
    giver: { name: "", img: "", uuid: null, ...flag.giver },
    objectives,
    rewards: visible(flag.rewards),
    sort: Number.isFinite(flag.sort) ? flag.sort : 0
  });
}

export function listQuests() {
  const quests = [];
  for (const entry of game.journal) {
    try {
      const quest = questView(entry);
      if (quest) quests.push(quest);
    } catch (error) {
      console.warn(`${MODULE_ID} | Skipping quest ${entry.uuid}`, error);
    }
  }
  return quests.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

function folderName() {
  return game.settings.get(MODULE_ID, "questFolder").trim() || "Quests";
}

function findFolder(name) {
  return game.folders.find((folder) => folder.type === "JournalEntry" && folder.name === name);
}

const folderRequests = new Map();

export async function ensureQuestFolder() {
  if (!game.users.activeGM?.isSelf) return;
  const name = folderName();
  const existing = findFolder(name);
  if (existing) return existing;
  if (!folderRequests.has(name)) {
    folderRequests.set(
      name,
      Folder.create({ name, type: "JournalEntry" }).finally(() => folderRequests.delete(name))
    );
  }
  return folderRequests.get(name);
}

export async function createQuest() {
  requireGM();
  const folder = await ensureQuestFolder();
  return JournalEntry.create({
    name: localize("NewQuest"),
    folder: folder?.id ?? null,
    flags: { [MODULE_ID]: { quest: emptyQuest() } },
    pages: [
      { name: "Beschreibung", type: "text", sort: 0, flags: { [MODULE_ID]: { questPage: "description" } } },
      {
        name: "SL-Notizen",
        type: "text",
        sort: CONST.SORT_INTEGER_DENSITY,
        flags: { [MODULE_ID]: { questPage: "gmNotes" } },
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE }
      }
    ]
  });
}

export function createQuestPage(entry) {
  requireQuest(entry);
  const sort = Math.max(0, ...entry.pages.map((page) => page.sort)) + CONST.SORT_INTEGER_DENSITY;
  return CONFIG.JournalEntryPage.documentClass.createDialog({ sort }, { parent: entry }, { rejectClose: false });
}

export function deleteQuest(entry) {
  requireQuest(entry);
  return entry.deleteDialog();
}

export function updateQuest(entry, { name, status, giver }) {
  requireQuest(entry);
  const update = {};
  if (name?.trim()) update.name = name.trim();
  if (QUEST_STATUSES.includes(status)) update[`${FLAG}.status`] = status;
  if (giver) update[`${FLAG}.giver`] = giver;
  return entry.update(update);
}

function locateObjective(roots, id) {
  for (const list of [roots, ...roots.map((root) => root.children)]) {
    const index = list.findIndex((item) => item.id === id);
    if (index >= 0) return { list, index, item: list[index] };
  }
}

function siblings(roots, parentId) {
  if (parentId === null) return roots;
  return roots.find((item) => item.id === parentId)?.children;
}

// A blur followed by a click can submit two edits before the first document update arrives.
const objectiveWrites = new foundry.utils.Semaphore();

function changeObjectives(entry, change) {
  return objectiveWrites.add(async () => {
    const flag = requireQuest(entry);
    const roots = foundry.utils.deepClone(questItems(flag.objectives));
    for (const root of roots) root.children = questItems(root.children);
    if (change(roots)) await entry.update({ [`${FLAG}.objectives`]: roots });
  });
}

export function addObjective(entry, text, parentId = null) {
  return changeObjectives(entry, (roots) => {
    const list = siblings(roots, parentId);
    if (!list) return false;
    const slug = text.slugify({ strict: true }) || "objective";
    let id = slug;
    for (let n = 2; locateObjective(roots, id); n++) id = `${slug}-${n}`;
    const objective = { id, text, done: false, hidden: false };
    if (parentId === null) objective.children = [];
    list.push(objective);
    return true;
  });
}

export function editObjective(entry, id, { text, done, hidden }) {
  return changeObjectives(entry, (roots) => {
    const found = locateObjective(roots, id);
    if (!found) return false;
    if (text !== undefined) found.item.text = text;
    if (done !== undefined) found.item.done = done;
    if (hidden !== undefined) found.item.hidden = hidden;
    return true;
  });
}

export function moveObjective(entry, id, parentId = null, beforeId = null) {
  return changeObjectives(entry, (roots) => {
    const found = locateObjective(roots, id);
    if (!found || id === parentId || id === beforeId || (parentId !== null && found.item.children?.length))
      return false;
    const target = siblings(roots, parentId);
    if (!target || (beforeId !== null && !target.some((item) => item.id === beforeId))) return false;
    found.list.splice(found.index, 1);
    if (parentId === null) found.item.children ??= [];
    else delete found.item.children;
    const index = beforeId === null ? target.length : target.findIndex((item) => item.id === beforeId);
    target.splice(index, 0, found.item);
    return true;
  });
}

export function deleteObjective(entry, id) {
  return changeObjectives(entry, (roots) => {
    const found = locateObjective(roots, id);
    if (!found) return false;
    found.list.splice(found.index, 1);
    return true;
  });
}

function preCreate(entry) {
  const flag = flagOf(entry);
  if (!game.user.isGM || !flag) return;
  const ownership = questOwnership(flag);
  if (!foundry.utils.equals(entry.ownership, ownership)) entry.updateSource({ ownership: _replace(ownership) });
  const folder = game.users.activeGM?.isSelf && !entry.folder && findFolder(folderName());
  if (folder) entry.updateSource({ folder: folder.id });
}

function flattenObjectives(roots) {
  return questItems(roots).flatMap((root) => [root, ...questItems(root.children)]);
}

function preserveObjectiveState(existing, incoming) {
  const byId = new Map(flattenObjectives(existing).map((objective) => [objective.id, objective]));
  for (const objective of flattenObjectives(incoming)) {
    const previous = byId.get(objective.id);
    if (!objective.id || !previous) continue;
    for (const key of ["done", "hidden"]) {
      if (objective[key] === undefined && previous[key] !== undefined) objective[key] = previous[key];
    }
  }
}

function preUpdate(entry, changes, options) {
  if (!game.user.isGM || entry.inCompendium || !("flags" in changes || "ownership" in changes)) return;
  const objectives = foundry.data.operators.DataFieldOperator.get(changes.flags?.[MODULE_ID]?.quest?.objectives);
  if (Array.isArray(objectives)) preserveObjectiveState(flagOf(entry)?.objectives, objectives);
  const flags = changes.flags
    ? foundry.utils.mergeObject(
        { flags: entry.flags },
        { flags: changes.flags },
        {
          inplace: false,
          recursive: options.recursive !== false,
          applyOperators: true
        }
      ).flags
    : entry.flags;
  const flag = flags?.[MODULE_ID]?.quest;
  if (!foundry.utils.isPlainObject(flag)) return;
  const ownership = questOwnership(flag);
  if (foundry.utils.equals(entry.ownership, ownership)) delete changes.ownership;
  else changes.ownership = _replace(ownership);
}

async function reconcile(entry) {
  if (!game.users.activeGM?.isSelf || !flagOf(entry)) return;
  const folder = !entry.folder && (await ensureQuestFolder());
  const flag = flagOf(entry);
  if (!flag || !game.journal.has(entry.id)) return;
  const update = {};
  if (folder && !entry.folder) update.folder = folder.id;
  const ownership = questOwnership(flag);
  if (!foundry.utils.equals(entry.ownership, ownership)) update.ownership = _replace(ownership);
  if (Object.keys(update).length) await entry.update(update);
}

export function setupQuestData() {
  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "questFolder", {
      name: "MY_MODULES.Quests.Folder.Name",
      hint: "MY_MODULES.Quests.Folder.Hint",
      scope: "world",
      config: true,
      type: String,
      default: "Quests"
    });
  });
  Hooks.on("preCreateJournalEntry", preCreate);
  Hooks.on("preUpdateJournalEntry", preUpdate);
  Hooks.on("createJournalEntry", reconcile);
  Hooks.on("updateJournalEntry", reconcile);
  Hooks.once("ready", async () => {
    if (game.users.activeGM?.isSelf) {
      for (const entry of game.journal) await reconcile(entry);
    }
  });
}
