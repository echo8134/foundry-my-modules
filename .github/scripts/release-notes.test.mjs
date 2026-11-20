import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseReleaseNotes } from "./release-notes.mjs";

const template = readFileSync(new URL("../pull_request_template.md", import.meta.url), "utf8");

test("the unfilled PR template has no publishable notes", () => {
  assert.equal(parseReleaseNotes(template), null);
});

test("only bullets from the release section appear in the release", () => {
  const body = [template, "- Players can pin quests.", "- GMs can move pins.", "## Follow-up", "- Internal task"];
  assert.deepEqual(parseReleaseNotes(body.join("\n").replaceAll("\n", "\r\n")), [
    "Players can pin quests.",
    "GMs can move pins."
  ]);
});

test("internal changes require an explicit N/A on its own", () => {
  assert.deepEqual(parseReleaseNotes(`${template}\n- N/A`), []);
  assert.equal(parseReleaseNotes(`${template}\n- N/A\n- Players can pin quests.`), null);
  assert.equal(parseReleaseNotes(`${template}\nDescribe the change here.`), null);
});
