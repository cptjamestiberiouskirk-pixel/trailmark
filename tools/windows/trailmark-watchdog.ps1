# trailmark-watchdog.ps1
# Watches the folder trailmark is installed from (the marketplace folder) for
# changes and for signs of anything malicious. Claude Code runs the plugin
# from that folder, or from a copy of it, at every session start, so any
# change there is worth knowing about.
#
# How it works: when you install or accept, it records a known-good list of
# every file (SHA-256, size, hidden/system flags, alternate data streams) and
# keeps a copy of each text file. Each scan compares the folder against that
# list and reports every added, changed or removed file. For added and changed
# text files it checks the new lines for risky content (downloads, encoded
# commands, security changes, startup entries, credential access, network use
# in plugin code) and checks the plugin's hook, manifest and marketplace files
# for programs Claude Code would start. It also reports links (junctions,
# symlinks), Microsoft Defender's real-time protection being switched off, and
# Defender detections in the folder, where Windows lets a standard user see them.
#
# HIGH notifications, reminders, and notices that the watchdog itself has a
# problem stay on screen until you dismiss them. Other MEDIUM notifications come
# and go like any other. A change you haven't accepted is notified again every
# 24 hours, and every time you log on or unlock the PC (at most one reminder
# every 10 minutes, so locking and unlocking quickly doesn't stack them up).
#
# It never changes, moves or deletes anything in the watched folder. Its own
# files live in %LOCALAPPDATA%\trailmark-watchdog.
#
#   -Scan       compare, log, notify on MEDIUM or HIGH (what the scheduled task runs)
#   -Remind     a scan that repeats the notification for anything still waiting
#               (the logon and unlock task runs this)
#   -Status     scan now and print everything, without a notification
#   -Accept     show what changed and record the folder as it is now as known-good
#   -Init       record the first known-good list (the installer runs this)
#   -TestAlert  show a sample notification
#   -SetLayout root|nested  with -Accept, switch the recorded plugin layout
#
# Not watched: top-level *.log files (and *.log in tools\windows, where the
# diagnostic scripts keep theirs), and the throwaway tm-roundtrip-* and
# tm-hooktest-* folders the trailmark tests create. Claude Code doesn't load
# either. -Status lists them. In a .git folder at the top or one level down,
# only config and hooks are watched, since the rest changes with every commit.
#
# Outside the folder (1.5.0), places that decide what Claude Code runs:
#   - copies of trailmark in Claude Code's plugin cache
#     (%USERPROFILE%\.claude\plugins\cache). Claude Code may run trailmark
#     from a copy there, and a session once found an old cached copy and ran
#     it. A copy that appears or changes is HIGH, and so is the copy Claude
#     Code lists as installed when it changes. The walk is bounded (entries
#     per folder, files per copy, total time); when it stops early, that is
#     itself HIGH, so padding the cache can't hide a copy. Links are recorded
#     with their target and never followed.
#   - what Claude Code's user settings run (settings.json and
#     settings.local.json there, and managed-settings.json under
#     %ProgramFiles%\ClaudeCode): hooks (every field, hashed), statusLine,
#     subagentStatusLine, fileSuggestion, processWrapper,
#     apiKeyHelper and the other *Helper/*Refresh/*Export commands,
#     permissions (defaultMode shown, the rest hashed), enabled plugins,
#     extra marketplaces, and the names of env variables (with a hash of each
#     value, never the value); and the MCP servers in .claude.json. Something
#     added there is HIGH.
# Only those are read there; nothing else in %USERPROFILE%\.claude is.
# Not covered: project settings (.claude\settings*.json and .mcp.json in
# each repo); what other enabled plugins run (a newly enabled plugin is
# reported, its hooks are not read); what is behind a link in the plugin
# cache once the link is accepted; .claude.json when it is over 2 MB.
#
# Limits: it runs as you, so malware running as you could change it or its
# known-good list too. It catches changes made by tools, by people, and by
# anything that doesn't know it's there. It adds to Defender; it doesn't
# replace it.

param(
  [switch]$Scan,
  [switch]$Status,
  [switch]$Accept,
  [switch]$Init,
  [switch]$TestAlert,
  [switch]$Remind,
  [switch]$Yes,
  [switch]$NoAlert,
  [switch]$DryRunAlert,
  [switch]$NoDefender,
  [string]$Root = '',
  [string]$StateDir = '',
  [string]$ClaudeDir = '',
  [ValidateSet('', 'root', 'nested')]
  [string]$SetLayout = ''
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

$ErrorActionPreference = 'Stop'
$WatchdogVersion = '1.7.0'
$OnWindows = ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT)
if (-not $StateDir) { $StateDir = Join-Path $env:LOCALAPPDATA 'trailmark-watchdog' }
# Claude Code's own folder, for the checks outside the watched folder.
if (-not $ClaudeDir) { $ClaudeDir = $(if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path ([string]$env:USERPROFILE) '.claude' }) }
$StateDir = [IO.Path]::GetFullPath($StateDir)

$BaselinePath = Join-Path $StateDir 'baseline.json'
$SnapshotDir  = Join-Path $StateDir 'snapshot'
$LogPath      = Join-Path $StateDir 'watchdog.log'
$LastScanPath = Join-Path $StateDir 'last-scan.json'
$AlertPath    = Join-Path $StateDir 'alert-state.json'
$LockPath     = Join-Path $StateDir 'scan.lock'
$RemindFloorMinutes = 10
$SelfPath     = $PSCommandPath
$Utf8         = New-Object System.Text.UTF8Encoding $false
$SnapMarker   = '.trailmark-watchdog-snapshot'
$ToastAppId   = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

