// Builds name tables and figures like Rybalka's villagers and guards, then checks the names tokens get on creation.
import { assert, check, joinGamemaster, MODULE_ID, run, waitFor } from "./harness.mjs";

const KLAVEK = ["Igor", "Pavel", "Bogdan", "Miroslav", "Radek", "Stanislav", "Vasil", "Zoran"];
const VIKMORDERE = ["Aslaug", "Bersi", "Ragna", "Ulf", "Hjalti", "Sigrun", "Torvald", "Eydis"];

async function buildWorld(gm) {
  return gm.evaluate(
    async (moduleId, klavek, vik) => {
      for (const t of game.tables.filter((t) => t.name.startsWith("MM "))) await t.delete();
      for (const a of game.actors.filter((a) => a.name.startsWith("MM "))) await a.delete();
      for (const s of game.scenes.filter((s) => s.name === "My Modules Names Test")) await s.delete();
      const table = (name, names) =>
        RollTable.create({
          name,
          formula: `1d${names.length}`,
          results: names.map((n, i) => ({ type: "text", name: n, range: [i + 1, i + 1], weight: 1 }))
        });
      const k = await table("MM Klavek", klavek);
      const v = await table("MM Vikmordere", vik);
      const actor = (name, tables, linked = false) =>
        Actor.create({
          name,
          type: "npc",
          prototypeToken: { name, actorLink: linked },
          flags: tables ? { [moduleId]: { randomName: { tables } } } : {}
        });
      const villager = await actor("MM Dorfbewohner", [k.uuid]);
      const guard = await actor("MM Wache", [k.uuid, v.uuid]);
      const npc = await actor("MM Juriendor", [k.uuid], true);
      const plain = await actor("MM Huhn", null);
      const scene = await Scene.create({ name: "My Modules Names Test", width: 2000, height: 1000, padding: 0 });
      await scene.activate();
      return { sceneId: scene.id, villager: villager.id, guard: guard.id, npc: npc.id, plain: plain.id };
    },
    MODULE_ID,
    KLAVEK,
    VIKMORDERE
  );
}

const createTokens = (gm, sceneId, actorId, count, extra = {}) =>
  gm.evaluate(
    async (sid, aid, n, more) => {
      const scene = game.scenes.get(sid);
      const actor = game.actors.get(aid);
      const data = await Promise.all(
        Array.from({ length: n }, async (_, i) => ({
          ...(await actor.getTokenDocument({ x: 100 * i, y: 100 })).toObject(),
          ...more
        }))
      );
      const created = await scene.createEmbeddedDocuments("Token", data);
      return created.map((t) => t.name);
    },
    sceneId,
    actorId,
    count,
    extra
  );

const unique = (names) => new Set(names).size === names.length;

await run(async () => {
  const gm = await joinGamemaster();
  await gm.evaluate((m) => game.settings.set(m, "tokenNameFormat", "{name}"), MODULE_ID);
  const ids = await buildWorld(gm);
  await waitFor(gm, (id) => canvas.scene?.id === id, ids.sceneId);

  await check("five villagers created together get five different Klavek names", async () => {
    const names = await createTokens(gm, ids.sceneId, ids.villager, 5);
    assert(unique(names) && names.every((n) => KLAVEK.includes(n)), `names: ${names}`);
  });

  await check("villagers dropped one by one avoid every name already on the scene", async () => {
    const names = [];
    for (let i = 0; i < 3; i++) names.push(...(await createTokens(gm, ids.sceneId, ids.villager, 1)));
    const all = await gm.evaluate((id) => game.scenes.get(id).tokens.map((t) => t.name), ids.sceneId);
    assert(unique(all) && all.length === 8, `scene names: ${all}`);
  });

  await check("a guard draws from both cultures", async () => {
    const names = await createTokens(gm, ids.sceneId, ids.guard, 12);
    assert(
      names.some((n) => KLAVEK.includes(n)),
      `no Klavek name in ${names}`
    );
    assert(
      names.some((n) => VIKMORDERE.includes(n)),
      `no Vikmordere name in ${names}`
    );
  });

  await check("a linked NPC, an actor without tables and an explicit name keep their names", async () => {
    const [npc] = await createTokens(gm, ids.sceneId, ids.npc, 1);
    const [plain] = await createTokens(gm, ids.sceneId, ids.plain, 1);
    const [named] = await createTokens(gm, ids.sceneId, ids.villager, 1, { name: "Der Bürgermeister" });
    assert(npc === "MM Juriendor", `linked NPC is ${npc}`);
    assert(plain === "MM Huhn", `plain actor is ${plain}`);
    assert(named === "Der Bürgermeister", `explicit name is ${named}`);
  });

  await check("the format setting can add the figure's role", async () => {
    await gm.evaluate((m) => game.settings.set(m, "tokenNameFormat", "{name} ({actor})"), MODULE_ID);
    const [name] = await createTokens(gm, ids.sceneId, ids.villager, 1);
    await gm.evaluate((m) => game.settings.set(m, "tokenNameFormat", "{name}"), MODULE_ID);
    assert(/^\S+ \(MM Dorfbewohner\)$/.test(name), `formatted name is ${name}`);
  });

  await check("the API rolls a name for an actor", async () => {
    const name = await gm.evaluate(
      (m, id) => game.modules.get(m).api.rollName(game.actors.get(id)),
      MODULE_ID,
      ids.villager
    );
    assert(KLAVEK.includes(name), `rolled ${name}`);
  });

  await check("the token HUD rolls a new name", async () => {
    const [name] = await createTokens(gm, ids.sceneId, ids.guard, 1);
    const tokenId = await gm.evaluate(
      (sid, n) => game.scenes.get(sid).tokens.find((t) => t.name === n).id,
      ids.sceneId,
      name
    );
    await gm.evaluate(async (id) => {
      const token = canvas.tokens.get(id);
      token.control();
      await canvas.hud.token.bind(token);
    }, tokenId);
    await waitFor(gm, () => document.querySelector("#token-hud .my-reroll-name"));
    await gm.evaluate(() =>
      document.querySelector("#token-hud .my-reroll-name").dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    await waitFor(gm, (sid, id, old) => game.scenes.get(sid).tokens.get(id).name !== old, ids.sceneId, tokenId, name);
  });
});
