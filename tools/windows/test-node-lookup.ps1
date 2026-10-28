# test-node-lookup.ps1 -- does a node program in the working folder run in
# place of the installed Node?
#
# Every trailmark hook starts `node` by name. On Windows some ways of starting
# a program look in the working folder before PATH. This finds out, on this
# PC, which ones do, with and without NoDefaultCurrentDirectoryInExePath=1.
#
# Part 1 (always): two throwaway folders under %LOCALAPPDATA%, one holding a
# copy of the installed node.exe, one holding a node.cmd that only prints a
# word. Each is used as the working folder for:
#   - cmd.exe /c node ...           (how a hook runs if its runner uses cmd)
#   - Node's child_process.spawnSync('node')   (libuv, used by many runners)
#   - PowerShell's & node           (PowerShell's own lookup)
# and the script reports which node ran.
#
# Part 2 (-ClaudeCode, then -Finish): a throwaway git repo with a copy of
# node.exe at its root, set up for trailmark (its memory folder is made under
# %USERPROFILE%\.claude\projects). You start one Claude Code session there (and
# a Codex chat, if the Codex copy is installed). Each SessionStart hook logs the
# path of the node that ran it; -Finish reads those lines and says whether the
# repo's copy ran, then removes the repo and its memory folder.
#
# What it changes: it creates and removes only its own folders, each marked
# with a .tm-nodelookup file, and removes nothing without that marker. It sets
# NoDefaultCurrentDirectoryInExePath for its own process only; your user
# setting is not touched. No network access.
#
# Usage (Windows PowerShell 5.1):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<folder>\tools\windows\test-node-lookup.ps1"
#   ... -ClaudeCode      also set up the Claude Code check
#   ... -Finish          read the Claude Code check and clean up
#   ... -Keep            leave the folders in place

param([switch]$ClaudeCode, [switch]$Finish, [switch]$Keep)

# Continue, not Stop: Windows PowerShell 5.1 turns a native program's stderr
# line into a terminating error under Stop when 2>&1 is used.
$ErrorActionPreference = 'Continue'
$Marker = '.tm-nodelookup'
$Launcher = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\plugins\trailmark\scripts\trailmark.js'))
# An older layout kept this script next to jb-memory-marketplace.
if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) { $Launcher = Join-Path $PSScriptRoot 'jb-memory-marketplace\plugins\jb-memory\scripts\jbm.js' }
$StatePath = Join-Path $env:LOCALAPPDATA 'tm-nodelookup-state.json'

# PowerShell's own lookup never uses the current folder, so this is the
# installed Node from PATH. Node is asked for its own path, so a shim (volta,
# scoop, nvm) on PATH gives the real node.exe.
function Get-RealNode {
  $c = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $p = (& $c.Source -p 'process.execPath' 2>$null | Out-String).Trim()
  if (-not $p -or -not (Test-Path -LiteralPath $p -PathType Leaf)) { throw ('could not find the installed node.exe (PATH gives ' + $c.Source + ')') }
  return [IO.Path]::GetFullPath($p)
}

