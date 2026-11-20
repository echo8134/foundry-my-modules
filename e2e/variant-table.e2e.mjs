import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const switchLevel = (gm, id, level, variant) =>
  gm.evaluate(
    (id, level, variant, m) => game.modules.get(m).api.setVariant(game.scenes.get(id), level, variant),
    id,
    level,
    variant,
    MODULE_ID
  );

async function checkParentEdits(gm, player) {
  const { id, level } = await gm.evaluate(async (m) => {
    const level = foundry.utils.randomID();
    const scene = await Scene.create(
      {
        name: "Variant parent edits",
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
        levels: [{ _id: level, name: "Ground" }],
        initialLevel: level,
        flags: { [m]: { defaultName: "Tag" } },
        tokens: [
          { name: "Base", level, flags: { [m]: { variant: "Tag" } } },
          { name: "Legacy guard", level, hidden: true, flags: { [m]: { variant: "Fest", restore: { hidden: false } } } }
        ],
        tiles: [{ texture: { src: "ui/parchment.jpg" }, width: 100, height: 100 }],
        lights: [{ config: { dim: 10 } }],
        sounds: [{ radius: 10 }],
        walls: [{ c: [100, 100, 200, 100] }]
      },
      { noHook: true, keepId: true }
    );
    return { id: scene.id, level };
  }, MODULE_ID);
  try {
    await check("removing a legacy guard's tag and hiding it together survives the next synchronization", async () => {
      await gm.evaluate(
        async (id, m) => {
          const scene = game.scenes.get(id);
          const guard = scene.tokens.getName("Legacy guard");
          await guard.update({ hidden: true, [`flags.${m}.variant`]: _del });
          await game.modules.get(m).api.setVariant(scene, scene.initialLevel.id, "Tag");
          const saved = scene.tokens.get(guard.id);
          if (!saved._source.hidden || saved.getFlag(m, "restore"))
            throw new Error("a stale restore unhides the ambush");
        },
        id,
        MODULE_ID
      );
    });

    await check("a full parent token save preserves the hidden choice of an inactive guard", async () => {
      await gm.evaluate(
        async (id, m) => {
          const scene = game.scenes.get(id);
          const [guard] = await scene.createEmbeddedDocuments("Token", [
            { name: "Round trip", level: scene.initialLevel.id, flags: { [m]: { variant: "Fest" } } }
          ]);
          await scene.update({ tokens: scene.tokens.map((t) => t.toObject()) });
          await game.modules.get(m).api.setVariant(scene, scene.initialLevel.id, "Fest");
          if (scene.tokens.get(guard.id)._source.hidden) throw new Error("full parent save hid the guard permanently");
          await scene.unsetFlag(m, "active");
          if (m in scene.flags && "active" in scene.flags[m]) throw new Error("unsetFlag retained the selection");
          await scene.tokens.get(guard.id).delete();
        },
        id,
        MODULE_ID
      );
    });

    await check("bulk edits select a new tile, light, sound or wall variant and expire its last member", async () => {
      await waitFor(player, (id) => game.scenes.has(id), id);
      await player.evaluate(
        (id, level, m) => {
          globalThis.bulkPublications = [];
          Hooks.on("updateScene", (scene) => {
            if (scene.id !== id) return;
            const active = scene.getFlag(m, "active")?.[level];
            if (active) bulkPublications.push([active, scene.tokens.getName("Base")._source.hidden]);
          });
        },
        id,
        level,
        MODULE_ID
      );
      for (const key of ["tiles", "lights", "sounds", "walls"]) {
        await gm.evaluate(
          async (id, level, m, key) => {
            const scene = game.scenes.get(id);
            await scene.update({
              [key]: [{ _id: scene[key].contents[0].id, flags: { [m]: { variant: key } } }],
              flags: { [m]: { active: { [level]: key } } }
            });
          },
          id,
          level,
          MODULE_ID,
          key
        );
        await waitFor(player, (key) => bulkPublications.some(([name]) => name === key), key);
        const exposed = await player.evaluate(() => bulkPublications.filter(([, hidden]) => !hidden));
        assert(!exposed.length, `base guard visible at publication: ${JSON.stringify(exposed)}`);
        await gm.evaluate(
          async (id, m, key) => {
            const scene = game.scenes.get(id);
            await scene.update({ [key]: [{ _id: scene[key].contents[0].id, flags: { [m]: { variant: _del } } }] });
          },
          id,
          MODULE_ID,
          key
        );
        await waitFor(
          player,
          (id, level, m) => {
            const scene = game.scenes.get(id);
            return !scene.getFlag(m, "active")?.[level] && !scene.tokens.getName("Base")._source.hidden;
          },
          id,
          level,
          MODULE_ID
        );
      }
    });

    await check(
      "creating 300 tagged tokens beside 300 existing tokens builds at most one membership index",
      async () => {
        const result = await gm.evaluate(
          async (id, level, m) => {
            const scene = game.scenes.get(id);
            const batch = (variant) =>
              Array.from({ length: 300 }, (_, i) => ({
                name: `${variant} ${i}`,
                level,
                flags: { [m]: { variant } }
              }));
            await scene.createEmbeddedDocuments("Token", batch("Tag"), { noHook: true });
            const values = scene.tiles.values;
            let visits = 0;
            let prepared = 0;
            let visitsAtLastCreate;
            scene.tiles.values = function () {
              visits++;
              return values.call(this);
            };
            const hook = Hooks.on("preCreateToken", (token) => {
              if (token.parent === scene && ++prepared === 300) visitsAtLastCreate = visits;
            });
            try {
              const created = await scene.createEmbeddedDocuments("Token", batch("Fest"));
              return { prepared, visitsAtLastCreate, hidden: created.filter((t) => t._source.hidden).length };
            } finally {
              delete scene.tiles.values;
              Hooks.off("preCreateToken", hook);
            }
          },
          id,
          level,
          MODULE_ID
        );
        assert(
          result.prepared === 300 && result.hidden === 300 && result.visitsAtLastCreate <= 1,
          JSON.stringify(result)
        );
      }
    );
  } finally {
    await gm.evaluate((id) => game.scenes.get(id).delete(), id);
  }
}

