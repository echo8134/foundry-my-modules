import { MODULE_ID } from "./constants.mjs";
import { questView } from "./quests/data.mjs";

const playback = new WeakMap();

async function restartSound(tile, src) {
  const previous = await playback.get(tile);
  await previous?.stop();
  return foundry.audio.AudioHelper.play({ src }, false);
}

function visibleQuest(uuid) {
  const id = typeof uuid === "string" && uuid.match(/^JournalEntry\.([^.]+)$/)?.[1];
  return id ? questView(game.journal.get(id)) : null;
}

function activateTile(tile) {
  const { clickSound, quest } = tile.document.flags[MODULE_ID];
  if (clickSound) {
    const sound = restartSound(tile, clickSound).catch((error) => console.error(MODULE_ID, error));
    playback.set(tile, sound);
  }
  if (visibleQuest(quest)) game.modules.get(MODULE_ID).api.quests.openQuest(quest);
}

function tileAt(event) {
  if (!canvas.ready || canvas.activeLayer === canvas.tiles || ui.controls.tool?.creation) return null;
  const events = canvas.app.renderer.events;
  const screen = new PIXI.Point();
  events.mapPositionToPoint(screen, event.clientX, event.clientY);
  const point = canvas.stage.worldTransform.applyInverse(screen);
  const objects = canvas.tiles.objects;
  if (objects.sortDirty) objects.sortChildren();
  let hit = null;
  for (const tile of objects.children) {
    const doc = tile.document;
    const flags = doc.flags[MODULE_ID];
    if ((!flags && !hit) || !tile.visible || !doc.shape.testPoint(point)) continue;
    const clickable = flags?.clickSound || visibleQuest(flags?.quest);
    if (doc.alpha === 0) {
      // A switched-off scene variant also has zero opacity.
      if (!clickable || flags.restore) continue;
    } else if (tile.mesh && !tile.mesh.containsCanvasPoint(point, Math.max(1 / 255, doc.texture.alphaThreshold))) {
      continue;
    }
    hit = clickable ? tile : null;
  }
  if (!hit) return null;
  if (
    canvas.scene.tokenVision &&
    !game.user.isGM &&
    !canvas.visibility.testVisibility(point, { tolerance: 0 }) &&
    !canvas.fog.isPointExplored(point)
  ) {
    return null;
  }
  const boundary = events.rootBoundary;
  const target = boundary.hitTest(screen.x, screen.y);
  if (target === canvas.stage) return hit;
  return target && boundary.propagationPath(target).some((item) => item instanceof foundry.canvas.placeables.Tile)
    ? hit
    : null;
}

const flagPath = (key) => `flags.${MODULE_ID}.${key}`;

function prepareFlags({ formData }) {
  const data = formData.object;
  for (const key of ["clickSound", "quest"]) {
    const path = flagPath(key);
    if (typeof data?.[path] === "string") data[path] = data[path].trim() || _del;
  }
}

function addTileFields(app, element, context) {
  const tab = element.querySelector('.tab[data-tab="appearance"]');
  if (!game.user.isGM || !tab || tab.querySelector(".my-tile-actions")) return;
  const section = document.createElement("fieldset");
  section.className = "my-tile-actions";
  const legend = document.createElement("legend");
  legend.textContent = game.i18n.localize("MY_MODULES.Tiles.Section");
  section.append(legend);
  const { BooleanField, FilePathField, StringField } = foundry.data.fields;
  for (const [key, field] of [
    ["clickSound", new FilePathField({ categories: ["AUDIO"] })],
    ["quest", new StringField({ placeholder: "JournalEntry.<id>" })],
    ["calendarSheet", new BooleanField()]
  ]) {
    section.append(
      field.toFormGroup(
        { label: `MY_MODULES.Tiles.${key}`, localize: true, rootId: app.id },
        { name: flagPath(key), value: context.document.getFlag(MODULE_ID, key) ?? field.initial }
      )
    );
  }
  tab.append(section);
  app.form.addEventListener("formdata", prepareFlags);
}

function listenForClicks({ app }) {
  const board = app.view;
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  const threshold = foundry.canvas.interaction.MouseInteractionManager.DEFAULT_DRAG_RESISTANCE_PX;
  let press;
  const moved = (event) => Math.hypot(event.clientX - press.x, event.clientY - press.y) >= threshold;

  function onDown(event) {
    press = null;
    if (event.button !== 0) return;
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    const tile = tileAt(event);
    if (!tile) return;
    press = { tile, id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function onMove(event) {
    if (press && (event.pointerId !== press.id || moved(event))) press = null;
    board.classList.toggle("my-clickable-tile", !event.buttons && Boolean(tileAt(event)));
  }

  function onUp(event) {
    if (press && event.pointerId === press.id && event.button === 0 && !moved(event)) {
      if (tileAt(event) === press.tile) activateTile(press.tile);
    }
    press = null;
  }

  function reset() {
    press = null;
    board.classList.remove("my-clickable-tile");
  }

  board.addEventListener("pointerdown", onDown, options);
  board.addEventListener("pointermove", onMove, options);
  board.addEventListener("pointerup", onUp, options);
  board.addEventListener("pointerleave", reset, options);
  board.addEventListener("pointercancel", reset, options);
  Hooks.once("canvasTearDown", () => {
    reset();
    listeners.abort();
  });
}

export function setupTiles() {
  Hooks.on("renderTileConfig", addTileFields);
  Hooks.on("canvasReady", listenForClicks);
}
