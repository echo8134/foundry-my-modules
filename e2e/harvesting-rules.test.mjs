import assert from "node:assert/strict";
import { test } from "node:test";
import { MODULE_ID } from "../scripts/constants.mjs";
import {
  finishAward,
  harvested,
  harvestRound,
  openHarvestRound,
  pendingAward,
  recordAward
} from "../scripts/harvesting/award.mjs";
import { previewHarvest } from "../scripts/harvesting/rules.mjs";

const components = [
  { id: "hide", name: "Hide", dc: 10 },
  { id: "gland", name: "Gland", dc: 16, danger: { text: "Venom" } }
];
const table = { components };

function outcomes(total, options = {}, withKit = true) {
  return previewHarvest(table, total, options, withKit).map((row) => row.outcome);
}

test("a kit protects a harvester missing by up to five, an empty kit gives no buffer", () => {
  assert.deepEqual(outcomes(16), ["gained", "gained"]);
  assert.deepEqual(outcomes(11), ["gained", "lost"]);
  assert.deepEqual(outcomes(10), ["gained", "danger"]);
  assert.deepEqual(outcomes(15, {}, false), ["gained", "danger"]);
  assert.deepEqual(outcomes(10, { passed: ["gland"] }), ["gained", "danger"]);
});

test("the cause of death adjusts each component DC before gain and danger are calculated", () => {
  assert.deepEqual(outcomes(11, { condition: "clean" }), ["gained", "gained"]);
  assert.deepEqual(outcomes(14, { condition: "brutal" }), ["lost", "danger"]);
  assert.deepEqual(outcomes(30, { ruined: ["hide"], passed: ["gland"] }), ["ruined", "passed"]);
});

test("mutually exclusive parts yield one usable choice", () => {
  const eyes = {
    components: [
      { id: "eyes", dc: 10, exclusiveGroup: "eyes" },
      { id: "intact-eyes", dc: 18, exclusiveGroup: "eyes" }
    ]
  };
  const gained = (total, options) =>
    previewHarvest(eyes, total, options, true)
      .filter((row) => row.outcome === "gained")
      .map((row) => row.component.id);
  assert.deepEqual(gained(20, {}), ["intact-eyes"]);
  assert.deepEqual(gained(10, {}), ["eyes"]);
  assert.deepEqual(gained(20, { passed: ["intact-eyes"] }), ["eyes"]);
});

test("a delayed duplicate reset and an old receipt cannot reopen or award a later harvest", async (context) => {
  globalThis.game = { user: { isGM: true, isActiveGM: true }, i18n: { localize: (key) => key } };
  context.after(() => {
    delete globalThis.game;
  });
  const flags = { harvested: true }; // A completed legacy token can have no surviving receipt.
  const writes = [];
  const table = {
    appraise: { skill: "nat", dc: 10 },
    components: [{ id: "hide", name: "Hide", item: "Hide", dc: 10, quantity: 1 }]
  };
  const token = {
    uuid: "Scene.test.Token.corpse",
    combatant: { isDefeated: true },
    actor: { effects: new Map(), getFlag: () => table },
    getFlag: (_scope, key) => key.split(".").reduce((obj, part) => obj?.[part], flags),
    update: (changes) => writes.push(changes)
  };
  const reservation = { token: token.uuid, receipt: "legacy" };
  const kit = { getFlag: () => undefined, effects: new Map([["HarvestKitCharge", { getFlag: () => reservation }]]) };
  const harvester = { uuid: "Actor.old", items: [kit] };
  const old = { token: token.uuid, actor: harvester.uuid };

  // Both GM tabs saw the same completed corpse before receiving either update.
  openHarvestRound(token, 0);
  openHarvestRound(token, 0);
  assert.deepEqual(writes, Array(2).fill({ [`flags.${MODULE_ID}.harvestRounds.r1.opened`]: true }));
  flags.harvestRounds = { r1: { opened: true } };
  assert.equal(harvestRound(token), 1);
  assert.equal(harvested(token), false);
  assert.equal(openHarvestRound(token, 1), false);
  assert.equal(pendingAward(token, harvester), undefined);
  await assert.rejects(recordAward(token, old), /Harvest.changed/);
  await assert.rejects(finishAward(token, harvester, { plan: old }), /Harvest.changed/);

  const current = { ...old, round: 1 };
  const receipt = { author: { isGM: true }, getFlag: () => current };
  game.messages = new Map([["current", receipt]]);
  Object.assign(reservation, { round: 1, receipt: "current" });
  assert.deepEqual(pendingAward(token, harvester), { receipt, plan: current });

  flags.harvestRounds.r1.harvested = true;
  assert.equal(openHarvestRound(token, 0), false);
  assert.equal(harvested(token), true);
  game.user.isGM = false;
  assert.equal(openHarvestRound(token, 1), false);
  assert.equal(writes.length, 2);
});
