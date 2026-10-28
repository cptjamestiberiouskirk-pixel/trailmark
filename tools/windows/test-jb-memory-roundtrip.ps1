# test-jb-memory-roundtrip.ps1
# Shows jb-memory doing its actual job, in a throwaway repo. It runs two passes,
# one with Claude pinned to the Bash tool and one pinned to the PowerShell tool:
#   1. Session one runs the checkpoint skill (/jb-memory:checkpoint) with a
#      made-up state: a decision, a next action and a marker word.
#   2. Session two is a brand-new session with no tools at all. It is asked
#      what the saved state says. The only way it can know is the handoff the
#      start hook injected.
# Each pass checks what the skill wrote, that the previous handoff was kept,
# that the Updated line carries the real clock time and git HEAD, and what
# session two answered. Session one's tool calls are listed, so the log shows
# which shell wrote the handoff. No real repo's memory is touched.
#
# Session one gets the Skill tool plus node, git status and git log through the
# pinned shell only; the PowerShell pass also gets the Write tool, because the
# skill sends the handoff as a file there. Session two gets no tools. Four short calls to the model
# below (default Sonnet 5.5).
#
# The throwaway repo (jbm-roundtrip-<time> in the temp folder, outside the
# folder jb-watchdog watches) and its %USERPROFILE%\.claude\projects folder
# are deleted at the end unless you pass -Keep. Log:
# test-jb-memory-roundtrip.log next to this file.

