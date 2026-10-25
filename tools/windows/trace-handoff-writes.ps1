# trace-handoff-writes.ps1
# Read-only. Shows what touched a repo's jb-memory handoff in a time window:
# the tool calls in Claude Code transcripts that ran write-handoff (or any
# jbm.js or memory.js command) or wrote or edited a file named handoff*, each
# with the start of its result, and the jb-memory hook messages in the window.
# Beside them, from the memory folder: handoff.md's last change, the last
# write the state file records, the saved versions in archive\handoff-history
# changed near the window, and the log lines in it.
#
# Skill calls are shown too, with what each returned, and the skill text
# Claude Code brought in after it: the folder it names and its first jbm.js
# line, so you can see which jbm.js path the session was given.
#
# Use it when check-jb-checkpoints.ps1 says something other than write-handoff
# may have written the handoff. For example, for session f96570df between
# 01:14 and 01:17 on 2026-10-20:
#   .\trace-handoff-writes.ps1 -Session f96570df -Date 2026-10-20 -From 01:14 -To 01:17
# -AllSessions reads every transcript changed since the window opened instead
# of one session's, and shows only the calls above.
#
# What it reads: the memory folder (found with jbm.js dir, as the checker does)
# and transcripts under %USERPROFILE%\.claude\projects. It prints the first 400
# characters of each matching command and of its result, the file path and any
# Updated: line of each matching Write or Edit, and, for -Session alone, the
# tool name and first 100 characters of the other tool calls in the window.
# No other conversation text is printed. Nothing in the repo, its memory
# folder or the transcripts is changed.
# Log: trace-handoff-writes.log next to this file. It keeps everything printed,
# command and result text included, until the next run replaces it; delete it
# when you're done if that text shouldn't stay on disk.

