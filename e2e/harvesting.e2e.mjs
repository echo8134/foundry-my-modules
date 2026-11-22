import { assert, check, join, joinGamemaster, MODULE_ID, PLAYER_NAME, run, waitFor } from "./harness.mjs";

const rollPrompt = ".harvest-roll [data-action=roll]";
const review = ".harvest-review";

async function setup(gm) {
  return gm.evaluate(
    async (m, name) => {
      const player = game.users.getName(name);
      const previousCharacter = player.character?.id ?? null;
      const suffix = foundry.utils.randomID();
      const goods = await Item.create({
        name: `Test scales ${suffix}`,
        type: "loot",
        system: { description: { value: "<p>A polished silver scale.</p>" } }
      });
      const gland = await Item.create({ name: `Test gland ${suffix}`, type: "loot" });
      const actor = await Actor.create({
        name: `Harvester ${suffix}`,
        type: "character",
        ownership: { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
        system: { skills: { nat: { value: 1 } }, abilities: { dex: { value: 18 }, int: { value: 18 } } }
      });
      const [kit] = await actor.createEmbeddedDocuments(
        "Item",
        [
          {
            name: "Erntebesteck (Harvesting Kit)",
            type: "tool",
            system: {
              ability: "dex",
              proficient: 1,
              uses: { max: "10", spent: 0 },
              activities: {
                AppraiseCreature: { _id: "AppraiseCreature", type: "check", name: "Begutachten (Appraise)" },
                CheckKitSupplies: {
                  _id: "CheckKitSupplies",
                  type: "check",
                  name: "Ernten (Harvest)",
                  consumption: { targets: [{ type: "itemUses", target: "", value: "1" }] }
                }
              }
            }
          }
        ],
        { keepId: true }
      );
      const creature = await Actor.create({
        name: `Test corpse ${suffix}`,
        type: "npc",
        system: { attributes: { hp: { value: 0, max: 10 } } },
        flags: {
          [m]: {
            harvest: {
              appraise: { skill: "nat", dc: 1 },
              size: "med",
              components: [
                { id: "scales", name: goods.name, dc: 2, quantity: 3, edible: false, item: goods.name },
                {
                  id: "gland",
                  name: gland.name,
                  dc: 90,
                  quantity: 1,
                  edible: false,
                  item: gland.name,
                  danger: { save: { ability: "con", dc: 12 }, text: "A bitter sap stings." }
                }
              ]
            }
          }
        }
      });
      const pc = await actor.getTokenDocument({ x: 200, y: 200, actorLink: true });
      const monster = await creature.getTokenDocument({ x: 300, y: 200, actorLink: false });
      const scene = await Scene.create({
        name: `Harvest test ${suffix}`,
        tokenVision: false,
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
        tokens: [pc.toObject(), monster.toObject(), { ...monster.toObject(), _id: null, x: 450 }]
      });
      await player.update({ character: actor.id });
      const [first, second] = scene.tokens.filter((t) => t.actorId === creature.id);
      return {
        actor: actor.id,
        creature: creature.id,
        scene: scene.id,
        first: first.id,
        second: second.id,
        kit: kit.id,
        goods: goods.id,
        goodsName: goods.name,
        gland: gland.id,
        previousCharacter
      };
    },
    MODULE_ID,
    PLAYER_NAME
  );
}

async function useActivity(player, fixture, activity, token) {
  await player.bringToFront();
  await player.evaluate(
    (f, action, target) => {
      canvas.tokens.get(target).setTarget(true, { releaseOthers: true });
      void game.actors.get(f.actor).items.get(f.kit).system.activities.get(action).use();
    },
    fixture,
    activity,
    token
  );
  await player.waitForSelector(rollPrompt, { visible: true, timeout: 15000 });
  await player.click(rollPrompt);
  await player.waitForSelector(rollPrompt, { hidden: true, timeout: 8000 });
}

const inventory = (gm, f) =>
  gm.evaluate((f) => {
    const actor = game.actors.get(f.actor);
    const name = game.items.get(f.goods).name;
    return {
      spent: actor.items.get(f.kit).system.uses.spent,
      awards: actor.items.filter((i) => i.name === name).map((i) => [i.system.quantity, i.system.description.value]),
      gland: actor.items.some((i) => i.name === game.items.get(f.gland).name)
    };
  }, f);

await run(async () => {
  const gm = await joinGamemaster("en");
  const f = await setup(gm);
  const player = await join(PLAYER_NAME, "", "de");
  const notices = [];
  for (const page of [gm, player]) {
    page.on("console", (msg) => {
      if (["warn", "error"].includes(msg.type())) notices.push(msg.text());
    });
  }
  try {
    for (const page of [gm, player]) {
      await page.evaluate((id) => game.scenes.get(id).view(), f.scene);
      await waitFor(
        page,
        (id) => canvas.ready && canvas.scene.id === id && canvas.tokens.placeables.length === 3,
        f.scene
      );
    }

    await check("a successful appraisal on the kit whispers the table to its user", async () => {
      await useActivity(player, f, "AppraiseCreature", f.first);
      await waitFor(
        player,
        (name) =>
          game.messages.some(
            (message) =>
              message.whisper.includes(game.user.id) &&
              message.content.includes(name) &&
              message.content.includes("A bitter sap stings.")
          ),
        f.goodsName
      );
      const { spent, awards } = await inventory(gm, f);
      assert(spent === 0 && awards.length === 0, "appraising changed the kit or inventory");
    });

    await check("cancelling the GM review preserves the corpse, charges and inventory", async () => {
      await useActivity(player, f, "CheckKitSupplies", f.first);
      await gm.bringToFront();
      await gm.waitForSelector(review, { visible: true });
      await gm.select(`${review} [name=condition]`, "brutal");
      await waitFor(gm, (selector) => document.querySelector(selector)?.textContent === "7", `${review} .harvest-dc`);
      await gm.locator(`${review} [name=ruined][value=scales]`).click();
      await waitFor(gm, (selector) => !!document.querySelector(selector), `${review} tr[data-outcome=ruined]`);
      await gm.waitForSelector(`${review} [data-action=cancel]`, { visible: true, timeout: 15000 });
      await gm.click(`${review} [data-action=cancel]`);
      await gm.waitForSelector(review, { hidden: true });
      const state = await inventory(gm, f);
      assert(state.spent === 0 && state.awards.length === 0 && !state.gland, "cancel awarded loot or spent a charge");
    });

    await check("confirming the GM preview awards the world item and triggers the missed danger", async () => {
      await gm.evaluate((f) => game.items.get(f.goods).update({ name: `${f.goodsName} (unavailable)` }), f);
      await player.bringToFront();
      const request = () =>
        player.evaluate(
          (fixture, moduleId) =>
            game.modules.get(moduleId).api.harvesting.request("harvest", game.actors.get(fixture.actor)),
          f,
          MODULE_ID
        );
      const firstAttempt = request();
      await player.waitForSelector(rollPrompt, { visible: true });
      await player.click(rollPrompt);
      await gm.bringToFront();
      await gm.waitForSelector(review, { visible: true });
      assert((await gm.$eval(review, (el) => el.textContent)).includes("Test gland"), "no danger in preview");
      await waitFor(
        gm,
        (selector) => document.querySelector(selector)?.disabled === true,
        `${review} [data-action=confirm]`
      );
      await gm.evaluate((f) => game.items.get(f.goods).update({ name: f.goodsName }), f);
      await waitFor(
        gm,
        (selector) => document.querySelector(selector)?.disabled === false,
        `${review} [data-action=confirm]`
      );
      await gm.evaluate((m) => {
        const hook = Hooks.on("preCreateChatMessage", (message) => {
          if (message.getFlag(m, "harvestCard")?.type !== "summary") return;
          Hooks.off("preCreateChatMessage", hook);
          return false;
        });
      }, MODULE_ID);
      await gm.locator(`${review} [data-action=confirm]`).click();
      assert((await firstAttempt) === false, "a refused result card reported success");
      const partial = await inventory(gm, f);
      assert(
        partial.awards.length === 1 && partial.spent === 1,
        "the test did not interrupt the handoff after the charge and loot"
      );
      assert((await request()) === true, "retry failed to finish the approved handoff");
      await waitFor(gm, (f) => game.actors.get(f.actor).items.get(f.kit).system.uses.spent === 1, f);
      await waitFor(gm, (f) => game.actors.get(f.actor).items.some((i) => i.name === game.items.get(f.goods).name), f);
      const state = await inventory(gm, f);
      assert(
        state.awards.length === 1 && state.awards[0][0] === 3 && state.awards[0][1].includes("polished silver scale"),
        "wrong quantity or source item"
      );
      assert(!state.gland, "a failed danger was still awarded");
      await player.waitForSelector(".message-content button.harvest-save", { visible: true });
      await waitFor(
        gm,
        (name) => game.messages.some((message) => !message.whisper.length && message.content.includes(name)),
        f.goodsName
      );
    });

    await check("a harvested token cannot give rewards twice, and the next token remains available", async () => {
      const result = await player.evaluate(
        async (f, m) => {
          canvas.tokens.get(f.first).setTarget(true, { releaseOthers: true });
          return await game.modules.get(m).api.harvesting.request("harvest", game.actors.get(f.actor));
        },
        f,
        MODULE_ID
      );
      assert(result === false, "spent corpse accepted");
      await useActivity(player, f, "CheckKitSupplies", f.second);
      await gm.waitForSelector(`${review} [data-action=cancel]`, { visible: true, timeout: 15000 });
      await gm.click(`${review} [data-action=cancel]`);
      const state = await inventory(gm, f);
      assert(state.spent === 1 && state.awards.length === 1, "second use duplicated the loot or cost");
    });

    await check("a proficient character can use an empty kit without spending another charge", async () => {
      await gm.evaluate((f) => game.actors.get(f.actor).items.get(f.kit).update({ "system.uses.spent": 10 }), f);
      await waitFor(player, (f) => game.actors.get(f.actor).items.get(f.kit).system.uses.spent === 10, f);
      await useActivity(player, f, "CheckKitSupplies", f.second);
      await gm.waitForSelector(`${review} [data-action=confirm]`, { visible: true, timeout: 15000 });
      await gm.click(`${review} [data-action=confirm]`);
      await waitFor(
        gm,
        (f) =>
          game.actors
            .get(f.actor)
            .items.filter((i) => i.name === f.goodsName)
            .reduce((sum, i) => sum + i.system.quantity, 0) === 6,
        f
      );
      const state = await inventory(gm, f);
      assert(state.spent === 10 && !state.gland, "kitless harvesting consumed a charge or awarded the gland");
    });

    await check(
      "two confirmations compete for one remaining charge, and the other corpse can be harvested after a refill",
      async () => {
        const result = await gm.evaluate(
          async (f, m) => {
            const { awardPlan, recordAward, finishAward, pendingAward } = await import(
              `/modules/${m}/scripts/harvesting/award.mjs`
            );
            const harvester = game.actors.get(f.actor);
            const kit = harvester.items.get(f.kit);
            await kit.update({ "system.uses.spent": 9 });
            const creature = game.actors.get(f.creature);
            const models = await Promise.all(
              [500, 650].map((x) => creature.getTokenDocument({ x, y: 200, actorLink: false }))
            );
            const tokens = await game.scenes.get(f.scene).createEmbeddedDocuments(
              "Token",
              models.map((model) => model.toObject())
            );
            const row = { outcome: "gained", component: creature.getFlag(m, "harvest").components[0] };
            const approve = async (token) => {
              const plan = awardPlan(harvester, token, kit, [row], 15);
              const receipt = await recordAward(token, plan);
              await finishAward(token, harvester, receipt);
            };
            const quantity = () =>
              harvester.items.filter((i) => i.name === f.goodsName).reduce((sum, i) => sum + i.system.quantity, 0);
            const initial = quantity();
            const attempts = await Promise.allSettled(tokens.map(approve));
            const loser = tokens[attempts.findIndex((a) => a.status === "rejected")];
            const first = {
              winners: attempts.filter((a) => a.status === "fulfilled").length,
              spent: kit.system.uses.spent,
              gained: quantity() - initial,
              harvested: tokens.filter((t) => t.getFlag(m, "harvested")).length,
              pending: loser && Boolean(pendingAward(loser, harvester))
            };
            if (!loser || first.winners !== 1) return { first };
            await kit.update({ "system.uses.spent": 0 });
            await approve(loser);
            return {
              first,
              refilled:
                kit.system.uses.spent === 1 &&
                quantity() === initial + 6 &&
                tokens.every((t) => t.getFlag(m, "harvested"))
            };
          },
          f,
          MODULE_ID
        );
        const { first } = result;
        assert(
          first.winners === 1 && first.spent === 10 && first.gained === 3 && first.harvested === 1 && !first.pending,
          JSON.stringify(first)
        );
        assert(result.refilled === true, "the losing corpse could not be harvested after a refill");
      }
    );
  } catch (error) {
    for (const page of [gm, player])
      console.log(
        await page.evaluate(() => ({
          dialogs: Array.from(document.querySelectorAll("dialog[open]")).map((el) =>
            el.textContent.trim().slice(0, 400)
          ),
          notifications: document.querySelector("#notifications")?.textContent,
          targets: [...game.user.targets].map((t) => t.name)
        }))
      );
    console.log(notices.slice(-15));
    throw error;
  } finally {
    await gm.evaluate(
      async (f, name) => {
        await game.users.getName(name).update({ character: f.previousCharacter });
        await game.scenes.active?.view();
        await game.scenes.get(f.scene)?.delete();
        await Actor.deleteDocuments([f.actor, f.creature]);
        await Item.deleteDocuments([f.goods, f.gland]);
      },
      f,
      PLAYER_NAME
    );
  }
});
