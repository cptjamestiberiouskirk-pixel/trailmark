#!/usr/bin/env bash
# install.sh -- installs trailmark for Claude Code (and, with --codex, adds
# the Codex marketplace) on macOS or Linux, from this release folder.
#
# What it does, in order. It stops at the first step that fails and says why.
#   1. Leaves out PATH entries that aren't absolute folders (".", empty,
#      relative) for this run and says so. Checks Node (present, and not
#      older than its line's October 2026 security release), git and the
#      claude command.
#   2. Checks this folder and the folders above it: Claude Code runs the
#      hooks from here, so write access for other users or a shared group,
#      another owner above it, or a link inside it is refused.
#   3. Runs trailmark's sandbox check (Node's permission model on this
#      machine).
#   4. Refuses if trailmark is already installed from another marketplace, or
#      if a marketplace named trailmark points at another folder, since two
#      copies would each run the hooks. --repoint allows the second case.
#   5. claude plugin validate, claude plugin marketplace add <this folder>,
#      claude plugin install trailmark@trailmark (user scope).
#   6. With --codex: codex plugin marketplace add <this folder>. Installing in
#      the ChatGPT desktop app is a manual step; it prints what to do.
#
# It downloads nothing, changes no file in this folder and touches no repo.
# The only settings it changes are the ones the claude and codex commands
# write when a marketplace is added and a plugin installed.
#
#   ./install.sh                 install for Claude Code
#   ./install.sh --codex         also add the Codex marketplace
#   ./install.sh --check         run steps 1 to 4 only, change nothing
#   ./install.sh --uninstall     uninstall the plugin and remove the
#                                marketplace (memory folders are kept)
#   ./install.sh --allow-old-node  continue on a Node below the security floor
#   ./install.sh --preflight     --check for the migration script: jb-memory,
#                                which it removes after these checks, doesn't count
#   ./install.sh --repoint       let an existing trailmark marketplace that
#                                points elsewhere point here instead

set -u

# Programs are run by name (node, claude, git, find and the rest), so PATH
# keeps only absolute folders: an empty entry or "." would find a program in
# the current folder, which may be a repo. Done before anything runs.
NEWPATH=''
IFS_OLD="$IFS"; IFS=':'; set -f
for e in $PATH; do
  case "$e" in /*) NEWPATH="${NEWPATH:+$NEWPATH:}$e" ;; esac
done
set +f; IFS="$IFS_OLD"
if [ "$NEWPATH" != "$PATH" ]; then PATH_DROPPED=1; else PATH_DROPPED=0; fi
PATH="$NEWPATH"; export PATH

case "$0" in */*) SELF_DIR="${0%/*}" ;; *) SELF_DIR=. ;; esac
HERE="$(CDPATH='' cd -- "$SELF_DIR" && pwd -P)"
MKT=trailmark
PLUGIN=trailmark
CODEX=0; CHECK=0; UNINSTALL=0; OLDNODE=0; REPOINT=0; PREFLIGHT=0
for a in "$@"; do
  case "$a" in
    --codex) CODEX=1 ;;
    --check) CHECK=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --allow-old-node) OLDNODE=1 ;;
    --repoint) REPOINT=1 ;;
    --preflight) PREFLIGHT=1; CHECK=1 ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $a (see --help)"; exit 2 ;;
  esac
done

