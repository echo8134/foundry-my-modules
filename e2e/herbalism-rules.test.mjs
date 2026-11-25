import assert from "node:assert/strict";
import { test } from "node:test";
import {
  gatherDC,
  gatherMode,
  herbalismEquipment,
  identifyDC,
  isHerbalismKit,
  previewGather,
  validHerbalismTable
} from "../scripts/herbalism/rules.mjs";
import { deferredGather, gatherPlan, plantContext } from "../scripts/herbalism/workflow.mjs";

const herb = {
  id: "sporecap",
  name: "Sporecap",
  item: "Item.sporecapSource01",
  quantity: 2,
  dc: 16,
  danger: { text: "It releases spores.", save: { ability: "con", dc: 13 }, damage: { formula: "1d6", type: "poison" } }
};
const table = { identify: { skill: "nat" }, components: [herb] };

test("plant tables require a supported Identify skill and distinct, complete components", () => {
  assert.equal(validHerbalismTable(table), true);
  assert.equal(validHerbalismTable({ ...table, components: [{ ...herb, charges: "1d4 + 1" }] }), true);
  assert.equal(validHerbalismTable({ ...table, identify: { skill: "med", dc: 20 } }), true);
  assert.equal(validHerbalismTable({ ...table, components: [{ ...herb, danger: undefined }] }), true);

  for (const invalid of [
    null,
    {},
    { ...table, identify: { skill: "arc" } },
    { ...table, identify: { skill: "kit" } },
    { ...table, identify: { skill: "nat", dc: "18" } },
    { ...table, identify: { skill: "nat", dc: -1 } },
    { ...table, components: [] },
    { ...table, components: [herb, herb] },
    { ...table, components: [null] }
  ]) {
    assert.equal(validHerbalismTable(invalid), false);
  }

  for (const changes of [
    { id: " " },
    { name: "" },
    { item: null },
    { quantity: 0 },
    { charges: " " },
    { charges: 4 },
    { quantity: 1.5 },
    { dc: null, rarity: "common" },
    { dc: -1 },
    { dc: 1.5 },
    { dc: undefined, rarity: "unknown" },
    { danger: { text: " " } },
    { danger: { text: "Spores", save: { ability: "sur", dc: 10 } } },
    { danger: { text: "Spores", save: { ability: "con", dc: "10" } } },
    { danger: { text: "Spores", damage: { formula: "1d4" } } }
  ]) {
    assert.equal(validHerbalismTable({ ...table, components: [{ ...herb, ...changes }] }), false);
  }
});

test("Identify uses 15 plus the gatherer's proficiency bonus or the GM's DC", () => {
  assert.equal(identifyDC(table, 2), 17);
  assert.equal(identifyDC(table, 6), 21);
  assert.equal(identifyDC({ ...table, identify: { skill: "med", dc: 19 } }, 6), 19);
});

test("rarity supplies the five default Gather DCs when no explicit DC is set", () => {
  for (const [rarity, dc] of [
    ["common", 12],
    ["uncommon", 15],
    ["rare", 18],
    ["veryRare", 21],
    ["legendary", 24]
  ]) {
    const component = { ...herb, rarity, dc: undefined };
    assert.equal(validHerbalismTable({ ...table, components: [component] }), true);
    assert.equal(gatherDC(component), dc);
    assert.equal(previewGather(component, dc, true).outcome, "gained");
  }
  assert.equal(gatherDC({ ...herb, rarity: "legendary", dc: 29 }), 29);
});

test("Gather uses the margin and kit to distinguish superior, usable, empty, and hazardous results", () => {
  for (const [total, outcome] of [
    [21, "superior"],
    [20, "gained"],
    [16, "gained"],
    [15, "lost"],
    [11, "lost"],
    [10, "danger"]
  ]) {
    assert.deepEqual(previewGather(herb, total, true), { component: herb, dc: 16, outcome });
  }
  assert.deepEqual(previewGather(herb, 15, false), { component: herb, dc: 16, outcome: "danger" });
  assert.equal(previewGather(herb, 16, false).outcome, "gained");
  assert.equal(previewGather(herb, 21, false).outcome, "superior");
  assert.equal(previewGather({ ...herb, danger: undefined }, 10, true).outcome, "danger");
});

function kit(id, charges, { baseItem = "herb", name = "Herbalism Kit", quantity = 1, proficient = 0 } = {}) {
  return { id, name, type: "tool", system: { type: { baseItem }, quantity, uses: { value: charges }, proficient } };
}

