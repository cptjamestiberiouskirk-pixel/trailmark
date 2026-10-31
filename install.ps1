# install.ps1 -- installs trailmark for Claude Code on Windows (and, with
# -Codex, adds the Codex marketplace), from this release folder. Runs under
# Windows PowerShell 5.1 or PowerShell 7. install.cmd runs it without changing
# the machine's execution policy.
#
# What it does, in order. It stops at the first step that fails and says why.
#   1. Checks Node (present, and not older than its line's October 2026
#      security release), git and the claude command.
#   2. Checks this folder and the folders above it: Claude Code runs the
#      hooks from here, so write rights for anyone but you, Administrators,
#      SYSTEM, TrustedInstaller and CREATOR OWNER, or another owner, are refused.
#   3. Checks NoDefaultCurrentDirectoryInExePath (see MANUAL.md); with
#      -SetNoCwdLookup it sets it to 1 for your user.
#   4. Runs trailmark's sandbox check (Node's permission model on this PC).
#   5. Refuses if trailmark is already installed from another marketplace, or
#      if a marketplace named trailmark points at another folder, since two
#      copies would each run the hooks. -Repoint allows the second case.
#   6. claude plugin validate, claude plugin marketplace add <this folder>,
#      claude plugin install trailmark@trailmark (user scope).
#   7. With -Codex: codex plugin marketplace add <this folder>.
#   8. With -Watchdog: runs tools\windows\install-trailmark-watchdog.ps1, which adds
#      two scheduled tasks that watch this folder (it asks before recording).
#
# It downloads nothing, changes no file in this folder and touches no repo.
# Settings it changes: what the claude and codex commands write when a
# marketplace is added and a plugin installed, and, only with -SetNoCwdLookup,
# one user environment variable.
#
#   .\install.ps1                  install for Claude Code
#   .\install.ps1 -Codex           also add the Codex marketplace
#   .\install.ps1 -Watchdog        also install trailmark-watchdog
#   .\install.ps1 -SetNoCwdLookup  also set NoDefaultCurrentDirectoryInExePath=1
#   .\install.ps1 -Check           run the checks only, change nothing
#   .\install.ps1 -Uninstall       uninstall the plugin and remove the
#                                  marketplace (memory folders are kept)
#   .\install.ps1 -AllowOldNode    continue on a Node below the security floor
#   .\install.ps1 -Preflight       -Check for the migration script: jb-memory, which
#                                  it removes after these checks, doesn't count
#   .\install.ps1 -Repoint         let an existing trailmark marketplace that
#                                  points elsewhere point here instead

param(
  [switch]$Codex,
  [switch]$Watchdog,
  [switch]$SetNoCwdLookup,
  [switch]$Check,
  [switch]$Uninstall,
  [switch]$AllowOldNode,
  [switch]$Repoint,
  [switch]$Preflight
)
# Windows PowerShell 5.1 started from PowerShell 7 inherits its PSModulePath,
# finds PowerShell 7's copies of its own modules first, and then fails to load
# Get-Acl, ConvertFrom-Json and the like. PowerShell 7's entries are dropped.
if ($PSVersionTable.PSVersion.Major -lt 6 -and $env:PSModulePath) {
  # PowerShell 7's folders, wherever it was installed from (installer, Store,
  # Scoop), are dropped, and Windows PowerShell's own modules come first.
  # Built with language features only: cmdlets from those modules can't load yet.
  $tmPsPaths = [System.Collections.Generic.List[string]]::new()
  foreach ($e in (@("$PSHOME\Modules") + @($env:PSModulePath -split ';'))) {
    if ($e -and $e -notmatch '(^|\\)PowerShell\\|\\WindowsApps\\Microsoft\.PowerShell|\\pwsh\\' -and -not $tmPsPaths.Contains($e)) { $tmPsPaths.Add($e) }
  }
  $env:PSModulePath = $tmPsPaths -join ';'
}

