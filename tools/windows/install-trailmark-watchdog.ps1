# install-trailmark-watchdog.ps1
# Sets up trailmark-watchdog for the folder trailmark is installed from: the
# release folder two levels up when this script sits in its tools\windows
# folder, otherwise the folder this script is in. -Root names another.
#
#   1. Copies trailmark-watchdog.ps1 to %LOCALAPPDATA%\trailmark-watchdog, outside
#      the folder it watches.
#   2. Records the folder's current contents as known-good. You see a summary
#      and type yes. If a known-good list already exists, it shows what changed
#      instead and asks again.
#   3. Removes the tasks and installed copy of jb-watchdog, its name before
#      0.5.0, if they are there (their log and known-good list stay), then
#      adds two scheduled tasks, as you, with no admin rights. They run only
#      while you're logged on, which is what lets them show notifications.
#        trailmark-watchdog           scans every 15 minutes
#        trailmark-watchdog-reminder  scans when you log on or unlock the PC, and
#                                     repeats the notification for anything still
#                                     waiting, on screen until you dismiss it (at
#                                     most one reminder every 10 minutes)
#   4. Runs each task once to check it works, then sends a test notification.
#
# The task starts powershell.exe with a hidden window, so a console window may
# flash for a moment when it runs. If that bothers you, run this again with
# -Headless: the task then starts through "conhost.exe --headless", which shows
# no window at all. Some security products flag that launch pattern as
# suspicious, because malware uses it to hide, which is why it isn't the default.
#
# Everything this script prints is also saved to install-trailmark-watchdog.log next
# to it (the summary in step 2 shows on screen only).
#
# Undo: run this script with -Uninstall. That removes both tasks and the
# installed script. The log and known-good list stay in
# %LOCALAPPDATA%\trailmark-watchdog so you can still read them.

param([switch]$Uninstall, [switch]$Headless, [string]$Root = '')
# Windows PowerShell 5.1 started from PowerShell 7 inherits its PSModulePath,
# finds PowerShell 7's copies of its own modules first, and then fails to load
# Get-Acl, ConvertFrom-Json and the like. PowerShell 7's entries are dropped.
if ($PSVersionTable.PSVersion.Major -lt 6 -and $env:PSModulePath) {
  $env:PSModulePath = (@($env:PSModulePath -split ';' | Where-Object { $_ -and $_ -notmatch '(^|\\)PowerShell\\' }) -join ';')
}

$ErrorActionPreference = 'Continue'
$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$src      = Join-Path $here 'trailmark-watchdog.ps1'
$stateDir = Join-Path $env:LOCALAPPDATA 'trailmark-watchdog'
$dest     = Join-Path $stateDir 'trailmark-watchdog.ps1'
# Before 0.5.0 the watchdog was jb-watchdog. Its tasks are removed here, since
# left running they would report every renamed file in the release folder.
$legacyTasks = @('jb-watchdog', 'jb-watchdog-reminder')
$legacyDest  = Join-Path (Join-Path $env:LOCALAPPDATA 'jb-watchdog') 'jb-watchdog.ps1'
function Remove-Legacy {
  foreach ($n in $legacyTasks) {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $n -Confirm:$false
      Write-Host ('  removed the old scheduled task ' + $n + ' (jb-watchdog, before the rename)')
    }
  }
  if (Test-Path -LiteralPath $legacyDest -PathType Leaf) { Remove-Item -LiteralPath $legacyDest -Force; Write-Host ('  removed the old copy ' + $legacyDest + '; its log and known-good list stay in that folder') }
}
$ps51     = Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe'
$conhost  = Join-Path $env:windir 'System32\conhost.exe'
$taskName = 'trailmark-watchdog'
$remindName = 'trailmark-watchdog-reminder'
$log      = Join-Path $here 'install-trailmark-watchdog.log'
$scriptDir = $here
if ($Root) { $here = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/')) }
else {
  $up = Split-Path -Parent (Split-Path -Parent $here)
  if ((Split-Path -Leaf $here) -ieq 'windows' -and (Split-Path -Leaf (Split-Path -Parent $here)) -ieq 'tools' -and (Test-Path -LiteralPath (Join-Path $up '.claude-plugin\marketplace.json') -PathType Leaf)) { $here = $up }
}

Start-Transcript -Path $log -Force | Out-Null

function Step([string]$t) { Write-Host ''; Write-Host "=== $t" }

function Finish([int]$Code) {
  try { Stop-Transcript | Out-Null } catch { }
  Write-Host ''
  Read-Host 'Press Enter to close' | Out-Null
  exit $Code
}

if ($Uninstall) {
  Step 'Remove trailmark-watchdog'
  foreach ($n in @($taskName, $remindName)) {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $n -Confirm:$false
      Write-Host ('  scheduled task ' + $n + ' removed')
    } else { Write-Host ('  no scheduled task named ' + $n) }
  }
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force; Write-Host ('  removed ' + $dest) }
  Remove-Legacy
  Write-Host ('  kept the log and known-good list in ' + $stateDir)
  Finish 0
}

