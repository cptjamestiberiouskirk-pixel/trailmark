# migrate-from-jb-memory.ps1 -- runs migrate-from-jb-memory.js (next to this
# file) with node.exe from PATH. Unlike cmd.exe, PowerShell never runs a
# program from the current folder by its bare name; a PATH entry that is the
# current folder (such as '.') is skipped here too. Options pass through:
#   .\migrate-from-jb-memory.ps1 --dry-run
# See migrate-from-jb-memory.js for what it does.

$ErrorActionPreference = 'Stop'
$here = (Get-Location).ProviderPath.TrimEnd('\')
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
