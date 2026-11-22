import assert from "node:assert/strict";
import { test } from "node:test";
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
