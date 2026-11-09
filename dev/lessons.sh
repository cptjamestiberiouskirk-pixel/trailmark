#!/usr/bin/env bash
# Prints the rules in LESSONS.md for the lessons check in PLAYBOOK.md. Reads
# that one file and writes nothing.
#
#   dev/lessons.sh              every open lesson's rule, newest first
#   dev/lessons.sh <word>...    every lesson, open or promoted, whose text holds
#                               one of the words (case does not matter)
#   dev/lessons.sh --check      checks the log's format: exit 1 if an entry is
#                               missing a field or is out of date order

set -u
FILE="$(dirname "$0")/../LESSONS.md"
[ -r "$FILE" ] || { echo "lessons: cannot read $FILE"; exit 2; }

MODE=open
WORDS=''
case "${1:-}" in
  --check) MODE=check ;;
  -*) echo 'usage: dev/lessons.sh [--check | <word>...]'; exit 2 ;;
  '') ;;
  *) MODE=words; WORDS="$*" ;;
esac

awk -v mode="$MODE" -v words="$WORDS" '
function field(line, name) { return index(line, "- " name ":") == 1 }
function repeated(name) { printf "BAD   line %d: %s: %s appears twice\n", NR, title, name; bad++ }
function flush(   miss, i, hit, text) {
  if (title == "") return
  miss = ""
  if (!what) miss = miss " What-went-wrong"
  if (!why) miss = miss " Why"
  if (rule == "") miss = miss " Rule-going-forward"
  if (status == "") miss = miss " Status"
  else if (status !~ /^(open|promoted)/) miss = miss " Status-not-open-or-promoted"
  if (miss != "") { printf "BAD   line %d: %s: missing%s\n", at, title, miss; bad++ }
  entries++
  if (status ~ /^open/) opened++
  if (mode == "open" && status ~ /^open/) { printf "%s\n    %s\n", title, rule; shown++ }
  if (mode == "words") {
    text = tolower(body); hit = 0
    for (i = 1; i <= nw; i++) if (index(text, w[i])) hit = 1
    if (hit) { printf "[%s] %s\n    %s\n", (status ~ /^open/ ? "open" : "promoted"), title, rule; shown++ }
  }
}
BEGIN { nw = split(tolower(words), w, " ") }
{ sub(/\r$/, "") }
/^```/ { fence = !fence; if (fence) fence_line = NR; if (title != "") body = body " " $0; next }
fence { if (title != "") body = body " " $0; next }
/^## [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]: / {
  flush()
  title = substr($0, 4); at = NR; body = title; what = 0; why = 0; rule = ""; status = ""
  date = substr($0, 4, 10)
  if (last != "" && date > last) { printf "BAD   line %d: %s: newer than the entry above it\n", NR, title; bad++ }
  last = date
  next
}
# Any other heading outside a fence: its fields must not land in the entry above.
/^## / { flush(); printf "BAD   line %d: heading is not in the dated form: %s\n", NR, substr($0, 4); bad++; title = ""; next }
title != "" {
  body = body " " $0
  if (field($0, "What went wrong")) { if (what) repeated("What-went-wrong"); what = 1 }
  else if (field($0, "Why")) { if (why) repeated("Why"); why = 1 }
  else if (field($0, "Rule going forward")) { if (rule != "") repeated("Rule-going-forward"); else rule = substr($0, 23) }
  else if (field($0, "Status")) { if (status != "") repeated("Status"); else status = substr($0, 11) }
}
END {
  flush()
  # Everything after an open fence was skipped, so the counts below are short.
  if (fence) { printf "BAD   line %d: code fence is never closed\n", fence_line; bad++ }
  if (entries == 0) { print "BAD   no entries found"; bad++ }
  if (mode == "check") printf "%d entries, %d open, %d promoted, %d bad\n", entries, opened, entries - opened, bad
  else printf "-- %d shown of %d lessons (%d open)\n", shown, entries, opened
  exit bad ? 1 : 0
}
' "$FILE"
