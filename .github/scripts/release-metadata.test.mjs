import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./release.sh", import.meta.url));
const repo = "example/table";
const url = `https://github.com/${repo}`;
const issue = (number, nameWithOwner = repo) => ({ number, repository: { nameWithOwner } });
const manifest = JSON.stringify(
  { feature: false, id: "table", version: "0.9.1", styles: ["table.css"], title: "Table" },
  null,
  2
);

function history(t) {
  const cwd = mkdtempSync(join(tmpdir(), "table-release-metadata-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = {
    PATH: `${cwd}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GITHUB_REPOSITORY: repo,
    PREVIOUS_RELEASE_TAG: "v0.9.1"
  };
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "release@example.invalid");
  git("config", "user.name", "Release Test");
  writeFileSync(join(cwd, "module.json"), manifest);
  git("add", "module.json");
  git("commit", "-q", "-m", "Last release");
  git("tag", env.PREVIOUS_RELEASE_TAG);

  const responses = {};
  writeFileSync(
    join(cwd, "gh"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const key = args.find(arg => arg.startsWith("repos/") || arg.startsWith("number="));
const response = JSON.parse(process.env.GH_RESPONSES)[key];
if (response === undefined) { console.error("Missing GitHub response for", key); process.exit(1); }
const pages = args.includes("--paginate") ? response : response.slice(0, 1);
if (args.includes("--slurp")) console.log(JSON.stringify(pages));
else for (const page of pages) console.log(JSON.stringify(page));
`,
    { mode: 0o755 }
  );

  function pull(number, file, issuePages, { merge = false, note = `Shipped change ${number}.`, contents } = {}) {
    const branch = `pr-${number}`;
    if (merge) git("switch", "-q", "-c", branch);
    writeFileSync(
      join(cwd, file),
      contents ?? (file === "module.json" ? JSON.stringify({ version: "0.9.1", number }) : `${number}\n`)
    );
    git("add", file);
    git("commit", "-q", "-m", `Change ${number}`);
    const head = git("rev-parse", "HEAD");
    if (merge) {
      git("switch", "-q", "main");
      git("merge", "--no-ff", "-q", branch, "-m", `Merge pull request #${number} from example/${branch}`);
    }
    const merged = git("rev-parse", "HEAD");
    const record = {
      number,
      body: `## Release notes\n- ${note}`,
      base: { ref: "main" },
      merged_at: "2026-01-01T00:00:00Z",
      merge_commit_sha: merged
    };
    for (const commit of [head, merged]) responses[`repos/${repo}/commits/${commit}/pulls`] = [[record]];
    responses[`number=${number}`] = issuePages.map((nodes, index) => ({
      data: {
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              nodes,
              pageInfo: { hasNextPage: index + 1 < issuePages.length, endCursor: String(index) }
            }
          }
        }
      }
    }));
    return merged;
  }

  function revert(commit, note) {
    git("revert", "--no-edit", commit);
    if (note) git("commit", "--amend", "-qm", git("log", "-1", "--format=%B"), "-m", `## Release notes\n- ${note}`);
    const head = git("rev-parse", "HEAD");
    responses[`repos/${repo}/commits/${head}/pulls`] = [[]];
    return head;
  }

  function labels(number, ...pages) {
    responses[`repos/${repo}/issues/${number}/labels?per_page=100`] = pages.map((names) =>
      names.map((name) => ({ name }))
    );
  }
  function prepare(previous = env.PREVIOUS_RELEASE_TAG) {
    return spawnSync("bash", [script, "plan", previous, "HEAD", "notes.md"], {
      cwd,
      encoding: "utf8",
      env: { ...env, GH_RESPONSES: JSON.stringify(responses) }
    });
  }
  function readRelease(previous) {
    const result = prepare(previous);
    assert.equal(result.status, 0, result.stderr);
    const notes = readFileSync(join(cwd, "notes.md"), "utf8");
    const marker = /^<!-- table-tools-release-issues-v1: (\[.*\]) -->$/.exec(notes.trimEnd().split("\n").at(-1));
    assert.ok(marker, "the last line records which issues to notify after publication");
    return { tag: result.stdout.trim(), notes, issues: JSON.parse(marker[1]).sort((a, b) => a - b) };
  }
  return { git, pull, revert, labels, prepare, readRelease };
}

