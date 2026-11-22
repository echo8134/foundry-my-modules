import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const version = "High.Tide";
const floorView = { x: 1300, y: 1000, scale: 1 };
const tideView = { x: 1900, y: 1500, scale: 1.5 };
const cellarView = { x: 850, y: 700, scale: 2 };
const freeView = { x: 1100, y: 900, scale: 1.25 };

async function menuAction(gm, action, row = "#scene-navigation-levels .scene-level.view") {
  await gm.waitForSelector(row, { visible: true });
  await gm.locator(row).click({ button: "right" });
  await gm.waitForSelector("#context-menu .context-item", { visible: true });
  await gm.$$eval(
    "#context-menu .context-item",
    async (items, label) => {
      const item = items.find((item) => item.textContent.trim() === label);
      if (!item) throw new Error(`Missing "${label}" in ${items.map((i) => i.textContent.trim()).join(", ")}`);
      const committed = new Promise((resolve) => Hooks.once("updateLevel", resolve));
      item.click();
      await committed;
    },
    action
  );
}

const pan = (page, view) => page.evaluate((view) => canvas.pan(view), view);
const openFloor = (page, level) => page.evaluate((id) => canvas.scene.view({ level: id }), level);
const expectView = (page, view) =>
  waitFor(
    page,
    ({ x, y, scale }) =>
      canvas.stage.pivot.x === x && canvas.stage.pivot.y === y && Math.abs(canvas.stage.scale.x - scale) < 0.001,
    view
  );
const switchVersion = (gm, level, version) =>
  gm.evaluate((m, id, v) => game.modules.get(m).api.setVariant(canvas.scene, id, v), MODULE_ID, level, version);

await run(async () => {
  const gm = await joinGamemaster("en");
  const previousScene = await gm.evaluate(() => game.scenes.active?.id);
  const { scene, ground, cellar } = await gm.evaluate(
    async (m, version) => {
      const ground = foundry.utils.randomID();
      const cellar = foundry.utils.randomID();
      const scene = await Scene.create(
        {
          name: "Level views test",
          width: 2800,
          height: 2000,
          padding: 0,
          tokenVision: false,
          initial: { x: 1400, y: 1000, scale: 1 },
          initialLevel: ground,
          levels: [
            { _id: ground, name: "Ground" },
            { _id: cellar, name: "Cellar" }
          ],
          flags: { [m]: { defaultName: "Day" } },
          tiles: [
            {
              x: 300,
              y: 200,
              width: 400,
              height: 300,
              texture: { src: "ui/parchment.jpg" },
              levels: [ground],
              flags: { [m]: { variant: version } }
            }
          ]
        },
        { keepId: true }
      );
      await scene.activate();
      return { scene: scene.id, ground, cellar };
    },
    MODULE_ID,
    version
  );
  try {
    await waitFor(gm, (id) => canvas.ready && !canvas.loading && canvas.scene.id === id, scene);
    const player = await join(PLAYER_NAME, "", "en");
    await check("the GM can save separate floor views and return to each", async () => {
      await pan(gm, floorView);
      await menuAction(gm, "Save view for this level");
      await openFloor(gm, cellar);
      await pan(gm, cellarView);
      await menuAction(gm, "Save view for this level");
      await openFloor(gm, ground);
      await expectView(gm, floorView);
      await openFloor(gm, cellar);
      await expectView(gm, cellarView);
    });

    await check("a variant inherits its floor view until the GM saves an override", async () => {
      await openFloor(gm, ground);
      await pan(gm, freeView);
      await switchVersion(gm, ground, version);
      await expectView(gm, floorView);
      await pan(gm, tideView);
      await menuAction(gm, "Save view for this variant");
      await switchVersion(gm, ground, "Day");
      await expectView(gm, floorView);
      await switchVersion(gm, ground, version);
      await expectView(gm, tideView);
      await expectView(player, tideView);
      await player.reload({ waitUntil: "domcontentloaded" });
      await waitFor(player, () => globalThis.canvas?.ready && !canvas.loading);
      await expectView(player, tideView);
    });

    await check("players on another floor can keep panning while the GM switches versions", async () => {
      await openFloor(player, cellar);
      await expectView(player, cellarView);
      await pan(player, freeView);
      await switchVersion(gm, ground, "Day");
      await waitFor(player, (m) => !canvas.scene.getFlag(m, "active")?.[canvas.scene.initialLevel.id], MODULE_ID);
      await expectView(player, freeView);
      await switchVersion(gm, ground, version);
      await player.evaluate(() => canvas.draw(canvas.scene, { level: canvas.level.id }));
      await expectView(player, freeView);
      await openFloor(player, ground);
      await expectView(player, tideView);
    });

    await check("clearing the variant restores the floor default on the next visit", async () => {
      await menuAction(gm, "Clear variant view");
      await switchVersion(gm, ground, "Day");
      await switchVersion(gm, ground, version);
      await expectView(gm, floorView);
      await expectView(player, floorView);
      await menuAction(gm, "Clear level view");
      await switchVersion(gm, ground, "Day");
      await pan(gm, freeView);
      await switchVersion(gm, ground, version);
      await expectView(gm, freeView);
      const opening = await gm.evaluate(() => canvas.scene._source.initial);
      assert(opening.x === 1400 && opening.y === 1000 && opening.scale === 1, JSON.stringify(opening));
    });
    await check("a single-floor map exposes its saved view on the scene row", async () => {
      await gm.evaluate((id) => canvas.scene.deleteEmbeddedDocuments("Level", [id]), cellar);
      await waitFor(gm, () => !document.querySelector("#scene-navigation-levels"));
      const row = "#scene-navigation-viewed [data-scene-id]";
      await pan(gm, floorView);
      await menuAction(gm, "Save view for this level", row);
      await pan(gm, freeView);
      await switchVersion(gm, ground, "Day");
      await expectView(gm, floorView);
      await menuAction(gm, "Clear level view", row);
    });
  } finally {
    await gm.evaluate(
      async (id, previous) => {
        await game.scenes.get(previous)?.activate();
        await game.scenes.get(id)?.delete();
      },
      scene,
      previousScene
    );
  }
});