param(
  [Parameter(Mandatory = $true)][string]$Session,
  [string]$Date = '',
  [string]$From = '00:00',
  [string]$To = '23:59',
  [string]$Repo = '',
  [string]$ProjectsDir = '',
  [switch]$AllSessions,
  [switch]$NoPause
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$jbm  = [IO.Path]::Combine($root, '..', '..', 'plugins', 'jb-memory', 'scripts', 'jbm.js')
# The release layout keeps this script in tools\windows; an older layout kept it
# next to jb-memory-marketplace.
if (-not (Test-Path -LiteralPath $jbm -PathType Leaf)) { $jbm = [IO.Path]::Combine($root, 'jb-memory-marketplace', 'plugins', 'jb-memory', 'scripts', 'jbm.js') }
$jbm = [IO.Path]::GetFullPath($jbm)
# The repo to look at: -Repo, or the folder you run this from.
if (-not $Repo) { $Repo = (Get-Location).ProviderPath }
$log  = Join-Path $root 'trace-handoff-writes.log'
if (-not $ProjectsDir) { $ProjectsDir = [IO.Path]::Combine([string]$env:USERPROFILE, '.claude', 'projects') }
$inv = [Globalization.CultureInfo]::InvariantCulture

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
# JSON string text as it reads: \n, \r and \t as spaces, \" and \\ as themselves.
function Unescape([string]$s) {
  # One pass, so a Windows path keeps its \n... folder names (C:\\nina).
  return [regex]::Replace($s, '\\(u[0-9a-fA-F]{4}|.)', { param($m) $c = $m.Groups[1].Value; if ($c -eq 'n' -or $c -eq 'r' -or $c -eq 't') { ' ' } elseif ($c.Length -eq 5) { '?' } else { $c } })
}
function FromMs($ms) {
  $n = [double]0
  if (-not [double]::TryParse([string]$ms, [Globalization.NumberStyles]::Float, $inv, [ref]$n) -or $n -le 0) { return $null }
  return [DateTimeOffset]::FromUnixTimeMilliseconds([long]$n).LocalDateTime
}
function LineTime([string]$line) {
  $ms = [regex]::Matches($line, '"timestamp":"(\d{4}-\d{2}-\d{2}T[^"]+)"')
  if ($ms.Count -eq 0) { return $null }
  $d = [DateTime]::MinValue
  if ([DateTime]::TryParse($ms[$ms.Count - 1].Groups[1].Value, $inv, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$d)) { return $d.ToLocalTime() }
  return $null
}
function T([DateTime]$t) { return $t.ToString('MM-dd HH:mm:ss', $inv) }

$Session = $Session.Trim().ToLowerInvariant()
if ($Session -notmatch '^[0-9a-f]{4,36}$' -and -not $AllSessions) { Write-Host ('  -Session takes a session ID or the start of one (hex digits), not "' + $Session + '"'); Done 1 }
$day = [DateTime]::Today
if ($Date) {
  if (-not [DateTime]::TryParseExact($Date, 'yyyy-MM-dd', $inv, [Globalization.DateTimeStyles]::None, [ref]$day)) { Write-Host ('  -Date takes yyyy-MM-dd, not "' + $Date + '"'); Done 1 }
}
$fromT = [TimeSpan]::Zero; $toT = [TimeSpan]::Zero
if (-not [TimeSpan]::TryParseExact($From, 'hh\:mm', $inv, [ref]$fromT) -or -not [TimeSpan]::TryParseExact($To, 'hh\:mm', $inv, [ref]$toT)) { Write-Host '  -From and -To take HH:mm'; Done 1 }
$lo = $day.Add($fromT)
$hi = $day.Add($toT).AddSeconds(59)
if ($hi -lt $lo) { $hi = $hi.AddDays(1) }
Write-Host ('window: ' + (T $lo) + ' to ' + (T $hi) + ' local time' + $(if ($AllSessions) { ', all sessions' } else { ', session ' + $Session }))

# ---------- memory folder ----------
Step 'Memory folder'
$memDir = ''
if ((Test-Path -LiteralPath $Repo) -and (Test-Path -LiteralPath $jbm)) {
  Push-Location -LiteralPath $Repo
  $dirOut = @((& node $jbm dir 2>&1) | ForEach-Object { [string]$_ })
  Pop-Location
  if ($dirOut.Count) { $memDir = $dirOut[0].Trim() }
}
if (-not $memDir -or -not (Test-Path -LiteralPath $memDir)) {
  Write-Host ('  memory folder not found for ' + $Repo + '; transcripts only')
} else {
  Write-Host ('  ' + $memDir)
  $hf = Join-Path $memDir 'handoff.md'
  if (Test-Path -LiteralPath $hf) {
    $upd = @(Get-Content -LiteralPath $hf -Encoding UTF8 | Where-Object { $_ -match '^Updated:' } | Select-Object -First 1)
    Write-Host ('  handoff.md last changed ' + (T (Get-Item -LiteralPath $hf).LastWriteTime) + '; ' + $(if ($upd.Count) { $upd[0] } else { 'no Updated line' }))
  }
  $pf = Join-Path $memDir 'handoff.prev.md'
  if (Test-Path -LiteralPath $pf) { Write-Host ('  handoff.prev.md last changed ' + (T (Get-Item -LiteralPath $pf).LastWriteTime) + ' (write-handoff, undo and rotate keep the version before theirs here)') }
  $state = $null
  try { $state = Get-Content -LiteralPath (Join-Path $memDir '.jbmem-state.json') -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { }
  if ($state -and $state.lastWriter) {
    $w = $state.lastWriter
    $what = $(if ($w.undo) { 'undo-handoff' } elseif ($w.rotate) { 'rotate' } else { 'write-handoff' })
    $wAt = FromMs $w.at
    Write-Host ('  last write the state file records: ' + $what + ' by session ' + (([string]$w.session) -replace '^(.{8}).*$', '$1') + ' at ' + $(if ($wAt) { T $wAt } else { 'unknown' }) + ', version ' + [string]$w.version)
  } else { Write-Host '  the state file records no handoff write' }
  $hist = [IO.Path]::Combine($memDir, 'archive', 'handoff-history')
  if (Test-Path -LiteralPath $hist) {
    $near = @(Get-ChildItem -LiteralPath $hist -Filter 'handoff-*.md' -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $lo.AddMinutes(-10) -and $_.LastWriteTime -le $hi.AddMinutes(10) } | Sort-Object LastWriteTime)
    Write-Host ('  saved versions in archive\handoff-history changed within 10 min of the window: ' + $near.Count)
    foreach ($f in $near) {
      $u = @(Get-Content -LiteralPath $f.FullName -Encoding UTF8 | Where-Object { $_ -match '^Updated:' } | Select-Object -First 1)
      Write-Host ('    ' + (T $f.LastWriteTime) + '  ' + $f.Name + '  ' + $(if ($u.Count) { $u[0] } else { 'no Updated line' }))
    }
  }
  # Log lines carry whole minutes, so the window is taken to the minute.
  $nf = [IO.Path]::Combine($memDir, 'notes', $day.ToString('yyyy-MM-dd', $inv) + '.md')
  if (Test-Path -LiteralPath $nf) {
    $inWin = @(Get-Content -LiteralPath $nf -Encoding UTF8 | Where-Object { $_ -match '^- (\d{2}):(\d{2}) ' -and $day.AddHours([int]$Matches[1]).AddMinutes([int]$Matches[2]) -ge $lo.AddSeconds(-59) -and $day.AddHours([int]$Matches[1]).AddMinutes([int]$Matches[2]) -le $hi })
    Write-Host ('  log lines in the window: ' + $inWin.Count)
    foreach ($l in $inWin) { Write-Host ('    ' + (Short $l 200)) }
  }
}

# ---------- transcripts ----------
Step 'Transcripts'
if (-not (Test-Path -LiteralPath $ProjectsDir)) { Write-Host ('  no ' + $ProjectsDir); Done 1 }
if ($AllSessions) {
  $files = @(Get-ChildItem -LiteralPath $ProjectsDir -Recurse -File -Filter '*.jsonl' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $lo })
} else {
  $files = @(Get-ChildItem -LiteralPath $ProjectsDir -Recurse -File -Filter ($Session + '*.jsonl') -ErrorAction SilentlyContinue)
}
Write-Host ('  transcripts to read: ' + $files.Count)
if ($files.Count -eq 0) { Write-Host '  none found'; Done 0 }

