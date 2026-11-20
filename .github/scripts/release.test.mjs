import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./release.sh", import.meta.url));
const releases = "https://github.com/example/table/releases";

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "foundry-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "example/table"
  };
  const run = (command, ...args) => execFileSync(command, args, { cwd: root, env, encoding: "utf8" });
  const git = (...args) => run("git", ...args).trim();
  const release = (...args) => run("bash", script, ...args).trim();
  function write(path, contents) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  function setVersion(version) {
    write("module.json", JSON.stringify({ id: "table", version, manifest: `${releases}/latest/download/module.json` }));
  }
  function commit() {
    git("add", ".");
    git("commit", "--quiet", "-m", "Update fixture");
    return git("rev-parse", "HEAD");
  }
  git("init", "--quiet");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release@example.invalid");
  for (const path of ["styles/table.css", "lang/en.json", "assets/sounds/pause.ogg", "LICENSE", "README.md"]) {
    write(path, path);
  }
  write("scripts/main.mjs", "export const enabled = true;");
  setVersion("0.7.0");
  return { root, release, git, write, setVersion, commit };
}

test("module changes advance the published patch, retries and documentation skip, and an explicit bump takes priority", (t) => {
  const { release, git, write, setVersion, commit } = repository(t);
  const initial = commit();
  assert.equal(release("plan", "", initial), "v0.7.0");
  git("tag", "v0.7.9", initial);

  write("scripts/main.mjs", "export const enabled = false;");
  const changed = commit();
  assert.equal(release("plan", "v0.7.9", changed), "v0.7.10");
  git("tag", "v0.7.10", changed);
  assert.equal(release("plan", "v0.7.10", changed), "");

  write("README.md", "Updated installation instructions");
  assert.equal(release("plan", "v0.7.10", commit()), "");
  setVersion("0.8.0");
  const minor = commit();
  assert.equal(release("plan", "v0.7.10", minor), "v0.8.0");
  git("tag", "v0.8.0", minor);
  write("assets/sounds/pause.ogg", "Updated sound");
  assert.equal(release("plan", "v0.8.0", commit()), "v0.8.1");
});

test("the Foundry manifest and ZIP use the same versioned download and files from the requested revision", (t) => {
  const { root, release, write, commit } = repository(t);
  const revision = commit();
  write("scripts/main.mjs", "throw new Error('unreleased');");
  commit();
  const output = join(root, "output");
  mkdirSync(output);
  release("package", "v0.7.10", revision, output);

  const zip = join(output, "module.zip");
  const fromZip = (file) => execFileSync("unzip", ["-p", zip, file], { encoding: "utf8" });
  const standalone = readFileSync(join(output, "module.json"), "utf8");
  assert.equal(fromZip("module.json"), standalone);
  const manifest = JSON.parse(standalone);
  assert.equal(manifest.version, "0.7.10");
  assert.equal(manifest.download, `${releases}/download/v0.7.10/module.zip`);
  assert.equal(manifest.manifest, `${releases}/latest/download/module.json`);
  assert.equal(fromZip("scripts/main.mjs"), "export const enabled = true;");
  assert.equal(fromZip("assets/sounds/pause.ogg"), "assets/sounds/pause.ogg");
});
