# test-jb-memory-sessions.ps1
# Shows that two Claude Code sessions sharing one jb-memory handoff can't
# undo each other's checkpoints (jb-memory 0.3.0), in a throwaway repo.
#
# Part A drives jbm.js directly, with made-up session IDs. No model calls.
#   - handoff prints a version, and a write without --base is refused
#   - a write based on an old version is refused (exit 3) and lists what the
#     other session changed; a merged write then goes through
#   - six writers on the same version at once, five rounds, with a pause
#     inside each check-then-write so the lock is what keeps them apart, and a
#     reader holding the handoff open the way an antivirus scan does: exactly
#     one wins each round, and no lock or temp file is left behind
#   - six session-start hooks at once all get recorded
#   - a lock left by a crashed command is broken, one held by a live process
#     is waited on; per-session drop files, a byte order mark, undo limited to
#     the session that wrote; transcript --session reads that session's file
#
# Part B is one real session running the checkpoint skill. While it composes
# the new handoff, a background job plays a second session and writes the
# handoff first. The session's write should be refused, and Claude should
# merge and write again, keeping the other session's line.
#
# Calls to the model: one to create the project folder, one checkpoint session
# (default Sonnet 5.5). -CliOnly runs Part A only, with no model calls and a
# private Claude config folder, so it can run anywhere node runs.
#
# The throwaway repo (jbm-sessions-<time> in the temp folder, so the watchdog
# stays quiet) and its projects folder are deleted at the end unless you pass
# -Keep. Log: test-jb-memory-sessions.log next to this file.

param([switch]$Keep, [switch]$CliOnly, [string]$Model = 'claude-sonnet-5-5', [ValidateSet('Bash', 'PowerShell')][string]$Tool = 'Bash')

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$jbm  = [IO.Path]::Combine($root, '..', '..', 'plugins', 'jb-memory', 'scripts', 'jbm.js')
# The release layout keeps this script in tools\windows; an older layout kept it
# next to jb-memory-marketplace.
if (-not (Test-Path -LiteralPath $jbm -PathType Leaf)) { $jbm = [IO.Path]::Combine($root, 'jb-memory-marketplace', 'plugins', 'jb-memory', 'scripts', 'jbm.js') }
$jbm = [IO.Path]::GetFullPath($jbm)
$log  = Join-Path $root 'test-jb-memory-sessions.log'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
# The throwaway repo goes in the temp folder, outside claude-plugins, so the
# watchdog has nothing to report while the test runs.
$workRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$repo = Join-Path $workRoot ('jbm-sessions-' + $stamp)
# Environment variables this script changes, saved so Finish can put them back:
# a run from an open window must leave that window as it found it.
$savedEnv = @{}
foreach ($v in 'CLAUDE_CONFIG_DIR', 'JBMEM_NESTED', 'JBMEM_DIR', 'JBMEM_METHOD', 'JBMEM_ROOT', 'JBMEM_GIT', 'JBMEM_SANDBOX', 'JBMEM_TEST_HOLD_MS', 'CLAUDE_CODE_PROJECT_DIR_NAME', 'CLAUDE_SESSION_ID') {
  $savedEnv[$v] = [Environment]::GetEnvironmentVariable($v, 'Process')
}
$privateCfg = $null
if ($CliOnly) {
  # A private config folder: nothing under the real .claude folder is touched.
  $privateCfg = Join-Path $workRoot ('jbm-sessions-cfg-' + $stamp)
  $env:CLAUDE_CONFIG_DIR = $privateCfg
}
if ($env:CLAUDE_CONFIG_DIR) { $projectsDir = Join-Path $env:CLAUDE_CONFIG_DIR 'projects' }
else {
  $homeDir = $(if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME })
  $projectsDir = [IO.Path]::Combine($homeDir, '.claude', 'projects')
}
$results = New-Object System.Collections.ArrayList
$memDir = $null
$node = $null
foreach ($v in 'JBMEM_NESTED', 'JBMEM_DIR', 'JBMEM_METHOD', 'JBMEM_ROOT', 'JBMEM_GIT', 'JBMEM_SANDBOX', 'CLAUDE_CODE_PROJECT_DIR_NAME', 'CLAUDE_SESSION_ID') {
  Remove-Item ('Env:' + $v) -ErrorAction SilentlyContinue
}

Start-Transcript -Path $log -Force | Out-Null

function Step([string]$t) { Write-Host ''; Write-Host "=== $t" }
function Result([string]$check, [string]$status, [string]$detail) {
  [void]$results.Add([pscustomobject]@{ Result = $status; Check = $check; Detail = $detail })
  Write-Host ('  ' + $status.PadRight(6) + $check + '   ' + $detail)
}
function PassFail([bool]$ok) { if ($ok) { 'PASS' } else { 'FAIL' } }
function Short([string]$id) { if ($id.Length -ge 8) { $id.Substring(0, 8) } else { $id } }

