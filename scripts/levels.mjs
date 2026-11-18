import { MODULE_ID } from "./constants.mjs";
import { getVariants, setupVariants, setVariant } from "./variants.mjs";

const FULL_LIST = "fullLevelList";
const VARIANT_STYLE = "variantStyle";

const rerender = foundry.utils.debounce(() => ui.nav?.render(), 50);

function choose(scene, levelId, name, event) {
  event.preventDefault();
  event.stopPropagation();
  setVariant(scene, levelId, name, { linked: !event.shiftKey }).catch((error) => ui.notifications.error(error.message));
}

function button(label, onClick, className) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = label;
  el.addEventListener("click", onClick);
  return el;
}

function arrowsControl(scene, level) {
  const row = document.createElement("div");
  row.className = "my-variant my-variant-arrows";
  const index = level.variants.indexOf(level.active);
  const step = (delta) => level.variants[(index + delta + level.variants.length) % level.variants.length];
  row.append(
    button("◀", (e) => choose(scene, level.levelId, step(-1), e), "my-variant-step"),
    Object.assign(document.createElement("span"), { className: "my-variant-name", textContent: level.active }),
    button("▶", (e) => choose(scene, level.levelId, step(1), e), "my-variant-step")
  );
  return row;
}

function treeControl(scene, level) {
  const list = document.createElement("ul");
  list.className = "my-variant my-variant-tree";
  for (const name of level.variants) {
    const item = document.createElement("li");
    const pick = button(name, (e) => choose(scene, level.levelId, name, e), "my-variant-option");
    pick.dataset.variant = name;
    pick.classList.toggle("active", name === level.active);
    item.append(pick);
    list.append(item);
  }
  return list;
}

function decorate(_app, element) {
  const menu = element.querySelector("#scene-navigation-levels");
  if (!menu) return;
  menu.classList.toggle("my-full-level-list", game.settings.get(MODULE_ID, FULL_LIST));
  if (!game.user.isGM) return;
  const sceneId = menu.querySelector("[data-scene-id]")?.dataset.sceneId;
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  const control = game.settings.get(MODULE_ID, VARIANT_STYLE) === "tree" ? treeControl : arrowsControl;
  menu.dataset.tooltipText = game.i18n.localize("MY_MODULES.Variants.Hint");
  for (const level of getVariants(scene)) {
    const row = menu.querySelector(`.scene-level[data-level-id="${level.levelId}"]`)?.closest(".level-row");
    row?.append(control(scene, level));
  }
}

export function setupLevels() {
  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, FULL_LIST, {
      name: "MY_MODULES.Levels.FullList.Name",
      hint: "MY_MODULES.Levels.FullList.Hint",
      scope: "client",
      config: true,
      type: Boolean,
      default: false,
      onChange: rerender
    });
    game.settings.register(MODULE_ID, VARIANT_STYLE, {
      name: "MY_MODULES.Variants.Style.Name",
      hint: "MY_MODULES.Variants.Style.Hint",
      scope: "client",
      config: true,
      type: String,
      choices: { arrows: "MY_MODULES.Variants.Style.Arrows", tree: "MY_MODULES.Variants.Style.Tree" },
      default: "arrows",
      onChange: rerender
    });
    game.modules.get(MODULE_ID).api = { getVariants, setVariant };
  });

  Hooks.on("renderSceneNavigation", decorate);
  setupVariants(rerender);
}