async function checkLegacyResets(gm, player) {
  await check(
    "resetting a batch of legacy tokens keeps every player mask with at most one membership scan",
    async () => {
      const id = await gm.evaluate(async (m) => {
        const level = foundry.utils.randomID();
        const scene = await Scene.create(
          {
            name: "Legacy player masks",
            levels: [{ _id: level, name: "Ground" }],
            initialLevel: level,
            tokenVision: false,
            ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
            flags: { [m]: { defaultName: "Tag", active: { [level]: "Fest" } } },
            tiles: [
              { texture: { src: "ui/parchment.jpg" }, width: 100, height: 100, flags: { [m]: { variant: "Fest" } } }
            ],
            tokens: Array.from({ length: 12 }, (_, i) => ({
              name: `Legacy ${i}`,
              level,
              flags: { [m]: { variant: "Tag" } },
              x: i * 100
            }))
          },
          { noHook: true, keepId: true }
        );
        return scene.id;
      }, MODULE_ID);
      try {
        await waitFor(player, (id) => game.scenes.has(id) && canvas.ready && !canvas.loading, id);
        const result = await player.evaluate(async (id) => {
          const previous = canvas.scene;
          const scene = game.scenes.get(id);
          await scene.view();
          const values = scene.tiles.values;
          let scans = 0;
          scene.tiles.values = function () {
            scans++;
            return values.call(this);
          };
          try {
            for (const token of scene.tokens) token.reset();
            return { scans, masked: scene.tokens.filter((token) => token.hidden && !token._source.hidden).length };
          } finally {
            delete scene.tiles.values;
            await previous.view();
          }
        }, id);
        assert(result.masked === 12 && result.scans <= 1, JSON.stringify(result));
      } finally {
        await gm.evaluate((id) => game.scenes.get(id).delete(), id);
      }
    }
  );
}

async function buildCathedral(gm) {
  return gm.evaluate(async (m) => {
    const previous = game.scenes.active?.id;
    const levels = Array.from({ length: 9 }, (_, i) => ({
      _id: foundry.utils.randomID(),
      name: i ? `Tower ${i}` : "Ground",
      sort: i,
      elevation: { bottom: i * 20, top: (i + 1) * 20 }
    }));
    const [ground, tower] = levels.map((l) => l._id);
    const token = (name, variant, x, y) => ({ name, x, y, level: ground, flags: { [m]: { variant } } });
    const scene = await Scene.create(
      {
        name: "Variant transition cathedral",
        width: 1400,
        height: 900,
        padding: 0,
        tokenVision: false,
        levels,
        initialLevel: ground,
        flags: { [m]: { defaultName: "Tag" } },
        tiles: levels.map((l) => ({
          x: 50,
          y: 50,
          width: 100,
          height: 100,
          texture: { src: "ui/parchment.jpg" },
          levels: [l._id],
          flags: { [m]: { variant: "Fest" } }
        })),
        tokens: [
          { ...token("Caster", "Tag", 500, 400), texture: { src: "ui/parchment.jpg", tint: "#ff0000" } },
          token("Guest", "Fest", 700, 400),
          token("Runner", "Fest", 200, 200),
          { ...token("Bell ringer", "Fest", 800, 400), elevation: 20, level: tower }
        ]
      },
      { keepId: true }
    );
    await scene.activate();
    return { id: scene.id, previous, ground, tower };
  }, MODULE_ID);
}