$relCmd = '(?i)write-handoff|undo-handoff|\brotate\b|jbm\.js|memory\.js|handoff[^\s"''/\\]*\.md'
$found = 0
foreach ($f in $files) {
  $sid = ''
  if ($f.BaseName -match '^([0-9a-f]{8})') { $sid = $Matches[1] }
  $pending = @{}
  $shown = New-Object System.Collections.ArrayList
  foreach ($line in [IO.File]::ReadLines($f.FullName)) {
    if (-not $line.Contains('"timestamp":"')) { continue }
    $t = LineTime $line
    if ($null -eq $t -or $t -lt $lo -or $t -gt $hi) { continue }
    $where = (T $t) + '  ' + $(if ($sid) { $sid } else { $f.BaseName }) + '  '
    # Results of the calls being followed, matched on the raw line.
    if ($pending.Count -gt 0 -and $line.Contains('tool_result')) {
      foreach ($id in @($pending.Keys)) {
        if (-not $line.Contains('"tool_use_id":"' + $id + '"')) { continue }
        $pending.Remove($id)
        $err = $line.Contains('"is_error":true')
        $text = ''
        if ($line -match '"tool_use_id":"' + [regex]::Escape($id) + '"[^{}]*?"content":"((?:[^"\\]|\\.){0,400})') { $text = $Matches[1] }
        elseif ($line -match '"(?:content|text)":"((?:[^"\\]|\\.){0,400})') { $text = $Matches[1] }
        [void]$shown.Add($where + '  result' + $(if ($err) { ' (error)' } else { '' }) + ': ' + (Short (Unescape $text) 400))
      }
    }
    # The text a skill brought in (Claude Code adds it as a message of its
    # own, headed "Base directory for this skill"): which jbm.js path the
    # session was given.
    if (-not $line.Contains('tool_result') -and -not $line.Contains('"isCompactSummary":true') -and ($line.Contains('Base directory for this skill') -or ($line.Contains('"isMeta":true') -and $line.Contains('jbm.js')))) {
      $dirText = ''; $jbmText = ''
      if ($line -match 'Base directory for this skill: ((?:[^"\\]|\\[^n]){1,300})') { $dirText = Unescape $Matches[1] }
      if ($line -match '(?:"|\\n)((?:[^"\\]|\\[^n]){0,200}jbm\.js(?:[^"\\]|\\[^n]){0,60})') { $jbmText = Unescape $Matches[1] }
      [void]$shown.Add($where + '>> skill text: base folder ' + $(if ($dirText) { Short $dirText 200 } else { 'not named' }) + '; first jbm.js line: ' + $(if ($jbmText) { Short $jbmText 200 } else { 'none' }))
      $found++
      continue
    }
    if ($line.Contains('[jb-memory] ') -and $line.Contains('"attachment"')) {
      if ($line -match '\[jb-memory\] ((?:[^"\\]|\\.){0,160})') { [void]$shown.Add($where + 'hook message: [jb-memory] ' + (Short (Unescape $Matches[1]) 160)) }
      continue
    }
    if (-not $line.Contains('"tool_use"')) { continue }
    $e = $null
    try { $e = $line | ConvertFrom-Json -ErrorAction Stop } catch { $e = $null }
    if ($null -eq $e) {
      # Too large or odd to parse: report it if it looks relevant.
      if ($line -match $relCmd) { [void]$shown.Add($where + 'a tool call that mentions the handoff (line not readable as JSON): ' + (Short $line 200)) }
      continue
    }
    if ($e.type -ne 'assistant' -or -not $e.message -or -not $e.message.content) { continue }
    foreach ($c in @($e.message.content)) {
      if ($c.type -ne 'tool_use') { continue }
      $name = [string]$c.name
      $in = $c.input
      $rel = $false; $detail = ''
      if ($name -eq 'Bash' -or $name -eq 'PowerShell') {
        $cmd = [string]$in.command
        $rel = $cmd -match $relCmd
        $detail = $(if ($rel) { Short $cmd 400 } else { Short $cmd 100 })
      } elseif ($name -match '^(Write|Edit|MultiEdit|NotebookEdit)$') {
        $fp = [string]$in.file_path
        if (-not $fp) { $fp = [string]$in.notebook_path }
        $rel = $fp -match '(?i)handoff'
        $detail = $fp
        if ($rel) {
          $bodies = @([string]$in.content, [string]$in.new_string) + @($in.edits | ForEach-Object { [string]$_.new_string })
          $u = @($bodies | ForEach-Object { $_ -split "`n" } | Where-Object { $_ -match '^Updated:' } | Select-Object -First 2)
          if ($u.Count) { $detail += '; Updated line written: ' + (($u | ForEach-Object { Short $_ 160 }) -join ' / ') }
          if ($in.content) { $detail += '; ' + @(([string]$in.content) -split "`n").Count + ' lines' }
        }
      } elseif ($name -eq 'Skill') {
        # Which skill, and (below) what the call returned.
        $rel = $true
        $detail = (Short ([string]$in.skill) 80) + $(if ($in.args) { ' ' + (Short ([string]$in.args) 80) } else { '' })
      } else {
        $raw = ($in | ConvertTo-Json -Compress -Depth 4)
        $rel = $raw -match '(?i)handoff\.md|write-handoff'
        $detail = $(if ($rel) { Short $raw 300 } else { '' })
      }
      if ($rel) {
        $pending[[string]$c.id] = 1
        $found++
        [void]$shown.Add($where + '>> ' + $name + ': ' + $detail)
      } elseif (-not $AllSessions) {
        [void]$shown.Add($where + '   ' + $name + $(if ($detail) { ': ' + $detail } else { '' }))
      }
    }
  }
  foreach ($id in @($pending.Keys)) { [void]$shown.Add('                        (no result recorded in the window for one of the calls above)') }
  if ($shown.Count) {
    Write-Host ''
    Write-Host ('--- ' + $f.FullName)
    foreach ($s in $shown) { Write-Host ('  ' + $s) }
  }
}

Step 'Summary'
Write-Host ('  skill calls and texts, and calls that ran a jb-memory command or wrote a handoff file, in the window (marked >>): ' + $found)
Write-Host '  A Write or Edit of handoff.md, or a jbm.js command run with another memory folder, is how a handoff gets an Updated line write-handoff did not write.'
Done 0
