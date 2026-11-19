import { MODULE_ID } from "../constants.mjs";

const channel = `module.${MODULE_ID}`;
const boundaries = "safetyBoundaries";
export const enabled = (tool) => game.settings.get(MODULE_ID, tool);
const label = (key) => game.i18n.localize(`MY_MODULES.Safety.${key}`);

function showCard(note = "") {
  document.getElementById("my-safety-overlay")?.close();
  const overlay = document.createElement("dialog");
  overlay.id = "my-safety-overlay";
  overlay.setAttribute("aria-labelledby", "my-safety-prompt");
  const card = document.createElement("div");
  card.className = "safety-signal";
  const symbol = document.createElement("b");
  symbol.className = "safety-symbol";
  symbol.textContent = "X";
  symbol.setAttribute("aria-hidden", "true");
  const message = document.createElement("strong");
  message.id = "my-safety-prompt";
  message.textContent = label("Prompt");
  card.append(symbol, message);
  if (note) {
    const detail = document.createElement("span");
    detail.id = "my-safety-private-note";
    detail.textContent = note;
    overlay.setAttribute("aria-describedby", detail.id);
    card.append(detail);
  }
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = label("Dismiss");
  card.append(dismiss);
  overlay.append(card);
  document.body.append(overlay);
  overlay.showModal();
  const timeout = setTimeout(() => overlay.close(), 6500);
  overlay.addEventListener("click", () => overlay.close());
  overlay.addEventListener(
    "close",
    () => {
      clearTimeout(timeout);
      overlay.remove();
    },
    { once: true }
  );
}

export function request(data) {
  const gm = game.users.activeGM;
  if (!gm || !game.socket.connected) {
    ui.notifications.warn(label("NeedGM"));
    return false;
  }
  game.socket.emit(channel, data, { recipients: [gm.id] });
  return true;
}

async function changeBoundary({ action, id, kind, text }, canManage) {
  if (!game.users.activeGM?.isSelf || !enabled("linesVeils")) return;
  const entries = game.settings.get(MODULE_ID, boundaries);
  const value = typeof text === "string" && text.trim();
  let next;
  if (action === "add" && ["line", "veil"].includes(kind) && value) {
    next = [...entries, { id: foundry.utils.randomID(), kind, text: value }];
  } else if (canManage && entries.some((entry) => entry.id === id)) {
    if (action === "edit" && value)
      next = entries.map((entry) => (entry.id === id ? { ...entry, text: value } : entry));
    if (action === "remove") next = entries.filter((entry) => entry.id !== id);
  }
  if (next) await game.settings.set(MODULE_ID, boundaries, next);
}

let pendingWrite = Promise.resolve();

function receive(data, senderId) {
  if (!data || typeof data !== "object") return;
  if (data.action === "showCard") {
    if (enabled("xCard") && senderId === game.users.activeGM?.id) showCard();
    return;
  }
  if (!game.users.activeGM?.isSelf) return;
  if (data.action === "xCard") {
    if (!enabled("xCard") || typeof data.note !== "string") return;
    game.socket.emit(channel, { action: "showCard" });
    showCard(data.note);
    return ChatMessage.create(
      {
        speaker: { alias: label("Card") },
        content: label("Prompt"),
        flags: { [MODULE_ID]: { xCard: true } }
      },
      { messageMode: "public" }
    );
  }
  if (!["add", "edit", "remove"].includes(data.action)) return;
  const canManage = data.action !== "add" && game.users.get(senderId)?.isGM;
  // Each request must read the setting after the previous write has finished.
  pendingWrite = pendingWrite
    .then(() => changeBoundary(data, canManage))
    .catch((error) => ui.notifications.error(error.message));
}

export function setupRelay(onToolsChanged, onBoundariesChanged) {
  Hooks.once("init", () => {
    for (const tool of ["xCard", "linesVeils", "openDoor"]) {
      game.settings.register(MODULE_ID, tool, {
        name: `MY_MODULES.Safety.${tool}.Setting`,
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
        onChange: onToolsChanged
      });
    }
    game.settings.register(MODULE_ID, boundaries, {
      scope: "world",
      config: false,
      type: Array,
      default: [],
      onChange: onBoundariesChanged
    });
  });
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (message.author?.isGM && message.getFlag(MODULE_ID, "xCard")) html.classList.add("my-safety-chat");
  });
  Hooks.once("ready", () => game.socket.on(channel, receive));
}