async function checkRendering(gm, player, { id, ground, tower }) {
  await check(
    "switching either floor never redraws the canvas or presents the outgoing guard in a Fest frame",
    async () => {
      await waitFor(
        player,
        (id) => canvas.scene?.id === id && canvas.ready && canvas.scene.tokens.getName("Caster").object?.mesh?.visible,
        id
      );
      for (const client of [gm, player]) {
        await client.evaluate(() => {
          globalThis.variantRedraws = 0;
          Hooks.on("canvasInit", () => variantRedraws++);
        });
      }
      await player.evaluate(
        (id, level, m) => {
          const scene = game.scenes.get(id);
          const guard = scene.tokens.getName("Caster");
          const renderer = canvas.app.renderer;
          const gl = renderer.gl;
          const pixel = new Uint8Array(4);
          const point = canvas.stage.toGlobal(guard.object.center);
          const x = Math.floor(point.x * renderer.resolution);
          const y = gl.drawingBufferHeight - 1 - Math.floor(point.y * renderer.resolution);
          const probe = {
            sawRed: false,
            lastRed: false,
            festFrames: 0,
            redFestFrames: 0,
            published: []
          };
          globalThis.variantFrames = probe;
          const inFest = () => scene.getFlag(m, "active")?.[level] === "Fest";
          const sample = () => {
            if (renderer.lastObjectRendered !== canvas.stage || renderer.renderTexture.current) return;
            gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            const red = pixel[0] > 60 && pixel[0] > Math.max(pixel[1], pixel[2]) * 2;
            probe.sawRed ||= red;
            probe.lastRed = red;
            if (!inFest()) return;
            probe.festFrames++;
            if (red) probe.redFestFrames++;
          };
          renderer.on("postrender", sample);
          const update = Hooks.on("updateScene", (doc) => {
            if (doc === scene && inFest())
              probe.published.push({
                mesh: guard.object?.mesh?.visible,
                lastRed: probe.lastRed,
                outgoingHidden: guard._source.hidden,
                incomingHidden: scene.tokens.getName("Guest")._source.hidden
              });
          });
          globalThis.stopFrameProbe = () => {
            renderer.off("postrender", sample);
            Hooks.off("updateScene", update);
          };
        },
        id,
        ground,
        MODULE_ID
      );
      try {
        await waitFor(player, () => variantFrames.sawRed);
        await switchLevel(gm, id, tower, "Fest");
        await switchLevel(gm, id, ground, "Fest");
        await waitFor(player, () => variantFrames.festFrames >= 2 && variantFrames.published.length);
        await switchLevel(gm, id, ground, "Tag");
        await waitFor(
          player,
          (id, ground, m) => !game.scenes.get(id).getFlag(m, "active")?.[ground] && variantFrames.lastRed,
          id,
          ground,
          MODULE_ID
        );
        const before = await player.evaluate(() => ({
          frames: variantFrames.festFrames,
          published: variantFrames.published.length
        }));
        await gm.evaluate(
          async (id, ground, m) => {
            await game.scenes.get(id).update({ flags: { [m]: { active: { [ground]: "Fest" } } } });
          },
          id,
          ground,
          MODULE_ID
        );
        await waitFor(
          player,
          (before) =>
            variantFrames.festFrames >= before.frames + 2 && variantFrames.published.length > before.published,
          before
        );
        const state = await player.evaluate(() => variantFrames);
        const redraws = await Promise.all([gm, player].map((client) => client.evaluate(() => variantRedraws)));
        assert(
          redraws.every((n) => n === 0),
          `full redraws on GM and player: ${redraws}`
        );
        assert(
          !state.redFestFrames &&
            state.published.every((s) => !s.mesh && !s.lastRed && s.outgoingHidden && s.incomingHidden),
          JSON.stringify(state)
        );
        console.log(
          `  ${state.festFrames} player frames, ${state.redFestFrames} outgoing, last frame red at publication: ${state.published[0].lastRed}`
        );
      } finally {
        await player.evaluate(() => stopFrameProbe());
      }
      await switchLevel(gm, id, ground, "Tag");
      await switchLevel(gm, id, tower, "Tag");
    }
  );

  await check("the caster's attached ALWAYS-visible emanation hides and returns with its bearer", async () => {
    await gm.evaluate(async (id) => {
      const scene = game.scenes.get(id);
      const token = scene.tokens.getName("Caster");
      await getDocumentClass("Region").createTokenEmanation(token, 5, {
        name: "Caster emanation",
        visibility: CONST.REGION_VISIBILITY.ALWAYS
      });
    }, id);
    const expectRegion = (hidden) =>
      waitFor(
        player,
        (id, expected) => {
          const region = game.scenes.get(id).regions.getName("Caster emanation");
          return region?.object && region._source.hidden === expected && region.object.visible === !expected;
        },
        id,
        hidden
      );
    await expectRegion(false);
    await switchLevel(gm, id, ground, "Fest");
    await expectRegion(true);
    await switchLevel(gm, id, ground, "Tag");
    await expectRegion(false);
  });
}

