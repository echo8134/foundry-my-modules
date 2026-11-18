// Builds a scene shaped like the Rybalka cathedral (nine levels, variants on the ground floor and the tower) and
// checks the full level list, the variant controls and the variant switching from a Gamemaster and a player client.
import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const SCENE = "My Modules Levels Test";
const LEVELS = [
  "Krypta",
  "Keller",
  "Erdgeschoss",
  "Turm 1",
  "Turm 2",
  "Turm 3",
  "Turm 4",
  "Turm 5",
  "Turm 6: Glockenstuhl"
];

async function buildScene(gm) {
  return gm.evaluate(
    async (moduleId, sceneName, levelNames) => {
      for (const s of game.scenes.filter((s) => s.name === sceneName)) await s.delete();
      const id = () => foundry.utils.randomID();
      const levels = levelNames.map((name, i) => ({
        _id: id(),
        name,
        sort: i,
        elevation: { bottom: (i - 2) * 20, top: (i - 1) * 20 }
      }));
      const [, , ground, ...tower] = levels.map((l) => l._id);
      const variant = (name) => ({ flags: { [moduleId]: { variant: name } } });
      const tile = (name, levelId, flag) => ({
        name,
        texture: { src: "ui/parchment.jpg" },
        x: 100,
        y: 100,
        width: 400,
        height: 300,
        levels: [levelId],
        ...(flag ? variant(flag) : {})
      });
      const scene = await Scene.create(
        {
          name: sceneName,
          width: 1200,
          height: 900,
          padding: 0,
          tokenVision: false,
          initialLevel: ground,
          levels,
          tiles: [
            tile("Ground", ground),
            tile("Ground Feast", ground, "Fest"),
            tile("Ground Night", ground, "Nacht"),
            tile("Ground Burning", ground, "Brand"),
            tile("Ground Ruined", ground, "Ruine"),
            ...tower.map((levelId, i) => tile(`Tower ${i + 1} Burning`, levelId, "Brand"))
          ],
          lights: [
            { x: 300, y: 300, levels: [ground], config: { dim: 10, bright: 5 }, ...variant("Brand") },
            { x: 600, y: 300, levels: [ground], config: { dim: 10, bright: 5 }, ...variant("Tag") }
          ],
          walls: [
            { c: [100, 500, 600, 500], levels: [ground], ...variant("Ruine") },
            { c: [100, 600, 600, 600], levels: [ground], ...variant(["Tag", "Fest", "Nacht", "Brand"]) }
          ],
          flags: { [moduleId]: { defaultName: "Tag" } }
        },
        { keepId: true }
      );
      await scene.activate();
      return { sceneId: scene.id, ground, tower };
    },
    MODULE_ID,
    SCENE,
    LEVELS
  );
}

// The state of every variant-bound document: alpha for tiles, hidden for lights, the sight restriction for walls.
const documentState = (page, sceneId) =>
  page.evaluate(
    (id, moduleId) => {
      const scene = game.scenes.get(id);
      const state = {};
      for (const t of scene.tiles) if (t.getFlag(moduleId, "variant")) state[t.name] = t.alpha;
      const label = (doc) => [doc.getFlag(moduleId, "variant")].flat().join("+");
      for (const l of scene.lights) state[`light ${label(l)}`] = l.hidden ? 0 : 1;
      for (const w of scene.walls) state[`wall ${label(w)}`] = w.sight === 0 ? 0 : 1;
      return state;
    },
    sceneId,
    MODULE_ID
  );

const shown = (state) =>
  Object.entries(state)
    .filter(([, v]) => v === 1)
    .map(([k]) => k)
    .sort();

const setClientSetting = (page, key, value) =>
  page.evaluate((m, k, v) => game.settings.set(m, k, v), MODULE_ID, key, value);

const clickVariant = (page, levelId, selector, shift = false) =>
  page.evaluate(
    (id, sel, shiftKey) => {
      const row = document.querySelector(`#scene-navigation-levels .scene-level[data-level-id="${id}"]`);
      const button = row?.closest(".level-row")?.querySelector(sel);
      if (!button) throw new Error(`no ${sel} at level ${id}`);
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey }));
    },
    levelId,
    selector,
    shift
  );

