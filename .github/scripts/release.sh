#!/usr/bin/env bash
set -euo pipefail
shopt -s inherit_errexit

runtime_paths=(scripts styles lang assets)

fail() {
  echo "$*" >&2
  exit 1
}

check_tag() {
  local number='(0|[1-9][0-9]*)'
  [[ $1 =~ ^v${number}\.${number}\.${number}$ ]] || fail "Expected a vMAJOR.MINOR.PATCH tag, got '$1'"
}

plan() {
  local previous=$1 sha=$2 requested changed highest
  requested=$(git show "$sha:module.json" | jq -er '.version | strings')
  check_tag "v$requested"

  if [[ -n $previous ]]; then
    check_tag "$previous"
    git merge-base --is-ancestor "refs/tags/$previous" "$sha" || fail "$previous is outside the history of $sha"
    changed=$(git diff --name-only "refs/tags/$previous" "$sha" -- module.json "${runtime_paths[@]}")
    [[ -n $changed ]] || return 0

    highest=$(printf '%s\n' "$previous" "v$requested" | sort -V | tail -n 1)
    if [[ $highest == "$previous" ]]; then
      echo "${previous%.*}.$((${previous##*.} + 1))"
      return
    fi
  fi
  echo "v$requested"
}

package() {
  local tag=$1 sha=$2 output=$3
  check_tag "$tag"
  local url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:?}/releases/download/$tag/module.zip"
  git show "$sha:module.json" | jq --arg version "${tag#v}" --arg url "$url" \
    '.version = $version | .download = $url' > "$output/module.json"
  git archive --format=zip -o "$output/module.zip" "$sha" "${runtime_paths[@]}" LICENSE README.md
  (cd "$output" && zip -q -X module.zip module.json)
}

publish() {
  local sha previous tag output state existing
  sha=$(git rev-parse HEAD)
  previous=$(gh api graphql -F owner='{owner}' -F name='{repo}' -f query='
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { latestRelease { tagName } }
    }' --jq '.data.repository.latestRelease.tagName // empty')
  tag=$(plan "$previous" "$sha")
  if [[ -z $tag ]]; then
    echo "$previous already contains the module changes on main."
    return
  fi

  existing=$(git tag --list "$tag")
  if [[ -n $existing ]]; then
    [[ $(git rev-parse "refs/tags/$tag^{commit}") == "$sha" ]] || fail "$tag already points to a different commit"
  fi

  output=$(mktemp -d)
  package "$tag" "$sha" "$output"
  GITHUB_SHA="$sha" PREVIOUS_RELEASE_TAG="$previous" node .github/scripts/release-notes.mjs > "$output/notes.md"

  state=$(gh api --paginate 'repos/{owner}/{repo}/releases?per_page=100' | jq -rs --arg tag "$tag" '
    map(.[] | select(.tag_name == $tag)) |
    if length == 0 then "new"
    elif length == 1 and (.[0] | .draft and (.prerelease | not) and .author.login == "github-actions[bot]") then "draft"
    else "reserved" end')
  case $state in
    new) gh release create "$tag" --draft --target "$sha" --title "$tag" --notes-file "$output/notes.md" ;;
    draft) echo "Resuming the unfinished release $tag." ;;
    *) fail "$tag already belongs to another release" ;;
  esac
  gh release upload "$tag" "$output/module.json" "$output/module.zip" --clobber
  gh release edit "$tag" --draft=false --latest --target "$sha" --notes-file "$output/notes.md"
}

case ${1:-} in
  plan) plan "$2" "$3" ;;
  package) package "$2" "$3" "$4" ;;
  publish) publish ;;
  *) fail "Usage: $0 plan <previous-tag-or-empty> <sha> | package <tag> <sha> <output-directory> | publish" ;;
esac