$ErrorActionPreference = 'Continue'
# UTF-8 both ways with node and claude, so paths outside ASCII survive.
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
$here   = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).ProviderPath.TrimEnd('\')
if ($here -match '^[A-Za-z]:$') { $here += '\' }
$mkt    = 'trailmark'
$plugin = 'trailmark'

function Step([string]$t) { Write-Host ''; Write-Host "=== $t" }
function Ok([string]$t) { Write-Host ('  ok    ' + $t) }
function Warn([string]$t) { Write-Host ('  WARN  ' + $t) -ForegroundColor Yellow }
function Fail([string]$t) { Write-Host ('  FAIL  ' + $t) -ForegroundColor Red; exit 1 }
function Have([string]$n) { return [bool](Get-Command $n -ErrorAction SilentlyContinue) }
# Runs a native command and returns its output as one string; $LASTEXITCODE is kept.
function Run([string]$Exe, [string[]]$A) { $o = & $Exe @A 2>&1 | ForEach-Object { [string]$_ }; return ($o -join "`n") }
# Standard output only, for output that is parsed: a notice the command
# prints on stderr (an update is available, say) must not end up in the JSON.
function RunOut([string]$Exe, [string[]]$A) { $o = & $Exe @A 2>$null | ForEach-Object { [string]$_ }; return ($o -join "`n") }
# The checks that parse JSON run tools\install-check.js, never JavaScript on
# the command line: Windows PowerShell 5.1 drops the quotes inside a native
# argument, which made such code fail silently. Returns the printed value, or
# $null when the input wasn't the list expected (exit code 3) or node failed.
$checkJs = Join-Path $here 'tools\install-check.js'
function NodeCheck([string]$What, [string]$In) {
  $o = $In | & node $checkJs $What 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return ([string]($o -join "`n")).Trim()
}

if ($Uninstall) {
  Step 'Uninstall'
  if (-not (Have 'claude')) { Fail 'claude is not on PATH.' }
  & claude plugin uninstall "$plugin@$mkt"
  if ($LASTEXITCODE -ne 0) { Warn "claude plugin uninstall $plugin@$mkt did not succeed (it may not be installed)." }
  & claude plugin marketplace remove $mkt
  if ($LASTEXITCODE -ne 0) { Warn "claude plugin marketplace remove $mkt did not succeed (it may not be configured)." }
  # The ChatGPT app lists an installed plugin only through its marketplace,
  # so the marketplace stays until trailmark-codex is uninstalled there.
  $codexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' })
  $codexCfg = ''
  try { $codexCfg = [IO.File]::ReadAllText((Join-Path $codexHome 'config.toml')) } catch { $codexCfg = '' }
  if ($codexCfg -match '(?m)^\s*\[\s*plugins\s*\.\s*"trailmark-codex@') {
    Warn 'trailmark-codex is still installed in the ChatGPT app. Uninstall it there first (Plugins), then run this again to remove its marketplace: the app shows it only through that marketplace.'
  } elseif (Have 'codex') {
    $null = Run 'codex' @('plugin', 'marketplace', 'remove', 'trailmark-codex')
    if ($LASTEXITCODE -eq 0) { Ok 'removed the trailmark-codex marketplace from Codex' }
  }
  Write-Host ''
  Write-Host 'Done. The memory folders (%USERPROFILE%\.claude\projects\<repo>\memory) were kept.'
  Write-Host 'trailmark-watchdog, if installed, stays: remove it with'
  Write-Host ('  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $here 'tools\windows\install-trailmark-watchdog.ps1') + '" -Uninstall')
  exit 0
}

Step 'Check the tools'
if (-not (Have 'node')) { Fail 'node is not on PATH. Install the Node.js LTS (24.22.1 or later), open a new terminal and run this again.' }
$nodePath = (Get-Command node).Source
$nodeVer = (Run 'node' @('-p', 'process.version')).Trim()
if (-not (Test-Path -LiteralPath $checkJs -PathType Leaf)) { Fail 'tools\install-check.js is missing; run install.ps1 from the release folder.' }
$advice = NodeCheck 'node-advice' ''
if ($null -eq $advice) { Fail 'node could not run tools\install-check.js.' }
if ($advice) {
  if ($AllowOldNode) { Warn ($advice + ' (continuing: -AllowOldNode)') } else { Fail ($advice + ' Or run again with -AllowOldNode.') }
} else { Ok ('node ' + $nodeVer + ' (' + $nodePath + ')') }
if ($nodePath.StartsWith($here + '\', [StringComparison]::OrdinalIgnoreCase)) { Fail 'the node on PATH is inside this folder. Use the installed Node.' }
if (Have 'git') { Ok (Run 'git' @('--version')) } else { Warn 'git is not on PATH. trailmark works, but logs no commits and shows no branch until it is.' }
if (-not (Have 'claude')) { Fail 'claude is not on PATH. Install Claude Code first.' }
$cv = ((Run 'claude' @('--version')) -split "`n")[0]
Ok ('claude ' + $cv)
if ($cv -match '(\d+)\.(\d+)\.(\d+)') {
  $v = [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3])
  if ($v -lt [version]'2.1.304') { Warn 'this Claude Code is older than 2.1.304, the oldest version tested. Hooks need command hooks with args and if; update Claude Code if the [trailmark] line never appears.' }
}
foreach ($p in ([string]$env:PATH).Split([IO.Path]::PathSeparator)) {
  $t = $p.Trim().Trim('"')
  if ($t -eq '' -or -not [IO.Path]::IsPathRooted($t) -or $t -match '^[A-Za-z]:[^\\/]' -or ($t -match '^[\\/][^\\/]' -and [IO.Path]::DirectorySeparatorChar -eq '\')) { Warn ('PATH holds an empty or relative entry ("' + $t + '"), which is looked up from the current folder. Remove it: every hook starts node by name.'); break }
}

Step 'Check this folder'
Write-Host ('  ' + $here)
if (-not (Test-Path -LiteralPath (Join-Path $here '.claude-plugin\marketplace.json') -PathType Leaf)) { Fail 'no .claude-plugin\marketplace.json here; run install.ps1 from the release folder.' }
# Who may change what the hooks run: you, Administrators, SYSTEM,
# TrustedInstaller and CREATOR OWNER (which stands for whoever creates a
# file). A right to write for anyone else, a group or another user, is refused.
# WriteData, AppendData, WriteExtendedAttributes, DeleteSubdirectoriesAndFiles,
# WriteAttributes, Delete, ChangePermissions, TakeOwnership, GenericAll, GenericWrite.
$writeMask = [int64](0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000)
# Above the release, what lets someone remove, rename or take over a folder on the way.
$parentMask = [int64](0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000)
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$okOwners = @($me, 'S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$okWriters = @($okOwners) + @('S-1-3-0')
# The owner and access rules of a file or folder: Get-Acl, or .NET directly
# when Get-Acl can't load (Windows PowerShell 5.1 only; the result is the same).
function Read-Acl([string]$Item) {
  $first = ''
  try { $a = Get-Acl -LiteralPath $Item -ErrorAction Stop; return @{ Owner = $a.GetOwner([Security.Principal.SecurityIdentifier]).Value; Access = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) } } catch { $first = $_.Exception.Message }
  try {
    if ([IO.Directory]::Exists($Item)) { $s = [IO.Directory]::GetAccessControl($Item) } else { $s = [IO.File]::GetAccessControl($Item) }
    return @{ Owner = $s.GetOwner([Security.Principal.SecurityIdentifier]).Value; Access = @($s.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) }
  } catch { throw ($first + '; ' + $_.Exception.Message) }
}
function Get-Bad([string]$Item, [bool]$ParentOnly) {
  $out = @()
  try { $acl = Read-Acl $Item } catch { return @('could not read the permissions of ' + $Item + ' (' + $_.Exception.Message + ')') }
  if ($true) {
    $own = ''
    # An owner given as a SID is used as it is. One that can't be named or
    # translated is refused: it can't be shown to be you.
    if ([string]$acl.Owner -match '^S-1-[0-9-]+$') { $own = [string]$acl.Owner }
    else { try { $own = (New-Object Security.Principal.NTAccount $acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value } catch { $own = '' } }
    if (-not $own) { $out += ($Item + ': its owner (' + $acl.Owner + ') could not be identified') }
    elseif ($okOwners -notcontains $own) { $out += ($Item + ': owned by ' + $acl.Owner) }
  }
  foreach ($r in $acl.Access) {
    if ($r.AccessControlType -ne 'Allow') { continue }
    if (([int]$r.PropagationFlags -band 2) -ne 0) { continue } # inherit-only: not on this item
    $sid = ''
    try { $sid = $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $out += ($Item + ': an access rule for ' + $r.IdentityReference.Value + ' could not be identified'); continue }
    if ($okWriters -contains $sid) { continue }
    $bits = [int64]([int]$r.FileSystemRights) -band 0xFFFFFFFF
    $mask = $(if ($ParentOnly) { $parentMask } else { $writeMask })
    if (($bits -band $mask) -ne 0) { $out += ($Item + ': ' + $r.IdentityReference.Value + ' ' + $r.FileSystemRights) }
  }
  return $out
}
$bad = @()
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  Warn 'not Windows: the permission check is skipped. On macOS and Linux, install.sh checks permissions.'
  $items = @()
} else {
  $items = @($here) + @(Get-ChildItem -LiteralPath $here -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\tools\\windows\\[^\\]+\.log$' } | ForEach-Object { $_.FullName })
}
# The release ships no links. A symbolic link or junction inside it could point
# at a folder others can write to, and the permission check above would never
# see it (Windows PowerShell 5.1 recurses into some of them, PowerShell 7 into none).
# OneDrive's cloud placeholders are reparse points too, but not links, so they pass.
if ($items.Count) {
  $lk = @(Get-ChildItem -LiteralPath $here -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.LinkType -eq 'SymbolicLink' -or $_.LinkType -eq 'Junction' } | Select-Object -First 1)
  if ($lk.Count) { Fail ($lk[0].FullName + ' is a ' + $lk[0].LinkType + '. The release has none; replace it with the real file or folder.') }
}
foreach ($it in $items) { $bad += Get-Bad $it $false; if ($bad.Count -ge 5) { break } }
$par = $(if ($items.Count) { Split-Path -Parent $here } else { '' })
while ($par -and $bad.Count -lt 5) { $bad += Get-Bad $par $true; $next = Split-Path -Parent $par; if ($next -eq $par) { break }; $par = $next }
if ($bad.Count) { Fail ('someone other than you could change what the hooks run: ' + ($bad -join '; ') + '. Move the folder under your user profile, or fix those permissions.') }
if ($items.Count) { Ok 'only you (and the system) can change this folder' }

Step 'Working-folder lookup'
$nd = [Environment]::GetEnvironmentVariable('NoDefaultCurrentDirectoryInExePath', 'User')
$ndm = [Environment]::GetEnvironmentVariable('NoDefaultCurrentDirectoryInExePath', 'Machine')
if ($nd) { Ok ('NoDefaultCurrentDirectoryInExePath is set for your user (' + $nd + ')') }
elseif ($ndm) { Ok ('NoDefaultCurrentDirectoryInExePath is set for this PC (' + $ndm + ')') }
elseif ($SetNoCwdLookup -and -not ($Check -or $Preflight)) {
  [Environment]::SetEnvironmentVariable('NoDefaultCurrentDirectoryInExePath', '1', 'User')
  Ok 'set NoDefaultCurrentDirectoryInExePath=1 for your user. Restart Claude Code and the desktop app so they see it.'
  Write-Host '        To undo: [Environment]::SetEnvironmentVariable(''NoDefaultCurrentDirectoryInExePath'', $null, ''User'')'
} else {
  Warn 'NoDefaultCurrentDirectoryInExePath is not set. Without it, cmd.exe and Node look for node.exe in the current folder (a repo) before PATH. Run again with -SetNoCwdLookup, or see MANUAL.md, "Windows: the working-folder lookup".'
}

Step 'Sandbox check'
Push-Location -LiteralPath $here
$sc = Run 'node' @([IO.Path]::Combine($here, 'plugins', 'trailmark', 'scripts', 'trailmark.js'), '--sandbox-check')
$scCode = $LASTEXITCODE
Pop-Location
foreach ($l in ($sc -split "`n")) { Write-Host ('  ' + $l) }
if ($scCode -ne 0 -or $sc -notmatch '(?m)^SANDBOX OK') { Fail 'the sandbox check did not pass. See MANUAL.md, "Sandbox check failed".' }

Step 'Check for other copies'
$list = RunOut 'claude' @('plugin', 'list', '--json')
if ($LASTEXITCODE -ne 0) { Fail 'claude plugin list --json failed, so other installs could not be checked.' }
$other = NodeCheck $(if ($Preflight) { 'others-new' } else { 'others' }) $list
if ($null -eq $other) { Fail 'could not read the output of claude plugin list --json.' }
if ($other) { Fail ('another copy is already installed as ' + $other + ' (jb-memory is Trailmark''s old name). Two copies would each run every hook. Uninstall it first: claude plugin uninstall ' + $other) }
$mlist = RunOut 'claude' @('plugin', 'marketplace', 'list', '--json')
if ($LASTEXITCODE -ne 0) { Fail 'claude plugin marketplace list --json failed, so other marketplaces could not be checked.' }
$where = NodeCheck 'marketplace' $mlist
if ($null -eq $where) { Fail 'could not read the output of claude plugin marketplace list --json.' }
$hereReal = [string](& node $checkJs real $here)
if ($where -and -not ($where.TrimEnd('\') -ieq $here) -and -not ($where.TrimEnd('\') -ieq $hereReal.TrimEnd('\'))) {
  if ($Repoint) { Warn ('the trailmark marketplace pointed at ' + $where + '; it will point here (-Repoint).') }
  else { Fail ('a marketplace named trailmark already points at ' + $where + '. Run again with -Repoint to point it here, or install from that folder.') }
}
Ok 'no other Trailmark or jb-memory install'

if ($Check -or $Preflight) { Write-Host ''; Write-Host 'Checks done: nothing was changed.'; exit 0 }

Step 'Install for Claude Code'
$null = Run 'claude' @('plugin', 'validate', $here)
if ($LASTEXITCODE -ne 0) { Fail ('claude plugin validate failed; run it by hand to see why: claude plugin validate "' + $here + '"') }
& claude plugin marketplace add $here
if ($LASTEXITCODE -ne 0) { Fail 'claude plugin marketplace add failed.' }
& claude plugin install "$plugin@$mkt"
if ($LASTEXITCODE -ne 0) { Fail 'claude plugin install failed.' }

if ($Codex) {
  Step 'Codex'
  if (Have 'codex') {
    & codex plugin marketplace add $here
    if ($LASTEXITCODE -ne 0) { Warn 'codex plugin marketplace add failed.' }
    Write-Host '  Next, in the ChatGPT desktop app: restart it, open Plugins, choose the'
    Write-Host '  trailmark-codex marketplace, install trailmark-codex, then review and trust'
    Write-Host '  its hooks. MANUAL.md, "Codex", has the rest.'
  } else { Warn 'codex is not on PATH. Add the marketplace from the ChatGPT app or install the Codex CLI; see MANUAL.md, "Codex".' }
}

if ($Watchdog) {
  Step 'trailmark-watchdog'
  $wi = Join-Path $here 'tools\windows\install-trailmark-watchdog.ps1'
  $ps51 = Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe'
  & $ps51 -NoProfile -ExecutionPolicy Bypass -File $wi -Root $here
  if ($LASTEXITCODE -ne 0) { $watchdogFailed = $true; Warn ('trailmark-watchdog was not installed (exit ' + $LASTEXITCODE + '); its messages are above. Trailmark itself is installed.') }
}

Step 'Done'
Write-Host '  Next, in each repo you want Trailmark in:'
Write-Host '    1. Start Claude Code there and run /trailmark:memory-setup'
Write-Host '    2. Start a new session and look for the [trailmark] status line;'
Write-Host '       it ends with "sandbox on".'
Write-Host '  MANUAL.md in this folder covers the rest.'
Write-Host '  Keep this folder where it is: Claude Code loads the plugin from it.'
# 3: installed, but the watchdog asked for wasn't.
if ($watchdogFailed) { exit 3 }
exit 0