Step 'Check'
if (-not (Test-Path -LiteralPath $src)) { Write-Host '  trailmark-watchdog.ps1 is not next to this script.'; Finish 1 }
if (-not (Test-Path -LiteralPath $here -PathType Container)) { Write-Host ('  Folder to watch not found: ' + $here); Finish 1 }
if (-not (Test-Path -LiteralPath $ps51)) { Write-Host ('  Windows PowerShell 5.1 not found at ' + $ps51); Finish 1 }
if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) { Write-Host '  The ScheduledTasks module is not available.'; Finish 1 }
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
Write-Host ('  folder to watch: ' + $here)
Write-Host ('  running as:      ' + $me)
Write-Host ('  PowerShell:      ' + $PSVersionTable.PSVersion.ToString() + ' (scans run under Windows PowerShell 5.1)')

Step 'Copy the watchdog'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
Copy-Item -LiteralPath $src -Destination $dest -Force
# Hashed with .NET directly: Get-FileHash can be missing from Windows
# PowerShell when it is started from a PowerShell 7 window.
function Get-FileSha([string]$Path) {
  $fs = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '') }
  finally { $fs.Dispose(); $sha.Dispose() }
}
$h1 = ''; $h2 = ''
try { $h1 = Get-FileSha $src; $h2 = Get-FileSha $dest } catch { }
if (-not $h1 -or $h1 -ne $h2) { Write-Host '  The copy could not be checked against the original, or does not match it.'; Finish 1 }
Write-Host ('  ' + $dest)
Write-Host ('  sha256 ' + $h2.ToLowerInvariant())

Step 'Record the known-good list'
& $ps51 -NoProfile -ExecutionPolicy Bypass -File $dest -Init -Root $here
$code = $LASTEXITCODE
if ($code -eq 3) { Write-Host '  Not recorded, so no task was added. Run this again when you are ready.'; Finish 1 }
if ($code -eq 4) { Write-Host '  A scheduled scan was still running. Nothing was changed; run this again in a minute.'; Finish 1 }
if ($code -ne 0) { Write-Host ('  Recording did not finish (exit ' + $code + ').'); Finish 1 }

Step 'Remove jb-watchdog, the old name, if it is installed'
# Only now, once the new known-good list is recorded, so declining above
# leaves the old watchdog running.
Remove-Legacy

Step 'Add the scheduled tasks'

function New-WatchdogAction([bool]$Headless, [string]$Mode) {
  $psArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $dest + '" ' + $Mode
  if ($Headless) { return (New-ScheduledTaskAction -Execute $conhost -Argument ('--headless ' + $ps51 + ' ' + $psArgs)) }
  return (New-ScheduledTaskAction -Execute $ps51 -Argument $psArgs)
}

function New-WatchdogSettings {
  return (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10))
}

function Register-Watchdog([bool]$Headless) {
  $every = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
  $desc = 'trailmark-watchdog: checks ' + $here + ' for changes and risky content every 15 minutes. Added by install-trailmark-watchdog.ps1.'
  Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action (New-WatchdogAction $Headless '-Scan') -Trigger @($every) -Principal $principal -Settings (New-WatchdogSettings) -Description $desc -Force -ErrorAction Stop | Out-Null
}

function Register-Reminder([bool]$Headless) {
  $atLogon = New-ScheduledTaskTrigger -AtLogOn -User $me
  $atLogon.Delay = 'PT1M'
  # "On workstation unlock" has no New-ScheduledTaskTrigger switch; it is built
  # from the Task Scheduler CIM class instead (StateChange 8 = session unlock).
  $cls = Get-CimClass -Namespace 'Root/Microsoft/Windows/TaskScheduler' -ClassName 'MSFT_TaskSessionStateChangeTrigger' -ErrorAction Stop
  $atUnlock = New-CimInstance -CimClass $cls -ClientOnly -Property @{ StateChange = [uint32]8; UserId = $me; Delay = 'PT30S'; Enabled = $true } -ErrorAction Stop
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
  $desc = 'trailmark-watchdog: scans ' + $here + ' at logon and unlock, and repeats the notification for anything not yet accepted. Added by install-trailmark-watchdog.ps1.'
  Register-ScheduledTask -TaskName $remindName -TaskPath '\' -Action (New-WatchdogAction $Headless '-Scan -Remind') -Trigger @($atLogon, $atUnlock) -Principal $principal -Settings (New-WatchdogSettings) -Description $desc -Force -ErrorAction Stop | Out-Null
}

