import { MODULE_ID } from "./constants.mjs";

const channel = `module.${MODULE_ID}`;
const active = new Map();

function updateButtons(uuid) {
  if (!game.user.isGM) return;
  for (const app of [ui.playlists, ui.playlists?.popout]) {
    const button = app?.element?.querySelector(`.my-soundboard [data-uuid="${CSS.escape(uuid)}"]`);
    if (button) button.ariaPressed = String(active.has(uuid));
  }
}

function stop(uuid) {
  const playback = active.get(uuid);
  if (!playback) return;
  active.delete(uuid);
  updateButtons(uuid);
  return playback.sound?.stop();
}

async function play({ uuid, src, volume }) {
  stop(uuid);
  const playback = { sound: null };
  active.set(uuid, playback);
  updateButtons(uuid);
  const finish = () => {
    if (active.get(uuid) !== playback) return;
    active.delete(uuid);
    updateButtons(uuid);
  };
  try {
    await game.audio.unlock;
    if (active.get(uuid) !== playback) return;
    const sound = game.audio.create({ src, context: game.audio.interface, singleton: false });
    playback.sound = sound;
    await sound.load();
    if (sound.failed) return finish();
    if (active.get(uuid) !== playback) return;
    sound.addEventListener("end", finish, { once: true });
    await sound.play({ volume, loop: false });
  } catch (error) {
    finish();
    console.error(MODULE_ID, error);
  }
}

function receive(data, senderId) {
  if (!game.users.get(senderId)?.isGM || typeof data?.uuid !== "string") return;
  if (data.action === "soundboardStop") return stop(data.uuid);
  if (data.action === "soundboardPlay" && game.settings.get(MODULE_ID, "soundboardEnabled")) return play(data);
}

function toggle(track) {
  const data = active.has(track.uuid)
    ? { action: "soundboardStop", uuid: track.uuid }
    : { action: "soundboardPlay", uuid: track.uuid, src: track.path, volume: track.volume };
  game.socket.emit(channel, data);
  receive(data, game.user.id);
}

function renderBoard(_app, element) {
  const previous = element.querySelector(".my-soundboard");
  const scrollTop = previous?.scrollTop ?? 0;
  const focusedUuid = previous?.querySelector("button:focus")?.dataset.uuid;
  previous?.remove();
  if (!game.user.isGM || !game.settings.get(MODULE_ID, "soundboardEnabled")) return;
  const footer = element.querySelector(".directory-footer");
  if (!footer) return;
  const name = game.settings.get(MODULE_ID, "soundboardPlaylist");
  const playlist = game.playlists.getName(name);
  const panel = document.createElement("section");
  panel.className = "my-soundboard";
  const heading = document.createElement("h3");
  heading.textContent = game.i18n.localize("MY_MODULES.Soundboard.Title");
  panel.append(heading);
  if (playlist?.sounds.size) {
    const grid = document.createElement("div");
    grid.className = "my-soundboard-grid";
    for (const id of playlist.playbackOrder) {
      const track = playlist.sounds.get(id);
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.soundId = id;
      button.dataset.uuid = track.uuid;
      button.ariaPressed = String(active.has(track.uuid));
      button.disabled = !track.path;
      button.textContent = track.name;
      button.addEventListener("click", () => toggle(track));
      grid.append(button);
    }
    panel.append(grid);
  } else {
    const hint = document.createElement("p");
    hint.textContent = game.i18n.format("MY_MODULES.Soundboard.Empty", { playlist: name });
    panel.append(hint);
  }
  footer.before(panel);
  panel.scrollTop = scrollTop;
  if (focusedUuid) panel.querySelector(`[data-uuid="${CSS.escape(focusedUuid)}"]`)?.focus({ preventScroll: true });
}

function refreshBoard() {
  for (const uuid of active.keys()) stop(uuid);
  ui.playlists?.render();
}

export function setupSoundboard() {
  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "soundboardEnabled", {
      name: "MY_MODULES.Soundboard.Enabled",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      onChange: refreshBoard
    });
    game.settings.register(MODULE_ID, "soundboardPlaylist", {
      name: "MY_MODULES.Soundboard.Playlist",
      scope: "world",
      config: true,
      type: String,
      default: "Soundboard",
      onChange: refreshBoard
    });
  });
  Hooks.once("ready", () => game.socket.on(channel, receive));
  Hooks.on("renderPlaylistDirectory", renderBoard);
}