# jbm.js as a child process with its own stdin, so several can run at once.
function Start-Jbm([string[]]$a, [string]$stdin) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = ((@($jbm) + $a) | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $psi.WorkingDirectory = $repo
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  return [pscustomobject]@{ P = $p; O = $p.StandardOutput.ReadToEndAsync(); E = $p.StandardError.ReadToEndAsync(); Stdin = $stdin }
}
# The text goes in as UTF-8 bytes. On Windows PowerShell 5.1 with the console
# code page at 65001, .NET may already have sent a byte order mark when the
# process started; jb-memory strips one, so either way the text arrives whole.
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
function Send-Jbm($j) {
  if ($j.Stdin) {
    $bytes = $utf8NoBom.GetBytes($j.Stdin)
    $j.P.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $j.P.StandardInput.BaseStream.Flush()
  }
  $j.P.StandardInput.Close()
}
function Wait-Jbm($j) {
  $j.P.WaitForExit()
  return [pscustomobject]@{ Code = $j.P.ExitCode; Out = [string]$j.O.Result; Err = [string]$j.E.Result }
}
function Jbm([string[]]$a, [string]$stdin) {
  $j = Start-Jbm $a $stdin
  Send-Jbm $j
  return (Wait-Jbm $j)
}
function Version-Now {
  $r = Jbm @('handoff') $null
  $m = [regex]::Match($r.Out, '(?m)^\[jb-memory\] handoff version: (\S+)')
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}
function Read-Shared([string]$path) {
  # Opened with every share flag, so a file another program is writing can still be read.
  if (-not (Test-Path -LiteralPath $path)) { return '' }
  $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete')
  try { $sr = New-Object IO.StreamReader($fs); return $sr.ReadToEnd() } finally { $fs.Dispose() }
}
function Handoff-Text { return (Read-Shared (Join-Path $memDir 'handoff.md')) }
function Leftovers {
  $names = @(Get-ChildItem -LiteralPath $memDir -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq '.jbmem.lock' -or $_.Name -eq '.jbmem.lock.break' -or $_.Name -like '*.tmp' } | ForEach-Object { $_.Name })
  return $names
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
# Runs claude with the event stream, lists each tool call with what it
# returned, and hands back the session ID, the calls and the final reply.
function Invoke-ClaudeTraced([string]$prompt, [string[]]$extra) {
  $argList = @('-p', $prompt, '--model', $Model, '--output-format', 'stream-json', '--verbose') + $extra
  Write-Host ('  > claude -p <prompt> --model ' + $Model + ' --output-format stream-json ' + ($extra -join ' '))
  Push-Location $repo
  $lines = @(& claude @argList 2>$null)
  $code = $LASTEXITCODE
  Pop-Location
  $result = ''
  $sid = ''
  $uses = New-Object System.Collections.ArrayList
  $outcomes = @{}
  foreach ($l in $lines) {
    $s = [string]$l
    if (-not $s.Trim()) { continue }
    $ev = $null
    try { $ev = $s | ConvertFrom-Json -ErrorAction Stop } catch { continue }
    if ($ev.session_id -and -not $sid) { $sid = [string]$ev.session_id }
    if ($ev.type -eq 'result') { $result = [string]$ev.result }
    if (-not $ev.message -or -not $ev.message.content) { continue }
    foreach ($c in @($ev.message.content)) {
      if ($c.type -eq 'tool_use') {
        $what = ''
        if ($c.input.command) { $what = [string]$c.input.command }
        elseif ($c.input.skill) { $what = [string]$c.input.skill }
        elseif ($c.input.file_path) { $what = 'file ' + [string]$c.input.file_path }
        [void]$uses.Add([pscustomobject]@{ Id = [string]$c.id; Tool = [string]$c.name; What = ($what -replace '\s+', ' '); Outcome = '' })
      } elseif ($c.type -eq 'tool_result') {
        $txt = ''
        if ($c.content -is [string]) { $txt = $c.content }
        else { $txt = (@($c.content) | Where-Object { $_.type -eq 'text' } | ForEach-Object { [string]$_.text }) -join ' ' }
        $outcomes[[string]$c.tool_use_id] = $(if ($c.is_error) { 'ERROR: ' } else { 'ok: ' }) + (($txt -replace '\s+', ' ').Trim())
      }
    }
  }
  if ($uses.Count -eq 0) { Write-Host '    (no tool calls seen in the stream)' }
  foreach ($u in $uses) {
    $u.Outcome = [string]$outcomes[$u.Id]
    $w = $u.What; if ($w.Length -gt 160) { $w = $w.Substring(0, 160) + '...' }
    $o = $u.Outcome; if ($o.Length -gt 220) { $o = $o.Substring(0, 220) + '...' }
    Write-Host ('    tool ' + $u.Tool + ': ' + $w)
    Write-Host ('        -> ' + $(if ($o) { $o } else { '(no result recorded)' }))
  }
  foreach ($r in ($result -split "`n")) { Write-Host ('    ' + $r) }
  Write-Host ('    [exit ' + $code + ']   session ' + $sid)
  return [pscustomobject]@{ Result = $result; SessionId = $sid; Uses = $uses; Code = $code }
}
function Show-File([string]$label, [string]$path) {
  Write-Host ('  --- ' + $label)
  if (Test-Path -LiteralPath $path) { (Read-Shared $path) -split "`r?`n" | ForEach-Object { Write-Host ('  | ' + $_) } }
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
  if ((Test-Path -LiteralPath $p) -and $env:ComSpec) { & cmd.exe /d /c rmdir /s /q "$p" 2>&1 | Out-Null }
  return -not (Test-Path -LiteralPath $p)
}
function Finish([int]$code) {
  Step 'Summary'
  if ($results.Count -gt 0) { $results | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host }
  Step 'Cleanup'
  Get-Job -Name 'jbm-second-session' -ErrorAction SilentlyContinue | Remove-Job -Force -ErrorAction SilentlyContinue
  $leaf = Split-Path -Leaf $repo
  $keyDirs = @()
  if ($leaf -match '^jbm-sessions-\d{8}-\d{6}$' -and (Test-Path -LiteralPath $projectsDir)) {
    $keyDirs = @(Get-ChildItem -LiteralPath $projectsDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name.EndsWith($leaf) } | ForEach-Object { $_.FullName })
  }
  $mine = @($repo)
  if ($privateCfg) { $mine += $privateCfg }
  if ($Keep) {
    foreach ($k in $keyDirs + $mine) { if (Test-Path -LiteralPath $k) { Write-Host ('  kept (-Keep): ' + $k) } }
  } else {
    foreach ($k in $keyDirs) { if (Remove-Tree $k) { Write-Host ('  removed  ' + $k) } else { Write-Host ('  FAILED   ' + $k) } }
    foreach ($k in $mine) {
      if ((Test-Path -LiteralPath $k) -and ((Split-Path -Leaf $k) -match '^jbm-sessions-') -and ((Split-Path -Parent $k).TrimEnd('\', '/') -eq $workRoot)) {
        if (Remove-Tree $k) { Write-Host ('  removed  ' + $k) } else { Write-Host ('  FAILED   ' + $k) }
      }
    }
  }
  foreach ($k in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $savedEnv[$k], 'Process') }
  try { Stop-Transcript -ErrorAction Stop | Out-Null } catch { }
  Write-Host ''
  if (-not $CliOnly) { Read-Host 'Press Enter to close' | Out-Null }
  exit $code
}

