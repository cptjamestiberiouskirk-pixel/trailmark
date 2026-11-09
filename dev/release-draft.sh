#!/usr/bin/env bash
# Put this commit's release zip in a draft release on GitHub.
#
# .github/workflows/release-draft.yml runs this on each push to main. With
# REPO=owner/name set and gh signed in, it also runs by hand from a clean tree.
#
# It does nothing when the version's tag already exists. Otherwise it builds
# the zip with release-check.sh --zip-only, checks it, and creates a draft with
# the zip and its .sha256. A draft has no tag and only people with write access
# can see it: a person publishes it, and GitHub makes the tag then.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
: "${REPO:?set REPO to owner/name}"

fail() { echo "::error::$*"; exit 1; }

ver="$(node -p "require('./plugins/trailmark/.claude-plugin/plugin.json').version")"
# Checked before it goes into any command or query below.
[[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "version is not x.y.z: $ver"
for m in plugins/trailmark-codex/plugin.json plugins/trailmark-codex/.codex-plugin/plugin.json; do
  v="$(node -p "require('./$m').version")"
  [ "$v" = "$ver" ] || fail "$m says $v, the Claude Code manifest says $ver"
done
tag="v$ver"
commit="$(git rev-parse HEAD)"

# matching-refs matches by prefix: v0.6.2 would also find v0.6.20.
tags="$(gh api "repos/$REPO/git/matching-refs/tags/$tag" --jq ".[] | select(.ref == \"refs/tags/$tag\") | .ref")"
if [ -n "$tags" ]; then echo "$tag already exists: nothing to do"; exit 0; fi

# Re-running an old job must not put older code over a newer draft.
tip="$(gh api "repos/$REPO/commits/main" --jq .sha)"
if [ "$tip" != "$commit" ]; then echo "main has moved on to $tip: nothing to do for $commit"; exit 0; fi

# Hidden in the notes of every draft this job makes, to tell them from drafts
# made by hand.
MARK='<!-- made by release-draft.yml -->'

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

bash dev/release-check.sh --zip-only "$T/out"
zip="$T/out/trailmark-$ver.zip"
(cd "$T/out" && sha256sum -c "trailmark-$ver.zip.sha256")
# Held in a variable: grep -q ending a pipe early would fail it under pipefail.
list="$(unzip -Z1 "$zip")"
if grep -qE '^trailmark/(CLAUDE\.md|PLAYBOOK\.md|LESSONS\.md|dev/)' <<<"$list"; then
  fail 'the zip holds a development-only file'
fi

section="$(awk -v h="## $ver " 'index($0, "## ") == 1 { if (on) exit; on = (index($0, h) == 1); next } on' CHANGELOG.md)"
[ -n "$section" ] || fail "CHANGELOG.md has no section for $ver"
{
  printf '%s\n\n' 'Install from GitHub:'
  printf '%s\n' '```text' \
    "claude plugin marketplace add $REPO" \
    'claude plugin install trailmark@trailmark' \
    '```' ''
  printf '%s\n\n' "Or download \`trailmark-$ver.zip\`, check it against \`trailmark-$ver.zip.sha256\`, unzip it somewhere only you can write to, and run \`install.sh\` (macOS, Linux) or \`install.cmd\` (Windows)."
  printf '%s\n' "$section"
  printf '\n%s\n' "How to report a vulnerability: [SECURITY.md](https://github.com/$REPO/blob/$tag/SECURITY.md)."
  printf '\n%s\n' "$MARK"
} > "$T/notes.md"

# An earlier push's draft is replaced, so the draft always matches main. All
# drafts are read before anything changes. A draft counts as finished only with
# both files uploaded: a failed upload leaves a draft that isn't. A hand-made
# draft stops the job with nothing changed.
drafts="$(gh api --paginate "repos/$REPO/releases" --jq ".[] | select(.draft and .tag_name == \"$tag\") | \"\(.id) \(.target_commitish) \([.assets[] | select(.state == \"uploaded\")] | length) \(.body // \"\" | contains(\"$MARK\"))\"")"
have=''; old=()
while read -r id draft_commit uploaded mine; do
  [ -n "$id" ] || continue
  if [ "$mine" != true ]; then echo "$tag has a draft made by hand: leaving it alone"; exit 0; fi
  if [ -z "$have" ] && [ "$draft_commit" = "$commit" ] && [ "$uploaded" = 2 ]; then have=1; else old+=("$id"); fi
done <<<"$drafts"

# The new draft first, so a failure here leaves the old one in place.
if [ -z "$have" ]; then
  gh release create "$tag" "$zip" "$zip.sha256" --repo "$REPO" --draft \
    --target "$commit" --title "Trailmark $ver" --notes-file "$T/notes.md"
  echo "draft release for $tag created from $commit"
else
  echo "the draft of $tag from $commit is complete"
fi
# Deleted by id: a draft has no tag to find it by. Looked at again first: the
# upload takes time, and someone may have published the old draft meanwhile.
for id in ${old[@]+"${old[@]}"}; do
  # On its own line: inside [ ] a failed lookup would read as "not a draft".
  still_draft="$(gh api "repos/$REPO/releases/$id" --jq .draft)"
  [ "$still_draft" = true ] || continue
  gh api -X DELETE "repos/$REPO/releases/$id"
done
