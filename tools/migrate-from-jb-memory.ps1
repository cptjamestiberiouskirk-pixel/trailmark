# migrate-from-jb-memory.ps1 -- runs migrate-from-jb-memory.js (next to this
# file) with node.exe from PATH. Unlike cmd.exe, PowerShell never runs a
# program from the current folder by its bare name; a PATH entry that is the
# current folder (such as '.') is skipped here too. Options pass through:
#   .\migrate-from-jb-memory.ps1 --dry-run
# See migrate-from-jb-memory.js for what it does.

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

$ErrorActionPreference = 'Stop'
$here = (Get-Location).ProviderPath.TrimEnd('\')
# PATH keeps only absolute folders for this run (as install.ps1 does), so
# node.exe isn't found through ".", a relative entry or a drive-relative C:.
$tmPathKeep = [System.Collections.Generic.List[string]]::new()
foreach ($p in ([string]$env:PATH).Split([IO.Path]::PathSeparator)) {
  $t = $p.Trim().Trim('"')
  if ($t -eq '') { continue }
  if (-not [IO.Path]::IsPathRooted($t) -or $t -match '^[A-Za-z]:([^\\/]|$)' -or $t -match '^[\\/][^\\/]') { continue }
  $tmPathKeep.Add($p)
}
$env:PATH = $tmPathKeep -join [IO.Path]::PathSeparator
$node = Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue |
  Where-Object { [IO.Path]::IsPathRooted($_.Source) -and ((Split-Path -Parent $_.Source).TrimEnd('\') -ne $here) } |
  Select-Object -First 1
if (-not $node) {
  Write-Host 'node.exe is not on PATH. Install Node.js 24.22.1 or later (22.23.4 or 26.12.1 on those lines), then run this again.' -ForegroundColor Red
  exit 1
}
$script = Join-Path $PSScriptRoot 'migrate-from-jb-memory.js'
& $node.Source $script @args
exit $LASTEXITCODE