# A probe folder's full path, if it is one this script makes: directly in
# %LOCALAPPDATA%, named tm-nodelookup-<kind>-<time>. '' otherwise.
function Test-ProbePath([string]$Dir) {
  if (-not $Dir) { return '' }
  try { $full = [IO.Path]::GetFullPath($Dir).TrimEnd('\') } catch { return '' }
  $parent = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')
  if (-not ([IO.Path]::GetDirectoryName($full)).Equals($parent, [StringComparison]::OrdinalIgnoreCase)) { return '' }
  if ((Split-Path -Leaf $full) -notmatch '^tm-nodelookup-(exe|cmd|repo)-\d{8}-\d{6}$') { return '' }
  return $full
}

# True when anything under Dir is a junction or link. Windows PowerShell 5.1's
# Remove-Item -Recurse can go through one and delete what it points to.
function Test-HasLinks([string]$Dir) {
  return [bool](Get-ChildItem -LiteralPath $Dir -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function New-ProbeFolder([string]$Name) {
  $d = Join-Path $env:LOCALAPPDATA $Name
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $d $Marker) -Value 'made by test-node-lookup.ps1; safe to delete' -Encoding ASCII
  return $d
}

# Removes a folder only when it is one of this script's (place and name, see
# Test-ProbePath), carries its marker file, and holds no link. Returns true
# when the folder is gone.
function Remove-ProbeFolder([string]$Dir) {
  $full = Test-ProbePath $Dir
  if (-not $full) { Write-Host ('  left in place (not a probe folder): ' + $Dir); return $false }
  if (-not (Test-Path -LiteralPath $full -PathType Container)) { return $true }
  if (-not (Test-Path -LiteralPath (Join-Path $full $Marker) -PathType Leaf)) { Write-Host ('  left in place (no marker): ' + $full); return $false }
  if (Test-HasLinks $full) { Write-Host ('  left in place (holds a link): ' + $full); return $false }
  Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $full) { Write-Host ('  could not remove: ' + $full); return $false }
  return $true
}

# The project folder for the probe repo under %USERPROFILE%\.claude\projects
# holds its memory folder and, after a session, Claude Code's transcript.
# Removed only when it sits directly in that projects folder, is named for
# this probe, has the memory folder directly inside it with the marker, and
# holds no link. Returns true when it is gone.
function Remove-ProbeProject([string]$Memory) {
  try {
    $mem = [IO.Path]::GetFullPath($Memory).TrimEnd('\')
    $proj = [IO.Path]::GetDirectoryName($mem)
    $projects = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.claude\projects')).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $proj)) { return $true }
    $fits = ([IO.Path]::GetDirectoryName($proj)).Equals($projects, [StringComparison]::OrdinalIgnoreCase) -and
      ((Split-Path -Leaf $mem) -eq 'memory') -and
      ((Split-Path -Leaf $proj) -match 'tm-nodelookup-repo-\d{8}-\d{6}$') -and
      (Test-Path -LiteralPath (Join-Path $mem $Marker) -PathType Leaf)
    if ($fits -and -not (Test-HasLinks $proj)) {
      Remove-Item -LiteralPath $proj -Recurse -Force -ErrorAction SilentlyContinue
      if (-not (Test-Path -LiteralPath $proj)) { return $true }
    }
    Write-Host ('  left in place: ' + $proj)
  } catch { Write-Host ('  left in place: ' + $Memory) }
  return $false
}

function Get-Verdict([string]$Out, [string]$Copy, [string]$Real) {
  $o = ($Out | Out-String).Trim()
  if ($o -match 'planted-cmd') { return 'the folder''s node.cmd ran' }
  if ($Copy -and $o -ieq $Copy) { return 'the folder''s node.exe ran' }
  if ($o -ieq $Real) { return 'installed Node' }
  if (-not $o) { return 'no output' }
  return ('other: ' + ($o -replace '\s+', ' '))
}

function Invoke-Probe([string]$Dir, [string]$Copy, [string]$Real) {
  $rows = @()
  foreach ($flag in @('', '1')) {
    $env:NoDefaultCurrentDirectoryInExePath = $flag
    $label = $(if ($flag) { 'set to 1' } else { 'not set' })
    Push-Location -LiteralPath $Dir
    try {
      $o1 = ''; try { $o1 = & cmd.exe /d /c 'node -p process.execPath' 2>&1 } catch { $o1 = 'error ' + $_.Exception.Message }
      $js = 'const r=require(''child_process'').spawnSync(''node'',[''-p'',''process.execPath''],{cwd:process.argv[1],encoding:''utf8'',windowsHide:true});console.log(r.error?(''error ''+r.error.code):(r.stdout||'''').trim())'
      $o2 = ''; try { $o2 = & $Real -e $js $Dir 2>&1 } catch { $o2 = 'error ' + $_.Exception.Message }
      $o3 = ''; try { $o3 = & node -p 'process.execPath' 2>&1 } catch { $o3 = 'error ' + $_.Exception.Message }
    } finally { Pop-Location }
    $rows += [pscustomobject]@{ Setting = $label; 'cmd.exe' = (Get-Verdict $o1 $Copy $Real); 'Node spawn' = (Get-Verdict $o2 $Copy $Real); 'PowerShell' = (Get-Verdict $o3 $Copy $Real) }
  }
  $env:NoDefaultCurrentDirectoryInExePath = $null
  return $rows
}

$real = Get-RealNode
Write-Host ('Installed Node: ' + $real + ' (' + (& $real --version) + ')')
Write-Host ('Your user setting NoDefaultCurrentDirectoryInExePath: ' + $(if ([Environment]::GetEnvironmentVariable('NoDefaultCurrentDirectoryInExePath', 'User')) { 'set' } else { 'not set' }))

if ($Finish) {
  if (-not (Test-Path -LiteralPath $StatePath)) { Write-Host 'Nothing to finish: run with -ClaudeCode first.'; exit 1 }
  $st = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json
  Write-Host ''
  Write-Host ('Repo: ' + $st.repo)
  Write-Host ('Its copy of node.exe: ' + $st.copy)
  Write-Host ('Your NoDefaultCurrentDirectoryInExePath when the check was set up: ' + $st.userSetting + '; now: ' + $(if ([Environment]::GetEnvironmentVariable('NoDefaultCurrentDirectoryInExePath', 'User')) { 'set' } else { 'not set' }))
  Write-Host '  (a result of "installed Node" says the runner is safe only if the setting was not set when Claude Code or the app started)'
  $notes = Join-Path $st.memory 'notes'
  $lines = @()
  if (Test-Path -LiteralPath $notes) { $lines = @(Get-ChildItem -LiteralPath $notes -Filter '*.md' | ForEach-Object { Get-Content -LiteralPath $_.FullName } | Where-Object { $_ -match 'SESSION_START' }) }
  if (-not $lines.Count) {
    Write-Host 'No session start was logged. Either no session was started in the repo, or the hooks did not run there (check that trailmark is enabled and the folder was trusted).'
  } else {
    foreach ($l in $lines) {
      $exec = ''; if ($l -match 'exec=(.+?)( session=[0-9a-f]{8})?\s*$') { $exec = $Matches[1].Trim() }
      $host1 = $(if ($l -match ' host=(\S+)') { $Matches[1] } elseif ($l -match ' entry=(\S+)') { 'claude-code (' + $Matches[1] + ')' } else { 'claude-code' })
      $v = $(if ($exec -ieq $st.copy) { 'THE REPO''S COPY RAN: this runner looks in the working folder' } elseif ($exec -ieq $st.real) { 'installed Node' } else { 'other: ' + $exec })
      Write-Host ('  ' + $host1 + ': ' + $v)
    }
  }
  if (-not $Keep) {
    $okRepo = Remove-ProbeFolder $st.repo
    $okProj = Remove-ProbeProject ([string]$st.memory)
    if ($okRepo -and $okProj) {
      Remove-Item -LiteralPath $StatePath -Force
      Write-Host 'Removed the probe repo and its memory folder.'
    } else {
      Write-Host ('Some folders were left in place (above). The state file stays: ' + $StatePath)
    }
  }
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dA = New-ProbeFolder ('tm-nodelookup-exe-' + $stamp)
$dB = New-ProbeFolder ('tm-nodelookup-cmd-' + $stamp)
$copyA = Join-Path $dA 'node.exe'
Copy-Item -LiteralPath $real -Destination $copyA
Set-Content -LiteralPath (Join-Path $dB 'node.cmd') -Value "@echo off`r`necho planted-cmd`r`nexit /b 0" -Encoding ASCII

Write-Host ''
Write-Host 'Folder with a node.exe copy:'
Invoke-Probe $dA $copyA $real | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
Write-Host 'Folder with a node.cmd:'
Invoke-Probe $dB '' $real | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
Write-Host 'Read it as: a hook runner that starts node the way a column does is exposed where that column says the folder''s node ran.'
Write-Host 'Node spawn never tries .cmd files, so in the node.cmd folder that column always shows the installed Node.'
Write-Host 'Claude Code and Codex use their own runners; -ClaudeCode checks Claude Code itself.'

if (-not $Keep) { [void](Remove-ProbeFolder $dA); [void](Remove-ProbeFolder $dB) }

if ($ClaudeCode) {
  if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) { Write-Host ('trailmark not found at ' + $Launcher); exit 1 }
  $git = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $repo = New-ProbeFolder ('tm-nodelookup-repo-' + $stamp)
  $copy = Join-Path $repo 'node.exe'
  $memory = ''
  $initOut = ''; $dirOut = ''
  & $git -C $repo init -q 2>&1 | Out-Null
  $gitOk = ($LASTEXITCODE -eq 0)
  if ($gitOk) {
    Copy-Item -LiteralPath $real -Destination $copy
    Push-Location -LiteralPath $repo
    try {
      # Where the memory folder goes, first, so it carries the marker before
      # anything else is written in it, and a failed setup can be cleaned up.
      $dirOut = & $real $Launcher dir 2>&1 | Out-String
      $memory = ($dirOut -split "`r?`n")[0].Trim()
      if ($memory -and [IO.Path]::IsPathRooted($memory)) {
        New-Item -ItemType Directory -Path $memory -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $memory $Marker) -Value 'made by test-node-lookup.ps1; safe to delete' -Encoding ASCII
        $initOut = & $real $Launcher init --force 2>&1 | Out-String
      }
    } finally { Pop-Location }
  }
  if (-not $gitOk -or -not $memory -or -not (Test-Path -LiteralPath (Join-Path $memory '.jbmem.json'))) {
    Write-Host $initOut; Write-Host $dirOut
    Write-Host 'Setting up the probe repo failed; removing it.'
    [void](Remove-ProbeFolder $repo)
    if ($memory) { [void](Remove-ProbeProject $memory) }
    exit 1
  }
  $userSetting = $(if ([Environment]::GetEnvironmentVariable('NoDefaultCurrentDirectoryInExePath', 'User')) { 'set' } else { 'not set' })
  [IO.File]::WriteAllText($StatePath, (ConvertTo-Json @{ repo = $repo; copy = $copy; real = $real; memory = $memory; userSetting = $userSetting }))
  if ($userSetting -eq 'set') {
    Write-Host 'Note: your user setting NoDefaultCurrentDirectoryInExePath is set, so this checks Claude Code WITH it. To see the runner''s own behavior, clear it, restart Claude Code, and set it up again.'
  }
  Write-Host ''
  Write-Host 'Claude Code check, set up:'
  Write-Host ('  repo:   ' + $repo)
  Write-Host ('  memory: ' + $memory)
  Write-Host ''
  Write-Host 'Now, in a new PowerShell window:'
  Write-Host ('  cd "' + $repo + '"')
  Write-Host '  claude'
  Write-Host '  (trust the folder if asked, send: hi, wait for the reply, then type /exit)'
  Write-Host 'Optional: open the same folder as a project in the ChatGPT app (Codex), send hi, close the chat.'
  Write-Host 'Then run this script again with -Finish.'
}
