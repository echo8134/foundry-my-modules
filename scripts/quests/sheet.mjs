import { MODULE_ID } from "../constants.mjs";
import {
  addObjective,
  addReward,
  canViewQuest,
  createQuestPage,
  deleteObjective,
  deleteReward,
  editObjective,
  editReward,
  eligibleParents,
  listQuests,
  moveObjective,
  QUEST_STATUSES,
  questView,
  statusLabel,
  updateQuest
} from "./data.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { TextEditor } = foundry.applications.ux;
const rowSelector = "[data-objective-id]";
const reportError = (error) => ui.notifications.error(error.message);

function objectiveRows(roots) {
  return roots.flatMap((root, index) => [
    {
      ...root,
      nextId: roots[index + 1]?.id,
      indentUnder: !root.children?.length && roots[index - 1]?.id
    },
    ...(root.children ?? []).map((child, i) => ({
      ...child,
      parentId: root.id,
      nextId: root.children[i + 1]?.id,
      outdentBefore: roots[index + 1]?.id
    }))
  ]);
}

async function rewardView(reward) {
  const item = reward.uuid && (await foundry.utils.fromUuid(reward.uuid).catch(() => null));
  const visibleItem = item?.documentName === "Item" && item.testUserPermission(game.user, "LIMITED");
  const locked = reward.locked !== false;
  return {
    ...reward,
    text: reward.text || (visibleItem ? item.name : ""),
    img: visibleItem ? item.img : null,
    locked,
    draggable: item?.documentName === "Item" && !locked && !reward.hidden
  };
}

async function pageView(page) {
  let html;
  if (page.type === "text") {
    html = await TextEditor.implementation.enrichHTML(page.text.content ?? "", {
      relativeTo: page,
      secrets: page.isOwner
    });
  } else {
    const embed = await page.toEmbed({ inline: true });
    html = (embed ?? page.toAnchor()).outerHTML;
  }
  return {
    id: page.id,
    name: page.name,
    restricted: page.ownership.default === CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE,
    html
  };
}

