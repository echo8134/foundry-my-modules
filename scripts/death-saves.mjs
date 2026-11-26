import german from "../lang/de.json" with { type: "json" };
import english from "../lang/en.json" with { type: "json" };
import { MODULE_ID } from "./constants.mjs";

const SETTING = "privateDeathSaves";
const OFF = "off";
const JOURNAL_ID = "MyDeathSaveRules";
const PAGE_ID = "MyDeathSavePage1";
const FLAG = `flags.${MODULE_ID}.${SETTING}`;
const STRINGS = "MY_MODULES.DeathSaves";
let creatingJournal = false;

const selectedRecipientId = () => game.settings.get(MODULE_ID, SETTING);

function isFullGM(user) {
  return user?.role === CONST.USER_ROLES.GAMEMASTER;
}

export function canViewDeathTray(actor) {
  const recipient = selectedRecipientId();
  if (recipient === OFF || (isFullGM(game.user) && game.user.id === recipient)) return true;

  const character = actor.token?.baseActor ?? actor;
  const assigned = game.users.filter((user) => !user.isGM && user.character === character);
  if (assigned.length) return assigned.some((user) => user.isSelf);
  return !actor.hasPlayerOwner || (!game.user.isGM && actor.isOwner);
}

function updateDeathTray(sheet) {
  sheet.element.classList.toggle("my-private-death-tray", !canViewDeathTray(sheet.actor));
}

function refreshDeathTrays() {
  for (const sheet of foundry.applications.instances.values()) {
    if (sheet instanceof game.dnd5e.applications.actor.CharacterActorSheet) updateDeathTray(sheet);
  }
}

function recipientChoices() {
  const choices = { [OFF]: `${STRINGS}.Off` };
  for (const user of game.users.filter(isFullGM)) choices[user.id] = user.name;

  const selected = selectedRecipientId();
  if (selected !== OFF && !Object.hasOwn(choices, selected)) {
    // Keep a stale selection from silently turning into Off when the settings form is saved.
    choices[selected] = { label: `${STRINGS}.UnavailableGM`, disabled: true };
  }
  return choices;
}

function canCreateJournal() {
  return game.user.isActiveGM && isFullGM(game.users.get(selectedRecipientId()));
}

function isRulesJournal(entry) {
  return entry?.id === JOURNAL_ID && entry.getFlag(MODULE_ID, SETTING);
}

function ruleText(source, ...keys) {
  for (const suffix of keys) {
    const key = `${STRINGS}.${suffix}`;
    if (source === english[key] || source === german[key]) return game.i18n.localize(key);
  }
  return source;
}

export function localizeRulesJournal(entry) {
  if (!isRulesJournal(entry)) return;
  if (!entry.getFlag(MODULE_ID, "customRuleName")) entry.name = ruleText(entry._source.name, "JournalName");
  const page = entry.pages.get(PAGE_ID);
  if (!page) return;
  if (!page.getFlag(MODULE_ID, "customRuleName")) page.name = ruleText(page._source.name, "PageName");
  if (page.type === "text" && !page.getFlag(MODULE_ID, "customRuleContent")) {
    page.text.content = ruleText(page._source.text.content, "Journal", "JournalOriginal");
  }
}

// Native sheet forms also submit untouched, client-localized fields. Keep their stored values
// and mark explicit edits so a GM can even choose wording that matches a shipped translation.
function preserveRuleEdits(doc, changes) {
  if ("name" in changes) {
    if (changes.name === doc.name) changes.name = doc._source.name;
    else foundry.utils.setProperty(changes, `flags.${MODULE_ID}.customRuleName`, true);
  }
  if (changes.text && "content" in changes.text) {
    if (changes.text.content === doc.text.content) changes.text.content = doc._source.text.content;
    else foundry.utils.setProperty(changes, `flags.${MODULE_ID}.customRuleContent`, true);
  }
}

async function createJournal() {
  if (!canCreateJournal() || game.journal.some((entry) => entry.getFlag(MODULE_ID, SETTING))) return;

  // Foundry can overwrite a world document when creating with keepId, even if this tab has a stale collection.
  const [existing] = await JournalEntry.database.get(JournalEntry, { query: { _id: JOURNAL_ID } });
  if (existing) {
    if (!existing.getFlag(MODULE_ID, SETTING))
      console.warn(`${MODULE_ID} | JournalEntry.${JOURNAL_ID} is already in use`);
    return;
  }
  if (!canCreateJournal()) return;

  await JournalEntry.create(
    {
      _id: JOURNAL_ID,
      name: english[`${STRINGS}.JournalName`],
      flags: { [MODULE_ID]: { [SETTING]: true } },
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      pages: [
        {
          _id: PAGE_ID,
          name: english[`${STRINGS}.PageName`],
          type: "text",
          text: { content: english[`${STRINGS}.Journal`] }
        }
      ]
    },
    { keepId: true }
  );
}

