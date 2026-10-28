# check-trailmark-checkpoints.ps1
# Read-only. Shows, for each Claude Code session that worked in a repo during
# the last -Hours, the milestones it hit (commits, PR merges, subagent results,
# compactions) next to the checkpoints it saved and the trailmark reminders it
# got. Counts, flags and the timeline cover that window only; the last
# checkpoint before an event counts even when it is older. Then it lists the
# gaps the checkpoint skill's own rules point at:
#   - a compaction with no checkpoint after it
#   - a refused (exit 3), over-budget (exit 2) or failed write never redone
#   - write-handoff run with --force (the skill says never) or from a trailmark.js
#     other than the installed plugin's, or saved without --base
#   - a checkpoint or session-end Skill call that came back as an error, such
#     as plain checkpoint, which Claude Code takes as its own /rewind
#   - a session whose latest start ran on a Node release older than the
#     October 2026 security release for its line
#   - a commit, PR merge or compaction older than -StaleMinutes with no
#     checkpoint since (subagent results are shown but not counted here)
#   - an idle session that left commits, merges or compactions after its last
#     checkpoint
#   - a drop file left in the memory folder
# Separately it lists late checkpoints: work in the window that waited longer
# than -StaleMinutes before a checkpoint covered it.
# A reminder with no checkpoint after it is counted, not flagged: the skill
# lets Claude skip one when nothing material changed.
# Each git commit command a session ran is shown with what git printed, next
# to the COMMIT line the hook logged, so the two can be compared. A SHA the
# hook logged more than once is counted once and listed under Log check.
# Since trailmark 0.3.3 the hook logs a commit made in another folder as
# COMMIT <sha> in="<folder>" <subject>, and one whose folder it can't tell as
# COMMIT_UNRESOLVED why=<reason>. A git commit command in another folder that
# has neither line next to it (0.3.2 and earlier) is counted from the command.
# Since 0.3.4 a commit no hook logged, found later in the session's folders,
# ends in "(found later)"; it is shown, not counted as a milestone. An
# END_MISMATCH line (the folder a command ended in, as the hook read it,
# against where Claude Code says it ended) is shown and counted under Log
# check. The handoff's Updated line is checked against the shape write-handoff
# writes, and the file against the version the state file says write-handoff
# saved last, so a handoff written some other way stands out.
#
# What it reads:
#   the repo's memory folder: .jbmem-state.json (sessions and the transcript
#   path Claude Code reported for each), notes\ (session starts, commits, PR
#   merges, compactions), handoff.md and archive\handoff-history\ (the last
#   20 saved versions)
#   each session's transcript under %USERPROFILE%\.claude\projects, scanned
#   for trailmark commands and their results, git commit commands, subagent
#   results, compaction markers, checkpoint and session-end skill calls, and
#   trailmark reminders
# It prints commit subjects from the notes, the first 90 characters of each git
# commit command, and short command results. No other
# conversation text is printed. Nothing is changed.
# Log: check-trailmark-checkpoints.log next to this file.