function Test-TaskRun([string]$Name) {
  # True once the task has written a fresh scan result. False once the task has
  # stopped without writing one, or after three minutes.
  $lastScan = Join-Path $stateDir 'last-scan.json'
  $before = Get-Date
  Start-ScheduledTask -TaskName $Name -ErrorAction Stop
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    if ((Test-Path -LiteralPath $lastScan) -and ((Get-Item -LiteralPath $lastScan).LastWriteTime -gt $before)) { return $true }
    if ($i -ge 5 -and [string](Get-ScheduledTask -TaskName $Name).State -ne 'Running') {
      Start-Sleep -Seconds 1
      return ((Test-Path -LiteralPath $lastScan) -and ((Get-Item -LiteralPath $lastScan).LastWriteTime -gt $before))
    }
  }
  return $false
}

$how = $(if ($Headless) { 'through conhost --headless, with no window' } else { 'through powershell.exe with a hidden window (it may flash for a moment)' })
$useHeadless = [bool]$Headless
try {
  Register-Watchdog $useHeadless
  $ran = Test-TaskRun $taskName
  if (-not $ran -and $useHeadless) {
    Write-Host '  conhost --headless did not finish a scan. Switching to plain powershell.exe.'
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $useHeadless = $false
    Register-Watchdog $false
    $how = 'through powershell.exe with a hidden window (it may flash for a moment)'
    $ran = Test-TaskRun $taskName
  }
} catch { Write-Host ('  Could not add or start the task: ' + $_.Exception.Message); Finish 1 }
if (-not $ran) { Write-Host '  The task did not run a scan. Task Scheduler > trailmark-watchdog > History shows why.'; Finish 1 }
$info = Get-ScheduledTaskInfo -TaskName $taskName
$scan = [IO.File]::ReadAllText((Join-Path $stateDir 'last-scan.json')) | ConvertFrom-Json
Write-Host ('  task trailmark-watchdog added; it runs ' + $how)
Write-Host ('  first scheduled scan: ' + $scan.top + ', ' + $scan.files + ' files, Defender real-time protection ' + $scan.defender)
Write-Host ('  next run: ' + $info.NextRunTime)

# The reminder task is an extra. If Windows refuses it, the 15-minute scans still run.
$remindOk = $false
try {
  Register-Reminder $useHeadless
  $remindOk = Test-TaskRun $remindName
  if ($remindOk) { Write-Host '  task trailmark-watchdog-reminder added; it runs at logon and unlock' }
  else { Write-Host '  task trailmark-watchdog-reminder was added but did not finish a scan. Task Scheduler > trailmark-watchdog-reminder > History shows why.' }
} catch { Write-Host ('  Could not add trailmark-watchdog-reminder (' + $_.Exception.Message + '). The 15-minute scans still run.') }

Step 'Test notification'
& $ps51 -NoProfile -ExecutionPolicy Bypass -File $dest -TestAlert
Write-Host '  A "trailmark-watchdog test" notification should have appeared and stayed on'
Write-Host '  screen until you click Dismiss, the way HIGH alerts will. If nothing'
Write-Host '  appeared, check Settings > System > Notifications and allow Windows PowerShell.'

Step 'Done'
Write-Host '  In Windows PowerShell 5.1, the same PowerShell the scheduled scan uses, so the'
Write-Host '  hashes an accept records match the ones the scan checks (from any window):'
Write-Host '    Status:         powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\trailmark-watchdog\trailmark-watchdog.ps1" -Status'
Write-Host '    Accept changes: powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\trailmark-watchdog\trailmark-watchdog.ps1" -Accept'
Write-Host ('  Log:            ' + (Join-Path $stateDir 'watchdog.log'))
Write-Host ('  Remove:         powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $scriptDir 'install-trailmark-watchdog.ps1') + '" -Uninstall')
Finish 0