async function checkMovement(gm, player, { id, ground, tower }) {
  await check("cut and paste preserves an inactive token's visibility except when pasted as hidden", async () => {
    const cutPaste = (hidden) =>
      gm.evaluate(
        async (id, hidden) => {
          const scene = game.scenes.get(id);
          const token = scene.tokens.getName("Guest");
          const { x, y } = token._source;
          canvas.tokens.activate();
          token.object.control({ releaseOthers: true });
          if (canvas.tokens.copyObjects({ cut: true }).length !== 1) throw new Error("expected one cut token");
          const [moved] = await canvas.tokens.pasteObjects({ x: hidden ? 850 : 450, y: 550 }, { hidden, snap: false });
          if (moved !== token || (x === moved._source.x && y === moved._source.y))
            throw new Error("cut did not move the token");
        },
        id,
        hidden
      );
    for (const hidden of [false, true]) {
      await cutPaste(hidden);
      await switchLevel(gm, id, ground, "Fest");
      await waitFor(
        player,
        (id, m, ground, hidden) => {
          const scene = game.scenes.get(id);
          return (
            scene.getFlag(m, "active")?.[ground] === "Fest" && scene.tokens.getName("Guest")._source.hidden === hidden
          );
        },
        id,
        MODULE_ID,
        ground,
        hidden
      );
      const actual = await gm.evaluate((id) => game.scenes.get(id).tokens.getName("Guest")._source.hidden, id);
      assert(actual === hidden, `after paste(hidden=${hidden}), guest.hidden=${actual}`);
      await switchLevel(gm, id, ground, "Tag");
    }
  });

  await check("switching the animated origin floor keeps a moving tower token hidden", async () => {
    await player.evaluate(
      (id, tower) => {
        const scene = game.scenes.get(id);
        globalThis.runnerLeaks = [];
        for (const event of ["updateScene", "updateToken"])
          Hooks.on(event, () => {
            const runner = scene.tokens.getName("Runner");
            if (runner._source.level === tower && !runner._source.hidden) runnerLeaks.push(event);
          });
      },
      id,
      tower
    );
    await gm.bringToFront();
    await gm.evaluate(
      async (id, ground, tower, m) => {
        const scene = game.scenes.get(id);
        const runner = scene.tokens.getName("Runner");
        const start = runner.x;
        const renderer = canvas.app.renderer;
        let switched;
        const onFrame = () => {
          if (switched || renderer.lastObjectRendered !== canvas.stage) return;
          if (runner._source.level !== tower || runner.level !== ground || runner.x <= start) return;
          switched = game.modules.get(m).api.setVariant(scene, ground, "Fest");
        };
        renderer.on("postrender", onFrame);
        try {
          const moved = await runner.move(
            [
              { x: 1050, explicit: true },
              { y: 350, level: tower, elevation: 20 }
            ],
            { animation: { duration: 3500 }, constrainOptions: { ignoreWalls: true, ignoreCost: true } }
          );
          await runner.object.movementAnimationPromise;
          if (!moved || !switched) throw new Error("no intermediate rendered waypoint triggered the switch");
          await switched;
        } finally {
          renderer.off("postrender", onFrame);
        }
        await runner.move({ level: ground, elevation: 0 }, { animate: false });
      },
      id,
      ground,
      tower,
      MODULE_ID
    );
    await waitFor(player, (id) => !game.scenes.get(id).tokens.getName("Runner")._source.hidden, id);
    await gm.evaluate(
      async (id, tower) => {
        await game.scenes.get(id).tokens.getName("Runner").move({ level: tower, elevation: 20 }, { animate: false });
      },
      id,
      tower
    );
    await waitFor(
      player,
      (id, tower) => {
        const runner = game.scenes.get(id).tokens.getName("Runner");
        return runner._source.level === tower && runner._source.hidden;
      },
      id,
      tower
    );
    const leaks = await player.evaluate(() => runnerLeaks);
    assert(!leaks.length, `visible tower token delivered on ${leaks}`);
  });
}

await run(async () => {
  const gm = await joinGamemaster();
  const player = await join(PLAYER_NAME);
  await checkParentEdits(gm, player);
  await checkLegacyResets(gm, player);
  const cathedral = await buildCathedral(gm);
  try {
    await checkRendering(gm, player, cathedral);
    await checkMovement(gm, player, cathedral);
  } finally {
    await gm.evaluate(async ({ id, previous }) => {
      if (previous) await game.scenes.get(previous)?.activate();
      await game.scenes.get(id).delete();
    }, cathedral);
  }
});