async function ensureJournal() {
  if (creatingJournal || !game.ready || !canCreateJournal()) return;
  creatingJournal = true;
  try {
    if (navigator.locks) await navigator.locks.request(`${MODULE_ID}.${game.world.id}.${SETTING}`, createJournal);
    else await createJournal();
  } catch (error) {
    console.error(`${MODULE_ID} | Could not create the death saves journal`, error);
  } finally {
    creatingJournal = false;
  }
}

function configureDeathSave(_config, _dialog, message) {
  if (game.user.isGM) return;

  const selected = selectedRecipientId();
  const recipient = selected === OFF ? foundry.utils.getProperty(message.data, FLAG) : selected;
  if (selected === OFF && typeof recipient !== "string") return;
  if (!isFullGM(game.users.get(recipient))) {
    ui.notifications.warn(`${STRINGS}.SelectGM`, { localize: true });
    return false;
  }

  message.rollMode = "gm";
  message.data = foundry.utils.expandObject(message.data ?? {});
  Object.assign(message.data, { whisper: [recipient], blind: false });
  foundry.utils.setProperty(message.data, FLAG, recipient);
}

function lockRollMode(app, html) {
  if (typeof foundry.utils.getProperty(app.message.data, FLAG) !== "string") return;
  const select = html.querySelector('select[name="rollMode"]');
  if (!select) return;
  select.value = "gm";
  select.disabled = true;
}

function hideRevealOption(_app, options) {
  const reveal = options.find((option) => option.label === "CHAT.RevealMessage");
  if (!reveal) return;
  const visible = reveal.visible;
  reveal.visible = (html) => !game.messages.get(html.dataset.messageId)?.getFlag(MODULE_ID, SETTING) && visible(html);
}

function privateRollNotice(message) {
  if (!message.getFlag(MODULE_ID, SETTING) || message.isContentVisible) return null;
  return game.i18n.format(`${STRINGS}.PrivateRoll`, {
    user: message.author?.name ?? game.i18n.localize(`${STRINGS}.UnknownUser`)
  });
}

export function setupDeathSaves() {
  Hooks.once("init", () => {
    if (game.system.id !== "dnd5e") return;
    Hooks.on("preUpdateJournalEntry", (entry, changes) => {
      if (isRulesJournal(entry)) preserveRuleEdits(entry, changes);
    });
    Hooks.on("preUpdateJournalEntryPage", (page, changes) => {
      if (page.id === PAGE_ID && isRulesJournal(page.parent)) preserveRuleEdits(page, changes);
    });
    game.settings.register(MODULE_ID, SETTING, {
      name: `${STRINGS}.Name`,
      hint: `${STRINGS}.Hint`,
      scope: "world",
      config: true,
      type: String,
      default: OFF,
      choices: recipientChoices,
      onChange: () => {
        refreshDeathTrays();
        return ensureJournal();
      }
    });
    Hooks.on("renderCharacterActorSheet", updateDeathTray);
    Hooks.on("updateUser", (_user, changes) => {
      if ("character" in changes || "role" in changes) refreshDeathTrays();
    });
    Hooks.on("createUser", refreshDeathTrays);
    Hooks.on("deleteUser", refreshDeathTrays);
    Hooks.on("dnd5e.preRollDeathSave", configureDeathSave);
    Hooks.on("dnd5e.postDeathSaveRollConfiguration", (rolls, ...args) => {
      if (rolls.length) return configureDeathSave(...args);
    });
    Hooks.on("renderRollConfigurationDialog", lockRollMode);
    Hooks.on("getChatMessageContextOptions", hideRevealOption);
    Hooks.on("preUpdateChatMessage", (message, changes) => {
      if (!("whisper" in changes || "blind" in changes)) return;
      const recipient = message.getFlag(MODULE_ID, SETTING);
      if (recipient) Object.assign(changes, { whisper: [recipient], blind: false });
    });
    Hooks.on("dnd5e.renderChatMessage", (message, html) => {
      const notice = privateRollNotice(message);
      if (!notice) return;
      // dnd5e adds the terminal outcome to the card even when the dice are private.
      html.querySelector(".flavor-text")?.remove();
      html.querySelector(".message-content").textContent = notice;
    });
    Hooks.once("setup", () => {
      const prototype = getDocumentClass("ChatMessage").prototype;
      const exportMessage = prototype.export;
      prototype.export = function (...args) {
        return privateRollNotice(this) ?? exportMessage.apply(this, args);
      };
    });
    Hooks.once("ready", ensureJournal);
  });
}