# Where the plugin files sit in the watched folder (1.6.0). Two layouts:
#   the release layout, where the folder itself is the marketplace
#   (.claude-plugin\marketplace.json at the top, plugins\trailmark and
#   plugins\trailmark-codex under it, .agents\plugins for Codex), and
#   the older one with the marketplace in a jb-memory-marketplace subfolder.
# -Init picks the layout from what is there and records it in the known-good
# list. Scans and -Accept keep the recorded one: switching takes -SetLayout
# (or a new -Root), so planting or deleting a manifest can't move the watch.
# Either way the plugin folders of both layouts count as plugin files, so the
# layout decides only where the manifest and the plugin copy are read from.
$LayoutNested = 'nested'
$LayoutRoot   = 'root'
$Layout       = $LayoutNested
$AllMarketPrefixes = @('.claude-plugin/', 'plugins/', '.agents/', 'jb-memory-marketplace/')
$MarketPrefixes = $AllMarketPrefixes
$MarketManifest = 'jb-memory-marketplace/.claude-plugin/marketplace.json'
$PluginRel      = 'jb-memory-marketplace/plugins/jb-memory'
function Set-Layout([string]$Name) {
  if ($Name -eq $LayoutRoot) {
    $script:Layout = $LayoutRoot
    $script:MarketManifest = '.claude-plugin/marketplace.json'
    $script:PluginRel      = 'plugins/trailmark'
    $script:HookScript     = '${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js'
  } else {
    $script:Layout = $LayoutNested
    $script:MarketManifest = 'jb-memory-marketplace/.claude-plugin/marketplace.json'
    $script:PluginRel      = 'jb-memory-marketplace/plugins/jb-memory'
    # A nested folder is from before the rename: its hooks run jbm.js.
    $script:HookScript     = '${CLAUDE_PLUGIN_ROOT}/scripts/jbm.js'
  }
}
function Find-Layout([string]$RootFull) {
  if (Test-Path -LiteralPath (Join-Path $RootFull 'jb-memory-marketplace\.claude-plugin\marketplace.json') -PathType Leaf) { return $LayoutNested }
  if (Test-Path -LiteralPath (Join-Path $RootFull '.claude-plugin\marketplace.json') -PathType Leaf) { return $LayoutRoot }
  return $LayoutNested
}
$KnownPlugins = @('trailmark', 'trailmark-codex', 'jb-memory', 'jb-memory-codex')
# Copies in the plugin cache under these names are watched; jb-memory is the
# name before 0.5.0, and a copy left from then would run every hook again.
$CopyNames = @('trailmark', 'jb-memory')
$Launchers = @('trailmark.js', 'jbm.js')
function Test-HasLauncher([string]$Dir) {
  foreach ($l in $Launchers) { if (Test-Path -LiteralPath (Join-Path (Join-Path $Dir 'scripts') $l) -PathType Leaf) { return $true } }
  return $false
}
# The Codex copy's hooks run one command string; anything but this exact
# launcher followed by "jbm --hook <name> [<word>]" is reported.
$CodexHookPrefix = 'node -e "const p=require(''path''),r=process.env.PLUGIN_ROOT;(r&&p.isAbsolute(r)&&/^(?:[A-Za-z]:|[/][A-Za-z0-9._~-])/.test(r))||process.exit(0);process.argv[1]=p.join(r,''scripts'',''trailmark.js'');require(process.argv[1])" trailmark --hook '
# The hook events trailmark uses, and the trailmark.js --hook name each one runs.
# PreToolUse (commit-start) and PostToolUseFailure came with trailmark 0.3.4.
# A hook outside this list, or trailmark.js with another --hook name for its event,
# is reported as a structure change.
$AllowedHookEvents = @('SessionStart', 'PreCompact', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure')
$HookNames = @{
  SessionStart       = @('session-start')
  PreCompact         = @('precompact')
  PreToolUse         = @('commit-start')
  PostToolUse        = @('milestone')
  PostToolUseFailure = @('milestone')
}
$HookScript = '${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js'
$ProgramExt = '.exe .dll .sys .scr .com .pif .msi .msp .jar .node .cpl .ocx .appx .msix .msixbundle .application .chm'.Split(' ')
$ScriptExt  = '.ps1 .psm1 .psd1 .ps1xml .cmd .bat .js .mjs .cjs .ts .vbs .vbe .jse .wsf .wsh .hta .py .sh .reg .lnk .url .scf .inf'.Split(' ')
$ArchiveExt = '.zip .7z .rar .tar .gz .tgz .iso .img .vhd .vhdx .cab'.Split(' ')
$JsExt      = '.js .mjs .cjs .ts'.Split(' ')
$SnapshotMax  = 1MB
$TextScanMax  = 2MB
$ShowAdded    = 25
$ShowRemoved  = 15
$ShowHits     = 25

# Patterns checked on the lines an added or changed file gained.
# Scope: any = every text file, code = scripts, JSON and the plugin folder, js = Node code.
$Rules = @(
  @{ Scope = 'any';  Why = 'downloads from the network';
     Rx = '(?i)\b(Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|bitsadmin|DownloadString|DownloadFile|DownloadData|Net\.WebClient|Net\.Http\.HttpClient)\b|(?i)(^|[\s;|&(])(iwr|irm|wget|curl(\.exe)?)\s' },
  @{ Scope = 'any';  Why = 'runs text as code';
     Rx = '(?i)\b(Invoke-Expression|ScriptBlock\]::Create)\b|(?i)\bAdd-Type\b(?!\s+-AssemblyName)|(?i)(^|[\s;|&(])iex([\s(]|$)|(?i)\s-(e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}' },
  @{ Scope = 'any';  Why = 'decodes hidden content';
     Rx = '(?i)FromBase64String|(?i)certutil(\.exe)?\b.*-(decode|urlcache)|[A-Za-z0-9+/]{200,}={0,2}' },
  @{ Scope = 'any';  Why = 'starts a Windows helper that malware often misuses';
     Rx = '(?i)\b(mshta|rundll32|regsvr32|wscript|cscript|msiexec|installutil|regasm|regsvcs)(\.exe)?\b' },
  @{ Scope = 'any';  Why = 'changes security settings';
     Rx = '(?i)\b(Add-MpPreference|Set-MpPreference|DisableRealtimeMonitoring|Set-ExecutionPolicy|Unblock-File|New-NetFirewallRule)\b|(?i)netsh\s+advfirewall|(?i)Zone\.Identifier' },
  @{ Scope = 'any';  Why = 'sets something to start on its own';
     Rx = '(?i)\b(Register-ScheduledTask|New-ScheduledTask|schtasks|New-Service|Register-WmiEvent)\b|(?i)\bsc(\.exe)?\s+create\b|(?i)CurrentVersion\\Run|(?i)Start Menu\\Programs\\Startup|(?i)\breg(\.exe)?\s+add\b' },
  @{ Scope = 'any';  Why = 'reads credentials or tokens';
     Rx = '(?i)(\.ssh[\\/]|id_rsa|id_ed25519|\.aws[\\/]credentials|\.git-credentials|\.credentials\.json|Login Data|\bcmdkey\b|\bvaultcmd\b|ConvertFrom-SecureString|Get-Credential|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)' },
  @{ Scope = 'code'; Why = 'contains a web address';
     Rx = '(?i)\b(https?|ftp|wss?)://[^\s''"<>]+' },
  @{ Scope = 'js';   Why = 'network, code loading or process start in Node code';
     Rx = '(?i)require\(\s*[''"](node:)?(https?|http2|net|tls|dgram|dns|vm|worker_threads|inspector|child_process|cluster)[''"]\s*\)|(?i)\bfrom\s+[''"](node:)?(https?|http2|net|tls|dgram|dns|vm|worker_threads|child_process)[''"]|(?i)\bfetch\s*\(|\beval\s*\(|\bnew\s+Function\s*\(|process\.(binding|dlopen)|--allow-(net|child-process|worker|addons|wasi)|\bWebSocket\b' }
)

$Rank = @{ 'OK' = 0; 'LOW' = 1; 'MEDIUM' = 2; 'HIGH' = 3 }

# ---------------------------------------------------------------- helpers

function Get-Now { return (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') }

function Write-Log([string[]]$Lines) {
  try {
    if ((Test-Path -LiteralPath $LogPath) -and ((Get-Item -LiteralPath $LogPath).Length -gt 1MB)) {
      Move-Item -LiteralPath $LogPath -Destination (Join-Path $StateDir 'watchdog.1.log') -Force
    }
    [IO.File]::AppendAllText($LogPath, ((@($Lines | ForEach-Object { Clean-Text ([string]$_) 4000 }) -join "`r`n") + "`r`n"), $Utf8)
  } catch { }
}

# Windows Restart Manager lookup: which processes have a file open. Compiled
# only when a save is refused, so normal scans never load it.
$RmSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class JbwdRm {
  [StructLayout(LayoutKind.Sequential)]
  struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
  public static string[] WhoHas(string path) {
    var found = new List<string>();
    uint h;
    int r = RmStartSession(out h, 0, Guid.NewGuid().ToString("N"));
    if (r != 0) { found.Add("(Restart Manager could not start: " + r + ")"); return found.ToArray(); }
    try {
      r = RmRegisterResources(h, 1, new string[] { path }, 0, null, 0, null);
      if (r != 0) { found.Add("(could not register the file: " + r + ")"); return found.ToArray(); }
      uint needed = 0, count = 0, reasons = 0;
      r = RmGetList(h, out needed, ref count, null, ref reasons);
      if (r == 234 && needed > 0) {
        var info = new RM_PROCESS_INFO[needed];
        count = needed;
        r = RmGetList(h, out needed, ref count, info, ref reasons);
        if (r == 0) {
          for (int i = 0; i < count; i++) {
            string s = info[i].strAppName + " (pid " + info[i].Process.dwProcessId;
            if (!string.IsNullOrEmpty(info[i].strServiceShortName)) s += ", service " + info[i].strServiceShortName;
            found.Add(s + ")");
          }
        } else { found.Add("(list failed: " + r + ")"); }
      } else if (r == 0) { found.Add("(no process holds it now)"); }
      else { found.Add("(list failed: " + r + ")"); }
    } finally { RmEndSession(h); }
    return found.ToArray();
  }
}
'@

function Get-FileHolders([string]$Path) {
  if (-not $OnWindows) { return @('(not on Windows, not looked up)') }
  try {
    if (-not ('JbwdRm' -as [type])) { Add-Type -TypeDefinition $RmSource -ErrorAction Stop }
    return @([JbwdRm]::WhoHas($Path) | ForEach-Object {
      $h = [string]$_
      if ($h -match 'pid (\d+)') {
        try { $p = Get-Process -Id ([int]$Matches[1]) -ErrorAction Stop; $h = $h + ' = ' + $p.ProcessName + '.exe' } catch { }
      }
      $h
    })
  } catch { return @('(could not ask Windows: ' + (Format-Line $_.Exception.Message) + ')') }
}

# Saving a state file. The new text goes to <name>.tmp, then a POSIX rename
# puts it in place in one step. That rename makes no extra files, and a handle
# another program has open on the old file doesn't block it as long as the
# handle allows delete, which a file watcher checking attributes always does.
# File.Replace, used up to 1.3.0, first makes a placeholder <name>~RF<hex>.TMP
# and renames the old file onto it under the older rename rules, where any
# open handle on the placeholder fails the save with "Unable to remove the
# file to be replaced". A file watcher that checks the new placeholder at that
# moment is enough (a rename-race test on Windows 11, 2026-10-18: 681 of 2000
# saves failed that way; the POSIX rename failed none). File.Replace is still
# the fallback where the POSIX rename isn't available (FAT, exFAT, some
# network drives) or the helper can't be compiled.
$RenameSource = @'
using System;
using System.Runtime.InteropServices;
public static class JbwdRename {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(IntPtr h, int cls, IntPtr info, uint size);
  // Renames src onto dst, replacing dst, with POSIX semantics.
  // Returns 0, or the Windows error number.
  public static int Posix(string src, string dst) {
    // DELETE | SYNCHRONIZE, share everything, open existing, backup semantics + open reparse point
    IntPtr h = CreateFileW(src, 0x10000 | 0x100000, 7, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
    if (h == new IntPtr(-1)) return Failed();
    // FILE_RENAME_INFO: ULONG Flags, HANDLE RootDirectory, DWORD FileNameLength, WCHAR FileName[]
    int offRoot = IntPtr.Size;
    int offLen = offRoot + IntPtr.Size;
    int offName = offLen + 4;
    int size = offName + dst.Length * 2 + 2;
    IntPtr buf = IntPtr.Zero;
    try {
      buf = Marshal.AllocHGlobal(size);
      for (int i = 0; i < size; i++) Marshal.WriteByte(buf, i, 0);
      Marshal.WriteInt32(buf, 0, 0x1 | 0x2);  // FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS
      Marshal.WriteInt32(buf, offLen, dst.Length * 2);
      Marshal.Copy(dst.ToCharArray(), 0, IntPtr.Add(buf, offName), dst.Length);
      // 22 = FileRenameInfoEx
      if (SetFileInformationByHandle(h, 22, buf, (uint)size)) return 0;
      return Failed();
    } finally {
      if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
      CloseHandle(h);
    }
  }
  // A failed call that left no error number still counts as failed (-1).
  static int Failed() {
    int e = Marshal.GetLastWin32Error();
    return e != 0 ? e : -1;
  }
}
'@

$script:PosixRename = $null   # $true once the helper is compiled, $false once it can't be used this run
$script:PosixWhy = ''
$script:PosixNoted = $false

function Test-PosixRename {
  if ($null -ne $script:PosixRename) { return $script:PosixRename }
  $script:PosixRename = $false
  if (-not $OnWindows) { $script:PosixWhy = 'not on Windows'; return $false }
  # For the test script only: forces the File.Replace fallback.
  if ($env:JBWD_SAVE -eq 'replace') { $script:PosixWhy = 'JBWD_SAVE=replace'; return $false }
  try {
    if (-not ('JbwdRename' -as [type])) { Add-Type -TypeDefinition $RenameSource -ErrorAction Stop }
    $script:PosixRename = $true
  } catch { $script:PosixWhy = 'could not compile the rename helper: ' + (Format-Line $_.Exception.Message) }
  return $script:PosixRename
}

function Get-Win32Message([int]$Code) {
  try { return ((New-Object ComponentModel.Win32Exception $Code).Message + ' (error ' + $Code + ')') } catch { return ('error ' + $Code) }
}

function Save-Json($Obj, [string]$Path) {
  $tmp = $Path + '.tmp'
  $leaf = Split-Path -Leaf $Path
  [void](Test-PosixRename)   # compile the helper first, so the .tmp file lives only as long as the rename takes
  [IO.File]::WriteAllText($tmp, (ConvertTo-Json -InputObject $Obj -Depth 10), $Utf8)
  # A program that has the old file open without allowing delete (a backup
  # tool, an editor, a scanner) still blocks the rename. Waits between tries
  # add up to about 2 s, long enough for one that is only reading to let go.
  $waits = @(100, 200, 400, 600, 800)
  $first = ''
  $held = @(); $heldTmp = @()
  $method = ''
  $try = 0
  while ($true) {
    $try++
    $msg = ''
    if (Test-PosixRename) {
      $method = 'rename'
      $rc = 0
      try { $rc = [JbwdRename]::Posix($tmp, $Path) }
      catch { $rc = -2; $script:PosixWhy = 'the rename helper failed: ' + (Format-Line $_.Exception.Message) }
      # 5 access denied, 32 sharing violation, 33 lock violation: another
      # program has a file open without allowing delete. Worth waiting for.
      # Anything else (1, 50, 87 where the drive has no POSIX rename, or a
      # code nobody planned for) won't change by waiting: use File.Replace
      # from here on, without counting a try.
      if ($rc -ne 0 -and $rc -ne 5 -and $rc -ne 32 -and $rc -ne 33) {
        $script:PosixRename = $false
        if ($rc -ne -2) { $script:PosixWhy = 'the POSIX rename is not usable here: ' + (Get-Win32Message $rc) }
        $try--
        continue
      }
      if ($rc -ne 0) { $msg = Get-Win32Message $rc }
    } else {
      $method = 'File.Replace'
      if ($OnWindows -and -not $script:PosixNoted) {
        $script:PosixNoted = $true
        Write-Log ((Get-Now) + '  ' + ('{0,-7}' -f 'note') + '  saving with File.Replace, ' + $script:PosixWhy)
      }
      try {
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) }
        else { [IO.File]::Move($tmp, $Path) }
      } catch {
        $e = $_.Exception
        if ($e.InnerException) { $e = $e.InnerException }
        $msg = $e.Message.Trim()
      }
    }
    if (-not $msg) { break }
    if (-not $first) {
      # Ask Windows who has the files open, while the holder still has them.
      $first = $msg
      $held = @(Get-FileHolders $Path)
      $heldTmp = @(Get-FileHolders $tmp)
    }
    if ($try -gt $waits.Count) { break }
    Start-Sleep -Milliseconds $waits[$try - 1]
  }
  $holdLines = @(
    ('    holding ' + $leaf + ': ' + ($held -join '; ')),
    ('    holding ' + (Split-Path -Leaf $tmp) + ': ' + ($heldTmp -join '; ')))
  if ($method -eq 'File.Replace') { $holdLines += ('    File.Replace also makes a placeholder ' + $leaf + '~RF*.TMP, which can''t be looked up; a file watcher opening it is enough to fail the save') }
  if (-not $msg) {
    if ($first) {
      Write-Log (@((Get-Now) + '  ' + ('{0,-7}' -f 'retried') + '  saved ' + $leaf + ' on try ' + $try + ' (' + $method + '), first refusal: ' + (Format-Line $first)) + $holdLines)
    }
    return
  }
  Write-Log (@((Get-Now) + '  ' + ('{0,-7}' -f 'refused') + '  saving ' + $leaf + ' after ' + $try + ' tries (' + $method + '): ' + (Format-Line $first)) + $holdLines)
  # If a File.Replace failed halfway the old file is already gone; put the new one in its place.
  if (-not (Test-Path -LiteralPath $Path) -and (Test-Path -LiteralPath $tmp)) {
    try {
      [IO.File]::Move($tmp, $Path)
      Write-Log ((Get-Now) + '  ' + ('{0,-7}' -f 'note') + '  ' + $leaf + ' was missing after the refusal; the new file was moved into place')
      return
    } catch { }
  }
  throw ('could not save ' + $leaf + ', held open by ' + ($held -join '; '))
}

function Read-Json([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json)
}

function Open-Shared([string]$Path) {
  # Read even while another program holds the file open for writing, the way
  # Node (and so Claude Code) can. Get-FileHash and ReadAllBytes can't.
  return (New-Object IO.FileStream -ArgumentList $Path, ([IO.FileMode]::Open), ([IO.FileAccess]::Read), ([IO.FileShare]7))
}

function Read-AllBytes([string]$Path) {
  $fs = Open-Shared $Path
  try {
    $ms = New-Object IO.MemoryStream
    $fs.CopyTo($ms)
    return , $ms.ToArray()
  } finally { $fs.Dispose() }
}

function Copy-Shared([string]$Src, [string]$Dst) {
  $in = Open-Shared $Src
  try {
    $out = [IO.File]::Create($Dst)
    try { $in.CopyTo($out) } finally { $out.Dispose() }
  } finally { $in.Dispose() }
}

function Get-Sha([string]$Path) {
  $fs = $null
  $sha = $null
  try {
    $fs = Open-Shared $Path
    $sha = [Security.Cryptography.SHA256]::Create()
    return ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLowerInvariant()
  } catch { return '' }
  finally {
    if ($fs) { $fs.Dispose() }
    if ($sha) { $sha.Dispose() }
  }
}

function Get-StringSha([string]$Text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Utf8.GetBytes($Text))) -replace '-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Get-Rel([string]$RootFull, [string]$Full) {
  return ($Full.Substring($RootFull.Length).TrimStart([char[]]@('\', '/')) -replace '\\', '/')
}

function Get-Disp([string]$Rel) {
  if ($OnWindows) { return ($Rel -replace '/', '\') }
  return $Rel
}

function Get-Ext([string]$Rel) { return [IO.Path]::GetExtension($Rel).ToLowerInvariant() }

function Test-InMarket([string]$Rel) {
  foreach ($p in $MarketPrefixes) { if ($Rel.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)) { return $true } }
  return $false
}

function Get-Kind([string]$Rel) {
  $ext = Get-Ext $Rel
  if ($ProgramExt -contains $ext) { return 'program' }
  if ($ScriptExt -contains $ext) { return 'script' }
  if ($ArchiveExt -contains $ext) { return 'archive' }
  return 'other'
}

function Test-Ignored([string]$Rel, [bool]$IsDir) {
  $parts = $Rel.Split('/')
  if ($parts.Length -eq 1 -and -not $IsDir -and $Rel -match '(?i)\.log$') { return $true }
  if ($Layout -eq $LayoutRoot -and $parts.Length -eq 3 -and $parts[0] -ieq 'tools' -and $parts[1] -ieq 'windows' -and -not $IsDir -and $parts[2] -match '(?i)^[\w.-]+\.log$') { return $true }
  if ($parts[0] -match '^tm-(roundtrip|hooktest)-\d{8}-\d{6}$') { return $true }
  if (-not $IsDir -and $parts[$parts.Length - 1] -eq 'Thumbs.db') { return $true }
  return $false
}

# Text from files (hook commands, folder names) is shown and logged only
# after this: control characters (C0, C1, so no terminal escape codes, CR or
# LF), zero-width and bidi controls become '?'.
function Clean-Text([string]$Text, [int]$Max = 400) {
  $t = $Text -replace '[\x00-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]', '?'
  if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max) + '...' }
  return $t
}

function Format-Line([string]$Text) {
  $t = (Clean-Text $Text 100000).Trim()
  if ($t.Length -gt 160) { $t = $t.Substring(0, 160) + '...' }
  return $t
}

function Get-AttrList($Item) {
  $a = [int]$Item.Attributes
  $out = @()
  if (($a -band 2) -ne 0) { $out += 'hidden' }
  if (($a -band 4) -ne 0) { $out += 'system' }
  return ($out -join ',')
}

function Get-StreamList([string]$Path) {
  if (-not $OnWindows) { return '' }
  try {
    $s = @(Get-Item -LiteralPath $Path -Stream * -Force -ErrorAction Stop |
      Where-Object { $_.Stream -ne ':$DATA' } |
      ForEach-Object { $_.Stream + ':' + $_.Length })
    return ((@($s | Sort-Object)) -join ',')
  } catch { return '?' }
}

function Split-Streams([string]$List) {
  $h = @{}
  if (-not $List -or $List -eq '?') { return $h }
  foreach ($e in $List.Split(',')) {
    $i = $e.LastIndexOf(':')
    if ($i -gt 0) { $h[$e.Substring(0, $i)] = $e.Substring($i + 1) }
  }
  return $h
}

function Read-TextFile([string]$Path) {
  # Text content, or $null for binary and oversized files.
  $fi = New-Object IO.FileInfo $Path
  if ($fi.Length -gt $TextScanMax) { return $null }
  $bytes = Read-AllBytes $Path
  $utf16 = ($bytes.Length -ge 2) -and ((($bytes[0] -eq 0xFF) -and ($bytes[1] -eq 0xFE)) -or (($bytes[0] -eq 0xFE) -and ($bytes[1] -eq 0xFF)))
  if (-not $utf16) {
    $n = [Math]::Min($bytes.Length, 8000)
    if ($n -gt 0 -and [Array]::IndexOf($bytes, [byte]0, 0, $n) -ge 0) { return $null }
  }
  $ms = New-Object IO.MemoryStream (, $bytes)
  $sr = New-Object IO.StreamReader($ms, $Utf8, $true)
  try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
}

function Split-Lines([string]$Text) {
  if ($null -eq $Text) { return @() }
  $l = @($Text -split "\r?\n")
  # A file that ends with a newline doesn't have an extra empty last line.
  if ($l.Length -gt 0 -and $l[$l.Length - 1] -eq '') { if ($l.Length -eq 1) { return @() }; $l = $l[0..($l.Length - 2)] }
  return $l
}

function Get-Count([int]$N, [string]$Word) {
  if ($N -eq 1) { return ('1 ' + $Word) }
  return ([string]$N + ' ' + $Word + 's')
}

function Get-LineDiff([string[]]$Old, [string[]]$New) {
  $count = New-Object 'System.Collections.Generic.Dictionary[string,int]' -ArgumentList ([StringComparer]::Ordinal)
  foreach ($l in $Old) { if ($count.ContainsKey($l)) { $count[$l] = $count[$l] + 1 } else { $count[$l] = 1 } }
  $added = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $New.Length; $i++) {
    $l = $New[$i]
    if ($count.ContainsKey($l) -and $count[$l] -gt 0) { $count[$l] = $count[$l] - 1 }
    else { [void]$added.Add([pscustomobject]@{ N = $i + 1; Text = $l }) }
  }
  $removed = New-Object System.Collections.ArrayList
  foreach ($l in $Old) {
    if ($count.ContainsKey($l) -and $count[$l] -gt 0) { [void]$removed.Add($l); $count[$l] = $count[$l] - 1 }
  }
  return [pscustomobject]@{ Added = $added; Removed = $removed }
}

function Get-RuleHits($Lines, [string]$Rel) {
  $ext = Get-Ext $Rel
  $isJs = $JsExt -contains $ext
  $isCode = ((Get-Kind $Rel) -ne 'other') -or ($ext -eq '.json') -or (Test-InMarket $Rel)
  $hits = New-Object System.Collections.ArrayList
  foreach ($ln in $Lines) {
    $t = [string]$ln.Text
    if ($isCode -and $t.Length -gt 2000) {
      [void]$hits.Add([pscustomobject]@{ N = $ln.N; Why = 'very long line (packed or hidden code often looks like this)'; Text = $t })
    }
    foreach ($r in $Rules) {
      if ($r.Scope -eq 'js' -and -not $isJs) { continue }
      if ($r.Scope -eq 'code' -and -not $isCode) { continue }
      if ($t -match $r.Rx) { [void]$hits.Add([pscustomobject]@{ N = $ln.N; Why = $r.Why; Text = $t }) }
    }
  }
  return , $hits
}

function Get-HookLines($Json) {
  # One line per hook handler: "<event>: <command> <args>".
  $out = New-Object System.Collections.ArrayList
  if (-not $Json -or -not $Json.PSObject.Properties['hooks']) { return , $out }
  foreach ($ev in @($Json.hooks.PSObject.Properties)) {
    foreach ($grp in @($ev.Value)) {
      if (-not $grp -or -not $grp.PSObject.Properties['hooks']) { continue }
      foreach ($h in @($grp.hooks)) {
        if (-not $h) { continue }
        $hargs = @()
        if ($h.PSObject.Properties['args']) { $hargs = @($h.args | ForEach-Object { [string]$_ }) }
        $type = ''; if ($h.PSObject.Properties['type']) { $type = [string]$h.type }
        $cmd = ''; if ($h.PSObject.Properties['command']) { $cmd = [string]$h.command }
        $first = ''; if ($hargs.Count -gt 0) { $first = $hargs[0] }
        $runsJbm = ($type -eq 'command') -and ($cmd -eq 'node') -and ($first -eq $HookScript)
        $named = ($hargs.Count -ge 3) -and ($hargs[1] -eq '--hook') -and ($HookNames.ContainsKey([string]$ev.Name)) -and (@($HookNames[[string]$ev.Name]) -contains $hargs[2])
        if (-not $runsJbm -and $type -eq 'command' -and $hargs.Count -eq 0 -and $cmd.StartsWith($CodexHookPrefix, [StringComparison]::Ordinal)) {
          $rest = $cmd.Substring($CodexHookPrefix.Length)
          if ($rest -cmatch '^([a-z][a-z-]{0,30})( [a-z][a-z-]{0,30})?$') {
            $runsJbm = $true
            $named = ($HookNames.ContainsKey([string]$ev.Name)) -and (@($HookNames[[string]$ev.Name]) -contains $Matches[1])
            $cmd = 'node <codex launcher> trailmark --hook ' + $rest
          }
        }
        $ok = $runsJbm -and ($AllowedHookEvents -contains $ev.Name) -and $named
        [void]$out.Add([pscustomobject]@{ Event = $ev.Name; Ok = $ok; RunsJbm = $runsJbm; Text = Clean-Text ((($ev.Name + ': ' + $cmd + ' ' + ($hargs -join ' ')).Trim() -replace [regex]::Escape('${CLAUDE_PLUGIN_ROOT}'), '<plugin>') + $(if ($type -and $type -ne 'command') { ' (type ' + $type + ')' } else { '' })) 600 })
      }
    }
  }
  return , $out
}

function Get-StructureNotes([string]$Rel, [string]$Full) {
  # Plugin files that decide what Claude Code starts. Explains a change to them.
  $notes = New-Object System.Collections.ArrayList
  if (-not (Test-InMarket $Rel)) { return , $notes }
  $name = [IO.Path]::GetFileName($Rel).ToLowerInvariant()
  if (@('.mcp.json', '.lsp.json', 'monitors.json') -contains $name) {
    [void]$notes.Add($name + ' in the plugin folder declares programs Claude Code would start with the plugin')
  }
  if (@('hooks.json', 'plugin.json', 'marketplace.json') -notcontains $name) { return , $notes }
  $j = $null
  try { $j = [IO.File]::ReadAllText($Full) | ConvertFrom-Json } catch {
    [void]$notes.Add($name + ' is not valid JSON, so Claude Code may not load the plugin')
    return , $notes
  }
  if ($name -eq 'hooks.json') {
    foreach ($h in (Get-HookLines $j)) {
      if (-not $h.Ok) {
        if ($AllowedHookEvents -notcontains $h.Event) { [void]$notes.Add('new hook event: ' + $h.Text) }
        elseif ($h.RunsJbm) { [void]$notes.Add('trailmark.js hook with a --hook name its event does not use: ' + $h.Text) }
        else { [void]$notes.Add('hook runs something other than trailmark.js: ' + $h.Text) }
      }
    }
  }
  if ($name -eq 'plugin.json') {
    foreach ($k in @('mcpServers', 'lspServers', 'monitors', 'hooks')) {
      if ($j.PSObject.Properties[$k]) { [void]$notes.Add('plugin.json declares ' + $k + ', which can start programs or load other hook files') }
    }
  }
  if ($name -eq 'marketplace.json' -and $j.PSObject.Properties['plugins']) {
    foreach ($p in @($j.plugins)) {
      if (-not $p) { continue }
      $src = $p.source
      $srcText = $(if ($src -is [string]) { $src } else { ConvertTo-Json -InputObject $src -Compress -Depth 5 })
      $localCodex = (-not ($src -is [string])) -and $src -and $src.PSObject.Properties['source'] -and ([string]$src.source -eq 'local') -and $src.PSObject.Properties['path'] -and ([string]$src.path -match '^\./plugins/(?!\.\.?$)[\w.-]+$')
      if (-not $localCodex -and (-not ($src -is [string]) -or -not ($src -match '^\./plugins/(?!\.\.?$)[\w.-]+$'))) { [void]$notes.Add('marketplace entry ' + $p.name + ' loads from ' + $srcText) }
      if ($KnownPlugins -notcontains [string]$p.name) { [void]$notes.Add('new marketplace entry ' + $p.name + ' (source ' + $srcText + ')') }
    }
  }
  return , $notes
}

function Get-ZoneInfo([string]$Path) {
  try {
    $z = @(Get-Content -LiteralPath $Path -Stream 'Zone.Identifier' -Force -ErrorAction Stop)
    $zone = ($z | Where-Object { $_ -match '^ZoneId=' } | Select-Object -First 1)
    $url = ($z | Where-Object { $_ -match '^(HostUrl|ReferrerUrl)=' } | Select-Object -First 1)
    $txt = ''
    if ($zone) { $txt = $zone }
    if ($url) { $txt = ($txt + ' ' + $url).Trim() }
    return (Format-Line $txt)
  } catch { return '' }
}

# ---------------------------------------------------------------- inventory

# A file over $HashFullMax is hashed by its first and last 8 MB, its size and
# its time, so one huge (or sparse) file can't stretch every scan past the
# task's time limit. Adding or changing one is HIGH, since its middle isn't read.
$HashFullMax = 64MB
function Get-InventorySha($Item) {
  if ([long]$Item.Length -le $HashFullMax) { return (Get-Sha $Item.FullName) }
  $fs = $null; $sha = $null
  try {
    $fs = Open-Shared $Item.FullName
    $sha = [Security.Cryptography.SHA256]::Create()
    $chunk = 8MB
    $buf = New-Object byte[] $chunk
    foreach ($pos in @(0, ([long]$fs.Length - $chunk))) {
      [void]$fs.Seek($pos, [IO.SeekOrigin]::Begin)
      $n = 0; $got = 0
      while ($got -lt $chunk -and ($n = $fs.Read($buf, $got, $chunk - $got)) -gt 0) { $got += $n }
      [void]$sha.TransformBlock($buf, 0, $got, $null, 0)
    }
    $tail = [Text.Encoding]::UTF8.GetBytes([string]$fs.Length + ':' + [string]$Item.LastWriteTimeUtc.Ticks)
    [void]$sha.TransformFinalBlock($tail, 0, $tail.Length)
    return ('partial-' + ([BitConverter]::ToString($sha.Hash) -replace '-', '').ToLowerInvariant())
  } catch { return '' }
  finally { if ($fs) { $fs.Dispose() }; if ($sha) { $sha.Dispose() } }
}

function Add-FileRecord($Inv, [string]$Rel, $Item) {
  $sha = Get-InventorySha $Item
  if (-not $sha) { [void]$Inv.unreadable.Add($Rel); return }
  $Inv.files[$Rel] = [ordered]@{ sha256 = $sha; size = [long]$Item.Length; attrs = (Get-AttrList $Item); streams = (Get-StreamList $Item.FullName) }
  $Inv.paths[$Rel] = $Item.FullName
}

function Add-GitParts($Inv, [string]$RootFull, [string]$GitDir) {
  # Inside a .git folder only config and real hooks can make something run.
  $cfg = Join-Path $GitDir 'config'
  if (Test-Path -LiteralPath $cfg -PathType Leaf) { Add-FileRecord $Inv (Get-Rel $RootFull $cfg) (Get-Item -LiteralPath $cfg -Force) }
  $hooks = Join-Path $GitDir 'hooks'
  if (Test-Path -LiteralPath $hooks -PathType Container) {
    foreach ($h in @(Get-ChildItem -LiteralPath $hooks -Force -File -ErrorAction SilentlyContinue)) {
      if ($h.Name -notlike '*.sample') { Add-FileRecord $Inv (Get-Rel $RootFull $h.FullName) $h }
    }
  }
}

# Maps keyed by path compare names exactly (Ordinal). A PowerShell hashtable
# ignores case, so in a case-sensitive folder (WSL, fsutil
# setCaseSensitiveInfo) hooks.json and HOOKS.json would share one entry and
# a change to one could hide behind the other.
# (The comma keeps PowerShell from unrolling the empty map into nothing.)
function New-PathMap { return , (New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)) }

