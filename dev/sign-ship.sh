#!/usr/bin/env bash
# Signs a /ship approval for one PR head with your security key, which asks
# for a touch. Run a copy kept outside the repo, never one from a PR branch.
# It prints the comment and posts nothing.
#   sign-ship.sh <pr> <full sha you reviewed> [key file] | gh pr comment <pr> --body-file -
set -euo pipefail
pr=${1:?usage: sign-ship.sh <pr number> <full sha> [key file]}
want=${2:?usage: sign-ship.sh <pr number> <full sha> [key file]}
key=${3:-$HOME/.ssh/trailmark_ship_sk}
case "$want" in *[!0-9a-f]*|'') echo "the sha must be 40 lowercase hex characters" >&2; exit 1 ;; esac
[ "${#want}" -eq 40 ] || { echo "the sha must be 40 lowercase hex characters" >&2; exit 1; }
repo=cptjamestiberiouskirk-pixel/trailmark
sha=$(gh pr view "$pr" --repo "$repo" --json headRefOid --jq .headRefOid)
if [ "$sha" != "$want" ]; then
  echo "PR #$pr is now at $sha, not $want. Review the new head first." >&2
  exit 1
fi
# The title is set by whoever opened the PR: drop control characters.
title=$(gh pr view "$pr" --repo "$repo" --json title --jq .title | tr -d '\000-\037\177')
line="trailmark ship $repo pr=$pr sha=$sha"
printf 'PR #%s "%s"\nSigning: %s\n' "$pr" "$title" "$line" >&2
dir=$(mktemp -d)
trap 'rm -rf -- "$dir"' EXIT
printf '%s\n' "$line" > "$dir/msg"
ssh-keygen -Y sign -f "$key" -n trailmark-ship "$dir/msg" > /dev/null
printf '/ship %s\n\n```\n%s\n```\n' "$sha" "$(cat "$dir/msg.sig")"
