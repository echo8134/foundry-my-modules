import { MODULE_ID } from "./constants.mjs";

const SETTING = "privateDeathSaves";
const OFF = "off";
const JOURNAL_ID = "MyDeathSaveRules";
const FLAG = `flags.${MODULE_ID}.${SETTING}`;
const STRINGS = "MY_MODULES.DeathSaves";
let creatingJournal = false;

const selectedRecipientId = () => game.settings.get(MODULE_ID, SETTING);

function isFullGM(user) {
  return user?.role === CONST.USER_ROLES.GAMEMASTER;
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
      name: game.i18n.localize(`${STRINGS}.JournalName`),
      flags: { [MODULE_ID]: { [SETTING]: true } },
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      pages: [
        {
          _id: "MyDeathSavePage1",
          name: game.i18n.localize(`${STRINGS}.PageName`),
          type: "text",
          text: { content: game.i18n.localize(`${STRINGS}.Journal`) }
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
  return game.i18n.format("CHAT.PrivateRollContent", {
    user: message.author?.name ?? game.i18n.localize("CHAT.UnknownUser")
  });
}

export function setupDeathSaves() {
  Hooks.once("init", () => {
    if (game.system.id !== "dnd5e") return;
    game.settings.register(MODULE_ID, SETTING, {
      name: `${STRINGS}.Name`,
      hint: `${STRINGS}.Hint`,
      scope: "world",
      config: true,
      type: String,
      default: OFF,
      choices: recipientChoices,
      onChange: ensureJournal
    });
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
