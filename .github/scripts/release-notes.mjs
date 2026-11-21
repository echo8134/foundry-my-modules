import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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

function* commitMessages(...args) {
  const fields = run("git", "log", "-z", "--format=%H%x00%s%x00%b", ...args).split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    yield { sha: fields[i], subject: fields[i + 1], body: fields[i + 2] };
  }
}

function patchId(from, to) {
  return run(
    "bash",
    "-o",
    "pipefail",
    "-c",
    'git diff --no-ext-diff --no-textconv --no-renames --full-index -U0 "$1" "$2" -- | git patch-id --verbatim',
    "patch-id",
    from,
    to
  );
}

function releaseCommits(range) {
  const commits = new Set(run("git", "rev-list", "--reverse", "--topo-order", range).split("\n").filter(Boolean));
  for (const { sha, subject, body } of commitMessages("--topo-order", "--grep=^This reverts commit ", range)) {
    if (!commits.has(sha) || !/^(Revert|Reapply) "/.test(subject)) continue;
    const record =
      /^This reverts commit ([a-f0-9]{40,64})(?:\.|, reversing\nchanges made to ([a-f0-9]{40,64})\.)$/m.exec(body);
    if (!record || !commits.has(record[1])) continue;
    const [, target, mainline] = record;
    const parents = run("git", "show", "-s", "--format=%P", target).split(" ");
    const parent = mainline ?? parents[0];
    if (!parent || !parents.includes(parent)) continue;
    const inverse = patchId(target, parent);
    if (!inverse || patchId(`${sha}^1`, sha) !== inverse) continue;

    // Dropping the side history also removes feature titles from a reverted merge.
    for (const introduced of run("git", "rev-list", `${parent}..${target}`).split("\n")) commits.delete(introduced);
    commits.delete(sha);
  }
  return commits;
}

function hasMinorTitle(range, modulePaths, commits) {
  for (const { sha, subject, body } of commitMessages("--show-pulls", range, "--", ...modulePaths)) {
    const title = /^Merge pull request #[0-9]+ from /.test(subject) ? body.split("\n", 1)[0] : subject;
    if (commits.has(sha) && /^feat(\([^)]+\))?!?: \[minor\] .+/.test(title)) return true;
  }
  return false;
}

function closingIssues(repository, pullNumber) {
  const [owner, name] = repository.split("/");
  const query = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: 100, after: $endCursor) {
          nodes { number repository { nameWithOwner } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;
  const pages = JSON.parse(
    run(
      "gh",
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${pullNumber}`
    )
  );
  return pages
    .flatMap((page) => page.data.repository.pullRequest.closingIssuesReferences.nodes)
    .filter((issue) => issue.repository.nameWithOwner.toLowerCase() === repository.toLowerCase())
    .map((issue) => issue.number);
}

function hasMinorLabel(repository, number) {
  const pages = JSON.parse(
    run("gh", "api", "--paginate", "--slurp", `repos/${repository}/issues/${number}/labels?per_page=100`)
  );
  return pages.flat().some((label) => label.name === "release:minor");
}

function releaseNotes(modulePaths) {
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_SHA: sha,
    PREVIOUS_RELEASE_TAG: previous,
    GITHUB_SERVER_URL: server = "https://github.com"
  } = process.env;
  const url = `${server}/${repository}`;
  const range = previous ? `${previous}..${sha}` : sha;
  const commits = releaseCommits(range);
  const moduleCommits = new Set(
    modulePaths.length ? run("git", "rev-list", "--first-parent", range, "--", ...modulePaths).split("\n") : []
  );
  const seen = new Set();
  const shippedPulls = new Set();
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
      if (moduleCommits.has(commit) || moduleCommits.has(pull.merge_commit_sha)) shippedPulls.add(pull.number);
      if (seen.has(pull.number)) continue;
      seen.add(pull.number);
      for (const note of parseReleaseNotes(pull.body) ?? [])
        entries.push(`- ${note} ([#${pull.number}](${url}/pull/${pull.number}))`);
    }
  }

  const issues = [...new Set([...shippedPulls].flatMap((number) => closingIssues(repository, number)))].sort(
    (a, b) => a - b
  );
  const changes = previous ? `${url}/compare/${previous}...${sha}` : `${url}/commits/${sha}`;
  const sections = [];
  if (entries.length) sections.push(`## What's changed\n\n${entries.join("\n")}`);
  if (issues.length)
    sections.push(`## Included issues\n\n${issues.map((n) => `[#${n}](${url}/issues/${n})`).join(", ")}`);
  sections.push(`[Full changelog](${changes})`);
  if (modulePaths.length) sections.push(`<!-- table-tools-release-issues-v1: ${JSON.stringify(issues)} -->`);
  return {
    notes: sections.join("\n\n"),
    bump:
      issues.some((number) => hasMinorLabel(repository, number)) ||
      (modulePaths.length && hasMinorTitle(range, modulePaths, commits))
        ? "minor"
        : "patch"
  };
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
  } else if (process.argv[2] === "--title-bump") {
    const [range, ...modulePaths] = process.argv.slice(3);
    console.log(hasMinorTitle(range, modulePaths, releaseCommits(range)) ? "minor" : "patch");
  } else if (process.argv[2] === "--prepare") {
    const [output, ...modulePaths] = process.argv.slice(3);
    if (!output || !modulePaths.length) throw new Error("--prepare needs a notes file and module paths");
    const { notes, bump } = releaseNotes(modulePaths);
    writeFileSync(output, `${notes}\n`);
    console.log(bump);
  } else {
    console.log(releaseNotes([]).notes);
  }
}