export class QuestSheet extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["my-quest-sheet"],
    window: { icon: "fa-solid fa-scroll", resizable: true },
    position: { width: 600, height: 640 }
  };

  static PARTS = {
    sheet: { template: `modules/${MODULE_ID}/scripts/quests/sheet.hbs`, scrollable: [""] }
  };

  constructor(entry, showSheet) {
    super({ id: `my-quest-sheet-${entry.id}` });
    this.entry = entry;
    this.showSheet = showSheet;
  }

  _configureRenderOptions(options) {
    super._configureRenderOptions(options);
    options.window ??= {};
    options.window.title = this.entry.name;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const quest = questView(this.entry);
    if (!quest) return context;
    const quests = listQuests();
    const gm = game.user.isGM;
    const pages = this.entry.pages
      .filter((page) => page.testUserPermission(game.user, "OBSERVER"))
      .sort((a, b) => a.sort - b.sort);
    const description =
      pages.find((page) => page.getFlag(MODULE_ID, "questPage") === "description") ??
      pages.find(
        (page) =>
          page.type === "text" &&
          !page.getFlag(MODULE_ID, "questPage") &&
          ["Beschreibung", "Description"].includes(page.name)
      );
    return {
      ...context,
      quest,
      gm,
      players: gm
        ? game.users
            .filter((user) => !user.isGM)
            .map((user) => ({
              id: user.id,
              name: user.name,
              selected: quest.personal.includes(user.id)
            }))
        : [],
      parents: gm
        ? eligibleParents(this.entry, quests).map((parent) => ({
            uuid: parent.uuid,
            name: parent.name,
            selected: parent.uuid === quest.parent
          }))
        : [],
      subquests: quests
        .filter((child) => child.parent === quest.uuid)
        .map((child) => ({
          id: child.id,
          name: child.name,
          statusLabel: statusLabel(child.status)
        })),
      statuses: QUEST_STATUSES.map((value) => ({
        value,
        label: statusLabel(value),
        selected: quest.status === value
      })),
      statusLabel: statusLabel(quest.status),
      objectives: objectiveRows(quest.objectives),
      rewards: await Promise.all(quest.rewards.map(rewardView)),
      description: description && (await pageView(description)),
      pages: await Promise.all(pages.filter((page) => page !== description).map(pageView))
    };
  }

  #saveText = ({ target }) => {
    if (target.value !== target.defaultValue) this.#changeField(target).catch(reportError);
  };

  _preSyncPartState(partId, element, prior, state) {
    super._preSyncPartState(partId, element, prior, state);
    const input = prior.querySelector("input[type=text][name]:focus");
    if (!input || input.value === input.defaultValue || !state.focus) return;
    input.removeEventListener("blur", this.#saveText);
    const next = element.querySelector(state.focus);
    if (next?.defaultValue !== input.defaultValue) return;
    next.value = input.value;
    next.setSelectionRange(input.selectionStart, input.selectionEnd, input.selectionDirection);
  }

  _attachPartListeners(partId, element, options) {
    super._attachPartListeners(partId, element, options);
    element.addEventListener("dragstart", (event) => {
      const row = event.target.closest("[data-reward-id]");
      if (!row || row.closest(".quest-page-content")) return;
      const reward = questView(this.entry)?.rewards.find((r) => r.id === row.dataset.rewardId);
      if (!row.draggable || !reward?.uuid || reward.locked !== false || reward.hidden) return event.preventDefault();
      event.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid: reward.uuid }));
      event.dataTransfer.effectAllowed = "copy";
    });
    if (!game.user.isGM) return;
    for (const input of element.querySelectorAll("input[type=text][name]")) {
      input.addEventListener("blur", this.#saveText);
    }
    element.addEventListener("change", ({ target }) => {
      if (target.matches("select, file-picker, input[type=checkbox]")) this.#changeField(target).catch(reportError);
    });
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target.matches("input[type=text]")) event.target.blur();
    });
    element.addEventListener("dragstart", (event) => {
      const handle = event.target.closest(".objective-grip");
      if (!handle) return;
      const id = handle.closest(rowSelector).dataset.objectiveId;
      event.dataTransfer.setData("text/plain", JSON.stringify({ type: "QuestObjective", uuid: this.entry.uuid, id }));
      event.dataTransfer.effectAllowed = "move";
    });
    element.addEventListener("dragover", (event) => {
      if (event.dataTransfer.types.includes("text/plain")) event.preventDefault();
    });
    element.addEventListener("drop", (event) => this.#drop(event).catch(reportError));
  }

  async #changeField(input) {
    if (input.closest(".quest-page-content")) return;
    const { name, value } = input;
    switch (name) {
      case "name":
        if (!value.trim()) return this.render();
        return updateQuest(this.entry, { name: value.trim() });
      case "status":
        return updateQuest(this.entry, { status: value });
      case "primary":
        return updateQuest(this.entry, { primary: input.checked });
      case "personal": {
        const selected = input.closest("fieldset").querySelectorAll("input:checked");
        return updateQuest(this.entry, { personal: Array.from(selected, (option) => option.value) });
      }
      case "parent":
        return updateQuest(this.entry, { parent: value || null });
      case "giver":
        return updateQuest(this.entry, { giver: { name: value, uuid: null } });
      case "giverImage":
        return updateQuest(this.entry, { giver: { img: value } });
      case "objectiveText":
        return editObjective(this.entry, input.closest(rowSelector).dataset.objectiveId, { text: value });
      case "rewardText":
        return editReward(this.entry, input.closest("[data-reward-id]").dataset.rewardId, { text: value });
    }
  }

  _onClickAction(event, button) {
    if (event.button !== 0 || button.closest(".quest-page-content")) return;
    if (button.dataset.action === "openSubquest") return this.showSheet(game.journal.get(button.dataset.questId));
    if (game.user.isGM) this.#edit(button).catch(reportError);
  }

  async #edit(button) {
    const row = button.closest(rowSelector)?.dataset;
    const id = row?.objectiveId;
    const rewardId = button.closest("[data-reward-id]")?.dataset.rewardId;
    switch (button.dataset.action) {
      case "showToPlayers": {
        const recipients = game.users.filter((user) => user.active && !user.isGM && canViewQuest(this.entry, user));
        if (recipients.length) {
          game.socket.emit(
            `module.${MODULE_ID}`,
            { action: "showQuest", questId: this.entry.id },
            { recipients: recipients.map((user) => user.id) }
          );
        }
        return;
      }
      case "addObjective":
        return addObjective(this.entry, game.i18n.localize("MY_MODULES.Quests.NewObjective"));
      case "deleteObjective":
        return deleteObjective(this.entry, id);
      case "toggleDone":
        return editObjective(this.entry, id, { done: button.getAttribute("aria-pressed") !== "true" });
      case "toggleHidden":
        return editObjective(this.entry, id, { hidden: button.getAttribute("aria-pressed") !== "true" });
      case "indent":
        return moveObjective(this.entry, id, button.dataset.under);
      case "outdent":
        return moveObjective(this.entry, id, null, button.dataset.before || null);
      case "addReward":
        return addReward(this.entry, game.i18n.localize("MY_MODULES.Quests.NewReward"));
      case "deleteReward":
        return deleteReward(this.entry, rewardId);
      case "toggleRewardHidden":
        return editReward(this.entry, rewardId, { hidden: button.getAttribute("aria-pressed") !== "true" });
      case "toggleRewardLock":
        return editReward(this.entry, rewardId, { locked: button.getAttribute("aria-pressed") !== "true" });
      case "addPage":
        return createQuestPage(this.entry);
      case "editPage":
        return this.renderChild(this.entry.pages.get(button.closest("[data-page-id]").dataset.pageId).sheet);
    }
  }

  async #drop(event) {
    const giver = event.target.closest(".quest-giver");
    const row = event.target.closest(rowSelector);
    const data = TextEditor.implementation.getDragEventData(event);
    if (data.type === "Item" && data.uuid) {
      event.preventDefault();
      const item = await CONFIG.Item.documentClass.fromDropData(data);
      return addReward(this.entry, item.name, item.uuid);
    }
    if (!giver && !row) return;
    event.preventDefault();
    if (giver && data.type === "Actor") {
      const actor = await CONFIG.Actor.documentClass.fromDropData(data);
      if (actor) return updateQuest(this.entry, { giver: { name: actor.name, img: actor.img, uuid: actor.uuid } });
    }
    if (!row || data.type !== "QuestObjective" || data.uuid !== this.entry.uuid) return;
    const { top, height } = row.getBoundingClientRect();
    const before = event.clientY < top + height / 2 ? row.dataset.objectiveId : row.dataset.nextId;
    return moveObjective(this.entry, data.id, row.dataset.parentId || null, before || null);
  }
}
