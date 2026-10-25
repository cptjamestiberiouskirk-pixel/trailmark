# verify-jb-hooks.ps1
# Checks the jb-memory hooks that only fire mid-session (commit, PR merge,
# subagent, compaction) on this PC. It works in a throwaway repo, so
# no real repo's memory is touched.
#
# Part 1, mechanism (no model calls): feeds each hook the JSON Claude Code
#   would send and checks what the hook writes. This shows the launcher, the
#   sandbox and the scripts work on Windows. It does not show Claude Code
#   calling them.
# Part 2, end to end (short calls to the model below): real `claude -p` runs
#   where Claude makes a commit, merges a PR with a stand-in gh, runs a gh help
#   call that must not count, uses a subagent, then compacts. Each check looks
#   for the hook's own footprint on disk, and separately for whether Claude
#   quoted the reminder.
# Part 3, end to end: commits written as `git -C <path> commit`, and commits and
#   PR merges run through Claude Code's PowerShell tool instead of Bash. Then
#   commits made in a second clone with git -C, cd (Bash) and Set-Location
#   (PowerShell), which jb-memory must log from that clone. Claude Code asks
#   before a folder change followed by git, which claude -p can't answer, so
#   the cd and Set-Location runs get a test hook that allows exactly that one
#   command (see New-AllowHook). Then where the Bash shell is after a cd into
#   an added folder (cd, then pwd: information only), for one folder in the
#   temp folder and one outside it (jbm-hooktest-<time>-out in
#   %LOCALAPPDATA%, deleted at the end). Then whether the Skill tool loads
#   jb-memory:checkpoint (PASS or FAIL) and what it does with plain
#   checkpoint (information: Claude Code's /rewind has that alias). These
#   read the session's transcript, not only Claude's reply. Then a commit in a
#   command that fails at the push afterwards, which Claude Code reports as
#   PostToolUseFailure. Then
#   checks that every session's start hook logged sandbox=on.
#
# jb-memory 0.3.3 checks in Part 1 (no model calls): a commit in a second clone
# is logged from that clone with in="<folder>", written as a Windows path and
# as a Git Bash path (/c/...), and through the PowerShell tool; the same
# command again logs nothing (the 0.3.2 bug logged the session folder's HEAD
# again here); the Updated line takes branch and HEAD from the clone and names
# it, and stays as before for a session in the main checkout; a commit whose
# folder can't be known is logged as COMMIT_UNRESOLVED; and a clone whose
# config would run a program on a lazy fetch runs nothing when the hook reads
# it. The second clone, that clone and a worktree are jbm-hooktest-<time>-clone,
# -hostile and -wt beside the throwaway repo, and are deleted with it.
#
# jb-memory 0.3.4 checks in Part 1 (no model calls): a command whose end
# folder, as read, isn't where Claude Code says it ended logs one END_MISMATCH
# line; another commit in the same folder while a command ran is left out
# when git printed the command's own; a commit in a command that then failed
# (PostToolUseFailure) is logged; a commit no hook saw is logged once as
# (found later) at write-handoff; the compaction snapshot's git status runs
# with a filter the repo itself defines switched off; and the PreToolUse
# commit hook's time is measured (median of 10, beside a bare node start).
# The test filter's marker and the allow hook live in jbm-hooktest-<time>-allow,
# deleted with the rest.
#
# The stand-in gh lives in the throwaway repo's .fakebin folder and goes on PATH
# only for the claude runs that merge. It prints one line, records that it ran,
# and changes nothing. GH_HOST is pointed at an invalid host for those runs, so
# the real gh couldn't reach GitHub even if it were picked up instead.
#
# The throwaway repo is jbm-hooktest-<time> in the temp folder, outside the
# folder jb-watchdog watches. Its memory folder and
# Claude Code transcripts go to %USERPROFILE%\.claude\projects\<that path>. Both
# are deleted at the end unless you pass -Keep. Claude Code may also remember the
# folder in %USERPROFILE%\.claude.json; that entry is harmless.
# Claude gets only the tool each step needs, for example Bash(git commit *),
# PowerShell(gh pr merge *) or Agent.
# Log: verify-jb-hooks.log next to this file.

param([switch]$Keep, [string]$Model = 'claude-sonnet-5-5')

