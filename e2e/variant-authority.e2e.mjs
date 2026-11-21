import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

// Hold a prepared Foundry request at the last client boundary before it reaches the database.
// All hooks, permissions, broadcasts and drawing still run in their real browser contexts.
async function holdWrite(page, sceneId, kind) {
  await page.evaluate(
    (id, kind) => {
      const io = foundry.helpers.SocketInterface;
      const dispatch = io.dispatch;
      const pending = Promise.withResolvers();
      const gate = { held: false, release: pending.resolve };
      globalThis.variantGate = gate;
      io.dispatch = async function (event, request) {
        const { type, action, operation } = request;
        const tokenWrite = type === "Token" && operation?.parentUuid === `Scene.${id}`;
        const tokenMatch =
          tokenWrite &&
          (kind === "create"
            ? action === "create"
            : action === "update" && (kind === "edit" || operation.updates.some((u) => u.hidden === false)));
        const sceneReveal =
          kind === "reveal" &&
          type === "Scene" &&
          action === "update" &&
          operation.updates.some(
            (u) =>
              u._id === id && foundry.data.operators.DataFieldOperator.get(u.tokens)?.some((t) => t.hidden === false)
          );
        if (event === "modifyDocument" && (tokenMatch || sceneReveal)) {
          io.dispatch = dispatch;
          gate.held = true;
          await pending.promise;
        }
        return dispatch.call(this, event, request);
      };
    },
    sceneId,
    kind
  );
}

const waitForHold = (page) => waitFor(page, () => variantGate.held);
const release = (page) => page.evaluate(() => variantGate.release());

const select = (page, scene, name) =>
  page.evaluate(
    async (id, variant, m) => {
      const s = game.scenes.get(id);
      await game.modules.get(m).api.setVariant(s, s.levels.contents[0].id, variant);
    },
    scene,
    name,
    MODULE_ID
  );

const editGuard = (page, scene, hidden) =>
  page.evaluate(
    async (id, hidden) => {
      await game.scenes.get(id).tokens.getName("Guard").update({ hidden });
    },
    scene,
    hidden
  );

const expectHidden = (page, scene, name, hidden) =>
  waitFor(
    page,
    (id, name, hidden) => {
      const t = game.scenes.get(id)?.tokens.getName(name);
      return t?._source.hidden === hidden && t.hidden === hidden;
    },
    scene,
    name,
    hidden
  );

async function observe(player, id) {
  await player.evaluate((id) => {
    for (const [event, hook] of globalThis.variantObservers ?? []) Hooks.off(event, hook);
    globalThis.variantObservers = [];
    globalThis.tokenEvents = [];
    for (const event of ["createToken", "updateToken", "drawToken", "updateRegion", "updateScene"]) {
      const hook = Hooks.on(event, (object, ...args) => {
        const t = object.document ?? object;
        if ((t.parent?.id ?? t.id) === id)
          tokenEvents.push({ event, name: t.name, hidden: t.hidden, source: t._source.hidden, userId: args.at(-1) });
      });
      variantObservers.push([event, hook]);
    }
  }, id);
}