function Get-Inventory([string]$RootFull) {
  $inv = @{
    files = (New-PathMap); paths = (New-PathMap)
    reparse = (New-PathMap)
    caseClash = New-Object System.Collections.ArrayList
    unreadable = New-Object System.Collections.ArrayList
    ignored = New-Object System.Collections.ArrayList
  }
  $stack = New-Object System.Collections.Stack
  $stack.Push($RootFull)
  while ($stack.Count -gt 0) {
    $dir = [string]$stack.Pop()
    $errs = $null
    $children = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue -ErrorVariable errs)
    foreach ($e in @($errs)) {
      if (-not $e) { continue }
      $tp = [string]$e.TargetObject
      if ($tp.StartsWith($RootFull, [StringComparison]::OrdinalIgnoreCase)) { $tp = Get-Rel $RootFull $tp }
      [void]$inv.unreadable.Add($tp)
    }
    foreach ($c in $children) {
      $rel = Get-Rel $RootFull $c.FullName
      $isDir = [bool]$c.PSIsContainer
      if (Test-Ignored $rel $isDir) { [void]$inv.ignored.Add($rel); continue }
      # A junction or symlink, or any reparse-point folder, is reported and not followed.
      # Other reparse files (cloud placeholders, for one) are read like normal files.
      if ((([int]$c.Attributes) -band 0x400) -ne 0) {
        if ($isDir -or (@('Junction', 'SymbolicLink') -contains [string]$c.LinkType)) {
          $tgt = ''
          try { $tgt = (@($c.Target | Where-Object { $_ } | ForEach-Object { [string]$_ })) -join ';' } catch { }
          $inv.reparse[$rel] = $tgt
          continue
        }
      }
      if ($isDir) {
        # A git repository in the folder or one level down: only config and hooks
        # can make anything run, and the rest changes constantly. Deeper .git
        # folders are hashed like anything else.
        if ($c.Name -eq '.git' -and $rel.Split('/').Length -le 2) { Add-GitParts $inv $RootFull $c.FullName }
        else { $stack.Push($c.FullName) }
        continue
      }
      Add-FileRecord $inv $rel $c
    }
  }
  $seenFold = New-PathMap
  foreach ($k in @(@($inv.files.Keys) + @($inv.reparse.Keys))) {
    $f = $k.ToLowerInvariant()
    if ($seenFold.ContainsKey($f)) { [void]$inv.caseClash.Add($k + ' / ' + $seenFold[$f]) } else { $seenFold[$f] = $k }
  }
  return $inv
}