test("only charged Herbalism Kits in inventory qualify for Gather", () => {
  const harvesting = kit("harvesting", 10, { baseItem: "harvest" });
  const mislabeled = kit("legacy-harvesting", 10, { baseItem: "" });
  mislabeled.system.activities = new Map([["AppraiseCreature", {}]]);
  const empty = kit("empty", 0);
  const missing = kit("missing", 10, { quantity: 0 });
  const first = kit("first", 2);
  const preferred = kit("preferred", 1, { baseItem: "", name: "Kräuterkunde-Ausrüstung (Herbalism Kit)" });
  const actor = { items: [harvesting, mislabeled, empty, missing, first, preferred], system: { tools: {} } };
  assert.equal(isHerbalismKit(kit("legacy", 1, { baseItem: "", name: "Kräuterkundebesteck" })), true);
  assert.equal(herbalismEquipment(actor).kit, first);
  assert.equal(herbalismEquipment(actor, "empty").kit, first);
  assert.equal(herbalismEquipment(actor, "preferred").kit, preferred);
  assert.equal(herbalismEquipment(actor, "empty").identifyKit, empty);
  assert.equal(herbalismEquipment({ ...actor, items: [harvesting, mislabeled, empty, missing] }).kit, undefined);
});

test("tool proficiency belongs to the character and persists without a charged kit", () => {
  const empty = kit("empty", 0);
  const transferred = kit("transferred", 10, { proficient: 1 });
  const trained = { items: [empty], system: { tools: { herb: { effectValue: 1 } } } };
  const untrained = { items: [transferred], system: { tools: {} } };
  assert.deepEqual(herbalismEquipment(trained), { kit: undefined, identifyKit: empty, proficiency: 1 });
  assert.deepEqual(herbalismEquipment(untrained), { kit: transferred, identifyKit: transferred, proficiency: 0 });
  assert.deepEqual(herbalismEquipment({ ...trained, items: [] }), {
    kit: undefined,
    identifyKit: undefined,
    proficiency: 1
  });
});

test("only trained gatherers with charges gain advantage from Identify", () => {
  for (const [withKit, proficiency, identified, mode] of [
    [true, 1, true, "advantage"],
    [true, 1, false, "ordinary"],
    [true, 0, true, "ordinary"],
    [true, 0.5, true, "ordinary"],
    [false, 1, true, "disadvantage"],
    [false, 0, false, "disadvantage"]
  ]) {
    assert.equal(gatherMode({ withKit, proficiency, identified }), mode);
  }
});

test("an untrained character with no kit or an empty kit can skip Identify and gather with either skill", () => {
  const token = { actor: { getFlag: () => table }, getFlag: () => undefined };
  for (const items of [[], [kit("empty", 0)]]) {
    const actor = { items, system: { skills: {}, tools: {} } };
    for (const method of ["sur", "nat"]) {
      const context = plantContext({ action: "gather", method }, actor, token);
      assert.deepEqual(context.methods, ["sur", "nat"]);
      assert.equal(context.method, method);
      assert.equal(context.mode, "disadvantage");
      assert.equal(context.kit, undefined);
    }
  }
});

test("only the original gatherer can return to a deferred roll, with the original kit and DC", (t) => {
  const original = kit("supplies", 1);
  const actor = { uuid: "Actor.gatherer", items: new Map([[original.id, original]]) };
  const token = { uuid: "Token.patch", getFlag: () => "savedRoll" };
  const attempt = { actor: actor.uuid, token: token.uuid, kit: original.id, table, total: 7 };
  const messages = new Map([["savedRoll", { author: { isGM: true }, getFlag: () => attempt }]]);
  globalThis.game = { messages, i18n: { localize: (k) => k } };
  t.after(() => {
    delete globalThis.game;
  });
  assert.equal(deferredGather("gather", token, actor).attempt.total, 7);
  assert.equal(deferredGather("gather", token, actor).table, table);
  assert.throws(() => deferredGather("identify", token, actor), /gatherStarted/);
  assert.throws(() => deferredGather("gather", token, { uuid: "Actor.other" }), /gatherStarted/);
  original.system.uses.value = 0;
  assert.throws(() => deferredGather("gather", token, actor), /kitChanged/);
  messages.clear();
  assert.throws(() => deferredGather("gather", token, actor), /brokenReceipt/);
});

test("a superior extra portion of a charge-bearing component rolls each specimen independently", async (t) => {
  const totals = [2, 3, 1];
  globalThis.Roll = class {
    async evaluate() {
      return { total: totals.shift() };
    }
  };
  let nextId = 0;
  globalThis.foundry = { utils: { randomID: () => String(nextId++) } };
  const source = { id: "sporecapSource01", system: { uses: { max: "8" } } };
  globalThis.game = { items: new Map([[source.id, source]]) };
  t.after(() => {
    delete globalThis.game;
    delete globalThis.foundry;
    delete globalThis.Roll;
  });
  const current = {
    actor: { getRollData: () => ({}) },
    token: {},
    table: { ...table, components: [{ ...herb, charges: "1d4" }] }
  };
  const plan = await gatherPlan(current, 21, [{ bonus: "portion" }]);
  assert.deepEqual(
    plan.gains.map((g) => [g.quantity, g.charges]),
    [
      [1, 2],
      [1, 3],
      [1, 1]
    ]
  );
  assert.deepEqual(
    plan.cards.at(-1).parts.map((p) => p.charges),
    [2, 3, 1]
  );
  assert.equal(new Set(plan.gains.map((g) => g.id)).size, 3);
  assert.equal(source.system.uses.max, "8");
});