param(
  [string]$Repo = '',
  [int]$Hours = 24,
  [int]$ActiveMinutes = 30,
  [int]$StaleMinutes = 60,
  [int]$FollowMinutes = 15,
  [int]$Timeline = 30,
  [string]$ProjectsDir = '',
  [switch]$NoPause
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$jbm  = [IO.Path]::Combine($root, '..', '..', 'plugins', 'trailmark', 'scripts', 'trailmark.js')
# The release layout keeps this script in tools\windows; an older layout kept it
# next to jb-memory-marketplace.
if (-not (Test-Path -LiteralPath $jbm -PathType Leaf)) { $jbm = [IO.Path]::Combine($root, 'jb-memory-marketplace', 'plugins', 'jb-memory', 'scripts', 'jbm.js') }
$jbm = [IO.Path]::GetFullPath($jbm)
# The repo to look at: -Repo, or the folder you run this from.
if (-not $Repo) { $Repo = (Get-Location).ProviderPath }
$log  = Join-Path $root 'check-trailmark-checkpoints.log'
if (-not $ProjectsDir) { $ProjectsDir = [IO.Path]::Combine([string]$env:USERPROFILE, '.claude', 'projects') }
$inv = [Globalization.CultureInfo]::InvariantCulture
$now = Get-Date
$since = $now.AddHours(-$Hours)
# commit-cmd: a git commit command run in a folder other than the session's,
# with no COMMIT ... in= or COMMIT_UNRESOLVED line from the hook next to it.
# Up to trailmark 0.3.2 the commit hook read HEAD from the session's folder,
# so it never logged those commits; the command is the only record of them.
# commit-unknown: a COMMIT_UNRESOLVED line (0.3.3): a commit whose folder the
# hook couldn't tell.
$milestoneKinds = @('commit', 'commit-cmd', 'commit-unknown', 'merge', 'subagent', 'compact')
# Subagent results count as milestones but don't make a session look stale on
# their own: the skill asks for a checkpoint only when they change the plan.
$openKinds = @('commit', 'commit-cmd', 'commit-unknown', 'merge', 'compact')
$hints = [ordered]@{ 'Commit landed.' = 'commit'; 'PR merge command finished.' = 'PR merge'; 'Subagent results came back.' = 'subagent' }
# The same test the commit hook uses (lib/commands.js): git, up to six global
# options with an optional value each, then the commit subcommand.
$W = '(?:[^\s"'']|"[^"]*"|''[^'']*'')+'
$commitRe = '\bgit\b(?:\s+-' + $W + '(?:\s+' + $W + ')?){0,6}\s+commit\b(?!-)'

Start-Transcript -Path $log -Force | Out-Null

function Step([string]$t) { Write-Host ''; Write-Host "=== $t" }
function Done([int]$code) {
  try { Stop-Transcript -ErrorAction Stop | Out-Null } catch { }
  if (-not $NoPause) { Write-Host ''; Read-Host 'Press Enter to close' | Out-Null }
  exit $code
}
function Short([string]$s, [int]$n) {
  $s = ($s -replace '\s+', ' ').Trim()
  if ($s.Length -gt $n) { $s = $s.Substring(0, $n) + '...' }
  return $s
}
function When($t) {
  if ($null -eq $t) { return 'unknown' }
  if ($t.Date -eq $now.Date) { return $t.ToString('HH:mm', $inv) }
  return $t.ToString('MM-dd HH:mm', $inv)
}
function Ago($t) {
  if ($null -eq $t) { return 'unknown' }
  return Span ($now - $t)
}
function Span([TimeSpan]$d) {
  $m = [int][Math]::Floor($d.TotalMinutes)
  if ($m -lt 0) { $m = 0 }
  if ($m -lt 60) { return "$m min" }
  if ($m -lt 2880) { return ('{0} h {1} min' -f [int][Math]::Floor($m / 60), ($m % 60)) }
  return ('{0} days' -f [int][Math]::Floor($m / 1440))
}
function FromMs($ms) {
  $n = [double]0
  if (-not [double]::TryParse([string]$ms, [Globalization.NumberStyles]::Float, $inv, [ref]$n) -or $n -le 0) { return $null }
  return [DateTimeOffset]::FromUnixTimeMilliseconds([long]$n).LocalDateTime
}
function FromIso([string]$s) {
  $d = [DateTime]::MinValue
  if ([DateTime]::TryParse($s, $inv, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$d)) { return $d.ToLocalTime() }
  return $null
}
# The entry's own timestamp is the last one on the line: message text comes
# before it, and timestamps inside text are escaped.
function LineTime([string]$line) {
  $ms = [regex]::Matches($line, '"timestamp":"(\d{4}-\d{2}-\d{2}T[^"]+)"')
  if ($ms.Count -eq 0) { return $null }
  return FromIso $ms[$ms.Count - 1].Groups[1].Value
}
# The first Node release of each line with the October 2026 security fixes
# (two of them in the permission model trailmark's sandbox uses). Same list
# as the plugin's lib/health.js.
function NodeAdvice([string]$v) {
  $m = [regex]::Match($v, '^v?(\d+)\.(\d+)\.(\d+)')
  if (-not $m.Success) { return '' }
  $have = [version]($m.Groups[1].Value + '.' + $m.Groups[2].Value + '.' + $m.Groups[3].Value)
  $floors = @{ 22 = '22.23.4'; 24 = '24.22.1'; 26 = '26.12.1' }
  $major = [int]$m.Groups[1].Value
  if ($floors.ContainsKey($major)) {
    if ($have -lt [version]$floors[$major]) { return ('Node ' + $v + ', older than the October 2026 security release for its line (' + $floors[$major] + ')') }
    return ''
  }
  if ($major -lt 22) { return ('Node ' + $v + ', which is out of support') }
  if ($major -lt 26 -and ($major % 2) -eq 1) { return ('Node ' + $v + ', which is not a long-term-support line') }
  return ''
}
function NewEvent($t, [string]$kind, [string]$text) { return [pscustomobject]@{ T = $t; Kind = $kind; Text = $text } }
function NormPath([string]$p) {
  $p = $p.Trim().Trim('"').Trim("'")
  if ($p -match '^/([a-zA-Z])(/.*)?$') { $p = $Matches[1] + ':' + $Matches[2] }
  $p = $p -replace '\\', '/'
  return $p.TrimEnd('/').ToLowerInvariant()
}
# A folder from a hook line's in="...": the hook writes % as %25, " as %22
# and | as %7C there.
function HookPath([string]$p) {
  return NormPath (($p -creplace '%22', '"' -creplace '%7C', '|') -creplace '%25', '%')
}
# The folder a git commit command ran in: its -C path, else the last cd before
# it, else '' (the session's own folder).
function CommitDir([string]$cmd) {
  $m = [regex]::Match($cmd, $commitRe)
  if (-not $m.Success) { return '' }
  $c = [regex]::Match($m.Value, '\s-C\s+("[^"]*"|''[^'']*''|\S+)')
  if ($c.Success) { return $c.Groups[1].Value.Trim('"').Trim("'") }
  $cds = [regex]::Matches($cmd.Substring(0, $m.Index), '(?:^|[;&|\n])\s*cd\s+("[^"]*"|''[^'']*''|[^\s;&|)]+)')
  if ($cds.Count) { return $cds[$cds.Count - 1].Groups[1].Value.Trim('"').Trim("'") }
  return ''
}
# The Updated line of a handoff file. write-handoff writes the local time,
# then " | " parts; memory-setup writes "(created by memory-setup)". A time
# marked UTC is read as UTC; Odd says how the line differs from either shape.
# The commands a Bash or PowerShell call runs, roughly: heredoc bodies and
# git -m messages taken out, then split at ; && || | and line ends. Text a
# command only mentions (a grep pattern, a commit message, a note) stays
# inside a segment that doesn't start with node.
function Segments([string]$cmd) {
  $t = $cmd -replace "`r", ''
  $t = [regex]::Replace($t, '(<<-?\s*["'']?([A-Za-z0-9_\-${}]+)["'']?)([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)', '$1$3')
  $t = [regex]::Replace($t, '(\s(?:-[a-zA-Z]*m|--message)(?:\s*|=))("[^"]*"|''[^'']*'')', '$1MSG')
  return @([regex]::Split($t, '&&|\|\||[;|\n]') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}
# The trailmark command a segment runs: node <trailmark.js or memory.js, or a
# variable holding its path> <subcommand>, after any VAR=value, time, command
# or exec, with node given by path or with options of its own. Returns
# @{ Sub; Path; Seg } or $null.
function JbmRun([string]$seg) {
  $m = [regex]::Match($seg, '^(?:\(\s*)?(?:(?:[A-Za-z_]\w*=\S*|time|command|exec|nohup)\s+)*(?:&\s*)?(?:"[^"]*node(?:\.exe)?"|''[^'']*node(?:\.exe)?''|(?:\S*[\\/])?node(?:\.exe)?)(?:\s+--?[A-Za-z][\w-]*(?:=\S+)?)*\s+("[^"]+"|''[^'']+''|(?:\\ |\S)+)\s+([a-z][a-z-]*)')
  if (-not $m.Success) { return $null }
  $p = $m.Groups[1].Value
  $p = $(if ($p -match '^["'']') { $p.Trim('"').Trim("'") } else { $p.Replace('\ ', ' ') })
  if ($p -notmatch '(?:jbm|memory)\.js$' -and $p -notmatch '^\$\{?(?:env:)?[A-Za-z_]\w*\}?$') { return $null }
  return @{ Sub = $m.Groups[2].Value; Path = $p; Seg = $seg }
}
# The trailmark.js (or memory.js) a write ran, when it isn't the installed
# plugin's: '' when it is, or when it can't be told (${CLAUDE_PLUGIN_ROOT},
# a variable set in an earlier command). A path written another way (a
# link, ~, /c/...) or a copy in Claude Code's plugin cache with the same
# content as the installed file counts as the installed one.
function OtherJbm([string]$p, [string]$cmd, [bool]$ps = $false) {
  if ($p -match '^\$\{?(?:env:)?([A-Za-z_]\w*)\}?$') {
    $name = $Matches[1]
    if ($name -eq 'CLAUDE_PLUGIN_ROOT') { return '' }
    # The last assignment in the command; PowerShell names ignore case.
    $opt = $(if ($ps) { [Text.RegularExpressions.RegexOptions]::IgnoreCase } else { [Text.RegularExpressions.RegexOptions]::None })
    $all = [regex]::Matches($cmd, '(?:^|[\s;&(])(?:export\s+)?(?:\$\{?(?:env:)?)?' + [regex]::Escape($name) + '\}?\s*=\s*("[^"]*"|''[^'']*''|[^\s;]+)', $opt)
    if (-not $all.Count) { return '' }
    $p = $all[$all.Count - 1].Groups[1].Value.Trim('"').Trim("'")
  }
  if ($p -match 'CLAUDE_PLUGIN_ROOT' -or $p -notmatch '^(?:[A-Za-z]:|/|~|\\\\)') { return '' }
  $mine = $(if ($p -match 'memory\.js$') { Join-Path (Split-Path -Parent $jbm) 'memory.js' } else { $jbm })
  if ((NormPath $p) -eq (NormPath $mine)) { return '' }
  # A network path is flagged without opening it: a hash would make Windows
  # connect to whatever server a transcript names.
  if ($p -match '^(?:\\\\|//)') { return $p }
  $f = $p
  if ($f -match '^~[\\/](.*)$') { $f = Join-Path ([string]$env:USERPROFILE) $Matches[1] }
  elseif ($f -match '^/([a-zA-Z])/(.*)$') { $f = $Matches[1] + ':/' + $Matches[2] }
  try {
    if ((Test-Path -LiteralPath $f -PathType Leaf) -and ((Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $mine -Algorithm SHA256).Hash)) { return '' }
  } catch { }
  return $p
}
# JSON string text as it reads, in one pass: \n, \r and \t as spaces, \uXXXX
# as ?, any other escaped character as itself (so C:\\nina stays C:\nina).
function Unescape([string]$s) {
  return [regex]::Replace($s, '\\(u[0-9a-fA-F]{4}|.)', { param($m) $c = $m.Groups[1].Value; if ($c -eq 'n' -or $c -eq 'r' -or $c -eq 't') { ' ' } elseif ($c.Length -eq 5) { '?' } else { $c } })
}
function Stamp([string]$file) {
  $lines = @(Get-Content -LiteralPath $file -Encoding UTF8 -ErrorAction SilentlyContinue)
  foreach ($l in $lines) {
    if ($l -match '^Updated:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(\s*UTC\b)?') {
      $t = [DateTime]::ParseExact($Matches[1], 'yyyy-MM-dd HH:mm', $inv)
      $utc = [bool]$Matches[2]
      if ($utc) { $t = [DateTime]::SpecifyKind($t, [DateTimeKind]::Utc).ToLocalTime() }
      $line = $l.Trim()
      $odd = ''
      if ($utc) { $odd = 'its time is marked UTC, which write-handoff never writes' }
      elseif ($line -notmatch '^Updated: \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: \| [^|]+)*$' -and $line -notmatch '^Updated: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(created by memory-setup\)$') { $odd = 'it is not in the shape write-handoff writes' }
      $sid = ''
      if ($line -match '(?i)\| session ([0-9a-f]{8})') { $sid = $Matches[1].ToLowerInvariant() }
      $by = $(if ($sid) { 'session ' + $sid } elseif ($line -match 'created by memory-setup') { 'memory-setup' } else { 'no session named' })
      return [pscustomobject]@{ T = $t; Sid = $sid; By = $by; Lines = $lines.Count; Line = $line; Odd = $odd }
    }
  }
  return $null
}

# ---------- memory folder ----------
Step 'Memory folder'
if (-not (Test-Path -LiteralPath $Repo)) { Write-Host ('  repo not found: ' + $Repo); Done 1 }
Push-Location -LiteralPath $Repo
$dirOut = @((& node $jbm dir 2>&1) | ForEach-Object { [string]$_ })
$statusOut = @((& node $jbm status 2>&1) | ForEach-Object { [string]$_ })
# Only the version line is kept from this: the handoff text isn't printed.
$handoffVersion = ''
foreach ($l in @((& node $jbm handoff 2>&1) | Select-Object -First 1)) { if ([string]$l -match 'handoff version: ([0-9a-f]{12}|none)') { $handoffVersion = $Matches[1] } }
Pop-Location
$memDir = $(if ($dirOut.Count) { $dirOut[0].Trim() } else { '' })
foreach ($l in $statusOut) { Write-Host ('  ' + $l) }
if (-not $memDir -or -not (Test-Path -LiteralPath (Join-Path $memDir '.jbmem.json'))) {
  Write-Host '  this repo is not set up for trailmark, or its memory folder was not found'
  Done 1
}

$state = $null
try { $state = Get-Content -LiteralPath (Join-Path $memDir '.jbmem-state.json') -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { }
if ($null -eq $state) { Write-Host '  no readable .jbmem-state.json, so no sessions to list'; Done 1 }

# Notes: "- HH:MM <text> session=<first 8 of the ID>", one file per local day.
$notes = New-Object System.Collections.ArrayList
$notesDir = Join-Path $memDir 'notes'
if (Test-Path -LiteralPath $notesDir) {
  foreach ($nf in @(Get-ChildItem -LiteralPath $notesDir -Filter '*.md' -File -ErrorAction SilentlyContinue)) {
    $day = [DateTime]::MinValue
    if (-not [DateTime]::TryParseExact($nf.BaseName, 'yyyy-MM-dd', $inv, [Globalization.DateTimeStyles]::None, [ref]$day)) { continue }
    if ($day -lt $since.Date) { continue }
    foreach ($ln in [IO.File]::ReadLines($nf.FullName)) {
      if ($ln -notmatch '^- (\d{2}):(\d{2}) (.+)$') { continue }
      $t = $day.AddHours([int]$Matches[1]).AddMinutes([int]$Matches[2])
      $body = $Matches[3]
      $sid = ''
      if ($body -match '(?i) session=([0-9a-f]{8})$') { $sid = $Matches[1].ToLowerInvariant(); $body = $body.Substring(0, $body.Length - 17) }
      [void]$notes.Add([pscustomobject]@{ T = $t; Sid = $sid; Text = $body })
    }
  }
}

# ---------- the handoff and its saved versions ----------
Step 'Handoff'
$handoffFile = Join-Path $memDir 'handoff.md'
$cur = $null
if (Test-Path -LiteralPath $handoffFile) { $cur = Stamp $handoffFile }
if ($cur) {
  Write-Host ('  current: ' + $cur.Line)
  Write-Host ('  written ' + (Ago $cur.T) + ' ago by ' + $cur.By + ', ' + $cur.Lines + ' lines')
  # Was this file written by write-handoff? Its Updated line, its version
  # against the one the state file says write-handoff saved last, and when the
  # file changed against when that write was recorded.
  $fileTime = (Get-Item -LiteralPath $handoffFile).LastWriteTime
  $lw = $state.lastWriter
  $lwAt = $(if ($lw) { FromMs $lw.at } else { $null })
  $lwVer = $(if ($lw -and ([string]$lw.version) -match '^[0-9a-f]{12}$') { [string]$lw.version } else { '' })
  $lwWho = $(if ($lw -and ([string]$lw.session) -match '^[0-9a-f]{8}') { 'session ' + ([string]$lw.session).Substring(0, 8) } else { 'no session named' })
  Write-Host ('  file last changed ' + (When $fileTime) + '; last write the state file records: ' + $(if ($lwAt) { $lwWho + ' at ' + (When $lwAt) + $(if ($lwVer) { ', version ' + $lwVer } else { '' }) } else { 'none' }) + '; version now: ' + $(if ($handoffVersion) { $handoffVersion } else { 'unknown' }))
  $odd = New-Object System.Collections.ArrayList
  if ($cur.Odd) { [void]$odd.Add('the Updated line: ' + $cur.Odd) }
  if ($lwVer -and $handoffVersion -and $handoffVersion -ne 'none' -and $lwVer -ne $handoffVersion) { [void]$odd.Add('the file is not the version write-handoff (or undo or rotate) last recorded (' + $lwVer + ')') }
  if ($lwAt -and ($fileTime - $lwAt).TotalSeconds -gt 5) {
    $gap = $fileTime - $lwAt
    [void]$odd.Add('the file changed ' + $(if ($gap.TotalMinutes -lt 1) { [string][int]$gap.TotalSeconds + ' s' } else { Span $gap }) + ' after that write')
  }
  if ($odd.Count) {
    Write-Host '  worth a look: something other than write-handoff may have written this file'
    foreach ($o in $odd) { Write-Host ('    - ' + $o) }
    Write-Host '    trace-handoff-writes.ps1 lists the tool calls that touched it around a given time.'
  }
  $after = @($notes | Where-Object { $_.Text -match '^COMMIT ' -and $_.T -gt $cur.T })
  if ($after.Count) {
    $who = @($after | ForEach-Object { $_.Sid } | Where-Object { $_ } | Sort-Object -Unique)
    Write-Host ('  commits logged since then: ' + $after.Count + $(if ($who.Count) { ' (by session ' + ($who -join ', ') + ')' } else { '' }))
  } else {
    Write-Host '  commits logged since then: none'
  }
} else {
  Write-Host '  no handoff.md, or no Updated line in it'
}
$versions = New-Object System.Collections.ArrayList
if ($cur) { [void]$versions.Add($cur) }
$histDir = [IO.Path]::Combine($memDir, 'archive', 'handoff-history')
if (Test-Path -LiteralPath $histDir) {
  foreach ($hf in @(Get-ChildItem -LiteralPath $histDir -Filter 'handoff-*.md' -File -ErrorAction SilentlyContinue)) {
    $s = Stamp $hf.FullName
    if ($s) { [void]$versions.Add($s) }
  }
}
# A rotate or undo keeps the Updated line, so the same version can be in the
# history more than once.
$seenLine = @{}
$distinct = @($versions | Sort-Object T -Descending | Where-Object { if ($seenLine.ContainsKey($_.Line)) { $false } else { $seenLine[$_.Line] = 1; $true } })
Write-Host ('  saved versions on record (the current one and up to 20 before it): ' + $distinct.Count)
foreach ($v in @($distinct | Select-Object -First 12)) {
  Write-Host ('    ' + (When $v.T).PadRight(12) + $v.By.PadRight(18) + $v.Lines + ' lines' + $(if ($v.Odd) { '  [Updated line not as write-handoff writes it]' } else { '' }))
}

$drops = @(Get-ChildItem -LiteralPath $memDir -Filter 'incoming-*.md' -File -ErrorAction SilentlyContinue)

# ---------- the commit log itself ----------
Step 'Log check'
$commitNotes = @($notes | Where-Object { $_.T -ge $since -and $_.Text -match '^COMMIT \S+' })
$bySha = @($commitNotes | Group-Object { ($_.Text -split ' ')[1] } | Where-Object { $_.Count -gt 1 } | Sort-Object Count -Descending)
$inOther = @($commitNotes | Where-Object { $_.Text -match '^COMMIT \S+ in="' }).Count
$unknownNotes = @($notes | Where-Object { $_.T -ge $since -and $_.Text -match '^COMMIT_UNRESOLVED ' })
$foundNotes = @($commitNotes | Where-Object { $_.Text -match ' \(found later\)$' })
$endNotes = @($notes | Where-Object { $_.T -ge $since -and $_.Text -match '^END_MISMATCH ' })
Write-Host ('  COMMIT lines in the window: ' + $commitNotes.Count + ', distinct SHAs: ' + @($commitNotes | ForEach-Object { ($_.Text -split ' ')[1] } | Sort-Object -Unique).Count + ', in another folder (in=): ' + $inOther)
if ($unknownNotes.Count) {
  $whys = @($unknownNotes | ForEach-Object { if ($_.Text -match 'why=(\S+)') { $Matches[1] } } | Group-Object | ForEach-Object { $_.Name + ' x' + $_.Count })
  Write-Host ('  COMMIT_UNRESOLVED lines (a commit whose folder the hook could not tell): ' + $unknownNotes.Count + ' (' + ($whys -join ', ') + ')')
}
if ($foundNotes.Count) {
  Write-Host ('  commits no hook logged, found later in a session''s folders (0.3.4): ' + $foundNotes.Count)
  foreach ($n in @($foundNotes | Select-Object -Last 5)) { Write-Host ('    ' + (When $n.T).PadRight(12) + 'session ' + $n.Sid + '  ' + (Short $n.Text 110)) }
}
if ($endNotes.Count) {
  $atStart = @($endNotes | Where-Object { $_.Text -match ' actual=start$' }).Count
  $atHome = @($endNotes | Where-Object { $_.Text -match ' actual=home$' }).Count
  Write-Host ('  END_MISMATCH lines (a command''s end folder as read, against where Claude Code says it ended): ' + $endNotes.Count + ' (session back where the command started: ' + $atStart + ', back in its own folder: ' + $atHome + ')')
  foreach ($n in @($endNotes | Select-Object -Last 5)) { Write-Host ('    ' + (When $n.T).PadRight(12) + 'session ' + $n.Sid + '  ' + (Short $n.Text 160)) }
}
if ($bySha.Count) {
  Write-Host '  SHAs logged more than once (each counts as one commit below):'
  foreach ($g in $bySha) {
    $who = @($g.Group | ForEach-Object { $_.Sid } | Where-Object { $_ } | Sort-Object -Unique)
    Write-Host ('    ' + $g.Name + ' x' + $g.Count + ', session ' + ($who -join ', ') + ', ' + ((@($g.Group | ForEach-Object { When $_.T })) -join ', '))
  }
} else {
  Write-Host '  no SHA logged more than once'
}

# ---------- transcripts ----------
function Read-Transcript([string]$file) {
  $ev = New-Object System.Collections.ArrayList
  $meta = @{ Entry = ''; Branch = ''; First = $null; Elsewhere = @{}; Home = '' }
  $pending = @{}
  $remKeys = @{}
  foreach ($line in [IO.File]::ReadLines($file)) {
    if (-not $meta.First -and $line.Contains('"timestamp":"')) { $meta.First = LineTime $line }
    if (-not $meta.Entry -and $line -match '"entrypoint":"([^"]+)"') { $meta.Entry = $Matches[1] }
    $gi = $line.IndexOf('"gitBranch":"')
    if ($gi -ge 0) {
      $gs = $gi + 13
      $ge = $line.IndexOf('"', $gs)
      if ($ge -gt $gs) { $meta.Branch = $line.Substring($gs, $ge - $gs) }
    }
    # The folder the session started in: the hook writes a commit there with
    # no in=, wherever the session has gone since.
    if (-not $meta.Home -and $line -match '"cwd":"((?:[^"\\]|\\.)*)"') { $meta.Home = $Matches[1] -replace '\\(["\\/])', '$1' }
    if ($line.Contains('"isSidechain":true')) { continue }

    # Results of the tool calls being followed. Matched on the raw line, so a
    # result too large to parse still counts.
    if ($pending.Count -gt 0 -and $line.Contains('tool_result')) {
      foreach ($id in @($pending.Keys)) {
        if (-not $line.Contains('"tool_use_id":"' + $id + '"')) { continue }
        $p = $pending[$id]
        $pending.Remove($id)
        $t = LineTime $line
        if ($null -eq $t) { $t = $p.T }
        if ($p.Kind -eq 'agent') {
          [void]$ev.Add((NewEvent $t 'subagent' ('subagent result' + $(if ($p.Desc) { ': ' + (Short $p.Desc 60) } else { '' }))))
          continue
        }
        if ($p.Kind -eq 'skillcall') {
          # A Skill call that came back as an error never loaded the skill.
          # Plain "checkpoint" is an alias of Claude Code's /rewind, and the
          # Skill tool refuses it as a CLI command: a session refused that
          # way once went looking for trailmark.js and ran an old copy.
          if ($line.Contains('"is_error":true') -or $line.Contains('not a skill')) {
            $why = ''
            if ($line -match '"(?:content|text)":"((?:[^"\\]|\\.){1,200})') { $why = Short ((Unescape $Matches[1]) -replace '</?tool_use_error>', '') 140 }
            $p.Ev.Kind = 'skill-refused'
            $p.Ev.Text = $p.Name + ' skill call refused' + $(if ($why) { ': ' + $why } else { '' })
            $hint = $(if ($p.Name -eq 'checkpoint') { ' (plain checkpoint is Claude Code''s /rewind; the skill is trailmark:checkpoint)' } elseif ($p.Name -notmatch ':') { ' (the skill is trailmark:' + $p.Name + ')' } else { '' })
            [void]$ev.Add((NewEvent $t 'oddskill' ('the Skill tool did not load ' + $p.Name + $hint + $(if ($why) { ': ' + $why } else { '' }))))
          }
          continue
        }
        if ($p.Kind -eq 'gitcommit') {
          # What git itself printed: "[<branch> <sha>] <subject>" for a new commit.
          $failedRun = $false
          if ($line -match '\[([^\[\]\s"{}\\]+(?: \([^)"\\]*\))?) ([0-9a-f]{7,40})\] ') { $what = 'git printed ' + $Matches[2] + ' on ' + $Matches[1] }
          elseif ($line.Contains('"is_error":true')) { $what = 'the command failed'; $failedRun = $true }
          elseif ($p.Quiet) { $what = 'quiet, so git printed no commit line' }
          else { $what = 'no commit line in the output' }
          $where = $(if ($p.Dir) { $p.Dir } else { 'the session folder' })
          $kind = $(if ($failedRun) { 'gitrun' } elseif ($p.Out) { 'commit-cmd' } else { 'gitrun' })
          $x = NewEvent $t $kind ('git commit in ' + (Short $where 60) + ' (' + $what + '): ' + (Short $p.Cmd 70))
          $x | Add-Member -NotePropertyName Dir -NotePropertyValue ([string]$p.Dir)
          [void]$ev.Add($x)
          continue
        }
        if ($p.Kind -eq 'undo') {
          $ok = $line.Contains('Restored the previous handoff')
          [void]$ev.Add((NewEvent $t 'undo' ('undo-handoff: ' + $(if ($ok) { 'restored the previous version' } else { 'refused or failed' }))))
          continue
        }
        $force = $(if ($p.Force) { ' (--force)' } else { '' })
        if ($line.Contains('handoff saved:')) {
          $size = ''
          if ($line -match 'handoff saved: (\d+) lines, (\d+) chars \(~(\d+) tokens\)') { $size = $Matches[1] + ' lines, ~' + $Matches[3] + ' tokens' }
          $arch = ''
          if ($line -match '\[done\] items: (\d+) archived') { $arch = ', ' + $Matches[1] + ' [done] archived' }
          if ($line.Contains('OVER BUDGET')) {
            [void]$ev.Add((NewEvent $t 'saved-over' ('checkpoint saved OVER BUDGET: ' + $size + $arch + $force)))
          } else {
            [void]$ev.Add((NewEvent $t 'saved' ('checkpoint saved: ' + $size + $arch + $force)))
          }
        } elseif ($line.Contains('REFUSED: the handoff changed')) {
          $by = ''
          if ($line -match 'Last written by session ([0-9a-f]{8})') { $by = ' by session ' + $Matches[1] }
          [void]$ev.Add((NewEvent $t 'refused' ('write refused (exit 3): handoff changed' + $by + ' after it was read')))
        } elseif ($line.Contains('another trailmark command is using') -or $line.Contains('could not create the lock file')) {
          [void]$ev.Add((NewEvent $t 'failed' 'write failed: memory folder lock busy'))
        } elseif ($line.Contains('write-handoff needs --base')) {
          [void]$ev.Add((NewEvent $t 'failed' 'write failed: no --base version given'))
        } elseif ($line.Contains('"is_error":true')) {
          $why = ''
          if ($line -match '"content":"((?:[^"\\]|\\.){0,160})') { $why = ': ' + (Short ($Matches[1] -replace '\\n', ' ') 120) }
          [void]$ev.Add((NewEvent $t 'failed' ('write failed' + $why)))
        } else {
          # The start of what came back, so the reason can be read here.
          $what = ''
          if ($line -match '"(?:content|text)":"((?:[^"\\]|\\.){1,160})') { $what = ': ' + (Short (Unescape $Matches[1]) 140) }
          [void]$ev.Add((NewEvent $t 'failed' ('write-handoff result not recognized' + $what)))
        }
        if ($p.Force) { [void]$ev.Add((NewEvent $t 'force' 'write-handoff ran with --force')) }
        if ($p.Other) { [void]$ev.Add((NewEvent $t 'oddwrite' ('write-handoff ran from ' + (Short $p.Other 120) + ', not the installed plugin''s trailmark.js (the skills run only their own path)'))) }
        elseif ($p.NoBase -and -not $p.Force -and $line.Contains('handoff saved:')) { [void]$ev.Add((NewEvent $t 'oddwrite' 'write-handoff saved without --base, so the version check was not made (the checkpoint skill always passes it; the installed trailmark.js refuses a write without it)')) }
      }
    }

    $want = $line.Contains('trailmark.js') -or $line.Contains('write-handoff') -or $line.Contains('undo-handoff') -or $line.Contains('compact_boundary') -or $line.Contains('[trailmark] ') -or
      $line.Contains('"name":"Agent"') -or $line.Contains('"name":"Task"') -or $line.Contains('"name":"Skill"') -or $line.Contains('<command-name>') -or
      (($line.Contains('"name":"Bash"') -or $line.Contains('"name":"PowerShell"')) -and $line.Contains('commit'))
    if (-not $want) { continue }
    $e = $null
    try { $e = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
    $t = LineTime $line

    if ($e.type -eq 'system' -and $e.subtype -eq 'compact_boundary') {
      $trig = ''
      if ($e.compactMetadata -and $e.compactMetadata.trigger) { $trig = ' (' + [string]$e.compactMetadata.trigger + ')' }
      [void]$ev.Add((NewEvent $t 'compact' ('compaction' + $trig)))
      continue
    }

    # Reminders from the PostToolUse hook arrive as hook attachments. One tool
    # call can leave more than one attachment carrying the same text.
    if ($e.type -eq 'attachment' -and $e.attachment -and ([string]$e.attachment.type) -like 'hook*') {
      foreach ($h in $hints.Keys) {
        if (-not $line.Contains('[trailmark] ' + $h)) { continue }
        $key = [string]$e.attachment.toolUseID
        if (-not $key) { $key = [string]$e.timestamp + $h }
        if ($remKeys.ContainsKey($key)) { break }
        $remKeys[$key] = 1
        [void]$ev.Add((NewEvent $t 'reminder' ('reminder after ' + $hints[$h])))
        break
      }
      continue
    }

    if ($e.type -eq 'user' -and $e.message -and $e.message.content -is [string]) {
      if ($e.message.content -match '<command-name>/?(?:trailmark:|jb-memory:)?(checkpoint|session-end)</command-name>') {
        [void]$ev.Add((NewEvent $t 'skill' ('/' + $Matches[1] + ' typed')))
      }
      continue
    }

    if ($e.type -ne 'assistant' -or -not $e.message -or -not $e.message.content) { continue }
    foreach ($c in @($e.message.content)) {
      if ($c.type -ne 'tool_use') { continue }
      $name = [string]$c.name
      if ($name -eq 'Bash' -or $name -eq 'PowerShell') {
        $cmd = [string]$c.input.command
        $jrun = @(Segments $cmd | ForEach-Object { JbmRun $_ } | Where-Object { $_ })
        if ($jrun.Count -eq 0) {
          if ($cmd -cmatch $commitRe) {
            $dir = CommitDir $cmd
            $out = $false
            if ($dir -match '^(?:[a-zA-Z]:|/)') {
              $nd = NormPath $dir; $nc = NormPath ([string]$e.cwd)
              $out = -not ($nc -and ($nd -eq $nc -or $nd.StartsWith($nc + '/')))
            } elseif ($dir -match '^\.\.') { $out = $true }
            if ($out) { $meta.Elsewhere[$dir] = 1 }
            $pending[[string]$c.id] = @{ Kind = 'gitcommit'; T = $t; Cmd = $cmd; Dir = $dir; Out = $out; Quiet = ($cmd -cmatch '\bcommit\b[^|;&]*\s(?:-[a-zA-Z]*q[a-zA-Z]*|--quiet)\b') }
          }
          continue
        }
        # Only a command that runs write-handoff (node, then trailmark.js or
        # memory.js or a variable holding its path, then write-handoff), not
        # one that mentions it in a grep, a note or a commit message.
        $wr = @($jrun | Where-Object { $_.Sub -eq 'write-handoff' })
        $ud = @($jrun | Where-Object { $_.Sub -eq 'undo-handoff' })
        if ($wr.Count) {
          $w = $wr[0]
          $pending[[string]$c.id] = @{ Kind = 'write'; T = $t; Force = ($w.Seg -match '(^|\s)--force\b'); NoBase = ($w.Seg -notmatch '(^|\s)--base='); Other = (OtherJbm $w.Path $cmd ($name -eq 'PowerShell')) }
        } elseif ($ud.Count) {
          $pending[[string]$c.id] = @{ Kind = 'undo'; T = $t }
        }
      } elseif ($name -eq 'Agent' -or $name -eq 'Task') {
        $pending[[string]$c.id] = @{ Kind = 'agent'; T = $t; Desc = [string]$c.input.description }
      } elseif ($name -eq 'Skill') {
        $sk = [string]$c.input.skill
        if ($sk -match '^(?:trailmark:|jb-memory:)?(checkpoint|session-end)$') {
          $x = NewEvent $t 'skill' ($Matches[1] + ' skill started')
          [void]$ev.Add($x)
          # Its result says whether the skill loaded (see 'skillcall' above).
          $pending[[string]$c.id] = @{ Kind = 'skillcall'; T = $t; Ev = $x; Name = $sk }
        }
      }
    }
  }
  foreach ($id in @($pending.Keys)) {
    $p = $pending[$id]
    if ($p.Kind -eq 'write') { [void]$ev.Add((NewEvent $p.T 'nores' 'write-handoff with no result recorded (still running, or interrupted)')) }
  }
  return [pscustomobject]@{ Events = $ev; Meta = $meta }
}

function Find-Transcript([string]$id, $rec) {
  if ($rec -and $rec.transcript -and (Test-Path -LiteralPath ([string]$rec.transcript))) { return [string]$rec.transcript }
  if (-not (Test-Path -LiteralPath $ProjectsDir)) { return '' }
  foreach ($d in @(Get-ChildItem -LiteralPath $ProjectsDir -Directory -ErrorAction SilentlyContinue)) {
    $f = Join-Path $d.FullName ($id + '.jsonl')
    if (Test-Path -LiteralPath $f) { return $f }
  }
  return ''
}

# ---------- sessions ----------
$sessions = New-Object System.Collections.ArrayList
if ($state.sessions) {
  foreach ($prop in $state.sessions.PSObject.Properties) {
    $id = ([string]$prop.Name).ToLowerInvariant()
    if ($id -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { continue }
    $rec = $prop.Value
    $tf = Find-Transcript $id $rec
    $lastAct = FromMs $rec.seen
    if ($tf) { $w = (Get-Item -LiteralPath $tf).LastWriteTime; if ($null -eq $lastAct -or $w -gt $lastAct) { $lastAct = $w } }
    if ($null -eq $lastAct -or $lastAct -lt $since) { continue }
    [void]$sessions.Add([pscustomobject]@{ Id = $id; Short = $id.Substring(0, 8); Rec = $rec; File = $tf; Last = $lastAct })
  }
}
$sessions = @($sessions | Sort-Object Last -Descending)
Step ('Sessions active in the last ' + $Hours + ' h: ' + $sessions.Count)
if ($sessions.Count -eq 0) { Write-Host '  none'; Done 0 }

$summary = New-Object System.Collections.ArrayList
foreach ($s in $sessions) {
  $active = ($now - $s.Last).TotalMinutes -le $ActiveMinutes
  $raw = New-Object System.Collections.ArrayList
  $meta = $null
  if ($s.File) {
    $r = Read-Transcript $s.File
    $meta = $r.Meta
    foreach ($x in $r.Events) { if ($null -ne $x.T) { [void]$raw.Add($x) } }
  }
  $haveCompact = @($raw | Where-Object { $_.Kind -eq 'compact' }).Count -gt 0
  $shaSeen = @{}
  # The Node the latest start ran on (see SESSION_START below). Two starts in
  # the same minute can come out in either order.
  $lastStartNode = ''; $lastStartAt = $null
  foreach ($n in @($notes | Where-Object { $_.Sid -eq $s.Short } | Sort-Object T)) {
    if ($n.Text -match '^COMMIT (\S+) ?(.*)$') {
      $sha = $Matches[1]; $rest = $Matches[2]; $in = ''
      if ($rest -match '^in="([^"]*)" ?(.*)$') { $in = $Matches[1]; $rest = $Matches[2] }
      $found = $rest -match ' \(found later\)$'
      if ($found) { $rest = $rest.Substring(0, $rest.Length - 14) }
      $subj = Short $rest 60
      if ($shaSeen.ContainsKey($sha)) { $x = NewEvent $n.T 'commit-again' ('commit ' + $sha + ' logged again (same SHA)') }
      elseif ($found) { $shaSeen[$sha] = 1; $x = NewEvent $n.T 'commit-found' ('commit ' + $sha + $(if ($in) { ' in ' + (Short $in 50) + ':' } else { '' }) + ' ' + $subj + ' [no hook logged it; found later]') }
      else { $shaSeen[$sha] = 1; $x = NewEvent $n.T 'commit' ('commit ' + $sha + $(if ($in) { ' in ' + (Short $in 50) + ':' } else { '' }) + ' ' + $subj) }
      $x | Add-Member -NotePropertyName In -NotePropertyValue $in
      [void]$raw.Add($x)
    }
    elseif ($n.Text -match '^COMMIT_UNRESOLVED why=(\S+)(?: in="([^"]*)")?') {
      $x = NewEvent $n.T 'commit-unknown' ('commit in a folder the hook could not tell (why=' + $Matches[1] + $(if ($Matches[2]) { ', ' + (Short $Matches[2] 50) } else { '' }) + ')')
      $x | Add-Member -NotePropertyName In -NotePropertyValue '?'
      [void]$raw.Add($x)
    }
    elseif ($n.Text -match '^END_MISMATCH tool=(\S+) parsed="([^"]*)" actual="([^"]*)"(.*)$') {
      $mTool = $Matches[1]; $mParsed = $Matches[2]; $mActual = $Matches[3]; $mRest = $Matches[4]
      $extra = $(if ($mRest -match 'actual=start') { ', where the command started' } elseif ($mRest -match 'actual=home') { ', the session''s own folder' } else { '' })
      [void]$raw.Add((NewEvent $n.T 'endcheck' ('end folder check (' + $mTool + '): read as ' + (Short $mParsed 50) + ', Claude Code says ' + (Short $mActual 50) + $extra)))
    }
    elseif ($n.Text -match '^PR_MERGE') { [void]$raw.Add((NewEvent $n.T 'merge' 'PR merge')) }
    elseif ($n.Text -match '^SESSION_START source=(\S+)') {
      [void]$raw.Add((NewEvent $n.T 'start' ('session start, source=' + $Matches[1])))
      # The Node that ran the hook, against the October 2026 security floor.
      # Notes are in the order written, so the last start read is the latest.
      $lastStartNode = ''
      if ($n.Text -match '\snode=(v\d+\.\d+\.\d+)') { $adv = NodeAdvice $Matches[1]; if ($adv) { $lastStartNode = 'session started on ' + $adv; [void]$raw.Add((NewEvent $n.T 'oldnode' $lastStartNode)) } }
      $lastStartAt = $n.T
    }
    elseif ($n.Text -match '^PRE_COMPACT' -and -not $haveCompact) { [void]$raw.Add((NewEvent $n.T 'compact' 'compaction (from the notes)')) }
  }
  # A git commit command in another folder that the hook logged is shown but
  # not counted again: the hook's line is the milestone. A command matches one
  # COMMIT ... in= line for its folder (or one under it), a COMMIT line with no
  # in= when its folder is the session's own (where the session started: a
  # session working in an added folder can cd back there), or one
  # COMMIT_UNRESOLVED line, up to 2 minutes after it, and each line matches
  # one command. Notes have whole minutes, so the window starts a minute and a
  # half early. A command whose folder isn't a full path matches an in= or
  # COMMIT_UNRESOLVED line by time.
  $homeN = $(if ($meta -and $meta.Home) { NormPath ([string]$meta.Home) } else { '' })
  $hookLines = @($raw | Where-Object { $_.Kind -eq 'commit' -or $_.Kind -eq 'commit-unknown' } | Sort-Object T)
  $used = New-Object 'bool[]' ($hookLines.Count + 1)
  foreach ($x in @($raw | Where-Object { $_.Kind -eq 'commit-cmd' } | Sort-Object T)) {
    $xd = [string]$x.Dir
    $full = $xd -match '^(?:[a-zA-Z]:|/)'
    $nd = $(if ($full) { NormPath $xd } else { '' })
    for ($i = 0; $i -lt $hookLines.Count; $i++) {
      if ($used[$i]) { continue }
      $h = $hookLines[$i]
      $d = ($h.T - $x.T).TotalMinutes
      if ($d -lt -1.5 -or $d -gt 2) { continue }
      if ($h.Kind -eq 'commit' -and -not $h.In) {
        if (-not ($full -and $homeN -and ($nd -eq $homeN -or $nd.StartsWith($homeN + '/')))) { continue }
      } elseif ($full -and $h.Kind -eq 'commit') {
        $ni = HookPath ([string]$h.In)
        if ($ni.StartsWith('...')) {
          # The hook keeps the last 157 characters of a folder longer than
          # 160 and starts it with ...: match that end, at a folder boundary.
          if (-not ($nd + '/').Contains($ni.Substring(3) + '/')) { continue }
        } elseif (-not ($nd -eq $ni -or $nd.StartsWith($ni + '/'))) { continue }
      }
      $used[$i] = $true
      $x.Kind = 'gitrun'
      $x.Text = $x.Text + ' [the hook logged it]'
      break
    }
  }
  # The state file keeps this session's last checkpoint time. If the
  # transcript scan missed that write (no transcript, or a format it doesn't
  # read), count it from there so "since the last checkpoint" stays right.
  $stLast = FromMs $s.Rec.lastWrite
  $stOnly = $false
  if ($stLast) {
    $near = @($raw | Where-Object { ($_.Kind -eq 'saved' -or $_.Kind -eq 'saved-over') -and [Math]::Abs(($_.T - $stLast).TotalMinutes) -le 2 })
    if ($near.Count -eq 0) {
      [void]$raw.Add((NewEvent $stLast 'saved' 'checkpoint saved (from the state file; not found in the transcript)'))
      $stOnly = $true
    }
  }
  # Sort, then drop exact repeats, and count compaction markers less than a
  # minute apart as one compaction.
  $all = New-Object System.Collections.ArrayList
  $lastCompact = $null
  $seenEv = @{}
  foreach ($x in @($raw | Sort-Object T)) {
    $k = $x.Kind + '|' + $x.T.ToString('o') + '|' + $x.Text
    if ($seenEv.ContainsKey($k)) { continue }
    $seenEv[$k] = 1
    if ($x.Kind -eq 'compact') {
      if ($lastCompact -and ($x.T - $lastCompact).TotalSeconds -lt 60) { continue }
      $lastCompact = $x.T
    }
    [void]$all.Add($x)
  }
  # Counts, flags and the timeline cover the window; the baseline (the last
  # checkpoint before an event) may come from before it.
  $ev = @($all | Where-Object { $_.T -ge $since })
  $isSave = { param($x) $x.Kind -eq 'saved' -or $x.Kind -eq 'saved-over' }
  $savedAll = @($all | Where-Object { & $isSave $_ })
  $saved = @($ev | Where-Object { & $isSave $_ })
  $miles = @($ev | Where-Object { $milestoneKinds -contains $_.Kind })
  $rems = @($ev | Where-Object { $_.Kind -eq 'reminder' })
  $lastSave = $(if ($savedAll.Count) { $savedAll[$savedAll.Count - 1].T } else { $null })
  # Compaction and late-checkpoint checks start no earlier than this session's
  # first recorded trailmark session start: a session opened before the plugin
  # was installed has no hooks or skills until it is resumed or reloaded.
  $scope = $since
  $recStart = FromMs $s.Rec.start
  if ($recStart -and $recStart -gt $scope) { $scope = $recStart }

  $started = FromMs $s.Rec.start
  if ($meta -and $meta.First -and ($null -eq $started -or $meta.First -lt $started)) { $started = $meta.First }
  $where = 'transcript not found'
  if ($s.File) {
    $dn = Split-Path -Leaf (Split-Path -Parent $s.File)
    $where = $(if ($dn -match '--claude-worktrees-(.+)$') { 'worktree ' + $Matches[1] } else { 'main checkout' })
  }
  $flags = New-Object System.Collections.ArrayList
  $late = New-Object System.Collections.ArrayList
  $notesOut = New-Object System.Collections.ArrayList

  Write-Host ''
  $status = $(if ($active) { 'ACTIVE, last activity ' + (Ago $s.Last) + ' ago' } else { 'idle since ' + (When $s.Last) + ' (' + (Ago $s.Last) + ')' })
  Write-Host ('--- session ' + $s.Short + '   ' + $status)
  $line2 = '  ' + $where
  if ($meta -and $meta.Branch) { $line2 += ', branch ' + $meta.Branch }
  if ($meta -and $meta.Entry) { $line2 += ', ' + $meta.Entry }
  Write-Host $line2
  Write-Host ('  started ' + (When $started) + $(if ($started) { ', ' + (Ago $started) + ' ago' } else { '' }))
  Write-Host ('  in the last ' + $Hours + ' h' + $(if ($scope -gt $since) { ' (compaction and late checks from ' + (When $scope) + ', its first trailmark session start)' } else { '' }) + ':')

  $cnt = @{}
  foreach ($k in $milestoneKinds) { $cnt[$k] = @($miles | Where-Object { $_.Kind -eq $k }).Count }
  $again = @($ev | Where-Object { $_.Kind -eq 'commit-again' }).Count
  Write-Host ('    milestones: ' + $cnt['commit'] + ' commit(s) logged, ' + $cnt['commit-unknown'] + ' in a folder the hook could not tell, ' + $cnt['commit-cmd'] + ' unlogged git commit command(s) in other folders, ' + $cnt['merge'] + ' PR merge(s), ' + $cnt['subagent'] + ' subagent result(s), ' + $cnt['compact'] + ' compaction(s)' +
    $(if ($again) { '; ' + $again + ' more COMMIT line(s) repeated a SHA already logged' } else { '' }))
  $refusedN = @($ev | Where-Object { $_.Kind -eq 'refused' }).Count
  $failedN = @($ev | Where-Object { $_.Kind -eq 'failed' }).Count
  Write-Host ('    checkpoints saved: ' + $saved.Count + $(if ($saved.Count) { ' (' + ((@($saved | ForEach-Object { When $_.T })) -join ', ') + ')' } else { '' }) +
    $(if ($refusedN) { '; refused: ' + $refusedN } else { '' }) + $(if ($failedN) { '; failed: ' + $failedN } else { '' }))
  $followed = 0
  foreach ($rm in $rems) {
    $hit = @($savedAll | Where-Object { $_.T -ge $rm.T -and ($_.T - $rm.T).TotalMinutes -le $FollowMinutes })
    if ($hit.Count) { $followed++ }
  }
  Write-Host ('    reminders: ' + $rems.Count + ' received, ' + $followed + ' followed by a checkpoint within ' + $FollowMinutes + ' min')

  # Since the last checkpoint (or the start, if none yet).
  $from = $(if ($lastSave) { $lastSave } else { $started })
  $open = @($all | Where-Object { $openKinds -contains $_.Kind -and ($null -eq $from -or $_.T -gt $from) })
  $openText = ''
  $label = @{ commit = 'commit(s)'; 'commit-cmd' = 'unlogged commit command(s) elsewhere'; 'commit-unknown' = 'commit(s) in an unknown folder'; merge = 'PR merge(s)'; compact = 'compaction(s)' }
  if ($open.Count) { $openText = ' (' + ((@($open | ForEach-Object { $_.Kind } | Group-Object | ForEach-Object { $_.Count.ToString() + ' ' + $label[$_.Name] })) -join ', ') + ')' }
  if ($lastSave) { Write-Host ('  last checkpoint: ' + (When $lastSave) + ', ' + (Ago $lastSave) + ' ago; commits, merges and compactions since: ' + $open.Count + $openText) }
  else { Write-Host ('  last checkpoint: none in this session; commits, merges and compactions since it started: ' + $open.Count + $openText) }

  # ---- what the checkpoint skill's rules say to look at ----
  $compactsAll = @($all | Where-Object { $_.Kind -eq 'compact' })
  for ($i = 0; $i -lt $compactsAll.Count; $i++) {
    $c = $compactsAll[$i]
    if ($c.T -lt $scope) { continue }
    $until = $(if ($i + 1 -lt $compactsAll.Count) { $compactsAll[$i + 1].T } else { $now.AddDays(1) })
    $after = @($savedAll | Where-Object { $_.T -ge $c.T -and $_.T -lt $until })
    if ($after.Count) { continue }
    $before = @($savedAll | Where-Object { $_.T -lt $c.T })
    $prev = $(if ($before.Count) { ' (last one before it: ' + (When $before[$before.Count - 1].T) + ')' } else { ' (none before it either)' })
    if ($active -and $i -eq $compactsAll.Count - 1 -and ($now - $c.T).TotalMinutes -lt $FollowMinutes) {
      [void]$notesOut.Add('compaction at ' + (When $c.T) + ', ' + (Ago $c.T) + ' ago: no checkpoint yet')
    } else {
      [void]$flags.Add('no checkpoint after the compaction at ' + (When $c.T) + $prev)
    }
  }
  foreach ($x in @($ev | Where-Object { $_.Kind -eq 'refused' -or $_.Kind -eq 'failed' -or $_.Kind -eq 'nores' })) {
    $later = @($savedAll | Where-Object { $_.T -gt $x.T })
    if ($later.Count -eq 0) { [void]$flags.Add($x.Text + ' at ' + (When $x.T) + ', and no checkpoint saved after it') }
  }
  foreach ($x in @($ev | Where-Object { $_.Kind -eq 'saved-over' })) {
    $later = @($savedAll | Where-Object { $_.T -gt $x.T -and $_.Kind -eq 'saved' })
    if ($later.Count -eq 0) { [void]$flags.Add('over-budget save at ' + (When $x.T) + ' never tightened (the skill says to rewrite it in the same turn)') }
  }
  foreach ($x in @($ev | Where-Object { $_.Kind -eq 'force' })) { [void]$flags.Add('write-handoff --force at ' + (When $x.T) + ' (the skill says never; it skips the version check)') }
  foreach ($x in @($ev | Where-Object { $_.Kind -eq 'oddwrite' -or $_.Kind -eq 'oddskill' })) { [void]$flags.Add('at ' + (When $x.T) + ': ' + $x.Text) }
  # Only the latest start counts: an old Node earlier in the window that has
  # since been updated is history.
  if ($lastStartNode -and $lastStartAt -and $lastStartAt -ge $since) { [void]$flags.Add('at ' + (When $lastStartAt) + ': ' + $lastStartNode + '; update Node') }
  if ($open.Count) {
    $oldest = $open[0].T
    if ($active -and ($now - $oldest).TotalMinutes -gt $StaleMinutes) {
      [void]$flags.Add($open.Count.ToString() + ' commit(s), merge(s) or compaction(s) since ' + $(if ($lastSave) { 'the last checkpoint' } else { 'the session started, with no checkpoint yet' }) + ', the oldest at ' + (When $oldest) + ' (' + (Ago $oldest) + ' ago)')
    } elseif (-not $active) {
      $ended = @($all | Where-Object { $_.Kind -eq 'skill' -and $_.Text -match 'session-end' -and ($null -eq $from -or $_.T -gt $from) }).Count -gt 0
      [void]$flags.Add('idle with ' + $open.Count + ' commit(s), merge(s) or compaction(s) after its last checkpoint' + $(if ($ended) { ' (session-end was started after it)' } else { ' (session-end not run)' }))
    }
  }
  foreach ($d in @($drops | Where-Object { $_.Name -like ('*' + $s.Id + '*') })) { [void]$flags.Add('drop file left behind: ' + $d.Name) }

  # Late checkpoints in the window: work that waited longer than -StaleMinutes
  # before a checkpoint covered it. History, not a current problem.
  $pendStart = $null; $pendN = 0
  foreach ($x in $all) {
    if (& $isSave $x) {
      if ($pendStart -and ($x.T - $pendStart).TotalMinutes -gt $StaleMinutes) {
        [void]$late.Add($pendN.ToString() + ' commit(s), merge(s) or compaction(s) from ' + (When $pendStart) + ' waited ' + (Span ($x.T - $pendStart)) + ' for the checkpoint at ' + (When $x.T))
      }
      $pendStart = $null; $pendN = 0
    } elseif ($openKinds -contains $x.Kind -and $x.T -ge $scope) {
      if (-not $pendStart) { $pendStart = $x.T }
      $pendN++
    }
  }

  # Cross-checks against the state file, in case the transcript format changed.
  if ($stOnly -and $s.File) {
    [void]$notesOut.Add('the checkpoint at ' + (When $stLast) + ' comes from the state file: the transcript scan did not find that write')
  }
  $stHint = FromMs $s.Rec.lastHintAt
  if ($stHint -and $stHint -ge $since -and $rems.Count -eq 0) {
    [void]$notesOut.Add('the state file records a reminder at ' + (When $stHint) + ' that the transcript scan did not find')
  }
  if (-not $s.File) { [void]$notesOut.Add('no transcript found, so only the notes and the state file were used') }
  $elseN = @($ev | Where-Object { $_.Kind -eq 'commit-cmd' }).Count
  if ($elseN -and $meta) {
    $allDirs = @($ev | Where-Object { $_.Kind -eq 'commit-cmd' } | ForEach-Object { $_.Dir } | Sort-Object -Unique)
    $dirs = @($allDirs | Select-Object -First 6)
    [void]$notesOut.Add($elseN.ToString() + ' git commit command(s) ran outside this session''s folder with no COMMIT line from the hook next to them (' + ($dirs -join ', ') + $(if ($allDirs.Count -gt 6) { ', ...' } else { '' }) + '). Up to trailmark 0.3.2 the commit hook read HEAD from the session''s folder, so it missed those commits and logged that folder''s HEAD again whenever another session committed in between; 0.3.3 logs them with in=. With 0.3.3 or later installed, a command here means git made no commit, or the hook did not run; 0.3.4 then logs the commit as (found later) at the next checkpoint or resume. They are counted here from the commands.')
  }

  if ($flags.Count) { Write-Host '  worth a look:'; foreach ($f in $flags) { Write-Host ('    - ' + $f) } }
  else { Write-Host '  worth a look: nothing' }
  if ($late.Count) { Write-Host ('  late checkpoints (over ' + $StaleMinutes + ' min after the work):'); foreach ($l in $late) { Write-Host ('    - ' + $l) } }
  foreach ($n in $notesOut) { Write-Host ('  note: ' + $n) }

  Write-Host '  timeline:'
  $shown = @($ev | Select-Object -Last $Timeline)
  if ($ev.Count -gt $shown.Count) { Write-Host ('    (' + ($ev.Count - $shown.Count) + ' earlier events in the window not shown; -Timeline ' + $ev.Count + ' shows all)') }
  if ($ev.Count -eq 0) { Write-Host '    nothing in the window' }
  foreach ($x in $shown) { Write-Host ('    ' + (When $x.T).PadRight(12) + $x.Text) }

  [void]$summary.Add([pscustomobject]@{
    Session = $s.Short
    Status = $(if ($active) { 'active' } else { 'idle' })
    Milestones = $miles.Count
    Checkpoints = $saved.Count
    Reminders = $(if ($rems.Count) { $followed.ToString() + '/' + $rems.Count } else { '0' })
    'Since last' = $(if ($lastSave) { Ago $lastSave } else { 'none yet' })
    Open = $open.Count
    Late = $late.Count
    Flags = $flags.Count
  })
}

$other = @($drops | Where-Object { $n = $_.Name; -not (@($sessions | Where-Object { $n -like ('*' + $_.Id + '*') }).Count) })
if ($other.Count) {
  Write-Host ''
  Write-Host ('Drop files not tied to a session listed above: ' + ((@($other | ForEach-Object { $_.Name })) -join ', '))
}

Step 'Summary'
$summary | Format-Table -AutoSize | Out-String -Width 160 | ForEach-Object { Write-Host $_.TrimEnd() }
Write-Host ('Milestones, Checkpoints, Reminders (followed/received) and Late cover the last ' + $Hours + ' h. Open = commits, PR merges and compactions since the session''s last checkpoint.')
Write-Host ('A session is active if it did something in the last ' + $ActiveMinutes + ' min.')
Done 0