param([switch]$Keep, [string]$Model = 'claude-sonnet-5-5')

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$root  = Split-Path -Parent $MyInvocation.MyCommand.Path
$jbm   = [IO.Path]::Combine($root, '..', '..', 'plugins', 'jb-memory', 'scripts', 'jbm.js')
# The release layout keeps this script in tools\windows; an older layout kept it
# next to jb-memory-marketplace.
if (-not (Test-Path -LiteralPath $jbm -PathType Leaf)) { $jbm = [IO.Path]::Combine($root, 'jb-memory-marketplace', 'plugins', 'jb-memory', 'scripts', 'jbm.js') }
$jbm = [IO.Path]::GetFullPath($jbm)
$log   = Join-Path $root 'test-jb-memory-roundtrip.log'
$workRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$repo  = Join-Path $workRoot ('jbm-roundtrip-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$projectsDir = [IO.Path]::Combine($env:USERPROFILE, '.claude', 'projects')
$results = New-Object System.Collections.ArrayList
$memDir = $null
foreach ($v in 'JBMEM_NESTED', 'JBMEM_DIR', 'JBMEM_METHOD', 'JBMEM_ROOT', 'JBMEM_GIT', 'CLAUDE_CODE_PROJECT_DIR_NAME') {
  Remove-Item ('Env:' + $v) -ErrorAction SilentlyContinue
}

Start-Transcript -Path $log -Force | Out-Null

function Step([string]$t) { Write-Host ''; Write-Host "=== $t" }
function Result([string]$check, [string]$status, [string]$detail) {
  [void]$results.Add([pscustomobject]@{ Result = $status; Check = $check; Detail = $detail })
  Write-Host ('  ' + $status.PadRight(6) + $check + '   ' + $detail)
}
function Notes {
  if (-not $memDir) { return @() }
  $d = Join-Path $memDir 'notes'
  if (-not (Test-Path -LiteralPath $d)) { return @() }
  return @(Get-ChildItem -LiteralPath $d -Filter '*.md' | ForEach-Object { Get-Content -LiteralPath $_.FullName })
}
function ShortHead {
  Push-Location $repo
  $h = [string](& git rev-parse --short HEAD 2>$null)
  Pop-Location
  return $h.Trim()
}
function Invoke-Claude([string]$prompt, [string[]]$extra) {
  # No double quotes in prompts: Windows PowerShell 5.1 does not escape them for native programs.
  $argList = @('-p', $prompt, '--model', $Model) + $extra
  Write-Host ('  > claude -p <prompt> --model ' + $Model + ' ' + ($extra -join ' '))
  Push-Location $repo
  $out = ((& claude @argList 2>&1) | ForEach-Object { [string]$_ }) -join "`n"
  $code = $LASTEXITCODE
  Pop-Location
  foreach ($l in ($out -split "`n")) { Write-Host ('    ' + $l) }
  Write-Host ('    [exit ' + $code + ']')
  return $out
}
# Like Invoke-Claude, but captures the event stream to list the tools Claude
# called. Returns the final reply text.
function Invoke-ClaudeTraced([string]$prompt, [string[]]$extra) {
  $argList = @('-p', $prompt, '--model', $Model, '--output-format', 'stream-json', '--verbose') + $extra
  Write-Host ('  > claude -p <prompt> --model ' + $Model + ' --output-format stream-json ' + ($extra -join ' '))
  Push-Location $repo
  $lines = @(& claude @argList 2>$null)
  $code = $LASTEXITCODE
  Pop-Location
  $result = ''
  $uses = New-Object System.Collections.ArrayList
  $outcomes = @{}
  foreach ($l in $lines) {
    $s = [string]$l
    if (-not $s.Trim()) { continue }
    $ev = $null
    try { $ev = $s | ConvertFrom-Json -ErrorAction Stop } catch { continue }
    if ($ev.type -eq 'result') { $result = [string]$ev.result }
    if (-not $ev.message -or -not $ev.message.content) { continue }
    foreach ($c in @($ev.message.content)) {
      if ($c.type -eq 'tool_use') {
        $what = ''
        if ($c.input.command) { $what = [string]$c.input.command }
        elseif ($c.input.skill) { $what = [string]$c.input.skill }
        elseif ($c.input.file_path) { $what = 'file ' + [string]$c.input.file_path }
        $what = ($what -replace '\s+', ' ')
        if ($what.Length -gt 140) { $what = $what.Substring(0, 140) + '...' }
        [void]$uses.Add([pscustomobject]@{ Id = [string]$c.id; Tool = [string]$c.name; What = $what })
      } elseif ($c.type -eq 'tool_result') {
        $txt = ''
        if ($c.content -is [string]) { $txt = $c.content }
        else { $txt = (@($c.content) | Where-Object { $_.type -eq 'text' } | ForEach-Object { [string]$_.text }) -join ' ' }
        $txt = ($txt -replace '\s+', ' ').Trim()
        if ($txt.Length -gt 180) { $txt = $txt.Substring(0, 180) + '...' }
        $outcomes[[string]$c.tool_use_id] = $(if ($c.is_error) { 'ERROR: ' } else { 'ok: ' }) + $txt
      }
    }
  }
  # Each call with what it returned, so a refused command shows its own message.
  if ($uses.Count -eq 0) { Write-Host '    (no tool calls seen in the stream)' }
  foreach ($u in $uses) {
    Write-Host ('    tool ' + $u.Tool + ': ' + $u.What)
    $o = $outcomes[$u.Id]
    Write-Host ('        -> ' + $(if ($o) { $o } else { '(no result recorded)' }))
  }
  foreach ($r in ($result -split "`n")) { Write-Host ('    ' + $r) }
  Write-Host ('    [exit ' + $code + ']')
  return $result
}
function Show-File([string]$label, [string]$path) {
  Write-Host ('  --- ' + $label)
  if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path | ForEach-Object { Write-Host ('  | ' + $_) } }
  else { Write-Host '  | (missing)' }
}
function Remove-Tree([string]$p) {
  # Links are removed as links first (the folder itself, or any link inside),
  # so the recursive delete below never follows one out of the throwaway
  # folder: claude -p ran tools in it, and Windows PowerShell 5.1 can follow
  # a junction while deleting. A link that won't go stops the delete.
  try {
    $top = Get-Item -LiteralPath $p -Force -ErrorAction Stop
    if ((([int]$top.Attributes) -band 0x400) -ne 0) {
      if ($top.PSIsContainer) { [IO.Directory]::Delete($top.FullName, $false) } else { [IO.File]::Delete($top.FullName) }
      return -not (Test-Path -LiteralPath $p)
    }
  } catch { return -not (Test-Path -LiteralPath $p) }
  $stack = New-Object System.Collections.Stack
  $stack.Push($p)
  while ($stack.Count -gt 0) {
    $d = [string]$stack.Pop()
    foreach ($c in @(Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue)) {
      if ((([int]$c.Attributes) -band 0x400) -ne 0) {
        try { if ($c.PSIsContainer) { [IO.Directory]::Delete($c.FullName, $false) } else { [IO.File]::Delete($c.FullName) } } catch { return $false }
      } elseif ($c.PSIsContainer) { $stack.Push($c.FullName) }
    }
  }
  Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $p) { & cmd.exe /d /c rmdir /s /q "$p" 2>&1 | Out-Null }
  return -not (Test-Path -LiteralPath $p)
}
function Finish([int]$code) {
  Step 'Summary'
  if ($results.Count -gt 0) { $results | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host }
  Step 'Cleanup'
  $leaf = Split-Path -Leaf $repo
  $keyDirs = @()
  if ($leaf -match '^jbm-roundtrip-\d{8}-\d{6}$') {
    $keyDirs = @(Get-ChildItem -LiteralPath $projectsDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name.EndsWith($leaf) } | ForEach-Object { $_.FullName })
  }
  if ($Keep) {
    Write-Host ('  kept (-Keep): ' + $repo)
    foreach ($k in $keyDirs) { Write-Host ('  kept (-Keep): ' + $k) }
  } else {
    foreach ($k in $keyDirs) { if (Remove-Tree $k) { Write-Host ('  removed  ' + $k) } else { Write-Host ('  FAILED   ' + $k) } }
    if ((Test-Path -LiteralPath $repo) -and ($leaf -match '^jbm-roundtrip-') -and ((Split-Path -Parent $repo) -eq $workRoot)) {
      if (Remove-Tree $repo) { Write-Host ('  removed  ' + $repo) } else { Write-Host ('  FAILED   ' + $repo) }
    }
  }
  try { Stop-Transcript -ErrorAction Stop | Out-Null } catch { }
  Write-Host ''
  Read-Host 'Press Enter to close' | Out-Null
  exit $code
}

