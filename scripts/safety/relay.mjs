import { MODULE_ID } from "../constants.mjs";

const channel = `module.${MODULE_ID}`;
const boundaries = "safetyBoundaries";
export const enabled = (tool) => game.settings.get(MODULE_ID, tool);
const label = (key) => game.i18n.localize(`MY_MODULES.Safety.${key}`);
export const sessionNotes = [];

function showCard(note = "") {
  const previous = document.getElementById("my-safety-overlay");
  const openNotes = previous?.open && previous.querySelector("#my-safety-private-note");
  let paragraph;
  if (note) {
    sessionNotes.unshift(note);
    sessionNotes.splice(10);
    Hooks.callAll(`${MODULE_ID}.safetyNotesChanged`);
    paragraph = document.createElement("p");
    paragraph.textContent = note;
  }
  if (openNotes) {
    if (paragraph) openNotes.append(paragraph);
    return;
  }
  previous?.close();
  previous?.remove();
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
  if (paragraph) {
    const detail = document.createElement("div");
    detail.id = "my-safety-private-note";
    detail.append(paragraph);
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
  if (note) {
    overlay.addEventListener("cancel", (event) => event.preventDefault());
    dismiss.addEventListener("click", () => overlay.close());
  } else {
    const timeout = setTimeout(() => overlay.close(), 6500);
    overlay.addEventListener("close", () => clearTimeout(timeout), { once: true });
    overlay.addEventListener("click", () => overlay.close());
  }
  overlay.addEventListener("close", () => overlay.remove(), { once: true });
}

export function request(data) {
  const gm = game.users.activeGM;
  if (!gm || !game.socket.connected) {
    ui.notifications.warn(label("NeedGM"));
    return false;
  }
  game.socket.emit(channel, { ...data, requestId: foundry.utils.randomID() }, { recipients: [gm.id] });
  return true;
}

async function changeBoundary({ action, requestId, id, kind, text }, senderId) {
  if (!game.users.activeGM?.isSelf || !enabled("linesVeils")) return;
  const entries = game.settings.get(MODULE_ID, boundaries);
  const value = typeof text === "string" && text.trim().slice(0, 200);
  let next;
  if (action === "add" && ["line", "veil"].includes(kind) && value) {
    if (entries.some((entry) => entry.id === requestId)) return;
    next = [...entries, { id: requestId, kind, text: value }];
  } else if (game.users.get(senderId)?.isGM && entries.some((entry) => entry.id === id)) {
    if (action === "edit" && value)
      next = entries.map((entry) => (entry.id === id ? { ...entry, text: value } : entry));
    if (action === "remove") next = entries.filter((entry) => entry.id !== id);
  }
  if (next) await game.settings.set(MODULE_ID, boundaries, next);
}

const pending = new Map();
const coolingDown = new Set();
let pendingWrite = Promise.resolve();

function finishRequest(requestId) {
  const job = pending.get(requestId);
  if (!job) return;
  clearTimeout(job.timeout);
  pending.delete(requestId);
  job.finish();
}

async function relayCard({ requestId, note }) {
  if (!enabled("xCard") || game.messages.has(requestId)) return;
  const message = await ChatMessage.create(
    {
      _id: requestId,
      speaker: { alias: label("Card") },
      content: label("Prompt"),
      flags: { [MODULE_ID]: { xCard: true } }
    },
    { messageMode: "public", keepId: true }
  );
  if (!message) return;
  game.socket.emit(channel, { action: "showCard", requestId });
  showCard(note);
}

async function runClaim({ requestId, tab }) {
  const job = pending.get(requestId);
  if (!job) return;
  if (job.writer && job.writer !== tab) return;
  clearTimeout(job.timeout);
  if (tab !== game.socket.id) {
    // Release the queue if the writing tab disappears. It renews its claim while Foundry is saving.
    job.timeout = setTimeout(() => finishRequest(requestId), 120000);
  }
  if (job.writer) return;
  job.writer = tab;
  if (tab !== game.socket.id) return;
  const renew = setInterval(() => claimRequest(requestId), 10000);
  try {
    if (job.data.action === "xCard") await relayCard(job.data);
    else await changeBoundary(job.data, job.senderId);
  } catch (error) {
    ui.notifications.error(error.message);
  } finally {
    clearInterval(renew);
    game.socket.emit(channel, { action: "finished", requestId }, { recipients: [game.user.id] });
  }
}

// Foundry 14 upserts top-level chat IDs. All GM tabs see the same first claim echoed by the server.
function claimRequest(requestId) {
  game.socket.emit(channel, { action: "claim", requestId, tab: game.socket.id }, { recipients: [game.user.id] });
}

function queueRequest(data, senderId) {
  const { requestId } = data;
  if (pending.has(requestId)) return;
  if (data.action === "xCard") {
    if (!enabled("xCard") || typeof data.note !== "string" || game.messages.has(requestId)) return;
    if (coolingDown.has(senderId)) return;
    coolingDown.add(senderId);
    setTimeout(() => coolingDown.delete(senderId), 3000);
    data = { ...data, note: data.note.trim().slice(0, 200) };
  } else if (!["add", "edit", "remove"].includes(data.action)) return;

  const { promise, resolve } = Promise.withResolvers();
  const job = { data, senderId, finish: resolve };
  pending.set(requestId, job);
  const claim = () => {
    if (pending.get(requestId) === job && !job.writer) {
      job.timeout = setTimeout(() => finishRequest(requestId), 120000);
      claimRequest(requestId);
    }
    return promise;
  };
  if (data.action === "xCard") claim();
  // Wait for the previous writer on whichever GM tab won before reading the shared setting.
  else pendingWrite = pendingWrite.then(claim);
}

function receive(data, senderId) {
  if (!data || typeof data !== "object") return;
  const { action, requestId } = data;
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9]{16}$/.test(requestId)) return;
  const gm = game.users.activeGM;
  if (action === "showCard") {
    if (enabled("xCard") && senderId === gm?.id) showCard(pending.get(requestId)?.data.note);
    return;
  }
  if (!gm?.isSelf) return;
  if (action === "claim" || action === "finished") {
    if (senderId !== gm.id) return;
    if (action === "claim") return runClaim(data);
    return finishRequest(requestId);
  }
  queueRequest(data, senderId);
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
