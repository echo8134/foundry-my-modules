import { MODULE_ID } from "./constants.mjs";

// The users whose cursor this user does not want to see. Stored per user, so it follows them to every device.
const HIDDEN_SETTING = "hiddenCursors";
// Set on a user who hides their own cursor from everyone. A flag, because every client must read it.
const OWN_FLAG = "hideOwnCursor";

const hidesOwnCursor = (user) => user.getFlag(MODULE_ID, OWN_FLAG) === true;
const hiddenByMe = () => new Set(game.settings.get(MODULE_ID, HIDDEN_SETTING));
const canToggleCursor = (user) => game.user.isGM || !user.isGM;
const cursorShown = (user) => !hidesOwnCursor(user) && (!canToggleCursor(user) || !hiddenByMe().has(user.id));

function refreshCursors() {
  for (const user of game.users) canvas.controls?.getCursorForUser(user.id)?.refreshVisibility(user);
  ui.players?.render();
}

async function toggleOwn() {
  await game.user.setFlag(MODULE_ID, OWN_FLAG, !hidesOwnCursor(game.user));
}

async function toggleOther(userId, everyone) {
  const hidden = hiddenByMe();
  const show = hidden.has(userId);
  const targets = everyone ? game.users.filter((u) => !u.isSelf && canToggleCursor(u)).map((u) => u.id) : [userId];
  for (const id of targets) show ? hidden.delete(id) : hidden.add(id);
  await game.settings.set(MODULE_ID, HIDDEN_SETTING, [...hidden]);
}

function addToggles(_app, element) {
  for (const row of element.querySelectorAll("li.player[data-user-id]")) {
    const user = game.users.get(row.dataset.userId);
    if (!user || !canToggleCursor(user)) continue;
    const shown = user.isSelf ? !hidesOwnCursor(user) : cursorShown(user);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `my-cursor-toggle icon fa-regular ${shown ? "fa-square-check" : "fa-square"}`;
    button.classList.toggle("off", !shown);
    button.dataset.tooltipText = game.i18n.localize(
      user.isSelf ? "MY_MODULES.Cursors.Own" : "MY_MODULES.Cursors.Other"
    );
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (user.isSelf) toggleOwn();
      else toggleOther(user.id, event.shiftKey);
    });
    row.append(button);
  }
}

export function setupCursors() {
  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, HIDDEN_SETTING, {
      scope: "user",
      config: false,
      type: Array,
      default: [],
      onChange: refreshCursors
    });

    const { Cursor } = foundry.canvas.containers;
    const refreshVisibility = Cursor.prototype.refreshVisibility;
    Cursor.prototype.refreshVisibility = function (user) {
      refreshVisibility.call(this, user);
      if (this.visible && !cursorShown(user)) this.visible = false;
    };
  });

  Hooks.on("renderPlayers", addToggles);
  Hooks.on("updateUser", (_user, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) refreshCursors();
  });
}