# One pass: session one checkpoints through $tool, session two recalls it.
function Run-Pass([string]$tool, [string]$marker, [string]$nextAction, [string]$keyword, [string]$prevMarkerPattern, [string]$prevLabel) {
  Step ('Pass ' + $tool + ', session one: the checkpoint skill records a state')
  $p1 = '/jb-memory:checkpoint This is a throwaway test repo for jb-memory. Use the ' + $tool + ' tool for every command. Record this state. Decision, which I made: cache ship stats keyed by hull class. Next action: ' + $nextAction + ', owner: the user. Put the test marker ' + $marker + ' in the Bootstrap line.'
  $allow = @('--allowedTools', 'Skill', ($tool + '(node *)'), ($tool + '(git status *)'), ($tool + '(git log *)'))
  # PowerShell can't pipe the handoff into write-handoff without manual approval,
  # so that pass saves it with the Write tool and sends it with --from instead.
  if ($tool -eq 'PowerShell') { $allow += 'Write' }
  $t0 = (Get-Date).AddSeconds(-60).ToString('yyyy-MM-dd HH:mm')
  [void](Invoke-ClaudeTraced $p1 $allow)
  $t1 = (Get-Date).ToString('yyyy-MM-dd HH:mm')
  Show-File 'handoff after session one' $handoff
  $h = $(if (Test-Path -LiteralPath $handoff) { Get-Content -LiteralPath $handoff -Raw } else { '' })
  $okWrite = $h.Contains($marker) -and $h.Contains($keyword)
  Result ($tool + ': checkpoint skill wrote the new state') $(if ($okWrite) { 'PASS' } else { 'FAIL' }) ('handoff has the marker and the next action: ' + $okWrite)
  if (-not $okWrite) { return }
  if ($tool -eq 'PowerShell') {
    # The skill names the drop file incoming-handoff-<session id>.md (0.3.0) or incoming-handoff.md (0.2.x).
    $left = @(Get-ChildItem -LiteralPath $memDir -Filter 'incoming-handoff*.md' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    $gone = $left.Count -eq 0
    Result ($tool + ': drop file removed after saving') $(if ($gone) { 'PASS' } else { 'WARN' }) ('incoming-handoff*.md gone: ' + $gone + $(if ($gone) { '' } else { ' (left: ' + ($left -join ', ') + ')' }))
  }
  $p = $(if (Test-Path -LiteralPath $prev) { Get-Content -LiteralPath $prev -Raw } else { '' })
  $okPrev = $p -match $prevMarkerPattern
  Result ($tool + ': previous handoff kept for undo') $(if ($okPrev) { 'PASS' } else { 'FAIL' }) ('handoff.prev.md holds ' + $prevLabel + ': ' + $okPrev)
  $okProv = $h -match '\[user \d{4}-\d{2}-\d{2}\][^\r\n]*hull class'
  Result ($tool + ': decision attributed to the user with a date') $(if ($okProv) { 'PASS' } else { 'WARN' }) ('[user YYYY-MM-DD] ... hull class: ' + $okProv)
  $m = [regex]::Match($h, '(?m)^Updated: (\d{4}-\d{2}-\d{2} \d{2}:\d{2})(.*)$')
  $stamp = $(if ($m.Success) { $m.Groups[1].Value } else { '' })
  $okTime = $m.Success -and ($stamp -ge $t0) -and ($stamp -le $t1)
  Result ($tool + ': Updated time is the real clock time') $(if ($okTime) { 'PASS' } else { 'FAIL' }) ('stamped ' + $stamp + ', session ran ' + $t0 + ' to ' + $t1)
  $head = ShortHead
  $okHead = $m.Success -and ($m.Groups[2].Value -match ('HEAD ' + [regex]::Escape($head) + '\b'))
  Result ($tool + ': Updated line carries git HEAD') $(if ($okHead) { 'PASS' } else { 'FAIL' }) ('expected HEAD ' + $head + ', line says:' + $m.Groups[2].Value)
  # 0.3.0: the skill passes the ID Claude Code substitutes for ${CLAUDE_SESSION_ID}.
  # No session on the line means the substitution didn't happen in this Claude Code.
  $okSid = $m.Success -and ($m.Groups[2].Value -match '\| session [0-9a-f]{8}(?: \| by (?:Claude Code|Codex))?$')
  Result ($tool + ': Updated line names the writing session') $(if ($okSid) { 'PASS' } else { 'FAIL' }) ('line says:' + $m.Groups[2].Value)
  # 0.4.5: write-handoff adds the agent that wrote the handoff.
  $okAgent = $m.Success -and ($m.Groups[2].Value -match '\| by Claude Code$')
  Result ($tool + ': Updated line names the agent (0.4.5)') $(if ($okAgent) { 'PASS' } else { 'FAIL' }) ('line says:' + $m.Groups[2].Value)

  Step ('Pass ' + $tool + ', session two: a brand-new session, no tools')
  $s0 = @(Notes | Where-Object { $_ -match 'SESSION_START' }).Count
  $p2 = 'Using only what is already in your context, with no tools: what test marker and what next action does the saved state for this repo record? Answer in one line. If you cannot tell, reply UNKNOWN.'
  $reply = Invoke-Claude $p2 @('--disallowedTools', 'Read', 'Glob', 'Grep', 'Bash', 'PowerShell', 'Skill', 'Agent', 'WebFetch', 'WebSearch')
  $starts = @(Notes | Where-Object { $_ -match 'SESSION_START' })
  $okStart = $starts.Count -gt $s0
  if ($okStart) { Write-Host ('  start hook logged: ' + $starts[-1]) }
  Result ($tool + ': start hook ran for session two') $(if ($okStart) { 'PASS' } else { 'FAIL' }) ('new SESSION_START line: ' + $okStart)
  $okKnew = $reply.Contains($marker) -and $reply.Contains($keyword)
  Result ($tool + ': session two knew the saved state') $(if ($okKnew) { 'PASS' } else { 'FAIL' }) ('reply has the marker and the next action: ' + $okKnew)
}

Step 'Environment'
Write-Host ('date: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '   PowerShell ' + $PSVersionTable.PSVersion + '   model: ' + $Model)
foreach ($t in 'node', 'git', 'claude') {
  $c = Get-Command $t -ErrorAction SilentlyContinue
  if (-not $c) { Write-Host ('STOPPED: ' + $t + ' is not on PATH'); Finish 1 }
  Write-Host ($t + ': ' + $c.Source)
}
if (-not (Test-Path -LiteralPath $jbm)) { Write-Host ('STOPPED: missing ' + $jbm); Finish 1 }

Step 'Throwaway repo, set up for jb-memory'
New-Item -ItemType Directory -Path $repo | Out-Null
Push-Location $repo
& git init -q 2>&1 | Out-Null
& git config user.name 'jb-memory roundtrip test'
& git config user.email 'roundtrip@example.invalid'
& git commit -q --allow-empty -m 'initial' 2>&1 | Out-Null
Pop-Location
Write-Host ('  ' + $repo + '   HEAD ' + (ShortHead))
[void](Invoke-Claude 'Reply with the single word OK.' @())
Push-Location $repo
$dirOut = @((& node $jbm dir 2>&1) | ForEach-Object { [string]$_ })
$memDir = $dirOut[0].Trim()
if (((Split-Path -Leaf (Split-Path -Parent $memDir)) -notmatch 'jbm-roundtrip-') -or (($dirOut -join "`n") -notmatch 'resolved by: key:')) {
  Pop-Location
  foreach ($l in $dirOut) { Write-Host ('  ' + $l) }
  Write-Host 'STOPPED: the memory folder did not resolve to the test repo. Nothing was changed there.'
  $memDir = $null
  Finish 1
}
& node $jbm init 2>&1 | ForEach-Object { Write-Host ('  ' + $_) }
Pop-Location
$handoff = Join-Path $memDir 'handoff.md'
$prev = Join-Path $memDir 'handoff.prev.md'
Show-File 'handoff before pass one' $handoff

Run-Pass 'Bash' 'AZIMUTH-7' 'write the ShipLoader tests' 'ShipLoader' 'created by memory-setup' 'the setup version'
# A second commit, so the PowerShell pass has a different HEAD to stamp.
Push-Location $repo; & git commit -q --allow-empty -m 'between passes' 2>&1 | Out-Null; Pop-Location
Run-Pass 'PowerShell' 'BOREALIS-4' 'profile the HullLoader cache' 'HullLoader' 'AZIMUTH-7' 'the Bash pass version'

$bad = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
Finish $(if ($bad -gt 0) { 1 } else { 0 })