await run(async () => {
  const gm = await joinGamemaster();
  const otherName = `Variant GM ${Date.now()}`;
  const otherId = await gm.evaluate(
    async (name) => (await User.create({ name, role: CONST.USER_ROLES.GAMEMASTER })).id,
    otherName
  );
  const other = await join(otherName);
  const player = await join(PLAYER_NAME);
  const [primary, secondary] = (await gm.evaluate(() => game.users.activeGM.isSelf)) ? [gm, other] : [other, gm];
  await waitFor(secondary, () => !game.users.activeGM.isSelf);
  let sceneId, foreignId, actorId;
  try {
    await check("a previously GM-hidden legacy ambush stays hidden on its first migration and activation", async () => {
      ({ sceneId, actorId } = await primary.evaluate(
        async (m, playerName) => {
          const actor = await Actor.create({
            name: "Variant player actor",
            type: "character",
            ownership: { [game.users.getName(playerName).id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
          });
          const scene = await Scene.create(
            {
              name: "Variant authority",
              tokenVision: false,
              ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
              flags: { [m]: { defaultName: "Tag" } },
              tokens: [
                { name: "Legacy ambush", hidden: true, flags: { [m]: { variant: "Fest" } } },
                { name: "Guard", flags: { [m]: { variant: "Fest" } } },
                { name: "Player scout", actorId: actor.id, actorLink: true }
              ]
            },
            { noHook: true }
          );
          return { sceneId: scene.id, actorId: actor.id };
        },
        MODULE_ID,
        PLAYER_NAME
      ));
      await waitFor(player, (id) => game.scenes.has(id), sceneId);
      await observe(player, sceneId);
      await player.evaluate(async (id) => {
        await game.scenes.get(id).view();
      }, sceneId);
      await waitFor(player, () => tokenEvents.some((e) => e.event === "drawToken" && e.name === "Legacy ambush"));
      await select(primary, sceneId, "Fest");
      await expectHidden(player, sceneId, "Guard", false);
      await primary.evaluate(async (id) => {
        await getDocumentClass("Region").createTokenEmanation(game.scenes.get(id).tokens.getName("Guard"), 5, {
          name: "Guard emanation",
          visibility: CONST.REGION_VISIBILITY.ALWAYS
        });
      }, sceneId);
      await select(primary, sceneId, "Tag");
      await expectHidden(player, sceneId, "Guard", true);
      await expectHidden(player, sceneId, "Legacy ambush", true);
      const ambush = await player.evaluate(() => tokenEvents.filter((e) => e.name === "Legacy ambush"));
      assert(
        ambush.every((e) => e.hidden && e.source),
        JSON.stringify(ambush)
      );
    });

    await check("a second GM's manual hide survives a previously prepared reveal", async () => {
      await holdWrite(primary, sceneId, "reveal");
      const switching = select(primary, sceneId, "Fest");
      try {
        await waitForHold(primary);
        await editGuard(secondary, sceneId, true);
        await waitFor(
          player,
          (id, m) => {
            const token = game.scenes.get(id).tokens.getName("Guard");
            return (token.getFlag(m, "gmHidden") ?? token.getFlag(m, "restore")?.hidden) === true;
          },
          sceneId,
          MODULE_ID
        );
        await player.evaluate(() => {
          globalThis.afterManualHide = tokenEvents.length;
        });
      } finally {
        await release(primary);
        await switching;
      }
      await expectHidden(player, sceneId, "Guard", true);
      await select(primary, sceneId, "Tag");
      await select(primary, sceneId, "Fest");
      await expectHidden(player, sceneId, "Guard", true);
      const guard = await player.evaluate(() =>
        tokenEvents.slice(afterManualHide).filter((e) => ["Guard", "Guard emanation"].includes(e.name))
      );
      assert(
        guard.some((e) => e.event === "updateRegion"),
        "the held reveal did not reach the attached region"
      );
      assert(
        guard.every((e) => e.hidden),
        JSON.stringify(guard)
      );
    });

    await check("a manual hide delivered after the other GM switches also survives the next switch", async () => {
      await select(primary, sceneId, "Tag");
      await editGuard(secondary, sceneId, false);
      await waitFor(
        primary,
        (id, m) => game.scenes.get(id).tokens.getName("Guard").getFlag(m, "gmHidden") === false,
        sceneId,
        MODULE_ID
      );
      await holdWrite(secondary, sceneId, "edit");
      const hiding = editGuard(secondary, sceneId, true);
      try {
        await waitForHold(secondary);
        await select(primary, sceneId, "Fest");
        await expectHidden(player, sceneId, "Guard", false);
      } finally {
        await release(secondary);
        await hiding;
      }
      await expectHidden(player, sceneId, "Guard", true);
      await select(secondary, sceneId, "Tag");
      await select(secondary, sceneId, "Fest");
      await expectHidden(player, sceneId, "Guard", true);
    });

    await check("a token prepared by a second GM before a switch arrives hidden after the switch", async () => {
      await waitFor(
        secondary,
        (id, m) => Object.values(game.scenes.get(id).getFlag(m, "active") ?? {}).includes("Fest"),
        sceneId,
        MODULE_ID
      );
      await holdWrite(secondary, sceneId, "create");
      const creating = secondary.evaluate(
        async (id, m) => {
          await game.scenes
            .get(id)
            .createEmbeddedDocuments("Token", [{ name: "Late guest", flags: { [m]: { variant: "Fest" } } }]);
        },
        sceneId,
        MODULE_ID
      );
      try {
        await waitForHold(secondary);
        await select(primary, sceneId, "Tag");
      } finally {
        await release(secondary);
        await creating;
      }
      await expectHidden(player, sceneId, "Late guest", true);
      const creation = await player.evaluate(() =>
        tokenEvents.find((e) => e.event === "createToken" && e.name === "Late guest")
      );
      assert(creation?.source && creation.hidden, JSON.stringify(creation));
      await select(primary, sceneId, "Fest");
      await expectHidden(player, sceneId, "Late guest", false);
    });

    await check("a creator using the other language cannot publish their translation as the active base", async () => {
      foreignId = await primary.evaluate(
        async () =>
          (
            await Scene.create({
              name: "Variant base language",
              ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
            })
          ).id
      );
      await waitFor(secondary, (id) => game.scenes.has(id), foreignId);
      await waitFor(player, (id) => game.scenes.has(id), foreignId);
      await observe(player, foreignId);
      const { lang, base } = await primary.evaluate(() => ({
        lang: game.i18n.lang,
        base: game.i18n.localize("MY_MODULES.Variants.Default")
      }));
      const translated = await secondary.evaluate(
        async (id, m, lang) => {
          await game.i18n.setLanguage(lang === "de" ? "en" : "de");
          const variant = game.i18n.localize("MY_MODULES.Variants.Default");
          const s = game.scenes.get(id);
          if (s.getFlag(m, "defaultName")) throw new Error("Fixture already has a shared base");
          await s.createEmbeddedDocuments("Token", [{ name: "Translated guest", flags: { [m]: { variant } } }]);
          return variant;
        },
        foreignId,
        MODULE_ID,
        lang
      );
      assert(translated !== base, `Both clients translated the base as ${base}`);
      await expectHidden(player, foreignId, "Translated guest", true);
      const creation = await player.evaluate(() =>
        tokenEvents.find((e) => e.event === "createToken" && e.name === "Translated guest")
      );
      assert(creation?.source && creation.hidden, JSON.stringify(creation));
      await waitFor(
        primary,
        (id, m, base) => game.scenes.get(id).getFlag(m, "defaultName") === base,
        foreignId,
        MODULE_ID,
        base
      );
      await select(secondary, foreignId, translated);
      await expectHidden(player, foreignId, "Translated guest", false);
      const authorityRevealed = await player.evaluate(() =>
        tokenEvents.some(
          (e) =>
            e.event === "updateToken" &&
            e.name === "Translated guest" &&
            !e.source &&
            e.userId === game.users.activeGM.id
        )
      );
      assert(authorityRevealed, "The active GM did not publish the requested reveal");
    });

    await check(
      "incoming visible source data is masked on the player before creation, drawing and updates",
      async () => {
        await select(primary, sceneId, "Tag");
        await observe(player, sceneId);
        await secondary.evaluate(
          async (id, m) => {
            const s = game.scenes.get(id);
            await s.createEmbeddedDocuments(
              "Token",
              [{ name: "Imported guest", flags: { [m]: { variant: "Fest" } } }],
              { noHook: true }
            );
            const [token] = await s.createEmbeddedDocuments("Token", [{ name: "Imported retag" }]);
            await token.update({ [`flags.${m}.variant`]: "Fest" }, { noHook: true });
          },
          sceneId,
          MODULE_ID
        );
        await waitFor(
          player,
          () =>
            tokenEvents.some((e) => e.event === "drawToken" && e.name === "Imported guest") &&
            tokenEvents.some((e) => e.event === "updateToken" && e.name === "Imported retag")
        );
        const observed = await player.evaluate(() =>
          tokenEvents.filter(
            (e) => e.name === "Imported guest" || (e.event === "updateToken" && e.name === "Imported retag")
          )
        );
        assert(
          observed.some((e) => e.event === "createToken" && !e.source) &&
            observed.some((e) => e.event === "updateToken" && e.name === "Imported retag" && !e.source) &&
            observed.every((e) => e.hidden),
          JSON.stringify(observed)
        );
      }
    );

    await check("untagging an ambush during a prepared reveal keeps it hidden after cleanup", async () => {
      await select(primary, sceneId, "Tag");
      await editGuard(secondary, sceneId, false);
      await waitFor(
        primary,
        (id, m) => game.scenes.get(id).tokens.getName("Guard").getFlag(m, "gmHidden") === false,
        sceneId,
        MODULE_ID
      );
      await holdWrite(primary, sceneId, "reveal");
      const switching = select(primary, sceneId, "Fest");
      try {
        await waitForHold(primary);
        await secondary.evaluate(
          async (id, m) => {
            await game.scenes
              .get(id)
              .tokens.getName("Guard")
              .update({ hidden: true, [`flags.${m}.variant`]: _del });
          },
          sceneId,
          MODULE_ID
        );
      } finally {
        await release(primary);
        await switching;
      }
      await waitFor(
        player,
        (id, m) => {
          const guard = game.scenes.get(id).tokens.getName("Guard");
          return guard._source.hidden && !Object.keys(guard.flags[m] ?? {}).length;
        },
        sceneId,
        MODULE_ID
      );
      await select(primary, sceneId, "Tag");
    });

    await check("a player can retag an owned token and sees it only in the selected variant", async () => {
      await player.evaluate(
        async (id, m) => {
          const t = game.scenes.get(id).tokens.getName("Player scout");
          if (!t.isOwner) throw new Error("The player does not own the fixture token");
          await t.setFlag(m, "variant", "Fest");
        },
        sceneId,
        MODULE_ID
      );
      await expectHidden(player, sceneId, "Player scout", true);
      await select(secondary, sceneId, "Fest");
      await expectHidden(player, sceneId, "Player scout", false);
      const publisher = await player.evaluate(
        () => tokenEvents.filter((e) => e.event === "updateScene").at(-1)?.userId
      );
      assert(publisher === (await primary.evaluate(() => game.user.id)), "the secondary GM published the selection");
    });
  } finally {
    await other.browserContext().close();
    await gm.evaluate(
      async (scenes, actor, user) => {
        for (const id of scenes) await game.scenes.get(id)?.delete();
        await game.actors.get(actor)?.delete();
        await game.users.get(user)?.delete();
      },
      [sceneId, foreignId],
      actorId,
      otherId
    );
  }
});
