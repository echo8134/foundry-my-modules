import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function parseReleaseNotes(body) {
  const lines = (body ?? "")
    .replaceAll(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replaceAll(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*\r?$/gm, "[code block]")
    .split(/\r?\n/);
  const heading = lines.findIndex((line) => /^##[ \t]+Release notes[ \t]*$/i.test(line));
  if (heading === -1) return null;

  const entries = [];
  for (const line of lines.slice(heading + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (!line.trim()) continue;
    const bullet = /^-\s+(.+)$/.exec(line.trimEnd());
    if (!bullet) return null;
    entries.push(bullet[1].trim());
  }
  if (!entries.length) return null;
  if (entries.some((entry) => /^N\/A$/i.test(entry))) return entries.length === 1 ? [] : null;
  return entries;
}

function run(command, ...args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trimEnd();
}

function releaseNotes() {
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_SHA: sha,
    GITHUB_SERVER_URL: server = "https://github.com"
  } = process.env;
  const url = `${server}/${repository}`;
  // Start at the parent so a retry skips a tag already created for this release.
  const [, parent] = run("git", "rev-list", "--parents", "-n1", sha).split(" ");
  const previous =
    parent &&
    run("git", "describe", "--always", "--tags", "--abbrev=0", "--first-parent", "--match", "v[0-9]*", parent);
  const hasPrevious = previous?.startsWith("v");
  const range = hasPrevious ? `${previous}..${sha}` : sha;
  const commits = new Set(run("git", "rev-list", "--reverse", "--topo-order", range).split("\n"));
  const seen = new Set();
  const entries = [];
  for (const commit of commits) {
    const pages = JSON.parse(run("gh", "api", "--paginate", "--slurp", `repos/${repository}/commits/${commit}/pulls`));
    const merged = pages
      .flat()
      .filter((pull) => pull.merged_at && pull.base.ref === "main" && commits.has(pull.merge_commit_sha));
    if (merged.length === 0) {
      const notes = parseReleaseNotes(run("git", "show", "-s", "--format=%B", commit));
      for (const note of notes ?? []) entries.push(`- ${note} ([${commit.slice(0, 7)}](${url}/commit/${commit}))`);
    }
    for (const pull of merged) {
      if (seen.has(pull.number)) continue;
      seen.add(pull.number);
      for (const note of parseReleaseNotes(pull.body) ?? [])
        entries.push(`- ${note} ([#${pull.number}](${url}/pull/${pull.number}))`);
    }
  }

  const changes = hasPrevious ? `${url}/compare/${previous}...${sha}` : `${url}/commits/${sha}`;
  if (entries.length) console.log(`## What's changed\n\n${entries.join("\n")}\n`);
  console.log(`[Full changelog](${changes})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--check-pr") {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (parseReleaseNotes(event.pull_request.body) === null) {
      console.error(
        'Add a "## Release notes" section with one "- " bullet per change, or only "- N/A" for internal work.'
      );
      process.exitCode = 1;
    }
  } else {
    releaseNotes();
  }
}
