import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function github(...args) {
  return execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trimEnd();
}

export function reconcileReleaseIssues(repository, tag, api = github) {
  if (!/^v(0|[1-9]\d*)(\.(0|[1-9]\d*)){2}$/.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
  const release = JSON.parse(api(`repos/${repository}/releases/tags/${tag}`));
  if (release.draft || release.prerelease || release.author.login !== "github-actions[bot]") return;

  const footer = (release.body ?? "").trimEnd().split(/\r?\n/).at(-1);
  const metadata = /^<!-- table-tools-release-issues-v1: (.*) -->$/.exec(footer);
  if (!metadata) return;
  const issues = JSON.parse(metadata[1]);
  if (!Array.isArray(issues) || !issues.every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw new Error(`Invalid release issue numbers on ${tag}`);
  }

  const marker = `<!-- table-tools-released: ${tag} -->`;
  const findMarker = `.[] | select(.user.login == "github-actions[bot]" and ((.body // "") | endswith("${marker}"))) | .id`;
  for (const issue of new Set(issues)) {
    const endpoint = `repos/${repository}/issues/${issue}/comments`;
    if (api(`${endpoint}?per_page=100`, "--paginate", "--jq", findMarker)) continue;
    const body = `Veröffentlicht in [${tag}](${release.html_url}).\n\n${marker}`;
    api(endpoint, "--method", "POST", "--silent", "-f", `body=${body}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reconcileReleaseIssues(process.env.GITHUB_REPOSITORY, process.argv[2]);
}