test("a labeled documentation PR and a closing issue in another repository leave a runtime fix at patch", (t) => {
  const { pull, labels, readRelease } = history(t);
  pull(10, "README.md", [[issue(1)]], { merge: true });
  labels(1, ["release:minor"]);
  pull(11, "module.json", [[issue(2), issue(3, "example/other")]]);
  labels(2, ["bug"]);
  const { tag, notes, issues } = readRelease();
  assert.equal(tag, "v0.9.2");
  assert.deepEqual(issues, [2]);
  assert.ok(notes.includes(`${url}/issues/2)`));
  assert.doesNotMatch(notes, /\/issues\/[13]\b/);
});

test("one marked issue across merged PRs raises the minor and links each shipped issue, including N/A entries", (t) => {
  const { pull, labels, readRelease } = history(t);
  pull(20, "module.json", [[issue(4)], [issue(5)]], { merge: true });
  pull(21, "module.json", [[issue(4), issue(6)]], { note: "N/A" });
  labels(4, []);
  labels(5, ["enhancement"], ["release:minor"]);
  labels(6, ["bug"]);
  const { tag, notes, issues } = readRelease();
  assert.equal(tag, "v0.10.0");
  assert.deepEqual(issues, [4, 5, 6]);
  for (const number of issues) assert.ok(notes.includes(`${url}/issues/${number})`));
  assert.ok(notes.includes("Shipped change 20."));
  assert.ok(notes.includes(`${url}/pull/20)`));
});

test("an unavailable issue label lookup stops release preparation", (t) => {
  const { pull, prepare } = history(t);
  pull(30, "module.json", [[issue(7)]]);
  const result = prepare();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing GitHub response/);
});

test("a runtime PR without closing issues keeps its release note and produces an empty notification list", (t) => {
  const { pull, readRelease } = history(t);
  pull(31, "module.json", [[]]);
  const { tag, notes, issues } = readRelease();
  assert.equal(tag, "v0.9.2");
  assert.deepEqual(issues, []);
  assert.ok(notes.includes("Shipped change 31."));
});

test("a reverted feature is excluded from the release until a revert restores it", (t) => {
  const { pull, revert, labels, readRelease } = history(t);
  const feature = pull(40, "module.json", [[issue(8)]], { contents: manifest.replace("false", "true") });
  labels(8, ["release:minor"]);
  const rollback = revert(feature);
  pull(41, "module.json", [[issue(9)]], { contents: manifest.replace('"Table"', '"Fixed title"') });
  labels(9, ["bug"]);

  const patch = readRelease();
  assert.equal(patch.tag, "v0.9.2");
  assert.deepEqual(patch.issues, [9]);
  assert.doesNotMatch(patch.notes, /Shipped change 40|\/issues\/8\b/);
  assert.ok(patch.notes.includes("Shipped change 41."));

  revert(rollback);
  const restored = readRelease();
  assert.equal(restored.tag, "v0.10.0");
  assert.deepEqual(restored.issues, [8, 9]);
  assert.ok(restored.notes.includes("Shipped change 40."));
});

test("reverting a previously released feature ships a patch with the rollback note", (t) => {
  const { git, pull, revert, labels, readRelease } = history(t);
  const feature = pull(42, "module.json", [[issue(10)]], { contents: manifest.replace("false", "true") });
  labels(10, ["release:minor"]);
  git("tag", "v0.10.0", feature);
  revert(feature, "Disabled the experimental setting.");

  const rollback = readRelease("v0.10.0");
  assert.equal(rollback.tag, "v0.10.1");
  assert.deepEqual(rollback.issues, []);
  assert.ok(rollback.notes.includes("Disabled the experimental setting."));
});