const optionSelector = (name) => `.my-variant-option[data-variant="${name}"]`;
const BASE_ONLY = ["light Tag", "wall Tag+Fest+Nacht+Brand"];
const sameList = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// Polls until exactly the expected variant documents are on: a sync writes one document type after the other.
async function expectShown(page, sceneId, expected) {
  let on = [];
  for (let i = 0; i < 40; i++) {
    on = shown(await documentState(page, sceneId));
    if (sameList(on, expected)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`on: ${on.join(", ")}; expected: ${[...expected].sort().join(", ")}`);
}

await run(async () => {
  const gm = await joinGamemaster();
  const { sceneId, ground, tower } = await buildScene(gm);
  await waitFor(gm, (id) => canvas.scene?.id === id, sceneId);

  await check(
    "on load the active GM switches every variant but the base state off and saves what it switched",
    async () => {
      await expectShown(gm, sceneId, BASE_ONLY);
      const restore = await gm.evaluate(
        (id, m) => game.scenes.get(id).walls.contents[0].getFlag(m, "restore"),
        sceneId,
        MODULE_ID
      );
      assert(restore?.sight > 0, `wall restore flag is ${JSON.stringify(restore)}`);
    }
  );

  await check("the default list scrolls, the full list shows all nine levels without scrolling", async () => {
    const measure = () =>
      gm.evaluate(() => {
        const menu = document.querySelector("#scene-navigation-levels");
        return { rows: menu.querySelectorAll(".level-row").length, scrolls: menu.scrollHeight > menu.clientHeight + 1 };
      });
    await setClientSetting(gm, "variantStyle", "arrows");
    await setClientSetting(gm, "fullLevelList", false);
    await waitFor(gm, () => !document.querySelector("#scene-navigation-levels.my-full-level-list"));
    const before = await measure();
    assert(before.rows === 9 && before.scrolls, `default list: ${JSON.stringify(before)}`);
    await setClientSetting(gm, "fullLevelList", true);
    await waitFor(gm, () => document.querySelector("#scene-navigation-levels.my-full-level-list"));
    const after = await measure();
    assert(after.rows === 9 && !after.scrolls, `full list: ${JSON.stringify(after)}`);
  });

  await check("the API lists the variants of each level", async () => {
    const variants = await gm.evaluate(
      (id, m) => game.modules.get(m).api.getVariants(game.scenes.get(id)),
      sceneId,
      MODULE_ID
    );
    const byLevel = Object.fromEntries(variants.map((v) => [v.levelId, v.variants.join("/")]));
    assert(byLevel[ground] === "Tag/Fest/Nacht/Brand/Ruine", `ground: ${byLevel[ground]}`);
    for (const id of tower) assert(byLevel[id] === "Tag/Brand", `tower level ${id}: ${byLevel[id]}`);
    assert(variants.length === 7, `${variants.length} levels with variants`);
  });

  await check("the arrows step the ground floor from Tag to Fest, shown as ◀ Fest ▶", async () => {
    await clickVariant(gm, ground, ".my-variant-step:last-child");
    const labelAt = (id) =>
      document
        .querySelector(`#scene-navigation-levels .scene-level[data-level-id="${id}"]`)
        ?.closest(".level-row")
        ?.querySelector(".my-variant-name")?.textContent;
    await waitFor(gm, `(${labelAt})("${ground}") === "Fest"`);
    const label = await gm.evaluate(labelAt, ground);
    assert(label === "Fest", `ground label is ${label}`);
    await expectShown(gm, sceneId, ["Ground Feast", "wall Tag+Fest+Nacht+Brand"]);
  });

  await check("in the tree, Brand switches the ground floor and all six tower levels together", async () => {
    await setClientSetting(gm, "variantStyle", "tree");
    await waitFor(gm, () => document.querySelector(".my-variant-tree"));
    await clickVariant(gm, ground, optionSelector("Brand"));
    await expectShown(gm, sceneId, [
      "Ground Burning",
      ...tower.map((_, i) => `Tower ${i + 1} Burning`),
      "light Brand",
      "wall Tag+Fest+Nacht+Brand"
    ]);
  });

  await check("shift-click on Tag at Turm 1 resets only that level", async () => {
    await clickVariant(gm, tower[0], optionSelector("Tag"), true);
    await expectShown(gm, sceneId, [
      "Ground Burning",
      ...tower.slice(1).map((_, i) => `Tower ${i + 2} Burning`),
      "light Brand",
      "wall Tag+Fest+Nacht+Brand"
    ]);
  });

  await check("Ruine swaps the church walls for its own and Tag resets every level", async () => {
    await clickVariant(gm, ground, optionSelector("Ruine"));
    await expectShown(gm, sceneId, [
      "Ground Ruined",
      "wall Ruine",
      ...tower.slice(1).map((_, i) => `Tower ${i + 2} Burning`)
    ]);
    await clickVariant(gm, ground, optionSelector("Tag"));
    await expectShown(gm, sceneId, BASE_ONLY);
    const active = await gm.evaluate((id, m) => game.scenes.get(id).getFlag(m, "active"), sceneId, MODULE_ID);
    assert(Object.keys(active ?? {}).length === 0, `active is ${JSON.stringify(active)}`);
  });

  await check("a second sync writes nothing", async () => {
    const writes = await gm.evaluate(async (id) => {
      let count = 0;
      const hook = Hooks.on("preUpdateTile", () => {
        count++;
      });
      const scene = game.scenes.get(id);
      await scene.update({ "flags.foundry-my-modules.active": _replace({}) });
      await new Promise((r) => setTimeout(r, 500));
      Hooks.off("preUpdateTile", hook);
      return count;
    }, sceneId);
    assert(writes === 0, `${writes} tile writes`);
  });

  await check("a player sees the full level list but no variant controls", async () => {
    const player = await join(PLAYER_NAME);
    await setClientSetting(player, "fullLevelList", true);
    await waitFor(player, () => document.querySelector("#scene-navigation-levels .level-row"));
    const seen = await player.evaluate(() => ({
      rows: document.querySelectorAll("#scene-navigation-levels .level-row").length,
      controls: document.querySelectorAll(".my-variant").length
    }));
    assert(seen.rows === 9, `player sees ${seen.rows} levels`);
    assert(seen.controls === 0, `player sees ${seen.controls} variant controls`);
  });
});