$ErrorActionPreference = 'Continue'
# Text piped to node (hook payloads, handoff text) goes as UTF-8, so a temp
# folder with a non-ASCII name reaches the hooks intact. Windows PowerShell
# 5.1 would send ASCII.
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$root  = Split-Path -Parent $MyInvocation.MyCommand.Path
$jbm   = [IO.Path]::Combine($root, '..', '..', 'plugins', 'jb-memory', 'scripts', 'jbm.js')
# The release layout keeps this script in tools\windows; an older layout kept it
# next to jb-memory-marketplace.
if (-not (Test-Path -LiteralPath $jbm -PathType Leaf)) { $jbm = [IO.Path]::Combine($root, 'jb-memory-marketplace', 'plugins', 'jb-memory', 'scripts', 'jbm.js') }
$jbm = [IO.Path]::GetFullPath($jbm)
$log   = Join-Path $root 'verify-jb-hooks.log'
$workRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$repo  = Join-Path $workRoot ('jbm-hooktest-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$fakeBin = Join-Path $repo '.fakebin'
$clone = $repo + '-clone'
$hostile = $repo + '-hostile'
$wt = $repo + '-wt'
$allowDir = $repo + '-allow'
# A folder outside the temp folder for the shell check: Git Bash shows the
# temp folder as /tmp/..., and every shell reset seen so far was in it.
$outDir = Join-Path ([IO.Path]::GetFullPath([string]$env:LOCALAPPDATA).TrimEnd('\', '/')) ((Split-Path -Leaf $repo) + '-out')
$allowSettings = Join-Path $allowDir 'settings.json'
$sidA = '11111111-aaaa-4bbb-8ccc-0000000000a1'
$sidB = '22222222-aaaa-4bbb-8ccc-0000000000b2'
$sidC = '33333333-aaaa-4bbb-8ccc-0000000000c3'
$sidD = '44444444-aaaa-4bbb-8ccc-0000000000d4'
$sidE = '55555555-aaaa-4bbb-8ccc-0000000000e5'
$projectsDir = [IO.Path]::Combine($env:USERPROFILE, '.claude', 'projects')
$results = New-Object System.Collections.ArrayList
$memDir = $null
$savedPath = $null
$savedGhHost = $null
$fakeOn = $false
# Started from inside a Claude Code session, these would point the hooks at
# that session's repo instead of the test repo.
foreach ($v in 'JBMEM_NESTED', 'JBMEM_DIR', 'JBMEM_METHOD', 'JBMEM_ROOT', 'JBMEM_GIT', 'CLAUDE_CODE_PROJECT_DIR_NAME') {
  Remove-Item ('Env:' + $v) -ErrorAction SilentlyContinue
}

# Asked the same way in every end-to-end step. Hook messages are named on
# purpose: asked whether text "came back with the command result", Sonnet 5.5
# can rule hook messages out (seen in the PR-merge diagnostic, 2026-10-16).
$AskQuote = 'Then check whether any text starting with [jb-memory] appeared in your context after the command ran, including hook messages. If it did, reply with the first 40 characters of that text. If not, reply NONE.'

Start-Transcript -Path $log -Force | Out-Null

function Step([string]$t) { Write-Host ''; Write-Host "=== $t" }
function Result([string]$check, [string]$level, [string]$status, [string]$detail) {
  [void]$results.Add([pscustomobject]@{ Result = $status; Level = $level; Check = $check; Detail = $detail })
  Write-Host ('  ' + $status.PadRight(6) + $check + '   ' + $detail)
}
function Notes {
  if (-not $memDir) { return @() }
  $d = Join-Path $memDir 'notes'
  if (-not (Test-Path -LiteralPath $d)) { return @() }
  return @(Get-ChildItem -LiteralPath $d -Filter '*.md' | ForEach-Object { Get-Content -LiteralPath $_.FullName -Encoding UTF8 })
}
function CountNotes([string]$pattern) { return @(Notes | Where-Object { $_ -match $pattern }).Count }
# Newest reminder time in the state file, 0 if none. Since jb-memory 0.3.0 a
# hook call that carries a session ID (every real session) records it in
# sessions.<id>.lastHintAt. Only a call without one, like the hand-fed Part 1
# calls, uses the top-level lastHintAt.
function LastHint {
  $max = [double]0
  try { $st = Get-Content -LiteralPath (Join-Path $memDir '.jbmem-state.json') -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { return $max }
  if ($null -eq $st) { return $max }
  $vals = @($st.lastHintAt)
  if ($st.sessions) { foreach ($p in $st.sessions.PSObject.Properties) { $vals += $p.Value.lastHintAt } }
  foreach ($v in $vals) {
    $n = [double]0
    if ([double]::TryParse([string]$v, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$n) -and $n -gt $max) { $max = $n }
  }
  return $max
}
function ShortHead {
  Push-Location $repo
  $h = [string](& git rev-parse --short HEAD 2>$null)
  Pop-Location
  return $h.Trim()
}
# git's output read as UTF-8 (a folder name with non-ASCII letters), not in
# the console's OEM code page. The console's setting is changed only for the
# call, and a host without a console (the ISE) keeps its own.
function GitText([string[]]$gitArgs) {
  $old = $null
  try { $old = [Console]::OutputEncoding; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { $old = $null }
  try { return ([string](& git @gitArgs 2>$null)).Trim() }
  finally { if ($null -ne $old) { try { [Console]::OutputEncoding = $old } catch { } } }
}
function HeadOf([string]$dir) { return (GitText @('-C', $dir, 'rev-parse', '--short', 'HEAD')) }
# The folder as the hook writes it: git's top level, drive letter upper case.
function TopOf([string]$dir) {
  $t = GitText @('-C', $dir, 'rev-parse', '--show-toplevel')
  if ($t -match '^[a-z]:') { $t = $t.Substring(0, 1).ToUpperInvariant() + $t.Substring(1) }
  return $t
}
function Fwd([string]$p) { return ($p -replace '\\', '/') }
# A folder as the hooks write it in a log line: forward slashes, drive letter
# upper case, no slash at the end.
function Disp([string]$p) {
  $t = Fwd $p
  if ($t -match '^[a-z]:') { $t = $t.Substring(0, 1).ToUpperInvariant() + $t.Substring(1) }
  if ($t.Length -gt 3) { $t = $t.TrimEnd('/') }
  return $t
}
# C:\x\y as Git Bash writes it: /c/x/y
function MsysPath([string]$p) { return ('/' + $p.Substring(0, 1).ToLowerInvariant() + (Fwd $p.Substring(2))) }
function CommitLines { return @(Notes | Where-Object { $_ -match '^- \d\d:\d\d COMMIT ' }) }
function HandoffVersion {
  Push-Location $repo
  $ho = @((& node $jbm handoff 2>&1) | ForEach-Object { [string]$_ })
  Pop-Location
  if ($ho.Count -and $ho[0] -match 'handoff version: (\S+)') { return $Matches[1] }
  return 'none'
}
function Write-HandoffAs([string]$sid, [string]$text) {
  $v = HandoffVersion
  Push-Location $repo
  $out = (($text | & node $jbm write-handoff ('--base=' + $v) ('--session=' + $sid) 2>&1) | ForEach-Object { [string]$_ }) -join "`n"
  Pop-Location
  $h = [IO.File]::ReadAllText((Join-Path $memDir 'handoff.md'))
  return [pscustomobject]@{ Out = $out; Line = [regex]::Match($h, '(?m)^Updated:[^\r\n]*').Value }
}
function Invoke-Hook([hashtable]$payload, [string[]]$hookArgs) {
  $json = $payload | ConvertTo-Json -Compress -Depth 6
  Push-Location $repo
  $out = (($json | & node $jbm --hook @hookArgs 2>&1) | ForEach-Object { [string]$_ }) -join "`n"
  Pop-Location
  return $out
}
function Invoke-Claude([string]$prompt, [string[]]$extra) {
  # Prompts must not contain double quotes: Windows PowerShell 5.1 does not
  # escape them when it passes arguments to a native program.
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

# Stand-in gh: one script for Git Bash (LF line endings) and one for PowerShell.
function New-FakeGh {
  New-Item -ItemType Directory -Force -Path $fakeBin | Out-Null
  $sh = @(
    '#!/bin/sh',
    '# Stand-in for the GitHub CLI, used only by verify-jb-hooks.ps1 in a throwaway repo.',
    '# Prints what a successful merge prints, records that it ran, and changes nothing.',
    'echo ran >> "$(dirname "$0")/ran.txt"',
    'echo "Merged pull request #1 (jb-memory hook test)"',
    'exit 0'
  ) -join "`n"
  [IO.File]::WriteAllText((Join-Path $fakeBin 'gh'), $sh + "`n")
  $cmd = @(
    '@echo off',
    'rem Stand-in for the GitHub CLI, used only by verify-jb-hooks.ps1 in a throwaway repo.',
    'rem Prints what a successful merge prints, records that it ran, and changes nothing.',
    'echo ran>>"%~dp0ran.txt"',
    'echo Merged pull request #1 (jb-memory hook test)',
    'exit /b 0'
  ) -join "`r`n"
  [IO.File]::WriteAllText((Join-Path $fakeBin 'gh.cmd'), $cmd + "`r`n")
}
function Enable-FakeGh {
  if ($script:fakeOn) { return }
  $script:savedPath = $env:PATH
  $script:savedGhHost = $env:GH_HOST
  $env:PATH = $fakeBin + [IO.Path]::PathSeparator + $env:PATH
  $env:GH_HOST = 'jbm-hooktest.invalid'
  $script:fakeOn = $true
}
function Disable-FakeGh {
  if (-not $script:fakeOn) { return }
  $env:PATH = $script:savedPath
  if ($null -ne $script:savedGhHost) { $env:GH_HOST = $script:savedGhHost } else { Remove-Item Env:GH_HOST -ErrorAction SilentlyContinue }
  $script:fakeOn = $false
}
function FakeGhRuns {
  $f = Join-Path $fakeBin 'ran.txt'
  if (Test-Path -LiteralPath $f) { return @(Get-Content -LiteralPath $f).Count } else { return 0 }
}

function Short1([string]$t) { $t = ($t -replace '\s+', ' ').Trim(); if ($t.Length -gt 160) { $t = $t.Substring(0, 160) + '...' }; return $t }
# Why a command Claude was asked to run didn't run, as far as its reply says.
# The PowerShell tool setting is named only when the reply says the tool
# isn't there.
function NotRunHint([string]$what, [string]$tool, [string]$reply) {
  if ($reply -match '(?i)approv|permission|blocked|not allowed|denied') {
    $h = $what + '; Claude Code wanted approval for the command'
    if ($reply -match '(?i)\bcd\b|Set-Location') { $h += ' (a folder change before git)' }
    return $h + ', which claude -p can''t give'
  }
  if ($tool -eq 'PowerShell' -and $reply -match '(?i)PowerShell tool[^.\r\n]{0,40}(not available|unavailable|isn.t available|not enabled|disabled)|(no|don.t have an?|do not have an?) PowerShell tool') {
    return $what + '; the PowerShell tool looks off here (CLAUDE_CODE_USE_POWERSHELL_TOOL)'
  }
  return $what
}

# The transcript lines claude -p wrote for the throwaway repo since $since:
# Claude Code keeps them in the repo's project folder, named after its path.
# A file changed since then can still hold an earlier run's lines, so each
# line is kept only if its own timestamp (the last one on the line: message
# text comes before it, and timestamps inside text are escaped) is not
# earlier. A line with no timestamp is kept.
function NewTranscriptLines([datetime]$since) {
  $leaf = Split-Path -Leaf $repo
  $sinceU = $since.ToUniversalTime().AddSeconds(-1)
  $lines = New-Object System.Collections.ArrayList
  foreach ($d in @(Get-ChildItem -LiteralPath $projectsDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name.EndsWith($leaf) })) {
    foreach ($f in @(Get-ChildItem -LiteralPath $d.FullName -Filter '*.jsonl' -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $since })) {
      foreach ($l in @(Get-Content -LiteralPath $f.FullName -Encoding UTF8 -ErrorAction SilentlyContinue)) {
        $ms = [regex]::Matches([string]$l, '"timestamp":"(\d{4}-\d{2}-\d{2}T[^"]+)"')
        if ($ms.Count) {
          $ts = [DateTime]::MinValue
          if ([DateTime]::TryParse($ms[$ms.Count - 1].Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$ts) -and $ts.ToUniversalTime() -lt $sinceU) { continue }
        }
        [void]$lines.Add([string]$l)
      }
    }
  }
  return ,$lines
}
# Tool calls and results in transcript lines, in order. Kind is use, result
# (with the tool's name and input, the text and whether it was an error) or
# skilltext (the message Claude Code adds with a skill's instructions).
function ToolEvents($lines) {
  $uses = @{}
  $out = New-Object System.Collections.ArrayList
  foreach ($l in @($lines)) {
    if (-not ($l.Contains('tool_use') -or $l.Contains('tool_result') -or $l.Contains('Base directory for this skill'))) { continue }
    try { $e = $l | ConvertFrom-Json -ErrorAction Stop } catch { continue }
    if (-not $e.message) { continue }
    if ($e.message.content -is [string]) {
      if ($e.message.content.Contains('Base directory for this skill')) { [void]$out.Add([pscustomobject]@{ Kind = 'skilltext'; Name = ''; Input = $null; Text = ''; Err = $false }) }
      continue
    }
    foreach ($c in @($e.message.content)) {
      if ($c.type -eq 'tool_use') {
        $uses[[string]$c.id] = $c
        [void]$out.Add([pscustomobject]@{ Kind = 'use'; Name = [string]$c.name; Input = $c.input; Text = ''; Err = $false })
      } elseif ($c.type -eq 'tool_result') {
        $txt = $(if ($c.content -is [string]) { [string]$c.content } else { (@($c.content) | ForEach-Object { [string]$_.text }) -join "`n" })
        $u = $uses[[string]$c.tool_use_id]
        [void]$out.Add([pscustomobject]@{ Kind = 'result'; Name = $(if ($u) { [string]$u.name } else { '' }); Input = $(if ($u) { $u.input } else { $null }); Text = $txt; Err = ($c.is_error -eq $true) })
      } elseif ($c.type -eq 'text' -and ([string]$c.text).StartsWith('Base directory for this skill')) {
        [void]$out.Add([pscustomobject]@{ Kind = 'skilltext'; Name = ''; Input = $null; Text = ''; Err = $false })
      }
    }
  }
  # Unrolled, so callers can pipe it.
  return $out
}
# cd into an added folder, then pwd, as two Bash calls in one session. What
# pwd printed and whether the cd output had Claude Code's reset line come
# from the transcript; Claude's reply is the fallback. Returns 'stayed',
# 'reset' (back, with the reset line), 'back' (back, no reset line),
# 'unclear' (back; the transcript and the reply disagree about the reset
# line) or ''. A space in the folder is written as backslash-space for Git
# Bash: the prompt can't carry double quotes (see Invoke-Claude).
function Check-ShellAfterCd([string]$label, [string]$folder) {
  $since = Get-Date
  $reply = Invoke-Claude ('Use the Bash tool twice, and no other tool. First run exactly the command inside these single quotes: ''cd ' + ((Fwd $folder) -replace ' ', '\ ') + '''. Then, as a separate Bash call, run exactly: ''pwd''. Reply with one line: PWD= followed by exactly what pwd printed, a space, then RESET=yes if the output of the cd command had a line starting with Shell cwd was reset, or RESET=no if it did not.') @('--allowedTools', 'Bash(cd *)', 'Bash(pwd)', '--add-dir', $folder)
  $bash = @(ToolEvents (NewTranscriptLines $since) | Where-Object { $_.Kind -eq 'result' -and $_.Name -eq 'Bash' })
  $pw = @($bash | Where-Object { $_.Input -and ([string]$_.Input.command).Trim() -eq 'pwd' }) | Select-Object -Last 1
  $pwdText = ''; $reset = $null; $from = 'from the transcript'
  $rr = [regex]::Match($reply, 'RESET=(yes|no)')
  $replyReset = $(if ($rr.Success) { $rr.Groups[1].Value -eq 'yes' } else { $null })
  if ($pw) {
    $pwdText = [string](@(([string]$pw.Text) -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) | Select-Object -First 1)
    $reset = (@($bash | Where-Object { ([string]$_.Text).Contains('Shell cwd was reset') }).Count -gt 0)
  } else {
    $from = 'from Claude''s reply: no pwd result in the transcript'
    $m = [regex]::Match($reply, '(?m)PWD=(.+?)(?:\s+RESET=(?:yes|no))?\s*$')
    if ($m.Success) { $pwdText = $m.Groups[1].Value.Trim().Trim('"').Trim("'") }
    $reset = $replyReset
  }
  # By last folder name: Git Bash may print the temp folder as /tmp/...
  $leaf = $(if ($pwdText) { (($pwdText -replace '\\', '/').TrimEnd('/') -split '/')[-1].ToLowerInvariant() } else { '' })
  $maintainEnv = [string]$env:CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR
  $setting = ' (CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR in this window: ' + $(if ($maintainEnv) { $maintainEnv } else { 'not set' }) + '; settings.json can set it too)'
  if ($leaf -and $leaf -eq (Split-Path -Leaf $folder).ToLowerInvariant()) {
    $note = $(if ($reset -eq $true) { '; but the cd output had a Shell cwd was reset line, which contradicts this pwd' } else { '' })
    Result $label 'end to end' 'INFO' ('pwd printed ' + $pwdText + ', the added folder: the shell stayed there' + $note + ' (' + $from + ')')
    return 'stayed'
  }
  if ($leaf -and $leaf -eq (Split-Path -Leaf $repo).ToLowerInvariant()) {
    if ($reset -eq $true) {
      Result $label 'end to end' 'INFO' ('pwd printed ' + $pwdText + ', the start folder, and the cd output said Shell cwd was reset: Claude Code counted the added folder as outside the session''s folders (' + $from + ')')
      return 'reset'
    }
    if ($reset -eq $false -and $replyReset -eq $true) {
      Result $label 'end to end' 'INFO' ('pwd printed ' + $pwdText + ', the start folder: Claude Code put the shell back; the transcript has no reset line, but Claude''s reply says the cd output had one, so which way it moved the shell is not settled (' + $from + ')')
      return 'unclear'
    }
    $why = $(if ($reset -eq $false) { 'with no reset line, which is how Claude Code moves it when CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR is on' } else { 'and whether the cd output had the reset line is not known' })
    Result $label 'end to end' 'INFO' ('pwd printed ' + $pwdText + ', the start folder: Claude Code put the shell back ' + $why + $setting + ' (' + $from + ')')
    return 'back'
  }
  Result $label 'end to end' 'INCONC' (NotRunHint ('no pwd output naming either folder: ' + (Short1 $reply)) 'Bash' $reply)
  return ''
}
# Ask Claude to invoke one skill with the Skill tool and nothing else, then
# read what the Skill tool returned from the transcript. Returns 'loaded',
# 'builtin' (refused as a Claude Code command), 'other' or 'none'.
function SkillLoad([string]$name, [ref]$detail) {
  $since = Get-Date
  $reply = Invoke-Claude ('Use the Skill tool exactly once, to invoke the skill named ' + $name + ', and use no other tool. Do not carry out any of the skill''s steps. Reply LOADED if the Skill tool gave you the skill''s instructions, or REFUSED followed by the error text if it returned an error.') @('--allowedTools', 'Skill')
  $ev = @(ToolEvents (NewTranscriptLines $since))
  $res = @($ev | Where-Object { $_.Kind -eq 'result' -and $_.Name -eq 'Skill' }) | Select-Object -Last 1
  if (-not $res) { $detail.Value = NotRunHint ('no Skill call in the transcript: ' + (Short1 $reply)) 'Skill' $reply; return 'none' }
  $detail.Value = Short1 ([string]$res.Text)
  if ([string]$res.Text -match 'built-in CLI command|is a UI command|not a skill') { return 'builtin' }
  $texts = @($ev | Where-Object { $_.Kind -eq 'skilltext' }).Count
  if (-not $res.Err -and ([string]$res.Text -match 'Launching skill' -or $texts -gt 0)) { return 'loaded' }
  return 'other'
}

function Check-Commit([string]$label, [string]$tool, [string]$cmd, [string]$allow) {
  $before = ShortHead
  $reply = Invoke-Claude ('Use the ' + $tool + ' tool to run exactly this command once, and use no other tool: ' + $cmd + '. ' + $AskQuote) @('--allowedTools', $allow)
  $after = ShortHead
  if ($after -eq $before) {
    Result $label 'end to end' 'INCONC' (NotRunHint 'Claude did not make the commit, so the hook had nothing to fire on' $tool $reply)
    return
  }
  $okLog = (CountNotes ('COMMIT ' + $after)) -gt 0
  Result ($label + ' fired') 'end to end' $(if ($okLog) { 'PASS' } else { 'FAIL' }) ('hook log line for ' + $after + ': ' + $okLog)
  $okCtx = $reply -match 'jb-memory\] Commit landed'
  Result ($label + ' reminder reached Claude') 'end to end' $(if ($okCtx) { 'PASS' } else { 'WARN' }) ('Claude quoted it: ' + $okCtx)
}

# For the cd and Set-Location checks only. Claude Code asks before a command
# that changes folder and then runs git (git in the new folder could run that
# folder's hooks), and claude -p can't answer, so no allow rule gets such a
# command through. A PreToolUse hook can answer allow instead. This one is
# written beside the throwaway repo and passed with --settings to those two
# runs only. It allows the one command in JBM_TEST_ALLOW_CMD, exactly as
# given, and logs every command it is shown to JBM_TEST_ALLOW_LOG.
function New-AllowHook {
  New-Item -ItemType Directory -Force -Path $allowDir | Out-Null
  $allowJs = Join-Path $allowDir 'allow-once.js'
  $js = @'
// Written by verify-jb-hooks.ps1 for one test run, and deleted with the run's
// other folders. Allows only the exact command in JBM_TEST_ALLOW_CMD, and logs
// each command it is shown to JBM_TEST_ALLOW_LOG. Changes nothing else.
'use strict';
const fs = require('fs');
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let p = {};
  try { p = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { p = {}; }
  const want = String(process.env.JBM_TEST_ALLOW_CMD || '').trim();
  const got = String((p && p.tool_input && p.tool_input.command) || '').trim();
  const hit = want !== '' && got === want;
  const logFile = process.env.JBM_TEST_ALLOW_LOG;
  if (logFile) {
    try { fs.appendFileSync(logFile, JSON.stringify({ tool: String((p && p.tool_name) || ''), hit: hit, command: got.slice(0, 600) }) + '\n'); } catch (e) { }
  }
  if (hit) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'verify-jb-hooks.ps1: the test command' } }));
  }
});
'@
  [IO.File]::WriteAllText($allowJs, $js)
  $settings = '{"hooks":{"PreToolUse":[{"matcher":"Bash|PowerShell","hooks":[{"type":"command","command":"node","args":[' + (ConvertTo-Json ([string]$allowJs)) + '],"timeout":10}]}]}}'
  [IO.File]::WriteAllText($allowSettings, $settings)
}

# A commit Claude makes in the second clone. The hook must log it from there.
# -AllowHook: run with the test's allow hook (New-AllowHook) for this command.
function Check-CommitIn([string]$label, [string]$tool, [string]$cmd, [string[]]$allow, [switch]$AllowHook) {
  $before = HeadOf $clone
  $repoBefore = ShortHead
  $n0 = CountNotes ('COMMIT ' + $repoBefore + ' ')
  $m0 = CountNotes ' END_MISMATCH '
  $extra = @('--allowedTools') + $allow + @('--add-dir', $clone)
  $seenLog = Join-Path $allowDir 'seen.jsonl'
  if ($AllowHook) {
    if (-not (Test-Path -LiteralPath $allowSettings)) { New-AllowHook }
    Remove-Item -LiteralPath $seenLog -ErrorAction SilentlyContinue
    $extra += @('--settings', $allowSettings)
    $env:JBM_TEST_ALLOW_CMD = $cmd
    $env:JBM_TEST_ALLOW_LOG = $seenLog
  }
  try {
    $reply = Invoke-Claude ('Use the ' + $tool + ' tool to run exactly this command once, and use no other tool: ' + $cmd + '. ' + $AskQuote) $extra
  } finally { Remove-Item Env:JBM_TEST_ALLOW_CMD, Env:JBM_TEST_ALLOW_LOG -ErrorAction SilentlyContinue }
  $seen = ''
  if ($AllowHook) {
    $lines = @()
    if (Test-Path -LiteralPath $seenLog) { $lines = @(Get-Content -LiteralPath $seenLog -Encoding UTF8) }
    if ($lines.Count -eq 0) { $seen = 'the test''s allow hook was not called' }
    else { $seen = 'the test''s allow hook saw ' + $lines.Count + ' command(s) and allowed ' + @($lines | Where-Object { $_ -match '"hit":true' }).Count + '; last: ' + $lines[-1] }
  }
  $after = HeadOf $clone
  if ($after -eq $before) {
    $hint = NotRunHint 'Claude did not make the commit in the clone, so the hook had nothing to fire on' $tool $reply
    if ($seen) { $hint += '; ' + $seen }
    Result $label 'end to end' 'INCONC' $hint
    return
  }
  $okLog = (CountNotes ('COMMIT ' + $after + ' in="' + [regex]::Escape((TopOf $clone)) + '" ')) -gt 0
  $okRepo = (CountNotes ('COMMIT ' + $repoBefore + ' ')) -eq $n0
  $detail = 'COMMIT ' + $after + ' in= line ' + $okLog + ', this repo''s HEAD not logged again ' + $okRepo
  if ($seen) { $detail += '; ' + $seen }
  Result ($label + ' logged from that folder') 'end to end' $(if ($okLog -and $okRepo) { 'PASS' } else { 'FAIL' }) $detail
  $okCtx = $reply -match 'jb-memory\] Commit landed'
  Result ($label + ' reminder reached Claude') 'end to end' $(if ($okCtx) { 'PASS' } else { 'WARN' }) ('Claude quoted it: ' + $okCtx)
  # Where Claude Code says the command ended, against where it ends as read:
  # jb-memory 0.3.4 logs END_MISMATCH when they differ. Information only.
  $mm = @(Notes | Where-Object { $_ -match ' END_MISMATCH ' })
  if ($mm.Count -gt $m0) { $endInfo = 'END_MISMATCH logged: ' + $mm[-1] }
  else { $endInfo = 'no END_MISMATCH line: Claude Code''s end folder matched the command as read, or the end is not known from the text' }
  Result ($label + ': end folder') 'end to end' 'INFO' $endInfo
}

function Check-PrMerge([string]$label, [string]$tool, [string]$allow) {
  $n0 = CountNotes 'PR_MERGE gh pr merge 1 --squash'
  $r0 = FakeGhRuns
  Enable-FakeGh
  try {
    $reply = Invoke-Claude ('This is a throwaway test repo, and gh here is a stand-in that only prints one line. Use the ' + $tool + ' tool to run exactly this command once, and use no other tool: gh pr merge 1 --squash. ' + $AskQuote) @('--allowedTools', $allow)
  } finally { Disable-FakeGh }
  if ((FakeGhRuns) -eq $r0) {
    Result $label 'end to end' 'INCONC' (NotRunHint 'the stand-in gh did not run, so the hook had nothing to fire on' $tool $reply)
    return
  }
  $okLog = (CountNotes 'PR_MERGE gh pr merge 1 --squash') -gt $n0
  Result ($label + ' fired') 'end to end' $(if ($okLog) { 'PASS' } else { 'FAIL' }) ('hook log line: ' + $okLog)
  $okCtx = $reply -match 'jb-memory\] PR merge command'
  Result ($label + ' reminder reached Claude') 'end to end' $(if ($okCtx) { 'PASS' } else { 'WARN' }) ('Claude quoted it: ' + $okCtx)
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
  Disable-FakeGh
  Step 'Summary'
  if ($results.Count -gt 0) { $results | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host }
  Step 'Cleanup'
  # Claude Code names the project folder after the repo path, so it ends with
  # the repo's own folder name, which carries this run's timestamp. The second
  # clone and the hostile clone sit beside the repo with the same name plus a
  # suffix.
  $leaf = Split-Path -Leaf $repo
  $keyDirs = @()
  if ($leaf -match '^jbm-hooktest-\d{8}-\d{6}$') {
    $keyDirs = @(Get-ChildItem -LiteralPath $projectsDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name.EndsWith($leaf) } | ForEach-Object { $_.FullName })
  }
  if ($Keep) {
    Write-Host ('  kept (-Keep): ' + $repo)
    foreach ($p in @($clone, $hostile, $wt, $allowDir, $outDir)) { if (Test-Path -LiteralPath $p) { Write-Host ('  kept (-Keep): ' + $p) } }
    foreach ($k in $keyDirs) { Write-Host ('  kept (-Keep): ' + $k) }
  } else {
    foreach ($k in $keyDirs) {
      if (Remove-Tree $k) { Write-Host ('  removed  ' + $k) } else { Write-Host ('  FAILED   ' + $k) }
    }
    foreach ($p in @($repo, $clone, $hostile, $wt, $allowDir)) {
      if ((Test-Path -LiteralPath $p) -and ((Split-Path -Leaf $p) -match '^jbm-hooktest-') -and ((Split-Path -Parent $p) -eq $workRoot)) {
        if (Remove-Tree $p) { Write-Host ('  removed  ' + $p) } else { Write-Host ('  FAILED   ' + $p) }
      }
    }
    # The folder outside the temp folder: only by its exact name, in %LOCALAPPDATA%.
    $outParent = [IO.Path]::GetFullPath([string]$env:LOCALAPPDATA).TrimEnd('\', '/')
    if ((Test-Path -LiteralPath $outDir) -and ((Split-Path -Leaf $outDir) -match '^jbm-hooktest-\d{8}-\d{6}-out$') -and ((Split-Path -Parent $outDir) -eq $outParent)) {
      if (Remove-Tree $outDir) { Write-Host ('  removed  ' + $outDir) } else { Write-Host ('  FAILED   ' + $outDir) }
    }
  }
  try { Stop-Transcript -ErrorAction Stop | Out-Null } catch { }
  Write-Host ''
  Read-Host 'Press Enter to close' | Out-Null
  exit $code
}

Step 'Environment'
Write-Host ('date: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '   PowerShell ' + $PSVersionTable.PSVersion + '   model: ' + $Model)
foreach ($t in 'node', 'git', 'claude') {
  $c = Get-Command $t -ErrorAction SilentlyContinue
  if (-not $c) { Write-Host ('STOPPED: ' + $t + ' is not on PATH'); Finish 1 }
  Write-Host ($t + ': ' + $c.Source)
}
if (-not (Test-Path -LiteralPath $jbm)) { Write-Host ('STOPPED: missing ' + $jbm); Finish 1 }

Step 'Throwaway repo'
New-Item -ItemType Directory -Path $repo | Out-Null
Push-Location $repo
& git init -q 2>&1 | Out-Null
& git config user.name 'jb-memory hook test'
& git config user.email 'hooktest@example.invalid'
& git commit -q --allow-empty -m 'initial' 2>&1 | Out-Null
Pop-Location
New-FakeGh
Write-Host ('  ' + $repo + '   HEAD ' + (ShortHead))

Step 'First Claude Code session there (creates its project folder)'
[void](Invoke-Claude 'Reply with the single word OK.' @())

Step 'Set the repo up for jb-memory'
Push-Location $repo
$dirOut = @((& node $jbm dir 2>&1) | ForEach-Object { [string]$_ })
foreach ($l in $dirOut) { Write-Host ('  ' + $l) }
$memDir = $dirOut[0].Trim()
$isTestDir = (Split-Path -Leaf (Split-Path -Parent $memDir)) -match 'jbm-hooktest-'
if (-not $isTestDir) {
  Pop-Location
  Write-Host ('STOPPED: the memory folder resolved to ' + $memDir + ', which is not the test repo''s. Nothing was changed there.')
  $memDir = $null
  Finish 1
}
if (($dirOut -join "`n") -notmatch 'resolved by: key:') {
  Pop-Location
  $memDir = $null
  Write-Host 'STOPPED: could not confirm Claude Code''s project folder for the test repo, so the hooks would not find its memory either.'
  Finish 1
}
$initOut = @((& node $jbm init 2>&1) | ForEach-Object { [string]$_ })
Pop-Location
foreach ($l in $initOut) { Write-Host ('  ' + $l) }
$cfgPath = Join-Path $memDir '.jbmem.json'
if (-not (Test-Path -LiteralPath $cfgPath)) { Write-Host 'STOPPED: init did not create .jbmem.json'; Finish 1 }
# Turn the reminder throttle off for this repo only, so every hook speaks.
$cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$cfg | Add-Member -NotePropertyName hints -NotePropertyValue ([pscustomobject]@{ minMinutesBetween = 0; freshCheckpointMinutes = 0 }) -Force
[IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 6))
Write-Host '  reminder throttle off for this test repo'

Step 'Part 1: mechanism (hooks fed by hand, no model calls)'
Push-Location $repo; & git commit -q --allow-empty -m 'mechanism commit' 2>&1 | Out-Null; Pop-Location
$head = ShortHead
$o = Invoke-Hook @{ cwd = $repo; hook_event_name = 'PostToolUse'; tool_name = 'Bash'; tool_input = @{ command = 'git commit -m mechanism' }; tool_response = @{ exit_code = 0 } } @('milestone', 'commit')
$okLog = (CountNotes ('COMMIT ' + $head)) -gt 0
$okHint = $o -match 'Commit landed'
Result 'commit hook' 'mechanism' $(if ($okLog -and $okHint) { 'PASS' } else { 'FAIL' }) ('log line ' + $okLog + ', reminder ' + $okHint)

$o = Invoke-Hook @{ cwd = $repo; hook_event_name = 'PostToolUse'; tool_name = 'Bash'; tool_input = @{ command = 'gh pr merge 12 --squash' }; tool_response = @{ exit_code = 0 } } @('milestone', 'pr-merge')
$okLog = (CountNotes 'PR_MERGE gh pr merge 12') -gt 0
$okHint = $o -match 'PR merge command finished'
Result 'PR-merge hook' 'mechanism' $(if ($okLog -and $okHint) { 'PASS' } else { 'FAIL' }) ('log line ' + $okLog + ', reminder ' + $okHint)

$o = Invoke-Hook @{ cwd = $repo; hook_event_name = 'PostToolUse'; tool_name = 'Bash'; tool_input = @{ command = 'gh pr merge 13' }; tool_response = @{ exit_code = 1 } } @('milestone', 'pr-merge')
$quiet = ((CountNotes 'PR_MERGE gh pr merge 13') -eq 0) -and ($o.Trim() -eq '')
Result 'failed PR merge ignored' 'mechanism' $(if ($quiet) { 'PASS' } else { 'FAIL' }) ('no log line and no reminder: ' + $quiet)

$n0 = CountNotes 'PR_MERGE'
$o = Invoke-Hook @{ cwd = $repo; hook_event_name = 'PostToolUse'; tool_name = 'Bash'; tool_input = @{ command = 'gh pr merge --help' }; tool_response = @{ exit_code = 0 } } @('milestone', 'pr-merge')
$quiet = ((CountNotes 'PR_MERGE') -eq $n0) -and ($o.Trim() -eq '')
Result 'PR-merge help call ignored' 'mechanism' $(if ($quiet) { 'PASS' } else { 'FAIL' }) ('no log line and no reminder: ' + $quiet)

$o = Invoke-Hook @{ cwd = $repo; hook_event_name = 'PostToolUse'; tool_name = 'Agent'; tool_input = @{ prompt = 'x' } } @('milestone', 'subagent')
$okHint = $o -match 'Subagent results came back'
Result 'subagent hook' 'mechanism' $(if ($okHint) { 'PASS' } else { 'FAIL' }) ('reminder ' + $okHint)

$o = Invoke-Hook @{ cwd = $repo; hook_event_name = 'PreCompact'; trigger = 'manual' } @('precompact')
$snap = Join-Path $memDir 'precompact.md'
$okSnap = (Test-Path -LiteralPath $snap) -and ((Get-Content -LiteralPath $snap -Raw -Encoding UTF8) -match 'Compaction \(manual\)')
$okLog = (CountNotes 'PRE_COMPACT trigger=manual') -gt 0
Result 'compaction snapshot hook' 'mechanism' $(if ($okSnap -and $okLog) { 'PASS' } else { 'FAIL' }) ('precompact.md ' + $okSnap + ', log line ' + $okLog)

$o = Invoke-Hook @{ cwd = $repo; hook_event_name = 'SessionStart'; source = 'compact' } @('session-start')
$okInject = $o -match 'Compaction \(manual\)'
Result 'snapshot injected after compaction' 'mechanism' $(if ($okInject) { 'PASS' } else { 'FAIL' }) ('session-start output carries the snapshot: ' + $okInject)

Step 'Part 1, jb-memory 0.3.3: commits in another folder (hooks fed by hand)'
& git clone -q $repo $clone 2>&1 | Out-Null
Push-Location $clone
& git config user.name 'jb-memory hook test'
& git config user.email 'hooktest@example.invalid'
& git checkout -q -b audit 2>&1 | Out-Null
& git commit -q --allow-empty -m 'clone commit 1' 2>&1 | Out-Null
Pop-Location
$cloneTop = TopOf $clone
$inPat = ' in="' + [regex]::Escape($cloneTop) + '" '
Write-Host ('  second clone: ' + $clone + '   top level ' + $cloneTop)
# As Claude Code runs the two hooks for one command: PreToolUse with the
# folder the command starts in, PostToolUse with the folder it ended in, the
# same tool call ID, and how long it ran. $between runs after PreToolUse (the
# command itself); $delayMs waits before PostToolUse (a hook that starts late);
# $stdout is the command's output as Claude Code passes it.
$script:toolSeq = 0
function Feed([string]$sid, [string]$cwd, [string]$tool, [string]$cmd, [string]$end = '', [int]$durationMs = 30000, [scriptblock]$between = $null, [int]$delayMs = 0, [string]$stdout = '') {
  $script:toolSeq++
  $id = 'toolu_verify' + $script:toolSeq + 'x' + $PID
  [void](Invoke-Hook @{ cwd = $cwd; session_id = $sid; hook_event_name = 'PreToolUse'; tool_name = $tool; tool_input = @{ command = $cmd }; tool_use_id = $id } @('commit-start'))
  if ($between) { & $between }
  if ($delayMs -gt 0) { Start-Sleep -Milliseconds $delayMs }
  if (-not $end) { $end = $cwd }
  return Invoke-Hook @{ cwd = $end; session_id = $sid; hook_event_name = 'PostToolUse'; tool_name = $tool; tool_input = @{ command = $cmd }; tool_response = @{ exit_code = 0; stdout = $stdout }; tool_use_id = $id; duration_ms = $durationMs } @('milestone', 'commit')
}
$c1 = HeadOf $clone
$repoHead = ShortHead
$o = Feed $sidA $repo 'Bash' ('cd "' + (Fwd $clone) + '" && git commit -q -m ''clone commit 1''')
$okIn = (CountNotes ('COMMIT ' + $c1 + $inPat + 'clone commit 1')) -gt 0
$okHint = $o -match 'Commit landed'
Result 'commit in another clone (cd E:/...) logged from that clone' 'mechanism' $(if ($okIn -and $okHint) { 'PASS' } else { 'FAIL' }) ('COMMIT ' + $c1 + ' in= line ' + $okIn + ', reminder ' + $okHint)

Push-Location $clone; & git commit -q --allow-empty -m 'clone commit 2' 2>&1 | Out-Null; Pop-Location
$c2 = HeadOf $clone
[void](Feed $sidA $repo 'Bash' ('cd ' + (MsysPath $clone) + ' && git commit -q -m ''clone commit 2'''))
$okMsys = (CountNotes ('COMMIT ' + $c2 + $inPat + 'clone commit 2')) -gt 0
Result 'commit in another clone (cd /c/... Git Bash path) logged from that clone' 'mechanism' $(if ($okMsys) { 'PASS' } else { 'FAIL' }) ('COMMIT ' + $c2 + ' in= line ' + $okMsys + ' (cd ' + (MsysPath $clone) + ')')

# The 0.3.2 bug: another session, in a worktree of this repo, commits there in
# between; then session A's command runs again with nothing new to commit.
# 0.3.2 logged this repo's HEAD again here (the 964ea2d0 repeat).
& git -C $repo worktree add -q -b wtb $wt 2>&1 | Out-Null
Push-Location $wt; & git commit -q --allow-empty -m 'worktree between' 2>&1 | Out-Null; Pop-Location
[void](Feed $sidB $wt 'Bash' 'git commit -q -m ''worktree between''')
$n0 = (CommitLines).Count
$o = Feed $sidA $repo 'Bash' ('cd ' + (MsysPath $clone) + ' && git commit -q -m ''clone commit 2''; true')
$n1 = (CommitLines).Count
$shas = @(CommitLines | ForEach-Object { if ($_ -match 'COMMIT ([0-9a-f]+)') { $Matches[1] } })
$dupes = @($shas | Group-Object | Where-Object { $_.Count -gt 1 }).Count
$okNoRepeat = ($n1 -eq $n0) -and ($o.Trim() -eq '') -and ($dupes -eq 0)
Result 'same command again, nothing new: no line, no repeat' 'mechanism' $(if ($okNoRepeat) { 'PASS' } else { 'FAIL' }) ('COMMIT lines ' + $n0 + ' -> ' + $n1 + ', SHAs logged twice: ' + $dupes)

Push-Location $clone; & git commit -q --allow-empty -m 'clone commit 3' 2>&1 | Out-Null; Pop-Location
$c3 = HeadOf $clone
[void](Feed $sidA $repo 'PowerShell' ('Set-Location -LiteralPath ''' + $clone + '''; git commit -q -m ''clone commit 3'''))
$okPs = (CountNotes ('COMMIT ' + $c3 + $inPat + 'clone commit 3')) -gt 0
Result 'commit in another clone (PowerShell Set-Location) logged from that clone' 'mechanism' $(if ($okPs) { 'PASS' } else { 'FAIL' }) ('COMMIT ' + $c3 + ' in= line ' + $okPs)

# cd sub && git commit: Claude Code then leaves the session in sub, and gives
# PostToolUse that folder. The PreToolUse record says where it started.
New-Item -ItemType Directory -Force -Path (Join-Path $repo 'sub') | Out-Null
Push-Location $repo; & git commit -q --allow-empty -m 'from sub' 2>&1 | Out-Null; Pop-Location
$hs = ShortHead
[void](Feed $sidD $repo 'Bash' 'cd sub && git commit -q --allow-empty -m ''from sub''' (Join-Path $repo 'sub'))
$okSub = (CountNotes ('COMMIT ' + $hs + ' from sub session=44444444')) -gt 0
Result 'cd sub && commit, session left in sub: logged as this repo''s commit' 'mechanism' $(if ($okSub) { 'PASS' } else { 'FAIL' }) ('COMMIT ' + $hs + ' line with no in= ' + $okSub)

$okRepo = (CountNotes ('COMMIT ' + $repoHead + ' ')) -le 1
Result 'this repo''s HEAD never logged for the clone''s commits' 'mechanism' $(if ($okRepo) { 'PASS' } else { 'FAIL' }) ('COMMIT lines for ' + $repoHead + ': ' + (CountNotes ('COMMIT ' + $repoHead + ' ')))

$wa = Write-HandoffAs $sidA "# Handoff: hook test`n- written by session A after committing in the clone`n"
$okA = $wa.Line -match ('\| branch audit \| HEAD ' + $c3 + ' \| in ' + [regex]::Escape($cloneTop) + ' \| session 11111111\s*$')
Result 'Updated line: branch and HEAD from the clone, folder named' 'mechanism' $(if ($okA) { 'PASS' } else { 'FAIL' }) $wa.Line
$wb = Write-HandoffAs $sidC "# Handoff: hook test`n- written by session C in the main checkout, no commits elsewhere`n"
$okB = $wb.Line -match ('^Updated: \S+ \S+ \| branch \S+ \| HEAD ' + (ShortHead) + ' \| session 33333333\s*$')
Result 'Updated line for the main checkout unchanged (no folder)' 'mechanism' $(if ($okB) { 'PASS' } else { 'FAIL' }) $wb.Line

# A short command whose PostToolUse hook starts 2.5 s after it ended (a busy
# PC): the window opens at the PreToolUse record, so its commit is found.
[void](Feed $sidA $repo 'Bash' ('cd "' + (Fwd $clone) + '" && git commit -q -m ''clone commit late''') '' 300 { Push-Location $clone; & git commit -q --allow-empty -m 'clone commit late' 2>&1 | Out-Null; Pop-Location } 2500)
$cl = HeadOf $clone
$okLate = (CountNotes ('COMMIT ' + $cl + $inPat + 'clone commit late')) -gt 0
Result 'hook starting 2.5 s after a 0.3 s command still logs its commit' 'mechanism' $(if ($okLate) { 'PASS' } else { 'FAIL' }) ('COMMIT ' + $cl + ' in= line ' + $okLate)

[void](Feed $sidA $repo 'Bash' 'cd "$JBM_NOT_SET" && git commit -q -m x')
$okUnres = (CountNotes 'COMMIT_UNRESOLVED why=unknown-folder session=11111111') -gt 0
Result 'folder from a variable: COMMIT_UNRESOLVED, not a guess' 'mechanism' $(if ($okUnres) { 'PASS' } else { 'FAIL' }) ('COMMIT_UNRESOLVED line ' + $okUnres)

# A clone whose config runs a program when git fetches a missing object: a
# partial clone whose origin is a local path with a planted uploadpack, and a
# HEAD (with a reflog entry) that names a commit which isn't there.
& git clone -q $repo $hostile 2>&1 | Out-Null
$marker = Join-Path $hostile 'uploadpack-ran.txt'
Push-Location $hostile
& git config core.repositoryformatversion 1
& git config extensions.partialClone origin
& git config remote.origin.promisor true
& git config protocol.file.allow always
# No double quotes: Windows PowerShell 5.1 doesn't escape them for a native
# program. The temp folder path has no spaces.
& git config remote.origin.uploadpack ('echo ran > ' + (Fwd $marker) + '; false')
$tree = ([string](& git rev-parse 'HEAD^{tree}')).Trim()
$parent = ([string](& git rev-parse HEAD)).Trim()
Pop-Location
$ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$ghost = ([string](("tree $tree`nparent $parent`nauthor t <t@t> $ts +0000`ncommitter t <t@t> $ts +0000`n`nghost") | & git -C $hostile hash-object -t commit --stdin)).Trim()
[IO.File]::AppendAllText((Join-Path $hostile '.git\logs\HEAD'), ($parent + ' ' + $ghost + ' t <t@t> ' + $ts + ' +0000' + "`t" + 'commit: ghost' + "`n"))
[IO.File]::WriteAllText((Join-Path $hostile '.git\HEAD'), ($ghost + "`n"))
& git -C $hostile log -1 --format=%s 2>&1 | Out-Null
if (-not (Test-Path -LiteralPath $marker)) {
  Result 'hardening: a hostile clone''s lazy fetch runs nothing' 'mechanism' 'INCONC' 'a plain git log there did not run the planted uploadpack, so there is nothing to block on this PC'
} else {
  Remove-Item -LiteralPath $marker -Force
  # git's own trace shows the hook's git calls did run in that clone.
  $trace = Join-Path $hostile 'git-trace.txt'
  $env:GIT_TRACE = $trace
  $env:GIT_TRACE_SETUP = $trace
  try { [void](Feed $sidA $repo 'Bash' ('cd "' + (Fwd $hostile) + '" && git commit -q -m ghost')) }
  finally { Remove-Item Env:GIT_TRACE, Env:GIT_TRACE_SETUP -ErrorAction SilentlyContinue }
  $ran = Test-Path -LiteralPath $marker
  $reached = (Test-Path -LiteralPath $trace) -and (([IO.File]::ReadAllText($trace)) -match [regex]::Escape((Fwd $hostile)))
  $status = $(if ($ran) { 'FAIL' } elseif (-not $reached) { 'INCONC' } else { 'PASS' })
  Result 'hardening: a hostile clone''s lazy fetch runs nothing' 'mechanism' $status ('a plain git log ran the planted uploadpack; the hook''s git calls reached that clone: ' + $reached + '; uploadpack ran from them: ' + $ran)
}

Step 'Part 1, jb-memory 0.3.4: end folder, printed commits, commit sweep, status filters, hook time (hooks fed by hand)'
# A command whose end folder, as read, isn't the folder Claude Code says it
# ended in: one END_MISMATCH line, and the commit is still logged from the
# clone. Here the session is back where it started (actual=start).
Push-Location $clone; & git commit -q --allow-empty -m 'clone commit endcheck' 2>&1 | Out-Null; Pop-Location
$ce = HeadOf $clone
$m0 = CountNotes ' END_MISMATCH '
[void](Feed $sidA $repo 'Bash' ('cd "' + (Fwd $clone) + '" && git commit -q -m ''clone commit endcheck''') $repo)
$mm = @(Notes | Where-Object { $_ -match ' END_MISMATCH ' })
$want = 'END_MISMATCH tool=bash parsed="' + (Disp $clone) + '" actual="' + (Disp $repo) + '" actual=start session=11111111'
$okEnd = ($mm.Count -eq $m0 + 1) -and $mm[-1].EndsWith($want) -and ((CountNotes ('COMMIT ' + $ce + $inPat + 'clone commit endcheck')) -eq 1)
Result 'end folder not where Claude Code says: one END_MISMATCH line, commit still logged' 'mechanism' $(if ($okEnd) { 'PASS' } else { 'FAIL' }) $(if ($mm.Count) { $mm[-1] } else { 'no END_MISMATCH line' })
# git -C moves no folder: the end as read is the repo, where Claude Code says
# it ended, so no line. The commit line shows the hook did run. (A hand-fed
# PostToolUse can't end in the clone: with no transcript to name the session's
# own folder, the hooks don't look for its memory from there.)
Push-Location $clone; & git commit -q --allow-empty -m 'clone commit agree' 2>&1 | Out-Null; Pop-Location
$ca = HeadOf $clone
[void](Feed $sidA $repo 'Bash' ('git -C "' + (Fwd $clone) + '" commit -q -m ''clone commit agree'''))
$okNoEnd = ((CountNotes ' END_MISMATCH ') -eq ($m0 + 1)) -and ((CountNotes ('COMMIT ' + $ca + $inPat + 'clone commit agree')) -eq 1)
Result 'end folder where Claude Code says: no END_MISMATCH line' 'mechanism' $(if ($okNoEnd) { 'PASS' } else { 'FAIL' }) ('END_MISMATCH lines added: ' + ((CountNotes ' END_MISMATCH ') - $m0) + ', commit logged ' + (CountNotes ('COMMIT ' + $ca + ' ')) + ' time(s)')

# Session B's commit command is running in the clone when session A's lands
# there too, and git printed only A's ([audit <sha>] ...): A's hook leaves B's
# commit out, and B's own hook logs it.
$script:toolSeq++
$idB = 'toolu_verify' + $script:toolSeq + 'x' + $PID
$cmdB = 'git -C "' + (Fwd $clone) + '" commit -m ''clone commit by another'''
[void](Invoke-Hook @{ cwd = $repo; session_id = $sidB; hook_event_name = 'PreToolUse'; tool_name = 'Bash'; tool_input = @{ command = $cmdB }; tool_use_id = $idB } @('commit-start'))
Push-Location $clone
& git commit -q --allow-empty -m 'clone commit by another' 2>&1 | Out-Null
$cb = HeadOf $clone
& git commit -q --allow-empty -m 'clone commit printed' 2>&1 | Out-Null
Pop-Location
$cp = HeadOf $clone
[void](Feed $sidA $repo 'Bash' ('git -C "' + (Fwd $clone) + '" commit -m ''clone commit printed''') '' 30000 $null 0 ('[audit ' + $cp + '] clone commit printed' + "`n" + ' 0 files changed'))
$okA = ((CountNotes ('COMMIT ' + $cp + $inPat + 'clone commit printed session=11111111')) -eq 1) -and ((CountNotes 'clone commit by another') -eq 0)
[void](Invoke-Hook @{ cwd = $repo; session_id = $sidB; hook_event_name = 'PostToolUse'; tool_name = 'Bash'; tool_input = @{ command = $cmdB }; tool_response = @{ exit_code = 0; stdout = ('[audit ' + $cb + '] clone commit by another') }; tool_use_id = $idB; duration_ms = 30000 } @('milestone', 'commit'))
$okB = (CountNotes ('COMMIT ' + $cb + $inPat + 'clone commit by another session=22222222')) -eq 1
Result 'two sessions commit in one folder at once: each logs its own (git printed both)' 'mechanism' $(if ($okA -and $okB) { 'PASS' } else { 'FAIL' }) ('A''s hook logged only A''s ' + $okA + '; B''s hook logged B''s ' + $okB)

# A command that commits and then fails: Claude Code sends PostToolUseFailure,
# with no duration and no output. The commit is still logged, with no reminder.
$script:toolSeq++
$idF = 'toolu_verify' + $script:toolSeq + 'x' + $PID
$cmdF = 'git -C "' + (Fwd $clone) + '" commit -q -m ''clone commit then failed'' && git push jbm-no-such-remote'
[void](Invoke-Hook @{ cwd = $repo; session_id = $sidA; hook_event_name = 'PreToolUse'; tool_name = 'Bash'; tool_input = @{ command = $cmdF }; tool_use_id = $idF } @('commit-start'))
Push-Location $clone; & git commit -q --allow-empty -m 'clone commit then failed' 2>&1 | Out-Null; Pop-Location
$cf = HeadOf $clone
$o = Invoke-Hook @{ cwd = $repo; session_id = $sidA; hook_event_name = 'PostToolUseFailure'; tool_name = 'Bash'; tool_input = @{ command = $cmdF }; tool_use_id = $idF; error = 'Exit code 128'; is_interrupt = $false } @('milestone', 'commit')
$okF = ((CountNotes ('COMMIT ' + $cf + $inPat + 'clone commit then failed')) -eq 1) -and ($o.Trim() -eq '')
Result 'commit in a command that then failed (PostToolUseFailure): logged, no reminder' 'mechanism' $(if ($okF) { 'PASS' } else { 'FAIL' }) ('COMMIT ' + $cf + ' in= line ' + ((CountNotes ('COMMIT ' + $cf + ' ')) -eq 1) + ', hook output empty ' + ($o.Trim() -eq ''))

# A commit no hook saw, in a session whose start the hook recorded:
# write-handoff logs it once, marked (found later).
[void](Invoke-Hook @{ cwd = $repo; session_id = $sidE; hook_event_name = 'SessionStart'; source = 'startup' } @('session-start'))
Push-Location $repo; & git commit -q --allow-empty -m 'made by a script' 2>&1 | Out-Null; Pop-Location
$hsw = ShortHead
# The sweep reads up to the second it starts in; a commit in that second is the next one's.
Start-Sleep -Milliseconds 1100
$we = Write-HandoffAs $sidE "# Handoff: hook test`n- written by session E after a commit no hook saw`n"
$we2 = Write-HandoffAs $sidE "# Handoff: hook test`n- written by session E again`n"
$okFound = (CountNotes ('COMMIT ' + $hsw + ' made by a script \(found later\) session=55555555')) -eq 1
$okOnce = ((CountNotes ('COMMIT ' + $hsw + ' ')) -eq 1) -and ($we.Out -match 'logged 1 commit\(s\) found') -and ($we2.Out -notmatch 'logged \d+ commit')
Result 'commit no hook saw: logged once as (found later) at write-handoff' 'mechanism' $(if ($okFound -and $okOnce) { 'PASS' } else { 'FAIL' }) ('found-later line ' + $okFound + ', once and reported once ' + $okOnce)

# A clean filter the repo itself defines: the compaction snapshot's git status
# runs with it switched off. Plain git runs it first, to show the test is live.
New-Item -ItemType Directory -Force -Path $allowDir | Out-Null
$fmark = Join-Path $allowDir 'filter-ran.txt'
$ftxt = Join-Path $repo 'filtered.txt'
[IO.File]::WriteAllText($ftxt, "x`n")
Push-Location $repo
& git add filtered.txt 2>&1 | Out-Null
& git commit -q -m 'filtered file' 2>&1 | Out-Null
[IO.File]::WriteAllText((Join-Path $repo '.gitattributes'), "filtered.txt filter=jbmtest`n")
# No double quotes: Windows PowerShell 5.1 doesn't escape them for a native program.
& git config filter.jbmtest.clean ('echo ran >> ' + (Fwd $fmark) + '; cat')
& git hash-object --path=filtered.txt filtered.txt 2>&1 | Out-Null
Pop-Location
$live = Test-Path -LiteralPath $fmark
Remove-Item -LiteralPath $fmark -ErrorAction SilentlyContinue
(Get-Item -LiteralPath $ftxt).LastWriteTime = (Get-Date).AddHours(-3)
[void](Invoke-Hook @{ cwd = $repo; session_id = $sidE; hook_event_name = 'PreCompact'; trigger = 'manual' } @('precompact'))
$filterRan = Test-Path -LiteralPath $fmark
$snapE = Join-Path (Join-Path $memDir 'snapshots') ($sidE + '.md')
$snapText = $(if (Test-Path -LiteralPath $snapE) { [IO.File]::ReadAllText($snapE) } else { '' })
$countLine = [regex]::Match($snapText, '(?m)^Uncommitted files: [^\r\n]*').Value
& git -C $repo config --unset filter.jbmtest.clean 2>&1 | Out-Null
Remove-Item -LiteralPath (Join-Path $repo '.gitattributes') -ErrorAction SilentlyContinue
$fStatus = $(if (-not $live) { 'INCONC' } elseif ($filterRan -or ($countLine -notmatch '^Uncommitted files: \d+$')) { 'FAIL' } else { 'PASS' })
Result 'snapshot status runs no filter the repo defines' 'mechanism' $fStatus ('plain git ran the test filter ' + $live + '; the hook''s status ran it ' + $filterRan + '; snapshot: ' + $countLine)

# Every git commit command waits for the PreToolUse hook. Its time, median of
# ten runs, beside a bare node start. The records these runs leave in the
# test repo's memory folder are removed after, so they hold up no sweep.
function MedianMs([scriptblock]$sb, [int]$n) {
  $t = @(for ($i = 0; $i -lt $n; $i++) { (Measure-Command $sb).TotalMilliseconds })
  $sorted = @($t | Sort-Object)
  return [math]::Round($sorted[[int][math]::Floor($sorted.Count / 2)])
}
$script:latSeq = 0
$nodeMs = MedianMs { & node -e 0 2>&1 | Out-Null } 10
$preMs = MedianMs { $script:latSeq++; [void](Invoke-Hook @{ cwd = $repo; session_id = $sidE; hook_event_name = 'PreToolUse'; tool_name = 'Bash'; tool_input = @{ command = 'git commit -m latency' }; tool_use_id = ('toolu_latency' + $script:latSeq + 'x' + $PID) } @('commit-start')) } 10
Get-ChildItem -LiteralPath (Join-Path $memDir 'pending') -Filter 'toolu_latency*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Result 'PreToolUse commit hook time, median of 10' 'mechanism' $(if ($preMs -gt 1000) { 'WARN' } else { 'INFO' }) ([string]$preMs + ' ms added to each git commit command; node alone starts in ' + $nodeMs + ' ms')

Step 'Part 2: end to end (real Claude Code sessions)'
Check-Commit 'commit hook' 'Bash' 'git commit --allow-empty -m ''jb-memory end-to-end test''' 'Bash(git commit *)'
Check-PrMerge 'PR-merge hook' 'Bash' 'Bash(gh pr merge *)'

# A help call must leave no PR_MERGE line. The stand-in answers it too; what
# counts is that the hook, which reads the command text, skips it.
$n0 = CountNotes 'PR_MERGE'
$r0 = FakeGhRuns
Enable-FakeGh
try {
  [void](Invoke-Claude 'This is a throwaway test repo, and gh here is a stand-in that only prints one line. Use the Bash tool to run exactly this command once, and use no other tool: gh pr merge --help. Then reply DONE.' @('--allowedTools', 'Bash(gh pr merge *)'))
} finally { Disable-FakeGh }
if ((FakeGhRuns) -eq $r0) {
  Result 'PR-merge help call not counted' 'end to end' 'INCONC' 'the command did not run'
} else {
  $quiet = (CountNotes 'PR_MERGE') -eq $n0
  Result 'PR-merge help call not counted' 'end to end' $(if ($quiet) { 'PASS' } else { 'FAIL' }) ('no PR_MERGE log line: ' + $quiet)
}

# subagent (the hook's footprint is the reminder time it records)
$h0 = LastHint
Start-Sleep -Milliseconds 50
$reply = Invoke-Claude 'Use the Agent tool exactly once. Give the subagent this task: reply with the word PONG and nothing else. Use no other tool. When its result comes back, check whether any text starting with [jb-memory] appeared in your context after the subagent returned, including hook messages. Leave out the [jb-memory] note from the start of the session. If there is such text, reply with the first 40 characters of it. If not, reply NONE.' @('--allowedTools', 'Agent')
$h1 = LastHint
$okFired = $h1 -gt $h0
Result 'subagent hook fired' 'end to end' $(if ($okFired) { 'PASS' } else { 'FAIL' }) ('reminder time recorded: ' + $okFired)
$okCtx = $reply -match 'jb-memory\] Subagent results'
Result 'subagent reminder reached Claude' 'end to end' $(if ($okCtx) { 'PASS' } else { 'WARN' }) ('Claude quoted it: ' + $okCtx)

# compaction: /compact from -p is not documented, so a miss here is not a failure
$p0 = CountNotes 'PRE_COMPACT'
$s0 = CountNotes 'SESSION_START source=compact'
[void](Invoke-Claude '/compact' @('--continue'))
$okPre = (CountNotes 'PRE_COMPACT') -gt $p0
$okStart = (CountNotes 'SESSION_START source=compact') -gt $s0
if ($okPre) {
  Result 'compaction hook fired' 'end to end' 'PASS' 'new PRE_COMPACT log line and snapshot'
  Result 'session-start after compaction' 'end to end' $(if ($okStart) { 'PASS' } else { 'WARN' }) ('SESSION_START source=compact logged: ' + $okStart)
} else {
  Result 'compaction hook' 'end to end' 'MANUAL' 'claude -p did not compact; check it in a desktop session with /compact'
}

Step 'Part 3: git -C commits and the PowerShell tool (end to end)'
# On Windows, Claude Code can run commands through a PowerShell tool as well as
# Bash, and hooks on one don't see the other. Each check pins Claude to one tool.
Check-Commit 'git -C commit hook (Bash)' 'Bash' 'git -C . commit --allow-empty -m ''jb-memory dash-C test''' 'Bash(git -C *)'
Check-Commit 'commit hook (PowerShell)' 'PowerShell' 'git commit --allow-empty -m ''jb-memory powershell test''' 'PowerShell(git commit *)'
Check-Commit 'git -C commit hook (PowerShell)' 'PowerShell' 'git -C . commit --allow-empty -m ''jb-memory powershell dash-C test''' 'PowerShell(git -C *)'
Check-PrMerge 'PR-merge hook (PowerShell)' 'PowerShell' 'PowerShell(gh pr merge *)'
# Prompts can't carry double quotes (see Invoke-Claude); the temp folder path has no spaces.
# git -C changes no folder, so a plain allow rule should be enough.
Check-CommitIn 'commit in another clone, git -C (Bash)' 'Bash' ('git -C ' + (Fwd $clone) + ' commit --allow-empty -m ''jb-memory git -C clone test''') @('Bash(git -C *)')
Check-CommitIn 'commit in another clone, git -C (PowerShell)' 'PowerShell' ('git -C ''' + $clone + ''' commit --allow-empty -m ''jb-memory git -C clone powershell test''') @('PowerShell(git -C *)')
# cd and Set-Location before git: Claude Code asks first, so the test's allow
# hook answers for exactly this command (New-AllowHook).
Check-CommitIn 'commit in another clone, cd (Bash)' 'Bash' ('cd ' + (Fwd $clone) + ' && git commit --allow-empty -m ''jb-memory other-folder test''') @('Bash(cd *)', 'Bash(git commit *)') -AllowHook
Check-CommitIn 'commit in another clone, Set-Location (PowerShell)' 'PowerShell' ('Set-Location -LiteralPath ''' + $clone + '''; git commit --allow-empty -m ''jb-memory other-folder powershell test''') @('PowerShell(Set-Location *)', 'PowerShell(git commit *)') -AllowHook
# Where the Bash shell is after a cd into a folder the session may use: cd,
# then pwd, as two calls in one session. Information for the end-folder
# check: the hook was told the start folder after cd and git commit. Claude
# Code moves the shell back after each Bash command when
# CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR is on, or when the command ended
# outside the session's folders (its start folder and the --add-dir ones);
# only the second adds "Shell cwd was reset to <folder>" to the output. Hooks
# get the folder the session is in when they run. (Read in the code of
# Claude Code 2.1.42 and 2.1.306, not 2.1.304.) The second run uses a folder
# outside the temp folder, to tell whether the reset comes with the temp
# folder, which Git Bash shows as /tmp/...
$shellTemp = Check-ShellAfterCd 'Bash shell after cd into an added folder (in the temp folder)' $clone
New-Item -ItemType Directory -Path $outDir -Force -ErrorAction SilentlyContinue | Out-Null
$shellOut = ''
if (Test-Path -LiteralPath $outDir) {
  $shellOut = Check-ShellAfterCd 'Bash shell after cd into an added folder (outside the temp folder)' $outDir
} else {
  Result 'Bash shell after cd into an added folder (outside the temp folder)' 'end to end' 'INCONC' ('could not create ' + $outDir)
}
if ($shellTemp -and $shellOut) {
  $both = $(if ($shellTemp -eq 'reset' -and $shellOut -eq 'stayed') { 'reset only in the temp folder: it comes with how the temp folder is named (/tmp/... in Git Bash), not with --add-dir' }
    elseif ($shellTemp -eq $shellOut) { 'the same in both folders (' + $shellTemp + '): the temp folder is not what makes the difference' }
    else { 'temp folder: ' + $shellTemp + ', outside it: ' + $shellOut })
  Result 'Bash shell after cd: temp folder against another folder' 'end to end' 'INFO' $both
}
# The checkpoint skill through the Skill tool. Plain "checkpoint" is an alias
# of Claude Code's built-in /rewind, and the Skill tool refuses it as a CLI
# command (seen 2026-10-20, Windows). In the code of Claude Code 2.1.306 and
# 2.1.309 an exact name match comes before any alias, so the full
# jb-memory:checkpoint, which the hook reminders name, should load. Claude
# gets only the Skill tool, so the skill's own steps can't run.
$sd = ''
$full = SkillLoad 'jb-memory:checkpoint' ([ref]$sd)
switch ($full) {
  'loaded'  { Result 'Skill tool loads jb-memory:checkpoint' 'end to end' 'PASS' ('loaded: ' + $sd) }
  'builtin' { Result 'Skill tool loads jb-memory:checkpoint' 'end to end' 'FAIL' ('refused as a Claude Code command: ' + $sd) }
  'other'   { Result 'Skill tool loads jb-memory:checkpoint' 'end to end' 'INCONC' ('the Skill tool returned: ' + $sd) }
  default   { Result 'Skill tool loads jb-memory:checkpoint' 'end to end' 'INCONC' $sd }
}
$sd = ''
$plain = SkillLoad 'checkpoint' ([ref]$sd)
switch ($plain) {
  'loaded'  { Result 'Skill tool with plain checkpoint' 'end to end' 'INFO' ('loaded jb-memory''s skill on this Claude Code: ' + $sd) }
  'builtin' { Result 'Skill tool with plain checkpoint' 'end to end' 'INFO' ('refused as Claude Code''s built-in command, as expected: ' + $sd) }
  'other'   { Result 'Skill tool with plain checkpoint' 'end to end' 'INFO' ('the Skill tool returned: ' + $sd) }
  default   { Result 'Skill tool with plain checkpoint' 'end to end' 'INCONC' $sd }
}
# A command that commits and then fails at the push. Claude Code runs the
# PostToolUseFailure hooks for a failed command, and jb-memory 0.3.4 runs its
# commit hook there too. The push names a remote that doesn't exist, so git
# stops before any network use.
$before = ShortHead
$reply = Invoke-Claude ('Use the Bash tool to run exactly this command once, and use no other tool: git commit --allow-empty -m ''jb-memory failed-command test'' && git push jbm-no-such-remote. The push is expected to fail. Then reply DONE.') @('--allowedTools', 'Bash(git commit *)', 'Bash(git push *)')
$after = ShortHead
if ($after -eq $before) {
  Result 'commit in a command that then failed' 'end to end' 'INCONC' (NotRunHint 'Claude did not make the commit, so the hook had nothing to fire on' 'Bash' $reply)
} else {
  $okF = (CountNotes ('COMMIT ' + $after + ' ')) -gt 0
  Result 'commit in a command that then failed is logged' 'end to end' $(if ($okF) { 'PASS' } else { 'FAIL' }) ('COMMIT ' + $after + ' line: ' + $okF)
}

Step 'Session starts recorded by the hook'
$starts = @(Notes | Where-Object { $_ -match 'SESSION_START' })
$lastStart = $(if ($starts.Count) { $starts[-1] } else { '' })
Write-Host ('  last: ' + $lastStart)
$off = @($starts | Where-Object { $_ -match 'sandbox=off' }).Count
$on = @($starts | Where-Object { $_ -match 'sandbox=on' }).Count
Result 'start hook ran sandboxed in every session' 'end to end' $(if ($on -gt 0 -and $off -eq 0) { 'PASS' } else { 'FAIL' }) ('sandbox=on ' + $on + ', sandbox=off ' + $off)

$bad = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
Finish $(if ($bad -gt 0) { 1 } else { 0 })
