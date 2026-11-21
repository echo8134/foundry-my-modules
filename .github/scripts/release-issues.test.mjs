import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { reconcileReleaseIssues } from "./release-issues.mjs";

const repo = "example/table";
const tag = "v0.10.0";
const url = `https://github.com/${repo}/releases/tag/${tag}`;
const bot = { login: "github-actions[bot]" };
const metadata = "<!-- table-tools-release-issues-v1: [5,9,5] -->";
const marker = `<!-- table-tools-released: ${tag} -->`;

test("retrying an interrupted release posts one bot link per issue across comment pages", () => {
  const comments = {
    5: Array.from({ length: 100 }, (_, id) => ({ id, body: marker, user: { login: "reader" } })),
    9: []
  };
  let interrupt = true;
  function api(path, ...args) {
    if (path === `repos/${repo}/releases/tags/${tag}`) {
      return JSON.stringify({ html_url: url, author: bot, draft: false, body: `Notes\r\n\r\n${metadata}\r\n` });
    }
    const [, issue] = /^repos\/example\/table\/issues\/(5|9)\/comments(?:\?per_page=100)?$/.exec(path);
    const records = comments[issue];
    if (args.includes("POST")) {
      const body = args[args.indexOf("-f") + 1].slice("body=".length);
      records.push({ user: bot, body, id: records.length + 1 });
      if (interrupt) {
        interrupt = false;
        throw new Error("Connection lost after GitHub stored the comment");
      }
      return "";
    }
    const pages = args.includes("--paginate") ? records : records.slice(0, 100);
    return execFileSync("jq", ["-r", args[args.indexOf("--jq") + 1]], {
      encoding: "utf8",
      input: JSON.stringify(pages)
    }).trimEnd();
  }
  assert.throws(() => reconcileReleaseIssues(repo, tag, api), /Connection lost/);
  reconcileReleaseIssues(repo, tag, api);
  reconcileReleaseIssues(repo, tag, api);
  for (const records of Object.values(comments)) {
    const posted = records.filter((comment) => comment.user === bot);
    assert.equal(posted.length, 1);
    assert.ok(posted[0].body.includes(`[${tag}](${url})`));
  }
});

test("only a published workflow release with an issue footer can send comments", () => {
  for (const release of [
    { body: "Historic release linking #5" },
    { body: `${metadata}\n\n[Full changelog](https://example.com)` },
    { body: metadata, draft: true },
    { body: metadata, prerelease: true },
    { body: metadata, author: { login: "someone-else" } },
    { body: "<!-- table-tools-release-issues-v1: [] -->" }
  ]) {
    reconcileReleaseIssues(repo, tag, (path) => {
      assert.equal(path, `repos/${repo}/releases/tags/${tag}`);
      return JSON.stringify({ author: bot, ...release });
    });
  }
});

test("invalid issue numbers and invalid release tags fail before commenting", () => {
  for (const invalid of [[5, -1], [0], ["other/repo#7"], ["5"], {}]) {
    assert.throws(
      () =>
        reconcileReleaseIssues(repo, tag, (path) => {
          assert.equal(path, `repos/${repo}/releases/tags/${tag}`);
          return JSON.stringify({
            author: bot,
            body: `<!-- table-tools-release-issues-v1: ${JSON.stringify(invalid)} -->`
          });
        }),
      /Invalid release issue numbers/
    );
  }
  assert.throws(() => reconcileReleaseIssues(repo, "v1/../../foo", assert.fail), /Invalid release tag/);
});