step() { printf '\n=== %s\n' "$1"; }
ok()   { printf '  ok    %s\n' "$1"; }
warn() { printf '  WARN  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; exit 1; }

if [ "$UNINSTALL" = 1 ]; then
  step 'Uninstall'
  command -v claude >/dev/null 2>&1 || fail 'claude is not on PATH.'
  # Exit 2 when a step failed for a reason other than "already gone".
  RC=0
  if OUT="$(claude plugin uninstall "$PLUGIN@$MKT" --json 2>&1)"; then ok "uninstalled $PLUGIN@$MKT"
  elif printf '%s' "$OUT" | grep -Eq '"failureCode"[[:space:]]*:[[:space:]]*"not_installed"'; then ok "$PLUGIN@$MKT was not installed"
  else warn "claude plugin uninstall $PLUGIN@$MKT failed: $OUT"; RC=2; fi
  if OUT="$(claude plugin marketplace remove "$MKT" --json 2>&1)"; then ok "removed the marketplace $MKT"
  elif printf '%s' "$OUT" | grep -Eq '"failureCode"[[:space:]]*:[[:space:]]*"not_configured"'; then ok "the marketplace $MKT was not configured"
  else warn "claude plugin marketplace remove $MKT failed: $OUT"; RC=2; fi
  # The ChatGPT app lists an installed plugin only through its marketplace,
  # so the marketplace stays until trailmark-codex is uninstalled there.
  # A config.toml that is there but can't be read keeps it too.
  CODEX_CFG="${CODEX_HOME:-$HOME/.codex}/config.toml"
  if [ -e "$CODEX_CFG" ] && ! [ -r "$CODEX_CFG" ]; then
    warn "$CODEX_CFG can't be read, so the trailmark-codex marketplace was kept: if trailmark-codex is installed, the ChatGPT app shows it only through that marketplace."
    RC=2
  elif [ -f "$CODEX_CFG" ] && grep -Eq '^[[:space:]]*\[[[:space:]]*plugins[[:space:]]*\.[[:space:]]*"trailmark-codex@' "$CODEX_CFG"; then
    warn 'trailmark-codex is still installed in the ChatGPT app. Uninstall it there first (Plugins), then run this again to remove its marketplace: the app shows it only through that marketplace.'
    RC=2
  elif command -v codex >/dev/null 2>&1; then
    if OUT="$(codex plugin marketplace remove trailmark-codex 2>&1)"; then ok 'removed the trailmark-codex marketplace from Codex'
    elif printf '%s' "$OUT" | grep -Eqi 'not configured|not found|no such marketplace'; then ok 'the trailmark-codex marketplace was not added in Codex'
    else warn "codex plugin marketplace remove trailmark-codex failed: $OUT"; RC=2; fi
  fi
  echo
  echo 'Done. The memory folders (~/.claude/projects/<repo>/memory) were kept; each repo'"'"'s'
  echo 'handoff and logs stay there. Delete .jbmem.json in one to stop using it.'
  exit "$RC"
fi

step 'Check the tools'
if [ "$PATH_DROPPED" = 1 ]; then warn 'PATH holds an empty entry, "." or a relative folder, so programs named by bare name can be found in the current folder (a repo). This run left those entries out (so a program found only through one counts as missing); remove them from PATH, since every hook starts node by name.'; fi
command -v node >/dev/null 2>&1 || fail 'node is not on PATH. Install the Node.js LTS (24.22.1 or later), open a new terminal and run this again.'
# Before node runs at all: with "." or an empty entry in PATH, the node found
# could be one in the current folder (a repo).
case "$(command -v node)" in
  /*) ;;
  *) fail "node is found as $(command -v node), through a PATH entry that isn't an absolute folder (\".\" or empty). Remove that entry from PATH, then run this again." ;;
esac
NODEV="$(node -p 'process.version' 2>/dev/null)" || fail 'node did not run.'
CHECK_JS="$HERE/tools/install-check.js"
ADVICE="$(node "$CHECK_JS" node-advice 2>/dev/null)" || fail 'could not run tools/install-check.js; is this the release folder?'
if [ -n "$ADVICE" ]; then
  if [ "$OLDNODE" = 1 ]; then warn "$ADVICE (continuing: --allow-old-node)"; else fail "$ADVICE Or run again with --allow-old-node."; fi
else ok "node $NODEV ($(command -v node))"; fi
case "$(command -v node)" in
  "$HERE"/*) fail 'the node on PATH is inside this folder. Use the installed Node.' ;;
esac
if command -v git >/dev/null 2>&1; then ok "$(git --version)"; else warn 'git is not on PATH. trailmark works, but logs no commits and shows no branch until it is.'; fi
command -v claude >/dev/null 2>&1 || fail 'claude is not on PATH. Install Claude Code first.'
case "$(command -v claude)" in
  /*) ;;
  *) fail "claude is found as $(command -v claude), through a PATH entry that isn't an absolute folder. Remove that entry from PATH, then run this again." ;;
esac
CV="$(claude --version 2>/dev/null | head -n1)"
ok "claude $CV"
node -e '
const m=/(\d+)\.(\d+)\.(\d+)/.exec(process.argv[1]||""); if(!m) process.exit(0);
const v=[+m[1],+m[2],+m[3]], f=[2,1,304];
for (let i=0;i<3;i++){ if(v[i]!==f[i]){ process.exit(v[i]<f[i]?1:0);} }' "$CV" \
  || warn 'this Claude Code is older than 2.1.304, the oldest version tested. Hooks need command hooks with args and if; update Claude Code if the [trailmark] line never appears.'


step 'Check this folder'
echo "  $HERE"
[ -f "$HERE/.claude-plugin/marketplace.json" ] || fail 'no .claude-plugin/marketplace.json here; run install.sh from the release folder.'
WW="$(find "$HERE" \( -type d -o -type f \) -perm -0002 ! -type l -print -quit 2>/dev/null)"
[ -z "$WW" ] || fail "other users can write to $WW. Claude Code runs the hooks from this folder, so fix that first (chmod -R go-w \"$HERE\")."
# Group write is fine only for a group that is yours alone (a user private
# group named after you). A shared group such as staff or users is not.
# Where no group is named after you (macOS: staff), any group write counts:
# find can't test against a group that doesn't exist, and would match nothing.
ME="$(id -un)"
if find "$HERE" -maxdepth 0 -group "$ME" >/dev/null 2>&1; then
  OWNGRP_NOT="! -group $ME"
  case "$ME" in *[!A-Za-z0-9._-]*) OWNGRP_NOT='' ;; esac
  # A group named after you that lists other members isn't yours alone.
  if command -v getent >/dev/null 2>&1; then
    MEMBERS="$(getent group "$ME" | cut -d: -f4)"
    case ",$MEMBERS," in ",,"|",$ME,") ;; *) OWNGRP_NOT='' ;; esac
    # Users whose primary group it is aren't listed there.
    GID="$(getent group "$ME" | cut -d: -f3)"
    if [ -n "$GID" ] && getent passwd | awk -F: -v g="$GID" -v me="$ME" '$4==g && $1!=me {found=1} END {exit !found}'; then OWNGRP_NOT=''; fi
  fi
else
  OWNGRP_NOT=''
fi
# shellcheck disable=SC2086
GW="$(find "$HERE" \( -type d -o -type f \) -perm -0020 ! -type l $OWNGRP_NOT -print -quit 2>/dev/null)"
[ -z "$GW" ] || fail "members of a shared group can write to $GW. Claude Code runs the hooks from this folder, so fix that first (chmod -R go-w \"$HERE\")."
# Access-list entries (setfacl) can grant others write access that the mode
# bits above don't show. Linux; on macOS, chmod -N removes them (ls -le).
# Only an entry that lets a named user or group write counts.
# An entry for yourself doesn't count, the mask's limit (#effective) does,
# and on a folder above the release, default: entries (for new files) don't.
acl_write() {
  DEFAULTS_TOO="$1"; shift
  getfacl "$@" -s -p 2>/dev/null | awk -v me="$ME" -v dflt="$DEFAULTS_TOO" '
    /^# file: / { f = substr($0, 9); next }
    {
      line = $0
      if (line ~ /^default:/) { if (dflt != 1) next; sub(/^default:/, "", line) }
      if (line !~ /^(user|group):[^:]+:/) next
      split(line, a, ":")
      if (a[1] == "user" && a[2] == me) next
      perm = substr(a[3], 1, 3)
      if (match(line, /#effective:[rwx-]+/)) perm = substr(line, RSTART + 11, 3)
      if (substr(perm, 2, 1) == "w") { print f; exit }
    }'
}
if command -v getfacl >/dev/null 2>&1; then
  ACL="$(acl_write 1 -R "$HERE")"
  [ -z "$ACL" ] || fail "$ACL has access-list entries (setfacl) that let others write there. Claude Code runs the hooks from this folder, so remove them first (setfacl -R -b \"$HERE\")."
fi
# The release ships no links, and a link could point at something others can write.
LK="$(find "$HERE" -type l -print -quit 2>/dev/null)"
[ -z "$LK" ] || fail "$LK is a link. The release has none; replace it with the real file or folder."
# The folders above it count too: whoever can write to a parent, or owns it,
# can replace this folder. A sticky folder (such as /tmp) stops that for others.
P="$(dirname "$HERE")"
while [ -n "$P" ]; do
  if [ -z "$(find "$P" -maxdepth 0 -perm -1000 2>/dev/null)" ]; then
    if [ -n "$(find "$P" -maxdepth 0 -perm -0002 2>/dev/null)" ]; then fail "other users can write to $P, which holds this folder. Move the release under your home folder."; fi
    # shellcheck disable=SC2086
    if [ -n "$(find "$P" -maxdepth 0 -perm -0020 $OWNGRP_NOT 2>/dev/null)" ]; then fail "members of a shared group can write to $P, which holds this folder. Move the release under your home folder."; fi
  fi
  if command -v getfacl >/dev/null 2>&1 && [ -n "$(acl_write 0 "$P")" ]; then fail "$P, which holds this folder, has access-list entries (setfacl) that let others write there. Move the release under your home folder."; fi
  if [ -z "$(find "$P" -maxdepth 0 \( -user "$ME" -o -user 0 \) 2>/dev/null)" ]; then fail "$P, which holds this folder, belongs to another user. Move the release under your home folder."; fi
  [ "$P" = "/" ] && break
  P="$(dirname "$P")"
done
OWNER_BAD="$(find "$HERE" ! -user "$(id -u)" -print -quit 2>/dev/null)"
[ -z "$OWNER_BAD" ] || warn "$OWNER_BAD is owned by another user. Anyone who owns a file here can change what the hooks run."
ok 'only you can write here'

step 'Sandbox check'
SC="$(cd "$HERE" && node plugins/trailmark/scripts/trailmark.js --sandbox-check 2>&1)"; SCR=$?
printf '%s\n' "$SC" | sed 's/^/  /'
[ $SCR -eq 0 ] && printf '%s' "$SC" | grep -q '^SANDBOX OK' || fail 'the sandbox check did not pass. See MANUAL.md, "Sandbox check failed".'

step 'Check for other copies'
LIST="$(claude plugin list --json 2>/dev/null)" || fail 'claude plugin list --json failed, so other installs could not be checked.'
OTHERS_MODE=others; [ "$PREFLIGHT" = 1 ] && OTHERS_MODE=others-new
OTHER="$(printf '%s' "$LIST" | node "$CHECK_JS" "$OTHERS_MODE")" || fail 'could not read the output of claude plugin list --json.'
[ -z "$OTHER" ] || fail "another copy is already installed as $OTHER (jb-memory is Trailmark's old name). Two copies would each run every hook. Uninstall it first: claude plugin uninstall $OTHER"
MLIST="$(claude plugin marketplace list --json 2>/dev/null)" || fail 'claude plugin marketplace list --json failed, so other marketplaces could not be checked.'
WHERE="$(printf '%s' "$MLIST" | node "$CHECK_JS" marketplace)" || fail 'could not read the output of claude plugin marketplace list --json.'
if [ -n "$WHERE" ] && [ "$WHERE" != "$HERE" ]; then
  if [ "$REPOINT" = 1 ]; then warn "the trailmark marketplace pointed at $WHERE; it will point here (--repoint)."
  else fail "a marketplace named trailmark already points at $WHERE. Run again with --repoint to point it here, or install from that folder."; fi
fi
ok 'no other Trailmark or jb-memory install'

# Read-only, so part of the checks: the migration runs them before it
# removes anything.
claude plugin validate "$HERE" >/dev/null || fail "claude plugin validate failed; run it by hand to see why: claude plugin validate \"$HERE\""
ok 'claude plugin validate passes'

if [ "$CHECK" = 1 ]; then echo; echo 'Checks done: nothing was changed.'; exit 0; fi

step 'Install for Claude Code'
claude plugin marketplace add "$HERE" || fail 'claude plugin marketplace add failed.'
claude plugin install "$PLUGIN@$MKT" || fail 'claude plugin install failed.'

if [ "$CODEX" = 1 ]; then
  step 'Codex'
  if command -v codex >/dev/null 2>&1; then
    codex plugin marketplace add "$HERE" || warn 'codex plugin marketplace add failed.'
    echo '  Next, in the ChatGPT desktop app: restart it, open Plugins, choose the'
    echo '  trailmark-codex marketplace, install trailmark-codex, then review and trust'
    echo '  its hooks. MANUAL.md, "Codex", has the rest.'
  else
    warn 'codex is not on PATH. Add the marketplace from the ChatGPT app or install the Codex CLI; see MANUAL.md, "Codex".'
  fi
fi

step 'Done'
cat <<EOF
  Next, in each repo you want Trailmark in:
    1. Start Claude Code there and run /trailmark:memory-setup
    2. Start a new session and look for the [trailmark] status line;
       it ends with "sandbox on".
  MANUAL.md in this folder covers the rest.
  Keep this folder where it is: Claude Code loads the plugin from it.
EOF