# ---------------------------------------------------------------- Defender

function Get-DefenderState([string]$RootFull) {
  $st = @{ realtime = 'unknown'; detections = @(); note = '' }
  if ($NoDefender -or -not $OnWindows) { $st.note = 'Defender not checked'; return $st }
  try {
    $cs = Get-MpComputerStatus -ErrorAction Stop
    if ([string]$cs.AMRunningMode -match 'Passive|EDR') { $st.realtime = 'passive' }
    elseif ($cs.RealTimeProtectionEnabled) { $st.realtime = 'on' }
    else { $st.realtime = 'off' }
  } catch { $st.note = 'Defender status unavailable to this account' }
  try {
    $found = New-Object System.Collections.ArrayList
    foreach ($d in @(Get-MpThreatDetection -ErrorAction Stop)) {
      if (-not $d) { continue }
      $res = @($d.Resources | ForEach-Object { [string]$_ })
      $hit = @($res | Where-Object { $_.IndexOf($RootFull, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
      if ($hit.Count -eq 0) { continue }
      $name = [string]$d.ThreatID
      try { $t = Get-MpThreat -ThreatID $d.ThreatID -ErrorAction Stop; if ($t -and $t.ThreatName) { $name = [string]$t.ThreatName } } catch { }
      [void]$found.Add([pscustomobject]@{ Id = [string]$d.DetectionID; Text = (Format-Line ($name + ' in ' + ($hit -join ', ') + ' (' + [string]$d.InitialDetectionTime + ')')) })
    }
    $st.detections = @($found)
  } catch { $st.note = ($st.note + '; Defender detection history unavailable to this account').TrimStart('; ') }
  return $st
}

# ---------------------------------------------------------------- outside the folder

# A folder's entries, read one at a time and at most $Max of them, so a
# folder padded with thousands of entries is never loaded whole. Full is
# false when entries were left unread.
function Get-Entries([string]$Dir, [int]$Max) {
  $items = New-Object System.Collections.ArrayList
  $full = $true
  try {
    foreach ($e in ([IO.DirectoryInfo]::new($Dir)).EnumerateFileSystemInfos()) {
      if ($items.Count -ge $Max) { $full = $false; break }
      [void]$items.Add($e)
    }
  } catch {
    # A folder that is there but can't be listed (access denied, read error
    # part-way) is not an empty one.
    if (Test-Path -LiteralPath $Dir) { $full = $false }
  }
  return [pscustomobject]@{ Items = $items; Full = $full }
}

function Test-Reparse($Item) { return ((([int]$Item.Attributes) -band 0x400) -ne 0) }

# Where a link points, read from the link itself, never followed (a target
# such as \\server\share would connect to that server).
function Get-LinkTarget([string]$Path) {
  try { return Clean-Text ((@((Get-Item -LiteralPath $Path -Force -ErrorAction Stop).Target) | ForEach-Object { [string]$_ }) -join ',') 300 } catch { return '?' }
}

# One hash over a plugin copy's files, walked by hand: a junction or link
# inside it is recorded with its target and never followed. At most 2,000
# entries (files and folders) and 8 folders deep, within 20 seconds; a copy
# cut short gets a marker line, so it can never hash the same as a full one.
# A file over 5 MB counts by size only. .orphaned_at, a marker Claude Code may
# write into old version folders, is left out.
function Get-CopyHash([string]$Dir) {
  $lines = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push(@($Dir, 0))
  $seen = 0
  $cut = ''
  $until = (Get-Date).AddSeconds(20)
  while ($stack.Count -gt 0 -and -not $cut) {
    if ((Get-Date) -gt $until) { $cut = 'time'; break }
    $top = $stack.Pop(); $d = [string]$top[0]; $depth = [int]$top[1]
    $r = Get-Entries $d 2000
    if (-not $r.Full) { $cut = 'entries' }
    foreach ($e in $r.Items) {
      if (++$seen -gt 2000) { $cut = 'entries'; break }
      $rel = Get-Rel $Dir $e.FullName
      if (Test-Reparse $e) { [void]$lines.Add($rel + ':link:' + (Get-LinkTarget $e.FullName)); continue }
      if ($e -is [IO.DirectoryInfo]) {
        if ($depth -lt 8) { $stack.Push(@($e.FullName, ($depth + 1))) } else { [void]$lines.Add($rel + ':deep') }
        continue
      }
      if ($e.Name -eq '.orphaned_at') { continue }
      $h = $(if ($e.Length -gt 5MB) { 'size' + $e.Length } else { Get-Sha $e.FullName })
      [void]$lines.Add($rel + ':' + $h)
    }
  }
  if ($cut) { [void]$lines.Add('<cut short: ' + $cut + '>') }
  return Get-StringSha ((@($lines) | Sort-Object) -join "`n")
}

# The folders Claude Code says it installed plugins to (installPath in
# plugins\installed_plugins.json), lower-cased, with / for \.
function Get-InstallPaths {
  $out = @{}
  $f = Join-Path (Join-Path $ClaudeDir 'plugins') 'installed_plugins.json'
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $out }
  if ((Get-Item -LiteralPath $f -Force).Length -gt 1MB) { return $out }
  try { $j = [IO.File]::ReadAllText($f) | ConvertFrom-Json } catch { return $out }
  $walk = New-Object System.Collections.Stack
  $walk.Push($j)
  $n = 0
  while ($walk.Count -gt 0 -and $n -lt 5000) {
    $v = $walk.Pop(); $n++
    if ($v -is [array]) { $i = 0; foreach ($x in $v) { if (++$i -gt 1000) { break }; $walk.Push($x) }; continue }
    if ($v -isnot [pscustomobject]) { continue }
    foreach ($p in @($v.PSObject.Properties | Select-Object -First 1000)) {
      if ($p.Name -eq 'installPath' -and $p.Value -is [string]) { $out[(($p.Value -replace '\\', '/').TrimEnd('/')).ToLowerInvariant()] = $true }
      elseif ($p.Value -is [array] -or $p.Value -is [pscustomobject]) { $walk.Push($p.Value) }
    }
  }
  return $out
}

# Copies of trailmark in Claude Code's plugin cache, at
# cache\<marketplace>\<plugin>\<version>: the plugin folder is named trailmark,
# or the copy holds trailmark's launcher. Claude Code may run a local plugin
# from a cache copy, so a copy it lists as installed, or one identical to the
# plugin in the watched folder, is the installed plugin; any other is not.
# A link at any of those three levels is an entry of its own (kind link,
# with its target): what is behind it is not walked.
# Returns @{ copies; incomplete }: incomplete says why the walk stopped early.
# Hints: marketplace folder names to look at first, by name, whatever the
# caps (the ones copies were accepted in before, and the ones Claude Code's
# installPath values point into), so padding the cache can't push them out
# of reach.
function Get-CacheCopies([string]$MarketHash, [string[]]$Hints = @()) {
  $out = [ordered]@{}
  $why = New-Object System.Collections.ArrayList
  $cache = Join-Path (Join-Path $ClaudeDir 'plugins') 'cache'
  if (-not (Test-Path -LiteralPath $cache -PathType Container)) { return @{ copies = $out; incomplete = '' } }
  $installed = Get-InstallPaths
  $until = (Get-Date).AddSeconds(90)
  $max = 200
  $addLink = {
    param($Item, $Key)
    $out[$Key] = [ordered]@{ hash = 'link:' + (Get-LinkTarget $Item.FullName); installed = $false; listed = $false; same = $false; link = $true }
  }
  $mk = Get-Entries $cache $max
  if (-not $mk.Full) { [void]$why.Add('more than ' + $max + ' folders in plugins\cache') }
  $cacheKey = (($cache -replace '\\', '/').TrimEnd('/')).ToLowerInvariant() + '/'
  foreach ($ip in @($installed.Keys)) { if ($ip.StartsWith($cacheKey)) { $Hints += @($ip.Substring($cacheKey.Length).Split('/')[0]) } }
  $mItems = New-Object System.Collections.ArrayList
  $done = @{}
  foreach ($h in @($Hints | Where-Object { $_ -and $_ -match '^[^\\/:*?"<>|]{1,200}$' -and $_ -ne '.' -and $_ -ne '..' } | Select-Object -Unique -First 50)) {
    # Get-Item reads the entry itself; a link is not followed.
    $hi = Get-Item -LiteralPath (Join-Path $cache $h) -Force -ErrorAction SilentlyContinue
    if ($hi -is [IO.DirectoryInfo]) { [void]$mItems.Add($hi); $done[$h.ToLowerInvariant()] = $true }
  }
  foreach ($m in $mk.Items) { if (-not $done.ContainsKey($m.Name.ToLowerInvariant())) { [void]$mItems.Add($m) } }
  foreach ($m in $mItems) {
    if ($m -isnot [IO.DirectoryInfo]) { continue }
    $mKey = 'plugins/cache/' + $m.Name
    if (Test-Reparse $m) { & $addLink $m $mKey; continue }
    $pl = Get-Entries $m.FullName $max
    if (-not $pl.Full) { [void]$why.Add('more than ' + $max + ' folders in ' + (Clean-Text $mKey 120)) }
    # trailmark itself (and jb-memory, its old name) is looked up by name too, past any cap.
    $items = @($pl.Items)
    foreach ($cn in $CopyNames) {
      if (-not ($items | Where-Object { $_.Name -eq $cn })) { $ni = Get-Item -LiteralPath (Join-Path $m.FullName $cn) -Force -ErrorAction SilentlyContinue; if ($ni -is [IO.DirectoryInfo]) { $items += $ni } }
    }
    foreach ($p in $items) {
      if ($p -isnot [IO.DirectoryInfo]) { continue }
      if ((Get-Date) -gt $until) { [void]$why.Add('the walk took longer than 90 seconds'); break }
      $pKey = $mKey + '/' + $p.Name
      $isNamed = ($CopyNames -contains $p.Name)
      if (Test-Reparse $p) { if ($isNamed) { & $addLink $p $pKey }; continue }
      $vs = Get-Entries $p.FullName $max
      if (-not $vs.Full) { [void]$why.Add('more than ' + $max + ' folders in ' + (Clean-Text $pKey 120)) }
      foreach ($v in $vs.Items) {
        if ($v -isnot [IO.DirectoryInfo]) { continue }
        if ((Get-Date) -gt $until) { break }
        $key = $pKey + '/' + $v.Name
        if (Test-Reparse $v) {
          if ($isNamed -or (Test-HasLauncher $v.FullName)) { & $addLink $v $key }
          continue
        }
        if (-not $isNamed -and -not (Test-HasLauncher $v.FullName)) { continue }
        $hash = Get-CopyHash $v.FullName
        $listed = $installed.ContainsKey((($v.FullName -replace '\\', '/').TrimEnd('/')).ToLowerInvariant())
        $same = [bool]($MarketHash -and $hash -eq $MarketHash)
        $isOld = ($p.Name -eq 'jb-memory') -or (-not (Test-Path -LiteralPath (Join-Path (Join-Path $v.FullName 'scripts') 'trailmark.js') -PathType Leaf))
        $out[$key] = [ordered]@{ hash = $hash; installed = [bool]($listed -or $same); listed = [bool]$listed; same = $same; old = [bool]$isOld }
      }
    }
    if ((Get-Date) -gt $until) { if ($why -notcontains 'the walk took longer than 90 seconds') { [void]$why.Add('the walk took longer than 90 seconds') }; break }
  }
  return @{ copies = $out; incomplete = (@($why) -join '; ') }
}

# What Claude Code's settings files run, one line each, sorted: hooks,
# command settings, permissions, enabled plugins, extra marketplaces, MCP
# servers, and env variable names. Each line ends with a hash of the whole
# raw value (for a hook: its event, its group's matcher and the full
# handler), so a change past the shown text, or in a field not shown (a
# hook's url or prompt), still changes the line. Values are shown cut short
# and cleaned; env values are never shown. Unreadable lists the files that
# are there but can't be read as JSON (or are over 2 MB).
# The same text for the same value under Windows PowerShell 5.1 and
# PowerShell 7 (their ConvertTo-Json output differs), so a scan and an
# accept run by different versions agree. Strings carry their length.
function Get-Canon($V, [int]$Depth = 0) {
  if ($Depth -gt 20) { return '<deep>' }
  if ($null -eq $V) { return 'null' }
  if ($V -is [psobject] -and $V -isnot [pscustomobject]) { $V = $V.PSObject.BaseObject }
  if ($V -is [string]) { return 's' + $V.Length + ':' + $V }
  if ($V -is [bool]) { return $(if ($V) { 'true' } else { 'false' }) }
  # PowerShell 7 reads an ISO date string as a date; 5.1 keeps the text.
  if ($V -is [datetime]) { return 'd' + $V.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffff', [Globalization.CultureInfo]::InvariantCulture) }
  if ($V -is [ValueType]) { try { return 'n' + ([double]$V).ToString('R', [Globalization.CultureInfo]::InvariantCulture) } catch { return 'n' + [string]$V } }
  if ($V -is [Collections.IDictionary]) { return '{' + ((@($V.Keys) | ForEach-Object { (Get-Canon ([string]$_) ($Depth + 1)) + '=' + (Get-Canon $V[$_] ($Depth + 1)) }) -join ',') + '}' }
  if ($V -is [Collections.IEnumerable]) { return '[' + ((@($V) | ForEach-Object { Get-Canon $_ ($Depth + 1) }) -join ',') + ']' }
  if ($V -is [pscustomobject]) { return '{' + ((@($V.PSObject.Properties) | ForEach-Object { (Get-Canon ([string]$_.Name) ($Depth + 1)) + '=' + (Get-Canon $_.Value ($Depth + 1)) }) -join ',') + '}' }
  return 'o' + [string]$V
}

function Get-ValueHash($Value) {
  return (Get-StringSha (Get-Canon $Value)).Substring(0, 12)
}

function Get-RunnerLines([string]$Name, $J) {
  $lines = New-Object System.Collections.ArrayList
  # A long value shows its start and its end: what is added to a command
  # usually goes at the end.
  $add = {
    param($Label, $Shown, $Raw)
    $s = Clean-Text ([string]$Shown) 100000
    if ($s.Length -gt 300) { $s = $s.Substring(0, 200) + ' ... ' + $s.Substring($s.Length - 90) }
    [void]$lines.Add($Name + ': ' + $Label + ' ' + $s + ' #' + (Get-ValueHash $Raw))
  }
  if ($J.PSObject.Properties['hooks'] -and $J.hooks -is [pscustomobject]) {
    foreach ($ev in @($J.hooks.PSObject.Properties)) {
      foreach ($grp in @($ev.Value)) {
        if (-not $grp -or $grp -isnot [pscustomobject]) { & $add ('hook ' + $ev.Name) '(not a hook group)' $grp; continue }
        $handlers = @(); if ($grp.PSObject.Properties['hooks']) { $handlers = @($grp.hooks) }
        $meta = [ordered]@{}; foreach ($q in @($grp.PSObject.Properties)) { if ($q.Name -ne 'hooks') { $meta[$q.Name] = $q.Value } }
        foreach ($h in $handlers) {
          if (-not $h) { continue }
          $shown = ''
          foreach ($k in @('command', 'url', 'prompt')) { if ($h.PSObject.Properties[$k]) { $shown = [string]$h.$k; break } }
          if ($h.PSObject.Properties['args']) { $shown = ($shown + ' ' + (@($h.args | ForEach-Object { [string]$_ }) -join ' ')).Trim() }
          $type = $(if ($h.PSObject.Properties['type']) { [string]$h.type } else { '?' })
          & $add ('hook ' + $ev.Name + ' (' + $type + ')') $shown ([ordered]@{ event = $ev.Name; group = $meta; handler = $h })
        }
      }
    }
  }
  foreach ($p in @($J.PSObject.Properties)) {
    $k = [string]$p.Name
    if ($k -eq 'statusLine' -and $p.Value) { $shown = $(if ($p.Value -is [pscustomobject] -and $p.Value.PSObject.Properties['command']) { $p.Value.command } else { '' }); & $add 'statusLine' $shown $p.Value }
    # Claude Code 2.1.310's command settings: apiKeyHelper, awsAuthRefresh,
    # awsCredentialExport, fileSuggestion, gcpAuthRefresh, otelHeadersHelper,
    # processWrapper, policyHelpers, proxyAuthHelper, statusLine,
    # subagentStatusLine. The pattern takes those and others named the same way.
    elseif ($k -match '(?i)(Helpers?|Refresh|Export|Wrapper|StatusLine|Suggestion|Command)$') { & $add (Clean-Text $k 60) $p.Value $p.Value }
    elseif ($k -eq 'permissions' -and $p.Value -is [pscustomobject]) {
      $mode = $(if ($p.Value.PSObject.Properties['defaultMode']) { 'defaultMode ' + [string]$p.Value.defaultMode } else { '' })
      $extra = @($p.Value.PSObject.Properties | Where-Object { $_.Name -ne 'defaultMode' } | ForEach-Object { $_.Name + ' ' + @($_.Value).Count })
      & $add 'permissions' (($mode, ($extra -join ', ')) -join '; ').Trim('; ') $p.Value
    }
    elseif ($k -eq 'enabledPlugins' -and $p.Value -is [pscustomobject]) {
      foreach ($q in @($p.Value.PSObject.Properties | Select-Object -First 500)) { if ($q.Value -eq $true) { & $add 'plugin' $q.Name $q.Name } }
    }
    elseif ($k -eq 'extraKnownMarketplaces' -and $p.Value -is [pscustomobject]) {
      foreach ($q in @($p.Value.PSObject.Properties | Select-Object -First 500)) { & $add 'marketplace' $q.Name ([ordered]@{ n = $q.Name; v = $q.Value }) }
    }
    elseif ($k -eq 'mcpServers' -and $p.Value -is [pscustomobject]) {
      foreach ($q in @($p.Value.PSObject.Properties | Select-Object -First 500)) {
        $shown = $(if ($q.Value -is [pscustomobject] -and $q.Value.PSObject.Properties['command']) { [string]$q.Value.command } elseif ($q.Value -is [pscustomobject] -and $q.Value.PSObject.Properties['url']) { [string]$q.Value.url } else { '' })
        & $add ('mcp server ' + (Clean-Text $q.Name 80)) $shown ([ordered]@{ n = $q.Name; v = $q.Value })
      }
    }
    elseif ($k -eq 'env' -and $p.Value -is [pscustomobject]) {
      foreach ($q in @($p.Value.PSObject.Properties | Select-Object -First 500)) { [void]$lines.Add($Name + ': env ' + (Clean-Text $q.Name 120) + ' #' + (Get-ValueHash ([string]$q.Value))) }
    }
  }
  return , $lines
}

function Get-SettingsRunners {
  $files = [ordered]@{
    'settings.json' = (Join-Path $ClaudeDir 'settings.json')
    'settings.local.json' = (Join-Path $ClaudeDir 'settings.local.json')
  }
  if ($env:ProgramFiles) { $files['managed-settings.json'] = (Join-Path (Join-Path $env:ProgramFiles 'ClaudeCode') 'managed-settings.json') }
  $lines = New-Object System.Collections.ArrayList
  $bad = New-Object System.Collections.ArrayList
  foreach ($name in $files.Keys) {
    $f = $files[$name]
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
    $j = $null
    try {
      if ((Get-Item -LiteralPath $f -Force).Length -gt 2MB) { throw 'too large' }
      $j = [IO.File]::ReadAllText($f) | ConvertFrom-Json
    } catch { [void]$bad.Add($name); continue }
    if (-not $j -or $j -isnot [pscustomobject]) { continue }
    foreach ($l in (Get-RunnerLines $name $j)) { [void]$lines.Add($l) }
  }
  # .claude.json (next to the config folder, or inside it when
  # CLAUDE_CONFIG_DIR is set) holds the user's MCP servers, which start with
  # every session, and much that changes all the time; only mcpServers is
  # read, at the top level and per project. It can grow past what Windows
  # PowerShell reads as JSON: then one line says it was not checked.
  $cj = $(if ($env:CLAUDE_CONFIG_DIR) { Join-Path $ClaudeDir '.claude.json' } else { Join-Path (Split-Path -Parent $ClaudeDir) '.claude.json' })
  if (Test-Path -LiteralPath $cj -PathType Leaf) {
    $j = $null
    try {
      if ((Get-Item -LiteralPath $cj -Force).Length -gt 2MB) { throw 'too large' }
      $j = [IO.File]::ReadAllText($cj) | ConvertFrom-Json
    } catch { [void]$lines.Add('.claude.json: not checked (over 2 MB or not readable as JSON)') }
    if ($j -and $j -is [pscustomobject]) {
      if ($j.PSObject.Properties['mcpServers']) { foreach ($l in (Get-RunnerLines '.claude.json' ([pscustomobject]@{ mcpServers = $j.mcpServers }))) { [void]$lines.Add($l) } }
      if ($j.PSObject.Properties['projects'] -and $j.projects -is [pscustomobject]) {
        foreach ($pr in @($j.projects.PSObject.Properties | Select-Object -First 500)) {
          if ($pr.Value -is [pscustomobject] -and $pr.Value.PSObject.Properties['mcpServers'] -and $pr.Value.mcpServers) {
            foreach ($l in (Get-RunnerLines ('.claude.json project ' + (Clean-Text $pr.Name 120)) ([pscustomobject]@{ mcpServers = $pr.Value.mcpServers }))) { [void]$lines.Add($l) }
          }
        }
      }
    }
  }
  return [pscustomobject]@{ Ok = ($bad.Count -eq 0); Bad = @($bad); Lines = @($lines | Sort-Object -Unique) }
}

function Get-OutsideState([string]$RootFull, $Baseline = $null) {
  $sh = Get-SettingsRunners
  $hints = @()
  if ($Baseline -and $Baseline.PSObject.Properties['outside'] -and $Baseline.outside -and $Baseline.outside.copies) {
    foreach ($p in @($Baseline.outside.copies.PSObject.Properties)) { $parts = ([string]$p.Name).Split('/'); if ($parts.Length -ge 3) { $hints += $parts[2] } }
  }
  $mh = ''
  $plug = Join-Path $RootFull ($PluginRel -replace '/', '\')
  if (Test-Path -LiteralPath $plug -PathType Container) { $mh = Get-CopyHash $plug }
  $cc = Get-CacheCopies $mh $hints
  return [ordered]@{ claudeDir = $ClaudeDir; psMajor = [int]$PSVersionTable.PSVersion.Major; copies = $cc.copies; cacheIncomplete = [string]$cc.incomplete; settingsReadable = [bool]$sh.Ok; settingsBad = @($sh.Bad); settingsHooks = @($sh.Lines) }
}

function Get-OutsideFindings($State, $Baseline) {
  $f = New-Object System.Collections.ArrayList
  $why = 'a copy of trailmark in Claude Code''s plugin cache that is not the installed plugin (Claude Code doesn''t list it as installed, and it differs from the plugin in the watched folder). A session once found an old copy like this and ran it. Remove it unless you know why it is there.'
  $old = $null
  if ($Baseline -and $Baseline.PSObject.Properties['outside']) { $old = $Baseline.outside }
  $oldCopies = @{}
  $oldSame = @{}
  if ($old -and $old.copies) {
    foreach ($p in @($old.copies.PSObject.Properties)) {
      $oldCopies[$p.Name] = $(if ($p.Value -is [string]) { [string]$p.Value } else { [string]$p.Value.hash })
      if ($p.Value -isnot [string] -and $p.Value.PSObject.Properties['same']) { $oldSame[$p.Name] = [bool]$p.Value.same }
    }
  }
  $incomplete = $(if ($State.Contains('cacheIncomplete')) { [string]$State.cacheIncomplete } else { '' })
  if ($incomplete) {
    [void]$f.Add((New-Finding 'HIGH' 'cache' '<claude>/plugins/cache' 'the check of Claude Code''s plugin cache stopped early, so a trailmark copy past that point was not seen. Look at what filled the cache.' @(Clean-Text $incomplete 600)))
  }
  foreach ($k in @($State.copies.Keys)) {
    $c = $State.copies[$k]
    $path = '<claude>/' + (Clean-Text $k 300)
    $known = $oldCopies.ContainsKey($k)
    $changed = $known -and $oldCopies[$k] -ne [string]$c.hash
    if ($c.Contains('link') -and $c.link) {
      if (-not $known -or $changed) { [void]$f.Add((New-Finding 'HIGH' 'cache' $path 'a link in Claude Code''s plugin cache where a trailmark copy can be; what it points to was not checked' @(Clean-Text ([string]$c.hash) 400))) }
      continue
    }
    # A copy under the old name (jb-memory, or one that holds only jbm.js) is
    # reported at every scan, installed or not and accepted or not: it would
    # run every hook a second time next to Trailmark.
    if ($c.Contains('old') -and $c.old) {
      [void]$f.Add((New-Finding 'HIGH' 'cache' $path ('a copy of jb-memory, Trailmark''s old name, is in Claude Code''s plugin cache' + $(if ($c.listed) { ' and listed as installed' } else { '' }) + '. It would run every hook a second time. Uninstall it (claude plugin uninstall jb-memory@<marketplace>) or remove the folder; MANUAL.md, section 15.') @()))
      continue
    }
    # A copy that matches the watched plugin: any change in it is the
    # plugin's own change, reported on the plugin's files.
    if ($c.same) { continue }
    if ($c.listed) {
      # The copy Claude Code lists as installed, and may run, but its content
      # is not the watched plugin's.
      if (-not $known) { [void]$f.Add((New-Finding 'HIGH' 'cache' $path 'the copy of trailmark Claude Code lists as installed differs from the plugin in the watched folder. Claude Code may run this copy. If you just updated the plugin, run /reload-plugins and scan again.' @())) }
      elseif ($changed) { [void]$f.Add((New-Finding 'HIGH' 'cache' $path 'the copy of trailmark Claude Code lists as installed changed since it was accepted, and it differs from the plugin in the watched folder. Claude Code may run this copy.' @())) }
      elseif ($oldSame.ContainsKey($k) -and $oldSame[$k]) { [void]$f.Add((New-Finding 'MEDIUM' 'cache' $path 'the plugin in the watched folder changed, and the copy Claude Code lists as installed still holds the earlier code. Run /reload-plugins, then scan again.' @())) }
      continue
    }
    if (-not $known) { [void]$f.Add((New-Finding 'HIGH' 'cache' $path $why @())) }
    elseif ($changed) { [void]$f.Add((New-Finding 'HIGH' 'cache' $path 'a cached copy of trailmark that is not the installed plugin changed since it was accepted' @())) }
  }
  foreach ($k in @($oldCopies.Keys)) {
    if (-not $State.copies.Contains($k)) {
      # Gone, or only not seen because the walk stopped early.
      $sev = $(if ($incomplete) { 'MEDIUM' } else { 'LOW' })
      [void]$f.Add((New-Finding $sev 'removed' ('<claude>/' + (Clean-Text $k 300)) $(if ($incomplete) { 'a cached copy of trailmark was not seen (the check stopped early)' } else { 'a cached copy of trailmark is gone' }) @()))
    }
  }
  $was = @()
  if ($old -and $old.PSObject.Properties['settingsHooks']) { $was = @($old.settingsHooks | ForEach-Object { [string]$_ }) }
  if (-not $State.settingsReadable) {
    # A file that can't be read can't be checked: as serious as a change.
    [void]$f.Add((New-Finding 'HIGH' 'settings' '<claude>/settings' ('Claude Code settings could not be read as JSON (or are over 2 MB), so what they run could not be checked: ' + ((@($State.settingsBad) | ForEach-Object { Clean-Text ([string]$_) 60 }) -join ', ')) @()))
  }
  $now = @($State.settingsHooks | ForEach-Object { [string]$_ })
  $bad = @($State.settingsBad | ForEach-Object { [string]$_ })
  # Lines from a file that can't be read now are not "removed".
  $gone = @($was | Where-Object { $line = $_; ($now -notcontains $line) -and -not (@($bad) -contains ($line.Split(':')[0])) })
  $added = @($now | Where-Object { $was -notcontains $_ })
  if ($added.Count -or $gone.Count) {
    $d = @($added | ForEach-Object { '+ ' + $_ }) + @($gone | ForEach-Object { '- ' + $_ })
    if (-not $old -or -not $old.PSObject.Properties['settingsHooks']) {
      # A known-good list from before 1.5.0 never recorded them: shown with an
      # alert the first time, so they are never accepted unseen.
      [void]$f.Add((New-Finding 'MEDIUM' 'settings' '<claude>/settings' 'what Claude Code''s settings run, not recorded before; check each line, then accept to record them' $d))
    } else {
      $sev = $(if ($added.Count) { 'HIGH' } else { 'MEDIUM' })
      $whyS = 'what Claude Code''s settings run changed (hooks, commands, plugins, marketplaces or env variables)'
      # Windows PowerShell 5.1 and PowerShell 7 read some JSON values
      # differently (dates, decimals), so a list accepted under one can differ
      # under the other with nothing changed.
      $oldMajor = $(if ($old.PSObject.Properties['psMajor']) { [int]$old.psMajor } else { 0 })
      if ($oldMajor -and $oldMajor -ne [int]$State.psMajor) {
        $sev = 'MEDIUM'
        $whyS += '; the known-good list was accepted under PowerShell ' + $oldMajor + ' and this scan ran under ' + $State.psMajor + ', which can read some values differently. Check the lines, then accept with Windows PowerShell (powershell.exe), which the scheduled scan uses.'
      }
      [void]$f.Add((New-Finding $sev 'settings' '<claude>/settings' $whyS $d))
    }
  }
  return , $f
}

# ---------------------------------------------------------------- evaluation

function New-Finding([string]$Sev, [string]$What, [string]$Path, [string]$Why, $Details) {
  return [pscustomobject]@{ Sev = $Sev; What = $What; Path = $Path; Why = $Why; Details = @($Details) }
}

function Get-ChangeFinding([string]$What, [string]$Rel, $Cur, $Old, [string]$Full) {
  $kind = Get-Kind $Rel
  $inMarket = Test-InMarket $Rel
  $ext = Get-Ext $Rel
  $sev = 'LOW'
  $why = 'not a program or script'
  if ($inMarket) { $sev = 'HIGH'; $why = 'part of the plugin Claude Code loads at every session start' }
  elseif ([long]$Cur.size -gt $HashFullMax) { $sev = 'HIGH'; $why = 'a very large file: only its start, end, size and time are checked, so a change in the middle could go unseen' }
  elseif ($kind -eq 'program') { $sev = 'HIGH'; $why = 'a program file' }
  elseif ($kind -eq 'script') { $sev = 'MEDIUM'; $why = 'a script' }
  elseif ($kind -eq 'archive') { $sev = 'MEDIUM'; $why = 'an archive, which can carry programs' }
  $details = New-Object System.Collections.ArrayList
  if ($Old) { [void]$details.Add('size ' + $Old.size + ' -> ' + $Cur.size + ' bytes') }
  else { [void]$details.Add('size ' + $Cur.size + ' bytes') }
  $text = $null
  try { $text = Read-TextFile $Full } catch { [void]$details.Add('could not read the file: ' + $_.Exception.Message) }
  if ($null -eq $text) {
    [void]$details.Add('binary or large file, content not checked')
  } else {
    $oldLines = @()
    $haveOld = $false
    if ($Old) {
      $snap = Join-Path $SnapshotDir (Get-Disp $Rel)
      if (Test-Path -LiteralPath $snap -PathType Leaf) {
        $t0 = Read-TextFile $snap
        if ($null -ne $t0) { $oldLines = Split-Lines $t0; $haveOld = $true }
      }
      if (-not $haveOld) { [void]$details.Add('no saved copy of the earlier version, so every line was checked') }
    }
    $diff = Get-LineDiff $oldLines (Split-Lines $text)
    $hits = Get-RuleHits $diff.Added $Rel
    if ($hits.Count -gt 0) {
      if ($inMarket -or $kind -ne 'other' -or $ext -eq '.json') { $sev = 'HIGH' }
      elseif ($sev -eq 'LOW') { $sev = 'MEDIUM' }
      $shown = 0
      foreach ($h in $hits) {
        if ($shown -ge $ShowHits) { [void]$details.Add('! ... ' + ($hits.Count - $shown) + ' more'); break }
        [void]$details.Add('! line ' + $h.N + ', ' + $h.Why + ': ' + (Format-Line $h.Text))
        $shown++
      }
    }
    foreach ($n in (Get-StructureNotes $Rel $Full)) { $sev = 'HIGH'; [void]$details.Add('! ' + $n) }
    $shown = 0
    foreach ($a in $diff.Added) {
      if ($shown -ge $ShowAdded) { [void]$details.Add('+ ... ' + ($diff.Added.Count - $shown) + ' more added lines'); break }
      [void]$details.Add('+ ' + $a.N + ': ' + (Format-Line $a.Text))
      $shown++
    }
    if ($haveOld) {
      $shown = 0
      foreach ($r in $diff.Removed) {
        if ($shown -ge $ShowRemoved) { [void]$details.Add('- ... ' + ($diff.Removed.Count - $shown) + ' more removed lines'); break }
        [void]$details.Add('- ' + (Format-Line $r))
        $shown++
      }
    }
  }
  return (New-Finding $sev $What $Rel $why $details)
}

function Get-StreamFindings([string]$Rel, [string]$OldList, [string]$NewList, [string]$Full) {
  $out = New-Object System.Collections.ArrayList
  if ($NewList -eq '?') { return , $out }
  $old = Split-Streams $OldList
  $new = Split-Streams $NewList
  foreach ($name in @($new.Keys | Sort-Object)) {
    if ($old.ContainsKey($name) -and $old[$name] -eq $new[$name]) { continue }
    $verb = $(if ($old.ContainsKey($name)) { 'changed' } else { 'added' })
    if ($name -eq 'Zone.Identifier') {
      $z = Get-ZoneInfo $Full
      [void]$out.Add((New-Finding 'MEDIUM' 'stream' $Rel ('marked as downloaded from the internet (Mark of the Web ' + $verb + ')') @($z)))
    } else {
      [void]$out.Add((New-Finding 'HIGH' 'stream' $Rel ('hidden data stream ' + $name + ' ' + $verb + ' (' + $new[$name] + ' bytes)') @()))
    }
  }
  return , $out
}

function Get-AttrFinding([string]$Rel, [string]$OldAttrs, [string]$NewAttrs) {
  $oldSet = @($OldAttrs.Split(',') | Where-Object { $_ })
  $gained = @($NewAttrs.Split(',') | Where-Object { $_ -and ($oldSet -notcontains $_) })
  if ($gained.Count -eq 0) { return $null }
  return (New-Finding 'MEDIUM' 'flags' $Rel ('now marked ' + ($gained -join ' and ') + ', which hides it from a normal folder view') @())
}

function Invoke-Evaluate($Baseline, [string]$RootFull) {
  $findings = New-Object System.Collections.ArrayList
  $res = [ordered]@{ time = (Get-Now); root = $RootFull; files = 0; ignored = @(); top = 'OK'; findings = $findings; defender = ''; digest = '' }
  if (-not (Test-Path -LiteralPath $RootFull -PathType Container)) {
    [void]$findings.Add((New-Finding 'HIGH' 'missing' '' 'the watched folder is missing or was moved' @()))
  } else {
    $rootItem = Get-Item -LiteralPath $RootFull -Force
    if ((([int]$rootItem.Attributes) -band 0x400) -ne 0) {
      [void]$findings.Add((New-Finding 'HIGH' 'link' '' 'the watched folder itself is now a link to somewhere else' @()))
    }
    $inv = Get-Inventory $RootFull
    $res.files = $inv.files.Count
    $res.ignored = @($inv.ignored)
    foreach ($cc in @($inv.caseClash)) { [void]$findings.Add((New-Finding 'HIGH' 'case' $cc 'two names that differ only by case. Windows tools treat them as one file, so one can hide behind the other. Remove one; this cannot be accepted' @())) }
    $base = New-PathMap
    if ($Baseline -and $Baseline.files) { foreach ($p in @($Baseline.files.PSObject.Properties)) { $base[$p.Name] = $p.Value } }
    foreach ($rel in @($inv.files.Keys | Sort-Object)) {
      $cur = $inv.files[$rel]
      $full = $inv.paths[$rel]
      if (-not $base.ContainsKey($rel)) {
        [void]$findings.Add((Get-ChangeFinding 'added' $rel $cur $null $full))
        foreach ($f in (Get-StreamFindings $rel '' ([string]$cur.streams) $full)) { [void]$findings.Add($f) }
        $af = Get-AttrFinding $rel '' ([string]$cur.attrs)
        if ($af) { [void]$findings.Add($af) }
        continue
      }
      $old = $base[$rel]
      if ([string]$old.sha256 -ne [string]$cur.sha256) { [void]$findings.Add((Get-ChangeFinding 'changed' $rel $cur $old $full)) }
      if ([string]$old.streams -ne [string]$cur.streams) {
        foreach ($f in (Get-StreamFindings $rel ([string]$old.streams) ([string]$cur.streams) $full)) { [void]$findings.Add($f) }
      }
      $af = Get-AttrFinding $rel ([string]$old.attrs) ([string]$cur.attrs)
      if ($af) { [void]$findings.Add($af) }
    }
    foreach ($rel in @($base.Keys | Sort-Object)) {
      if ($inv.files.ContainsKey($rel)) { continue }
      if (@($inv.unreadable) -contains $rel) { continue }
      if (Test-InMarket $rel) { [void]$findings.Add((New-Finding 'HIGH' 'removed' $rel 'removed from the plugin Claude Code loads, which changes what runs' @())) }
      else { [void]$findings.Add((New-Finding 'LOW' 'removed' $rel '' @())) }
    }
    $knownLinks = New-PathMap
    if ($Baseline -and $Baseline.PSObject.Properties['reparse'] -and $Baseline.reparse) {
      foreach ($p in @($Baseline.reparse.PSObject.Properties)) { $knownLinks[$p.Name] = [string]$p.Value }
    }
    foreach ($rel in @($inv.reparse.Keys | Sort-Object)) {
      $tgt = [string]$inv.reparse[$rel]
      if (-not $knownLinks.ContainsKey($rel)) {
        [void]$findings.Add((New-Finding 'HIGH' 'link' $rel 'a junction or symbolic link, which can make this path point at files outside the folder' @('points to ' + $tgt)))
      } elseif ($knownLinks[$rel] -ne $tgt) {
        [void]$findings.Add((New-Finding 'HIGH' 'link' $rel 'a known link now points somewhere else' @(('was ' + $knownLinks[$rel]), ('now ' + $tgt))))
      }
    }
    foreach ($rel in @($knownLinks.Keys | Sort-Object)) {
      if (-not $inv.reparse.ContainsKey($rel)) { [void]$findings.Add((New-Finding 'LOW' 'removed' $rel 'a known link was removed' @())) }
    }
    foreach ($rel in @($inv.unreadable)) {
      if (Test-InMarket $rel) { [void]$findings.Add((New-Finding 'HIGH' 'unread' $rel 'could not be read, so it could not be checked; Claude Code may still load it' @())) }
      elseif (-not $base.ContainsKey($rel)) { [void]$findings.Add((New-Finding 'MEDIUM' 'unread' $rel 'new item that could not be read' @())) }
      elseif ((Get-Kind $rel) -ne 'other') { [void]$findings.Add((New-Finding 'MEDIUM' 'unread' $rel 'could not be read this scan, so it could not be checked' @())) }
      else { [void]$findings.Add((New-Finding 'LOW' 'unread' $rel 'could not be read this scan (in use?)' @())) }
    }
  }
  if ($Baseline -and $Baseline.PSObject.Properties['watchdogSha256'] -and $Baseline.watchdogSha256 -and $SelfPath) {
    if ((Get-Sha $SelfPath) -ne [string]$Baseline.watchdogSha256) {
      [void]$findings.Add((New-Finding 'HIGH' 'watchdog' '' ('the watchdog script itself changed since it was last accepted (' + $SelfPath + ')') @()))
    }
  }
  $def = Get-DefenderState $RootFull
  $res.defender = $def.realtime
  if ($def.note) { $res.defender = $def.realtime + ' (' + $def.note + ')' }
  if ($Baseline -and $Baseline.PSObject.Properties['defenderRealtime'] -and [string]$Baseline.defenderRealtime -eq 'on' -and $def.realtime -eq 'off') {
    [void]$findings.Add((New-Finding 'HIGH' 'defender' '' 'Microsoft Defender real-time protection was turned off' @()))
  }
  $seen = @()
  if ($Baseline -and $Baseline.PSObject.Properties['defenderSeen']) { $seen = @($Baseline.defenderSeen) }
  foreach ($d in @($def.detections)) {
    if ($d -and $seen -notcontains $d.Id) { [void]$findings.Add((New-Finding 'HIGH' 'defender' '' ('Defender detected ' + $d.Text) @())) }
  }
  $outside = Get-OutsideState $RootFull $Baseline
  foreach ($of in (Get-OutsideFindings $outside $Baseline)) { [void]$findings.Add($of) }
  $res['outside'] = $outside
  foreach ($f in $findings) { if ($Rank[$f.Sev] -gt $Rank[$res.top]) { $res.top = $f.Sev } }
  $res.digest = Get-StringSha ((@($findings | ForEach-Object { $_.Sev + '|' + $_.What + '|' + $_.Path + '|' + $_.Why + '|' + (@($_.Details) -join '~') }) | Sort-Object) -join "`n")
  $res['defenderDetections'] = @($def.detections | ForEach-Object { $_.Id })
  $res['inventory'] = $inv
  return $res
}

function Format-Findings($Findings) {
  $out = New-Object System.Collections.ArrayList
  foreach ($f in $Findings) {
    $p = ''
    if ($f.Path) { $p = Clean-Text (Get-Disp $f.Path) }
    [void]$out.Add(('    {0,-6} {1,-9} {2}' -f $f.Sev, $f.What, $p).TrimEnd())
    if ($f.Why) { [void]$out.Add('                     ' + (Clean-Text $f.Why 1000)) }
    foreach ($d in @($f.Details)) { if ($d) { [void]$out.Add('                     ' + (Clean-Text ([string]$d) 1000)) } }
  }
  return , $out
}

# ---------------------------------------------------------------- alerts

function Send-Alert([string]$Title, [string]$Body, [string]$Footer, [switch]$Sticky) {
  if ($DryRunAlert -or -not $OnWindows) {
    $how = $(if ($Sticky) { 'dry run, stays on screen' } else { 'dry run' })
    Write-Log ('    alert (' + $how + '): ' + $Title + ' | ' + $Body + ' | ' + $Footer)
    return $how
  }
  $toastErr = ''
  try {
    # Windows notifications need Windows PowerShell 5.1. The inner block keeps the
    # WinRT type names from failing the whole function under PowerShell 7.
    # A reminder-style notification with a Dismiss button stays on screen until
    # it is dismissed. Windows needs the button for that, so it's only added then.
    & {
      param($T, $B, $F, $AppId, $Stay)
      $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
      $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
      $open = '<toast>'
      $actions = ''
      if ($Stay) {
        $open = '<toast scenario="reminder">'
        $actions = '<actions><action content="Dismiss" arguments="dismiss" activationType="system"/></actions>'
      }
      $x = $open + '<visual><binding template="ToastGeneric"><text>' + [Security.SecurityElement]::Escape($T) +
           '</text><text>' + [Security.SecurityElement]::Escape($B) + '</text><text>' + [Security.SecurityElement]::Escape($F) +
           '</text></binding></visual>' + $actions + '</toast>'
      $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
      $doc.LoadXml($x)
      $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
    } $Title $Body $Footer $ToastAppId ([bool]$Sticky)
    if ($Sticky) { return 'notification, stays on screen' }
    return 'notification'
  } catch { $toastErr = $_.Exception.Message }
  try {
    # Fallback: a tray balloon, which works under PowerShell 7 as well.
    & {
      param($T, $B)
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $n = New-Object System.Windows.Forms.NotifyIcon
      $n.Icon = [System.Drawing.SystemIcons]::Warning
      $n.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning
      $n.BalloonTipTitle = $T
      $n.BalloonTipText = $B
      $n.Visible = $true
      $n.ShowBalloonTip(15000)
      Start-Sleep -Seconds 8
      $n.Dispose()
    } $Title ($Body + ' ' + $Footer)
    return 'balloon'
  } catch { return ('none (' + (Format-Line ($toastErr + ' / ' + $_.Exception.Message)) + ')') }
}

function Get-ShortPath([string]$Rel) {
  $parts = $Rel.Split('/')
  if ($parts.Length -le 2) { return (Get-Disp $Rel) }
  return ('...' + [IO.Path]::DirectorySeparatorChar + (Get-Disp (($parts[($parts.Length - 2)..($parts.Length - 1)]) -join '/')))
}

function Invoke-Alert($Res) {
  $alertable = @($Res.findings | Where-Object { $_.Sev -ne 'LOW' })
  if ($alertable.Count -eq 0) {
    # Back to quiet: the same change coming back later notifies again.
    if (Test-Path -LiteralPath $AlertPath) { Remove-Item -LiteralPath $AlertPath -Force }
    return ''
  }
  # Details are part of the key, so a further change to a file already reported notifies again.
  $digest = Get-StringSha ((@($alertable | ForEach-Object { $_.Sev + '|' + $_.What + '|' + $_.Path + '|' + $_.Why + '|' + (@($_.Details) -join '~') }) | Sort-Object) -join "`n")
  $prev = $null
  try { $prev = Read-Json $AlertPath } catch { }
  $repeat = $false
  $lastRemind = ''
  if ($prev -and $prev.PSObject.Properties['remindTime']) { $lastRemind = [string]$prev.remindTime }
  if ($prev -and [string]$prev.digest -eq $digest) {
    # Same findings as last time. A normal scan repeats them once a day. A scan
    # at logon or unlock always repeats them, because a notification that came
    # while you were away may never have been seen; only a reminder shown in the
    # last 10 minutes holds it back.
    $repeat = $true
    try {
      if ($Remind) {
        if ($lastRemind) {
          $lr = [datetime]::ParseExact($lastRemind, 'yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
          if (((Get-Date) - $lr).TotalMinutes -lt $RemindFloorMinutes) { return 'already reminded' }
        }
      } else {
        $last = [datetime]::ParseExact([string]$prev.time, 'yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
        if (((Get-Date) - $last).TotalHours -lt 24) { return 'already notified' }
      }
    } catch { }
  }
  $top = @($alertable | Sort-Object { - $Rank[$_.Sev] })
  $items = @($top | Select-Object -First 2 | ForEach-Object {
    $where = $(if ($_.Path) { Get-ShortPath $_.Path } else { $_.Why })
    $_.Sev + ' ' + $_.What + ' ' + $where })
  $more = ''
  if ($alertable.Count -gt 2) { $more = ' (+' + ($alertable.Count - 2) + ' more)' }
  $title = 'trailmark-watchdog: ' + $Res.top + ' in ' + (Split-Path -Leaf $Res.root)
  if ($repeat) { $title = 'trailmark-watchdog reminder: ' + $Res.top + ' still waiting in ' + (Split-Path -Leaf $Res.root) }
  # HIGH findings and anything shown at logon or unlock stay until dismissed.
  $method = Send-Alert $title (($items -join '; ') + $more) ('Details: ' + $LogPath) -Sticky:(($Res.top -eq 'HIGH') -or [bool]$Remind)
  # A notification that could not be shown is tried again on the next scan.
  if ($method -notlike 'none*') {
    if ($Remind) { $lastRemind = Get-Now }
    elseif ([string]$prev.digest -ne $digest) { $lastRemind = '' }
    Save-Json ([ordered]@{ digest = $digest; time = (Get-Now); method = $method; remindTime = $lastRemind }) $AlertPath
  }
  return $method
}

# ---------------------------------------------------------------- recording

function Get-Summary($Inv, $Def, $Outside = $null) {
  $out = New-Object System.Collections.ArrayList
  $market = 0; $scripts = 0; $archives = 0; $programs = 0; $other = 0
  foreach ($rel in $Inv.files.Keys) {
    if (Test-InMarket $rel) { $market++; continue }
    switch (Get-Kind $rel) { 'program' { $programs++ } 'script' { $scripts++ } 'archive' { $archives++ } default { $other++ } }
  }
  [void]$out.Add('  Files:        ' + $Inv.files.Count + ' (plugin ' + $market + ', scripts ' + $scripts + ', programs ' + $programs + ', archives ' + $archives + ', other ' + $other + ')')
  foreach ($rel in @($Inv.files.Keys | Sort-Object)) {
    if ((Test-InMarket $rel) -and $rel -match '(?i)/hooks/hooks\.json$') {
      [void]$out.Add('  Hooks in ' + (Get-Disp $rel) + ':')
      try {
        foreach ($h in (Get-HookLines ([IO.File]::ReadAllText($Inv.paths[$rel]) | ConvertFrom-Json))) {
          [void]$out.Add('    ' + $(if ($h.Ok) { '' } else { '! ' }) + $h.Text)
        }
      } catch { [void]$out.Add('    ! not valid JSON') }
    }
    if ($rel -ieq $MarketManifest -or ($Layout -eq $LayoutRoot -and $rel -ieq '.agents/plugins/marketplace.json')) {
      try {
        $m = [IO.File]::ReadAllText($Inv.paths[$rel]) | ConvertFrom-Json
        foreach ($p in @($m.plugins)) { if ($p) { [void]$out.Add('  Marketplace entry: ' + $p.name + ' -> ' + $(if ($p.source -is [string]) { $p.source } else { ConvertTo-Json -InputObject $p.source -Compress })) } }
      } catch { [void]$out.Add('  ! marketplace.json is not valid JSON') }
    }
  }
  $streams = @($Inv.files.Keys | Where-Object { $Inv.files[$_].streams } | Sort-Object | ForEach-Object { (Get-Disp $_) + ' [' + $Inv.files[$_].streams + ']' })
  [void]$out.Add('  Data streams: ' + $(if ($streams.Count) { $streams -join '; ' } else { 'none' }))
  $flagged = @($Inv.files.Keys | Where-Object { $Inv.files[$_].attrs } | Sort-Object | ForEach-Object { (Get-Disp $_) + ' [' + $Inv.files[$_].attrs + ']' })
  [void]$out.Add('  Hidden/system: ' + $(if ($flagged.Count) { $flagged -join '; ' } else { 'none' }))
  [void]$out.Add('  Links:        ' + $(if ($Inv.reparse.Count) { (@($Inv.reparse.Keys | Sort-Object | ForEach-Object { (Get-Disp $_) + ' -> ' + $Inv.reparse[$_] })) -join '; ' } else { 'none' }))
  [void]$out.Add('  Not watched:  ' + $(if ($Inv.ignored.Count) { (@($Inv.ignored | ForEach-Object { Get-Disp $_ })) -join '; ' } else { 'nothing' }))
  [void]$out.Add('  Defender:     real-time protection ' + $Def)
  if ($Outside) {
    $c = @($Outside.copies.Keys)
    [void]$out.Add('  Plugin cache: ' + $(if ($c.Count) { (@($c | ForEach-Object { $cp = $Outside.copies[$_]; $(if ($cp.same) { '' } else { '! ' }) + (Clean-Text (Get-Disp ('<claude>/' + $_)) 300) + $(if ($cp.Contains('link') -and $cp.link) { ' (link: ' + (Clean-Text ([string]$cp.hash) 300) + ')' } elseif ($cp.listed) { ' (listed as installed)' } elseif ($cp.same) { ' (same as the watched plugin)' } else { '' }) })) -join '; ' } else { 'no trailmark copies' }))
    if ($Outside.Contains('cacheIncomplete') -and $Outside.cacheIncomplete) { [void]$out.Add('  ! Plugin cache check stopped early: ' + (Clean-Text ([string]$Outside.cacheIncomplete) 600)) }
    if (-not $Outside.settingsReadable) { [void]$out.Add('  ! Settings not readable as JSON: ' + ((@($Outside.settingsBad) | ForEach-Object { Clean-Text ([string]$_) 60 }) -join ', ')) }
    if (@($Outside.settingsHooks).Count) { [void]$out.Add('  Settings run:'); foreach ($h in @($Outside.settingsHooks)) { [void]$out.Add('    ' + (Clean-Text ([string]$h) 700)) } }
    else { [void]$out.Add('  Settings run: nothing') }
  }
  return , $out
}

function Remove-Snapshot([string]$Dir) {
  # Only ever removes a folder this script created, recognised by its marker file.
  if (-not (Test-Path -LiteralPath $Dir)) { return }
  if (Test-Path -LiteralPath (Join-Path $Dir $SnapMarker) -PathType Leaf) { Remove-Item -LiteralPath $Dir -Recurse -Force }
}

function Save-Baseline($Res, [string]$RootFull, $Previous) {
  $inv = $Res.inventory
  if (@($inv.caseClash).Count) { throw ('names that differ only by case can''t be recorded: ' + (@($inv.caseClash) -join '; ') + '. Remove one of each pair, then accept again.') }
  # Snapshot text files first, checking each copy matches what was reviewed.
  $newSnap = $SnapshotDir + '.new'
  Remove-Snapshot $newSnap
  New-Item -ItemType Directory -Path $newSnap -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $newSnap $SnapMarker), 'trailmark-watchdog snapshot', $Utf8)
  foreach ($rel in @($inv.files.Keys)) {
    $rec = $inv.files[$rel]
    if ($rec.size -gt $SnapshotMax) { continue }
    $src = $inv.paths[$rel]
    $isText = $false
    try { $isText = ($null -ne (Read-TextFile $src)) } catch { }
    if (-not $isText) { continue }
    $dst = Join-Path $newSnap (Get-Disp $rel)
    $dstDir = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
    Copy-Shared $src $dst
    if ((Get-Sha $dst) -ne $rec.sha256) {
      Remove-Snapshot $newSnap
      throw ('the folder changed while it was being recorded (' + (Get-Disp $rel) + '). Run it again.')
    }
  }
  $files = [ordered]@{}
  foreach ($rel in @($inv.files.Keys | Sort-Object)) { $files[$rel] = $inv.files[$rel] }
  $selfSha = ''
  if ($SelfPath) { $selfSha = Get-Sha $SelfPath }
  $realtime = ([string]$Res.defender).Split(' ')[0]
  # A run that can't see Defender (PowerShell 7, -NoDefender, no access) keeps
  # what an earlier run saw, so accepting never switches off the Defender check.
  $seen = @($Res.defenderDetections)
  if ($Previous) {
    if ($realtime -eq 'unknown' -and $Previous.PSObject.Properties['defenderRealtime']) { $realtime = [string]$Previous.defenderRealtime }
    if ($Previous.PSObject.Properties['defenderSeen']) { $seen = @(@($Previous.defenderSeen) + $seen | Where-Object { $_ } | Sort-Object -Unique) }
  }
  $links = [ordered]@{}
  foreach ($k in @($inv.reparse.Keys | Sort-Object)) { $links[$k] = $inv.reparse[$k] }
  $b = [ordered]@{
    tool = 'trailmark-watchdog'; version = $WatchdogVersion; root = $RootFull; layout = $Layout; accepted = (Get-Now)
    watchdog = $SelfPath; watchdogSha256 = $selfSha
    defenderRealtime = $realtime; defenderSeen = @($seen)
    reparse = $links; files = $files
    outside = $Res.outside
  }
  Remove-Snapshot $SnapshotDir
  if (Test-Path -LiteralPath $SnapshotDir) { throw ('cannot replace ' + $SnapshotDir + ': it is not a trailmark-watchdog snapshot folder') }
  Move-Item -LiteralPath $newSnap -Destination $SnapshotDir
  Save-Json $b $BaselinePath
  if (Test-Path -LiteralPath $AlertPath) { Remove-Item -LiteralPath $AlertPath -Force }
}

function Invoke-Record($Baseline) {
  $previous = $Baseline
  # -Root naming another folder than the recorded one (the release moved):
  # record that folder afresh, the way -Init does the first time.
  # Only -Init moves it (the installer runs -Init): -Accept always compares
  # against the recorded folder and shows what changed.
  if ($Baseline -and $Root -and $Init) {
    $want = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
    try { if ((([int](Get-Item -LiteralPath $want -Force).Attributes) -band 0x400) -ne 0) { Write-Host ('  ' + $want + ' is a link; give the folder itself.'); return 2 } } catch { }
    if ($want -ine ([string]$Baseline.root).TrimEnd([char[]]@('\', '/'))) {
      Write-Host ''
      Write-Host ('! The watched folder changes from ' + $Baseline.root + ' to ' + $want + '.')
      Write-Host '  The new folder is recorded from scratch; the old one is no longer watched.'
      $Baseline = $null
      Set-Layout $LayoutNested
    }
  }
  if ($Baseline) { $rootFull = [string]$Baseline.root } else {
    if (-not $Root) { Write-Host 'Give the folder to watch with -Root.'; return 2 }
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
  }
  if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) { Write-Host ('Folder not found: ' + $rootFull); return 2 }
  $found = $(if ($SetLayout) { $SetLayout } else { Find-Layout $rootFull })
  if ($found -ne $Layout) {
    if ($Baseline -and -not $SetLayout) {
      Write-Host ''
      Write-Host ('! The folder now looks like the ' + $found + ' layout, but the known-good list says ' + $Layout + '. Keeping ' + $Layout + '.')
      Write-Host ('  If you moved the files yourself, accept with -SetLayout ' + $found + '.')
    } else {
      if ($Baseline) { Write-Host ''; Write-Host ('! The layout changes from ' + $Layout + ' to ' + $found + ' (-SetLayout).') }
      Set-Layout $found
    }
  }
  $res = Invoke-Evaluate $Baseline $rootFull
  Write-Host ''
  Write-Host ('trailmark-watchdog ' + $WatchdogVersion + ', watching ' + $rootFull)
  foreach ($l in (Get-Summary $res.inventory $res.defender $res.outside)) { Write-Host $l }
  if ($Baseline) {
    Write-Host ''
    if ($res.findings.Count -eq 0) {
      Write-Host ('Nothing changed since the known-good list was recorded (' + $Baseline.accepted + ').')
      return 0
    }
    Write-Host ('Changes since ' + $Baseline.accepted + ':')
    foreach ($l in (Format-Findings $res.findings)) { Write-Host $l }
    if ($res.top -eq 'HIGH') { Write-Host ''; Write-Host 'This includes HIGH findings. Make sure you know where each one came from before accepting.' }
    $question = 'Type yes to record the folder as it is now as known-good'
  } else {
    $question = 'Type yes to record these ' + (Get-Count $res.files 'file') + ' as known-good'
  }
  Write-Host ''
  if (-not $Yes) {
    $answer = Read-Host $question
    if ($answer -ne 'yes') { Write-Host 'Not recorded.'; return 3 }
  }
  Save-Baseline $res $rootFull $previous
  $verb = $(if ($Baseline) { 'accepted ' + (Get-Count $res.findings.Count 'finding') } else { 'recorded first known-good list' })
  Write-Log ((Get-Now) + '  ' + ('{0,-7}' -f 'record') + '  ' + $verb + ', ' + (Get-Count $res.files 'file'))
  Write-Host ('Recorded ' + (Get-Count $res.files 'file') + ' as known-good.')
  return 0
}

# ---------------------------------------------------------------- status

function Show-Status($Res, $Baseline) {
  Write-Host ''
  Write-Host ('trailmark-watchdog ' + $WatchdogVersion)
  Write-Host ('  Watching:     ' + $Res.root)
  Write-Host ('  Layout:       ' + $Layout + ' (plugin at ' + ($PluginRel -replace '/', '\') + ')')
  Write-Host ('  Known-good:   ' + (Get-Count @($Baseline.files.PSObject.Properties).Count 'file') + ', accepted ' + $Baseline.accepted)
  Write-Host ('  Scanned now:  ' + (Get-Count $Res.files 'file') + ', result ' + $Res.top)
  Write-Host ('  Defender:     real-time protection ' + $Res.defender)
  Write-Host ('  Not watched:  ' + $(if (@($Res.ignored).Count) { (@($Res.ignored | ForEach-Object { Get-Disp $_ })) -join '; ' } else { 'nothing' }))
  $a = $null
  try { $a = Read-Json $AlertPath } catch { }
  if ($a) { Write-Host ('  Last alert:   ' + $a.time + ' by ' + $a.method) }
  if ($OnWindows) {
    try {
      $t = Get-ScheduledTask -TaskName 'trailmark-watchdog' -ErrorAction Stop
      $ti = Get-ScheduledTaskInfo -TaskName 'trailmark-watchdog' -ErrorAction Stop
      Write-Host ('  Task:         ' + $t.State + ', last run ' + $ti.LastRunTime + ' (result ' + $ti.LastTaskResult + '), next run ' + $ti.NextRunTime)
    } catch { Write-Host '  Task:         not found (scans run only when started by hand)' }
    try {
      $t = Get-ScheduledTask -TaskName 'trailmark-watchdog-reminder' -ErrorAction Stop
      $ti = Get-ScheduledTaskInfo -TaskName 'trailmark-watchdog-reminder' -ErrorAction Stop
      Write-Host ('  Reminders:    ' + $t.State + ' (at logon and unlock), last run ' + $ti.LastRunTime + ' (result ' + $ti.LastTaskResult + ')')
    } catch { Write-Host '  Reminders:    no logon/unlock task' }
  }
  Write-Host ''
  if ($Res.findings.Count -eq 0) { Write-Host 'No changes since the known-good list was recorded.'; return }
  Write-Host 'Findings:'
  foreach ($l in (Format-Findings $Res.findings)) { Write-Host $l }
  Write-Host ''
  Write-Host 'Once you know where these came from, record them with -Accept.'
}

# ---------------------------------------------------------------- main

function Send-ProblemAlert([string]$Title, [string]$Msg) {
  # At most one of these a day, so a lasting problem doesn't notify every 15 minutes.
  if ($NoAlert -or $Status -or $Init -or $Accept) { return }
  try {
    $errState = $null
    try { $errState = Read-Json ($AlertPath + '.error') } catch { }
    if ($errState) {
      $t = [datetime]::ParseExact([string]$errState.time, 'yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
      if (((Get-Date) - $t).TotalHours -lt 24) { return }
    }
    $m = Send-Alert $Title $Msg ('Details: ' + $LogPath) -Sticky
    # Written directly, not through Save-Json: when saves are what's failing,
    # this marker must still be written, or the once-a-day limit stops working.
    if ($m -notlike 'none*') { [IO.File]::WriteAllText(($AlertPath + '.error'), (ConvertTo-Json -InputObject ([ordered]@{ time = (Get-Now); method = $m })), $Utf8) }
  } catch { }
}

$exitCode = 0
$lock = $null
$interactive = [bool]($Init -or $Accept -or $Status)
try {
  if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
  if ($TestAlert) {
    $m = Send-Alert 'trailmark-watchdog test' 'This is what a HIGH alert looks like: it stays until you dismiss it.' ('Details go to ' + $LogPath) -Sticky
    Write-Log ((Get-Now) + '  ' + ('{0,-7}' -f 'test') + '  test notification sent by: ' + $m)
    Write-Host ('Test notification sent by: ' + $m)
  } else {
    # A scheduled scan that finds another run going just steps aside. A command
    # you typed waits up to 30 seconds for it to finish.
    # A reminder at logon or unlock also waits, so it isn't lost to a scan in progress.
    $tries = $(if ($interactive -or $Remind) { 30 } else { 1 })
    for ($i = 0; $i -lt $tries -and -not $lock; $i++) {
      try { $lock = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
      catch { $lock = $null; if ($tries -gt 1) { Start-Sleep -Seconds 1 } }
    }
    if (-not $lock) {
      Write-Log ((Get-Now) + '  ' + ('{0,-7}' -f 'skip') + '  another trailmark-watchdog run is in progress')
      if ($interactive) { Write-Host 'Another trailmark-watchdog run is still going. Try again in a minute.'; $exitCode = 4 }
    } else {
      # A scan that started but never finished (killed at the task's time
      # limit, say) leaves its start marker newer than last-scan.json: say so
      # before trying again, in case this one is killed too. A PC that was
      # asleep or off leaves no such marker, so that never alerts.
      # The marker keeps the start of the oldest unfinished scan: a new scan
      # rewrites it only when the one before finished, so scans that keep
      # being killed age it until it alerts.
      if (-not $interactive) {
        $startPath = Join-Path $StateDir 'scan-started'
        try {
          $ls0 = $(if (Test-Path -LiteralPath $LastScanPath -PathType Leaf) { (Get-Item -LiteralPath $LastScanPath).LastWriteTime } else { [datetime]::MinValue })
          $st0 = $(if (Test-Path -LiteralPath $startPath -PathType Leaf) { (Get-Item -LiteralPath $startPath).LastWriteTime } else { [datetime]::MinValue })
          $unfinished = ($st0 -gt $ls0.AddSeconds(5))
          if ($unfinished -and ((Get-Date) - $st0).TotalMinutes -gt 30) {
            Write-Log ((Get-Now) + '  ' + ('{0,-7}' -f 'error') + '  no scan has finished since ' + $st0.ToString('yyyy-MM-dd HH:mm'))
            Send-ProblemAlert 'trailmark-watchdog scans are not finishing' ('No scan has finished since ' + $st0.ToString('yyyy-MM-dd HH:mm') + ', so changes may be going unreported. Run -Status to see why.')
          }
          if (-not $unfinished) { [IO.File]::WriteAllText($startPath, (Get-Now), $Utf8) }
        } catch { }
      }
      $baseline = Read-Json $BaselinePath
      # A list recorded before 1.6.0 has no layout: it watched the nested one.
      Set-Layout $(if ($baseline -and $baseline.PSObject.Properties['layout']) { [string]$baseline.layout } else { $LayoutNested })
      if ($Init -or $Accept) {
        if ($Accept -and -not $baseline) { Write-Host 'No known-good list yet. Run the installer, or -Init -Root <folder>.'; $exitCode = 2 }
        else { $exitCode = Invoke-Record $baseline }
      } elseif (-not $baseline) {
        Write-Log ((Get-Now) + '  ' + ('{0,-7}' -f 'error') + '  the known-good list is missing (' + $BaselinePath + ')')
        Write-Host 'No known-good list. Run install-trailmark-watchdog first.'
        Send-ProblemAlert 'trailmark-watchdog has no known-good list' ('It is missing from ' + $StateDir + ', so nothing is being checked. Run install-trailmark-watchdog again.')
        $exitCode = 2
      } else {
        $res = Invoke-Evaluate $baseline ([string]$baseline.root)
        $prev = $null
        try { $prev = Read-Json $LastScanPath } catch { }
        $same = ($prev -and [string]$prev.digest -eq $res.digest)
        $mode = $(if ($Status) { 'status' } elseif ($Remind) { 'remind' } else { 'scan' })
        $alertNote = ''
        if (-not $Status -and -not $NoAlert) {
          $m = Invoke-Alert $res
          if ($m) { $alertNote = ', alert: ' + $m }
        }
        $line = (Get-Now) + '  ' + ('{0,-7}' -f $mode) + '  ' + ('{0,-6}' -f $res.top) + '  ' + (Get-Count $res.files 'file')
        if (@($res.ignored).Count) { $line += ', ' + @($res.ignored).Count + ' not watched' }
        if ($res.findings.Count -eq 0) { $line += ', no changes' }
        elseif ($same) { $line += ', same ' + (Get-Count $res.findings.Count 'finding') + ' as the last scan' }
        else { $line += ', ' + (Get-Count $res.findings.Count 'finding') }
        $line += $alertNote
        $logLines = @($line)
        if ($res.findings.Count -gt 0 -and -not $same) { foreach ($l in (Format-Findings $res.findings)) { $logLines += $l } }
        Write-Log $logLines
        $saved = [ordered]@{ time = $res.time; root = $res.root; files = $res.files; top = $res.top; digest = $res.digest; defender = $res.defender; ignored = @($res.ignored); findings = @($res.findings) }
        Save-Json $saved $LastScanPath
        # A scan that got this far clears an earlier problem notice, so a new problem notifies straight away.
        if (Test-Path -LiteralPath ($AlertPath + '.error')) { Remove-Item -LiteralPath ($AlertPath + '.error') -Force -ErrorAction SilentlyContinue }
        if ($Status) { Show-Status $res $baseline }
        if ($res.findings.Count -gt 0) { $exitCode = 1 }
      }
    }
  }
} catch {
  $msg = Format-Line ($_.Exception.Message + ' at line ' + $_.InvocationInfo.ScriptLineNumber)
  Write-Log ((Get-Now) + '  ' + ('{0,-7}' -f 'error') + '  ' + $msg)
  Write-Host ('trailmark-watchdog error: ' + $msg)
  Send-ProblemAlert 'trailmark-watchdog could not finish a scan' $msg
  $exitCode = 2
} finally {
  if ($lock) { $lock.Dispose() }
}
exit $exitCode
