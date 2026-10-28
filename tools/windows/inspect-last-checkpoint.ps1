# inspect-last-checkpoint.ps1
# Read-only. Shows how the most recent trailmark checkpoints in a repo were
# written: which tool Claude used (Bash heredoc, or the Write tool plus --from),
# what each of those calls returned, including any refusal, the permission mode
# the session ran in, and whether a drop file was left behind.
#
# It reads Claude Code's session transcripts under %USERPROFILE%\.claude\projects,
# the newest ones that ran write-handoff, and prints only the trailmark tool
# calls and their results. The rest of the conversation, and the text Claude
# wrote with the Write tool, are not printed. Nothing is changed.
# Log: inspect-last-checkpoint.log next to this file.

param(
  [string]$Repo = '',
  [int]$Hours = 48,
  [int]$Sessions = 2
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
$log  = Join-Path $root 'inspect-last-checkpoint.log'
$projectsDir = [IO.Path]::Combine($env:USERPROFILE, '.claude', 'projects')

Start-Transcript -Path $log -Force | Out-Null
function Step([string]$t) { Write-Host ''; Write-Host "=== $t" }
function Short([string]$s, [int]$n) {
  $s = ($s -replace '\s+', ' ').Trim()
  if ($s.Length -gt $n) { $s = $s.Substring(0, $n) + '...' }
  return $s
}
function Done {
  try { Stop-Transcript -ErrorAction Stop | Out-Null } catch { }
  Write-Host ''
  Read-Host 'Press Enter to close' | Out-Null
  exit 0
}

Step 'Memory folder'
if (-not (Test-Path -LiteralPath $Repo)) { Write-Host ('  repo not found: ' + $Repo); Done }
Push-Location $Repo
$dirOut = @((& node $jbm dir 2>&1) | ForEach-Object { [string]$_ })
$statusOut = @((& node $jbm status 2>&1) | ForEach-Object { [string]$_ })
Pop-Location
$memDir = $dirOut[0].Trim()
foreach ($l in $dirOut + $statusOut) { Write-Host ('  ' + $l) }
# 0.3.0 names drop files incoming-handoff-<session id>.md; 0.2.x used incoming-handoff.md.
$drops = @(Get-ChildItem -LiteralPath $memDir -Filter 'incoming-*.md' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
Write-Host ('  drop files left behind: ' + $(if ($drops.Count) { $drops -join ', ' } else { 'none' }))
$notesDir = Join-Path $memDir 'notes'
if (Test-Path -LiteralPath $notesDir) {
  $nf = Get-ChildItem -LiteralPath $notesDir -Filter '*.md' | Sort-Object Name | Select-Object -Last 1
  if ($nf) {
    Write-Host ('  latest log lines (' + $nf.Name + '):')
    Get-Content -LiteralPath $nf.FullName | Where-Object { $_ -match '^- ' } | Select-Object -Last 12 | ForEach-Object { Write-Host ('    ' + $_) }
  }
}

Step ('Transcripts from the last ' + $Hours + ' hours that ran write-handoff')
$since = (Get-Date).AddHours(-$Hours)
$cands = @(Get-ChildItem -LiteralPath $projectsDir -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter '*.jsonl' -File -ErrorAction SilentlyContinue } |
  Where-Object { $_.LastWriteTime -ge $since } |
  Where-Object { Select-String -LiteralPath $_.FullName -SimpleMatch 'write-handoff' -List -Quiet } |
  Sort-Object LastWriteTime -Descending | Select-Object -First $Sessions)
if ($cands.Count -eq 0) { Write-Host '  none found'; Done }

foreach ($f in $cands) {
  Write-Host ''
  Write-Host ('--- ' + $f.Directory.Name + '\' + $f.Name + '   last written ' + $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
  $uses = [ordered]@{}
  $results = @{}
  $modes = New-Object System.Collections.ArrayList
  $meta = ''
  foreach ($line in [IO.File]::ReadLines($f.FullName)) {
    if (-not ($line.Contains('tool_use') -or $line.Contains('tool_result') -or $line.Contains('permissionMode'))) { continue }
    $ev = $null
    try { $ev = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
    if ($ev.permissionMode -and -not $modes.Contains([string]$ev.permissionMode)) { [void]$modes.Add([string]$ev.permissionMode) }
    if (-not $meta -and $ev.entrypoint) { $meta = 'entrypoint ' + $ev.entrypoint + $(if ($ev.version) { ', Claude Code ' + $ev.version } else { '' }) + $(if ($ev.gitBranch) { ', branch ' + $ev.gitBranch } else { '' }) }
    if (-not $ev.message -or -not $ev.message.content) { continue }
    foreach ($c in @($ev.message.content)) {
      if ($c.type -eq 'tool_use') {
        $sum = ''
        $keep = $false
        if ($c.input.command) { $sum = [string]$c.input.command; $keep = $sum -match '(?:trailmark|jbm)\.js' }
        elseif ($c.input.file_path) { $sum = 'file ' + [string]$c.input.file_path; $keep = $sum -match 'incoming-|[\\/]memory[\\/]' }
        elseif ($c.input.skill) { $sum = 'skill ' + [string]$c.input.skill; $keep = $sum -match 'trailmark|jb-memory' }
        if ($keep) { $uses[[string]$c.id] = [pscustomobject]@{ Time = [string]$ev.timestamp; Tool = [string]$c.name; What = $sum } }
      } elseif ($c.type -eq 'tool_result') {
        $txt = ''
        if ($c.content -is [string]) { $txt = $c.content }
        else { $txt = (@($c.content) | Where-Object { $_.type -eq 'text' } | ForEach-Object { [string]$_.text }) -join ' ' }
        $results[[string]$c.tool_use_id] = [pscustomobject]@{ Error = [bool]$c.is_error; Text = $txt }
      }
    }
  }
  Write-Host ('  ' + $(if ($meta) { $meta } else { 'no entrypoint recorded' }))
  Write-Host ('  permission mode(s) recorded: ' + $(if ($modes.Count) { $modes -join ', ' } else { 'none recorded' }))
  if ($uses.Count -eq 0) { Write-Host '  no trailmark tool calls found'; continue }
  foreach ($id in $uses.Keys) {
    $u = $uses[$id]
    $r = $results[$id]
    $t = $(if ($u.Time.Length -ge 19) { $u.Time.Substring(11, 8) } else { $u.Time })
    Write-Host ('  ' + $t + '  ' + $u.Tool + ': ' + (Short $u.What 150))
    if ($r) {
      Write-Host ('      -> ' + $(if ($r.Error) { 'ERROR: ' } else { 'ok: ' }) + (Short $r.Text 220))
    } else {
      Write-Host '      -> (no result recorded)'
    }
  }
}
Done