Step 'Environment'
Write-Host ('date: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '   PowerShell ' + $PSVersionTable.PSVersion + $(if ($CliOnly) { '   CLI only' } else { '   model: ' + $Model + '   tool: ' + $Tool }))
$need = @('node', 'git')
if (-not $CliOnly) { $need += 'claude' }
foreach ($t in $need) {
  $c = Get-Command $t -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { Write-Host ('STOPPED: ' + $t + ' is not on PATH'); Finish 1 }
  Write-Host ($t + ': ' + $c.Source)
  if ($t -eq 'node') { $node = $c.Source }
}
if (-not (Test-Path -LiteralPath $jbm)) { Write-Host ('STOPPED: missing ' + $jbm); Finish 1 }
$pj = Join-Path (Split-Path -Parent (Split-Path -Parent $jbm)) '.claude-plugin\plugin.json'
if (Test-Path -LiteralPath $pj) { Write-Host ('jb-memory ' + ((Get-Content -LiteralPath $pj -Raw | ConvertFrom-Json).version)) }

Step 'Throwaway repo, set up for jb-memory'
New-Item -ItemType Directory -Path $repo | Out-Null
Push-Location $repo
& git init -q 2>&1 | Out-Null
& git config user.name 'jb-memory sessions test'
& git config user.email 'sessions@example.invalid'
& git commit -q --allow-empty -m 'initial' 2>&1 | Out-Null
Pop-Location
Write-Host ('  ' + $repo)
if ($CliOnly) {
  # Claude Code names the project folder after the path, every character
  # other than a letter or digit turned into a dash.
  $key = ([IO.Path]::GetFullPath($repo)) -replace '[^a-zA-Z0-9]', '-'
  New-Item -ItemType Directory -Path (Join-Path $projectsDir $key) -Force | Out-Null
} else {
  [void](Invoke-Claude 'Reply with the single word OK.' @())
}
$dir = Jbm @('dir') $null
$dirOut = @($dir.Out -split "`r?`n")
$memDir = $dirOut[0].Trim()
if (((Split-Path -Leaf (Split-Path -Parent $memDir)) -notmatch 'jbm-sessions-') -or ($dir.Out -notmatch 'resolved by: key:')) {
  foreach ($l in $dirOut) { Write-Host ('  ' + $l) }
  Write-Host 'STOPPED: the memory folder did not resolve to the test repo. Nothing was changed there.'
  $memDir = $null
  Finish 1
}
$init = Jbm @('init') $null
foreach ($l in ($init.Out -split "`r?`n")) { if ($l) { Write-Host ('  ' + $l) } }
Write-Host ('  memory folder: ' + $memDir)

$S1 = [guid]::NewGuid().ToString()
$S2 = [guid]::NewGuid().ToString()
Write-Host ('  made-up sessions: S1 ' + (Short $S1) + ', S2 ' + (Short $S2))

Step 'Part A1: versions and the base check'
$v0 = Version-Now
Result 'handoff prints a version' (PassFail ($v0 -match '^[0-9a-f]{12}$')) ('version ' + $v0)
$r = Jbm @('write-handoff') "# H`n- no base`n"
Result 'a write without --base is refused' (PassFail (($r.Code -eq 1) -and ($r.Err -match 'needs --base'))) ('exit ' + $r.Code + ': ' + $r.Err.Trim())

Step 'Part A2: two sessions write on the same version'
$r1 = Jbm @('write-handoff', ('--base=' + $v0), ('--session=' + $S1)) "# H`n## Next actions`n1. shared item`n- S1 ADDED THIS`n"
Result 'S1 writes first' (PassFail ($r1.Code -eq 0)) ('exit ' + $r1.Code)
$before = Handoff-Text
$r2 = Jbm @('write-handoff', ('--base=' + $v0), ('--session=' + $S2)) "# H`n## Next actions`n1. shared item`n- S2 ADDED THIS`n"
foreach ($l in ($r2.Out -split "`r?`n")) { if ($l) { Write-Host ('    | ' + $l) } }
$listed = $r2.Out -match '(?m)^\+ - S1 ADDED THIS\s*$'
Result 'S2, still on the old version, is refused' (PassFail ($r2.Code -eq 3)) ('exit ' + $r2.Code)
Result 'the refusal lists what S1 added' (PassFail $listed) ('+ - S1 ADDED THIS listed: ' + $listed)
Result 'nothing was written by the refused write' (PassFail ((Handoff-Text) -eq $before)) ''
$m = [regex]::Match($r2.Out, 'write the merged handoff with --base=([0-9a-f]{12})')
$v1 = $(if ($m.Success) { $m.Groups[1].Value } else { '' })
$r3 = Jbm @('write-handoff', ('--base=' + $v1), ('--session=' + $S2)) "# H`n## Next actions`n1. shared item`n- S1 ADDED THIS`n- S2 ADDED THIS`n"
$h = Handoff-Text
$both = $h.Contains('S1 ADDED THIS') -and $h.Contains('S2 ADDED THIS')
Result 'the merged write goes through with both lines' (PassFail (($r3.Code -eq 0) -and $both)) ('exit ' + $r3.Code + ', both lines: ' + $both)
$okStamp = $h -match ('(?m)^Updated: .*\| session ' + (Short $S2) + '(?: \| by (?:Claude Code|Codex))?\s*$')
Result 'the Updated line names the writing session' (PassFail $okStamp) ([regex]::Match($h, '(?m)^Updated:.*$').Value)

Step 'Part A3: six writers on the same version at once, five rounds'
# A reader that keeps opening the handoff and the state file without delete
# sharing, the way a virus scanner or Get-Content does. While it has a file
# open, Windows refuses to replace it, and jb-memory has to retry.
$readerStop = Join-Path $memDir 'reader.stop'
$readerUp = Join-Path $memDir 'reader.up'
$reader = Start-Job -Name 'jbm-reader' -ArgumentList $memDir, $readerStop, $readerUp -ScriptBlock {
  param($memDir, $stop, $up)
  $opens = 0; $misses = 0
  [IO.File]::WriteAllText($up, 'up')
  $end = (Get-Date).AddMinutes(3)
  while (-not (Test-Path -LiteralPath $stop) -and (Get-Date) -lt $end) {
    foreach ($n in 'handoff.md', '.jbmem-state.json') {
      try {
        $fs = [IO.File]::Open((Join-Path $memDir $n), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'Read, Write')
        try { [void](New-Object IO.StreamReader($fs)).ReadToEnd(); Start-Sleep -Milliseconds 3 } finally { $fs.Dispose() }
        $opens++
      } catch { $misses++ }
    }
    Start-Sleep -Milliseconds 2
  }
  return ('' + $opens + ' opens, ' + $misses + ' misses')
}
$t0 = Get-Date
while (-not (Test-Path -LiteralPath $readerUp) -and ((Get-Date) - $t0).TotalSeconds -lt 30) { Start-Sleep -Milliseconds 100 }
$env:JBMEM_TEST_HOLD_MS = '100'
$roundsOk = 0
$detail = New-Object System.Collections.ArrayList
for ($round = 1; $round -le 5; $round++) {
  $base = Version-Now
  $jobs = @()
  for ($i = 1; $i -le 6; $i++) {
    $sid = [guid]::NewGuid().ToString()
    $jobs += Start-Jbm @('write-handoff', ('--base=' + $base), ('--session=' + $sid)) ("# H`n## Next actions`n1. shared item`n- ROUND $round WRITER $i`n")
  }
  # All six are running before any of them gets its text.
  foreach ($j in $jobs) { Send-Jbm $j }
  $codes = @($jobs | ForEach-Object { (Wait-Jbm $_).Code })
  $won = @($codes | Where-Object { $_ -eq 0 }).Count
  $refused = @($codes | Where-Object { $_ -eq 3 }).Count
  $h = Handoff-Text
  $writers = ([regex]::Matches($h, ('ROUND ' + $round + ' WRITER \d'))).Count
  $ok = ($won -eq 1) -and ($refused -eq 5) -and ($writers -eq 1)
  if ($ok) { $roundsOk++ }
  [void]$detail.Add('round ' + $round + ': exit codes ' + ($codes -join ',') + ', writer lines in handoff ' + $writers)
}
Remove-Item Env:JBMEM_TEST_HOLD_MS -ErrorAction SilentlyContinue
[IO.File]::WriteAllText($readerStop, 'stop')
$readerOut = [string](Receive-Job -Job $reader -Wait -AutoRemoveJob)
Remove-Item -LiteralPath $readerStop, $readerUp -Force -ErrorAction SilentlyContinue
foreach ($d in $detail) { Write-Host ('    ' + $d) }
Write-Host ('    reader holding the files open meanwhile: ' + $readerOut)
Result 'exactly one writer wins each round' (PassFail ($roundsOk -eq 5)) ($roundsOk.ToString() + ' of 5 rounds, reader ' + $readerOut)
$hookIds = @(1..6 | ForEach-Object { [guid]::NewGuid().ToString() })
$env:JBMEM_TEST_HOLD_MS = '80'
$hooks = @($hookIds | ForEach-Object { Start-Jbm @('--hook', 'session-start') ('{"cwd":"' + ($repo -replace '\\', '\\') + '","source":"startup","session_id":"' + $_ + '"}') })
foreach ($j in $hooks) { Send-Jbm $j }
$hookCodes = @($hooks | ForEach-Object { (Wait-Jbm $_).Code })
Remove-Item Env:JBMEM_TEST_HOLD_MS -ErrorAction SilentlyContinue
$st = $null
try { $st = (Read-Shared (Join-Path $memDir '.jbmem-state.json')) | ConvertFrom-Json } catch { }
$recorded = @($hookIds | Where-Object { $st -and $st.sessions -and $st.sessions.($_) -and $st.sessions.($_).start }).Count
Result 'six session-start hooks at once are all recorded' (PassFail (($recorded -eq 6) -and (@($hookCodes | Where-Object { $_ -ne 0 }).Count -eq 0))) ('' + $recorded + ' of 6, exit codes ' + ($hookCodes -join ','))
$left = @(Leftovers)
Result 'no lock, moved-aside lock or temp file left' (PassFail ($left.Count -eq 0)) $(if ($left.Count) { $left -join ', ' } else { 'clean' })

Step 'Part A4: locks, drop files, undo'
$lock = Join-Path $memDir '.jbmem.lock'
# A command that crashes while it holds the lock: a node process that takes
# the lock with jb-memory's own code and exits inside it.
$crashJs = Join-Path $repo 'crash-holder.js'
[IO.File]::WriteAllText($crashJs, "require(process.argv[2]).withLock(process.argv[3], () => process.exit(7));`n")
$storeJs = [IO.Path]::Combine((Split-Path -Parent $jbm), 'lib', 'store.js')
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node; $psi.Arguments = '"' + $crashJs + '" "' + $storeJs + '" "' + $memDir + '"'; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
$crash = [System.Diagnostics.Process]::Start($psi)
$crash.WaitForExit()
Remove-Item -LiteralPath $crashJs -Force -ErrorAction SilentlyContinue
$label = $(if (Test-Path -LiteralPath $lock) { (Read-Shared $lock).Trim() } else { '(no lock left)' })
Write-Host ('    crashed holder exit ' + $crash.ExitCode + ', left: ' + $label)
# A dead holder's lock is broken once it is over 5 s old.
(Get-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue).LastWriteTime = (Get-Date).AddSeconds(-10)
$t0 = Get-Date
$r = Jbm @('write-handoff', ('--base=' + (Version-Now)), ('--session=' + $S1)) "# H`n## Next actions`n1. after a crashed command's lock`n"
$ms = [int]((Get-Date) - $t0).TotalMilliseconds
Result 'a lock left by a crashed command is broken' (PassFail (($crash.ExitCode -eq 7) -and ($label -match '^pid \d+ host ') -and ($r.Code -eq 0) -and -not (Test-Path -LiteralPath $lock) -and ($ms -lt 5000))) ('exit ' + $r.Code + ' after ' + $ms + ' ms')
$hostName = $(if ($label -match ' host (\S+)') { $Matches[1] } else { 'unknown' })
[IO.File]::WriteAllText($lock, ('pid ' + $PID + ' host ' + $hostName + ' since now token live' + "`n"))
$before = Handoff-Text
$t0 = Get-Date
$r = Jbm @('write-handoff', ('--base=' + (Version-Now)), ('--session=' + $S1)) "# H`n- should not land`n"
$ms = [int]((Get-Date) - $t0).TotalMilliseconds
$okWait = ($r.Code -eq 1) -and ($r.Err -match 'another jb-memory command is using the memory folder') -and ((Handoff-Text) -eq $before) -and (Test-Path -LiteralPath $lock)
Result 'a lock held by a live process is waited on, then refused' (PassFail $okWait) ('exit ' + $r.Code + ' after ' + $ms + ' ms, lock kept: ' + (Test-Path -LiteralPath $lock))
Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
$bom = Join-Path $memDir ('incoming-handoff-' + $S1 + '.md')
[IO.File]::WriteAllText($bom, "---`r`nname: handoff`r`ndescription: x`r`ntype: project`r`n---`r`n# H`r`n- written with a BOM`r`n", (New-Object System.Text.UTF8Encoding $true))
$r = Jbm @('write-handoff', ('--base=' + (Version-Now)), ('--session=' + $S1), ('--from=' + $bom)) $null
$h = Handoff-Text
$fm = ([regex]::Matches($h, '(?m)^---\s*$')).Count
Result 'a file with a byte order mark gets one frontmatter block' (PassFail (($r.Code -eq 0) -and ($fm -eq 2) -and $h.Contains('written with a BOM'))) ('exit ' + $r.Code + ', --- lines: ' + $fm)
$drop = Join-Path $memDir ('incoming-handoff-' + $S1 + '.md')
[IO.File]::WriteAllText($drop, "# H`r`n## Next actions`r`n1. from the drop file`r`n")
$r = Jbm @('write-handoff', ('--base=' + (Version-Now)), ('--session=' + $S1), ('--from=' + $drop)) $null
Result 'a per-session drop file is saved and removed' (PassFail (($r.Code -eq 0) -and -not (Test-Path -LiteralPath $drop) -and (Handoff-Text).Contains('from the drop file'))) ('exit ' + $r.Code)
$dropB = Join-Path $memDir ('incoming-handoff-' + $S2 + '.md')
[IO.File]::WriteAllText($dropB, "# H`r`n- stale`r`n")
$r = Jbm @('write-handoff', ('--base=' + $v0), ('--session=' + $S2), ('--from=' + $dropB)) $null
Result 'a refused drop file stays for the merged text' (PassFail (($r.Code -eq 3) -and (Test-Path -LiteralPath $dropB))) ('exit ' + $r.Code)
Remove-Item -LiteralPath $dropB -Force -ErrorAction SilentlyContinue
$r = Jbm @('undo-handoff', ('--session=' + $S2)) $null
Result "undo refuses to undo another session's write" (PassFail (($r.Code -eq 1) -and ($r.Err -match ('session ' + (Short $S1))))) ('exit ' + $r.Code + ': ' + $r.Err.Trim())
$r = Jbm @('undo-handoff', ('--session=' + $S1)) $null
Result 'undo of its own write works' (PassFail ($r.Code -eq 0)) ('exit ' + $r.Code)

Step 'Part A5: transcript --session reads that session''s own file'
$keyDir = Split-Path -Parent $memDir
$fa = Join-Path $keyDir ($S1 + '.jsonl')
$fb = Join-Path $keyDir ($S2 + '.jsonl')
$ts = (Get-Date).ToUniversalTime().AddMinutes(-5).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$cwdJson = ($repo -replace '\\', '\\')
[IO.File]::WriteAllText($fa, ('{"type":"user","timestamp":"' + $ts + '","cwd":"' + $cwdJson + '","message":{"content":"S1 TRANSCRIPT TEXT"}}' + "`n"))
[IO.File]::WriteAllText($fb, ('{"type":"user","timestamp":"' + $ts + '","cwd":"' + $cwdJson + '","message":{"content":"S2 TRANSCRIPT TEXT"}}' + "`n"))
(Get-Item -LiteralPath $fa -Force).LastWriteTime = (Get-Date).AddMinutes(-3)
$newest = Jbm @('transcript') $null
$own = Jbm @('transcript', ('--session=' + $S1)) $null
Write-Host ('    without --session: ' + $(if ($newest.Out -match 'S2 TRANSCRIPT') { 'S2 (the newest file)' } else { 'other' }))
Result 'transcript --session=S1 reads S1''s file, not the newest' (PassFail (($own.Code -eq 0) -and ($own.Out -match 'S1 TRANSCRIPT') -and ($own.Out -notmatch 'S2 TRANSCRIPT'))) ('exit ' + $own.Code)
Remove-Item -LiteralPath $fa, $fb -Force -ErrorAction SilentlyContinue

if ($CliOnly) {
  $bad = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
  Finish $(if ($bad -gt 0) { 1 } else { 0 })
}

Step ('Part B: a real session checkpoints while a second session writes first (' + $Tool + ' tool)')
$start = "# Handoff: sessions test`nUpdated: x`n`n## Bootstrap`n- Throwaway repo for the jb-memory sessions test.`n`n## Next actions`n1. write the ShipLoader tests -- owner: user`n"
$r = Jbm @('write-handoff', ('--base=' + (Version-Now)), ('--session=' + $S1)) $start
if ($r.Code -ne 0) { Write-Host ('STOPPED: could not reset the handoff: ' + $r.Err); Finish 1 }
Show-File 'handoff before the session' (Join-Path $memDir 'handoff.md')
$SZ = [guid]::NewGuid().ToString()
$leaf = Split-Path -Leaf $repo
$since = (Get-Date).AddSeconds(-5)

# The second session: waits until the real session's transcript shows it has
# read the handoff (a version line in a tool result), then writes first.
$second = Start-Job -Name 'jbm-second-session' -ArgumentList $projectsDir, $leaf, $repo, $jbm, $SZ, $since -ScriptBlock {
  param($projectsDir, $leaf, $repo, $jbm, $SZ, $since)
  $OutputEncoding = New-Object System.Text.UTF8Encoding $false
  $deadline = (Get-Date).AddMinutes(8)
  $re = 'handoff version: [0-9a-f]{12} \(write it back'
  while ((Get-Date) -lt $deadline) {
    $files = @(Get-ChildItem -LiteralPath $projectsDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name.EndsWith($leaf) } |
      ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter '*.jsonl' -ErrorAction SilentlyContinue } |
      Where-Object { $_.LastWriteTime -gt $since })
    foreach ($f in $files) {
      $text = ''
      try {
        $fs = [IO.File]::Open($f.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete')
        try { $text = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
      } catch { continue }
      if ($text -match $re) {
        Set-Location -LiteralPath $repo
        $out = @(& node $jbm handoff 2>&1 | ForEach-Object { [string]$_ })
        $m = [regex]::Match(($out -join "`n"), 'handoff version: ([0-9a-f]{12})')
        $body = ($out | Select-Object -Skip 1) -join "`n"
        if ($body -match 'CORVUS-3') { return ('TOO LATE: the session had already written its handoff (' + $f.Name + ')') }
        $add = '- KESTREL-9: does the HullLoader cache survive a hull refit? A refit test would settle it.'
        if ($body -match '(?m)^## Open questions and risks\s*$') { $body = $body -replace '(?m)^(## Open questions and risks\s*)$', ('$1' + "`n" + $add) }
        else { $body = $body.TrimEnd() + "`n`n## Open questions and risks`n" + $add + "`n" }
        $w = @($body | & node $jbm write-handoff ('--base=' + $m.Groups[1].Value) ('--session=' + $SZ) 2>&1 | ForEach-Object { [string]$_ })
        return ('WROTE exit ' + $LASTEXITCODE + ' at ' + (Get-Date -Format 'HH:mm:ss.fff') + ' after seeing the read in ' + $f.Name + ': ' + ($w -join ' | '))
      }
    }
    Start-Sleep -Milliseconds 250
  }
  return 'TIMED OUT: the session never read the handoff'
}

$p1 = '/jb-memory:checkpoint This is a throwaway test repo for jb-memory. Use the ' + $Tool + ' tool for every command. Record this state. Decision, which I made: cache ship stats keyed by hull class. Next action: profile the HullLoader cache, owner: the user. Put the test marker CORVUS-3 in the Bootstrap line.'
$allow = @('--allowedTools', 'Skill', ($Tool + '(node *)'), ($Tool + '(git status *)'), ($Tool + '(git log *)'))
if ($Tool -eq 'PowerShell') { $allow += 'Write' }
$run = Invoke-ClaudeTraced $p1 $allow
$jobOut = [string](Receive-Job -Job $second -Wait -AutoRemoveJob)
Write-Host ('  second session: ' + $jobOut)
Show-File 'handoff after both sessions' (Join-Path $memDir 'handoff.md')

$writes = @($run.Uses | Where-Object { $_.What -match 'write-handoff' })
$refusedWrite = @($writes | Where-Object { $_.Outcome -match 'REFUSED' }).Count -gt 0
$lastWrite = $(if ($writes.Count) { $writes[-1].Outcome } else { '' })
$h = Handoff-Text
$sid8 = Short $run.SessionId
Result 'the second session wrote between the read and the write' (PassFail ($jobOut -match '^WROTE exit 0')) ($jobOut.Substring(0, [Math]::Min(120, $jobOut.Length)))
Result 'the session''s first write was refused' (PassFail $refusedWrite) ($writes.Count.ToString() + ' write-handoff call(s)')
Result 'its later write was saved' (PassFail ($lastWrite -match 'handoff saved')) ($lastWrite.Substring(0, [Math]::Min(100, $lastWrite.Length)))
Result 'the session''s new state is in the handoff' (PassFail ($h.Contains('CORVUS-3') -and $h.Contains('HullLoader'))) ('CORVUS-3 and HullLoader present')
$archived = @(Get-ChildItem -LiteralPath (Join-Path $memDir 'archive') -Filter '*.md' -ErrorAction SilentlyContinue | ForEach-Object { Read-Shared $_.FullName }) -join "`n"
$dupes = @(([regex]::Matches($archived, '(?m)^\s*(?:[-*]|\d+[.)])\s+\[done\].*$') | ForEach-Object { $_.Value.Trim() }) | Group-Object | Where-Object { $_.Count -gt 1 }).Count
Result 'no [done] item archived twice' (PassFail ($dupes -eq 0)) ('' + $dupes + ' duplicated')
Result 'the second session''s line survived the merge' (PassFail $h.Contains('KESTREL-9')) ('KESTREL-9 present: ' + $h.Contains('KESTREL-9'))
$okSid = ($sid8.Length -eq 8) -and ($h -match ('(?m)^Updated: .*\| session ' + [regex]::Escape($sid8) + '(?: \| by (?:Claude Code|Codex))?\s*$'))
Result 'the Updated line names the real session' (PassFail $okSid) ('session ' + $sid8 + ': ' + [regex]::Match($h, '(?m)^Updated:.*$').Value)
$state = $null
try { $state = (Read-Shared (Join-Path $memDir '.jbmem-state.json')) | ConvertFrom-Json } catch { }
$rec = $(if ($state -and $state.sessions -and $run.SessionId) { $state.sessions.($run.SessionId) } else { $null })
Result 'the state file has the session''s start and last write' (PassFail ($rec -and $rec.start -and $rec.lastWrite)) $(if ($rec) { 'start ' + $rec.start + ', lastWrite ' + $rec.lastWrite + ', transcript ' + $rec.transcript } else { 'no record for ' + $run.SessionId })
$okProv = $h -match '\[user \d{4}-\d{2}-\d{2}\][^\r\n]*hull class'
Result 'the decision kept its provenance' $(if ($okProv) { 'PASS' } else { 'WARN' }) ('[user YYYY-MM-DD] ... hull class: ' + $okProv)
$left = @(Leftovers) + @(Get-ChildItem -LiteralPath $memDir -Filter 'incoming-*.md' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
Result 'nothing left over in the memory folder' $(if ($left.Count -eq 0) { 'PASS' } else { 'WARN' }) $(if ($left.Count) { $left -join ', ' } else { 'clean' })

$bad = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
Finish $(if ($bad -gt 0) { 1 } else { 0 })
