'use strict';
// Which Bash commands count as milestones, and for a commit, which folder it
// ran in.
//
// isMilestoneCommand is the cheap test. The launcher runs it before any git
// work, so a command that isn't a milestone costs only a Node start, and
// hook-milestone.js runs it again. The `if` patterns in hooks.json are a
// coarser pre-filter still.
//
// commitSites reads the command the way the shell would, far enough to say
// where each `git commit` in it ran: cd, pushd and popd (Set-Location,
// Push-Location and Pop-Location for PowerShell), git -C, subshells,
// pipelines, command substitution, heredocs, quoting, bash -c and
// powershell -Command, shell functions (with their arguments, return and
// exit), scripts fed to a shell on stdin or written to a file by the same
// command, and PowerShell assignments and stored script blocks.
// A commit named only inside a quoted heredoc, a quoted string or a comment
// is not a commit. Code that may not run (an if branch, a loop body, a script block
// handed to a cmdlet) still counts for the commits in it, but a folder change
// inside it leaves the folder unknown afterwards. A folder it can't know for
// sure is reported as unresolved, never guessed: reading HEAD from the wrong
// folder is the bug 0.3.3 fixes.

const os = require('os');
const path = require('path');

// One shell word: plain characters and quoted runs, so "E:/Code/Unity Projects"
// or user.name="Ann B" count as one word. The alternatives can't overlap, which
// keeps matching linear.
const WORD = String.raw`(?:[^\s"']|"[^"]*"|'[^']*')+`;

// git, up to six global options with an optional value each (-C <path>,
// -c <key=value>, --no-pager, ...), then the commit subcommand. commit-tree and
// commit-graph don't count.
const COMMIT = new RegExp(String.raw`\bgit\b(?:\s+-${WORD}(?:\s+${WORD})?){0,6}\s+commit\b(?!-)`);

// gh pr merge, with the rest of that shell segment (up to a pipe, ; or &).
// A help call (--help or -h in that segment) merges nothing, so it doesn't
// count. Quoted text is blanked first, so a title like "how -h works" can't
// read as a flag.
const PR_MERGE = /\bgh\s+pr\s+merge\b([^|;&\n]*)/g;
const HELP = /(?:^|\s)(?:--help|-h)(?=\s|$)/;

function isPrMerge(c) {
  const bare = c.replace(/"[^"]*"|'[^']*'/g, '""');
  for (const m of bare.matchAll(PR_MERGE)) if (!HELP.test(m[1])) return true;
  return false;
}

function isMilestoneCommand(kind, command) {
  const c = typeof command === 'string' ? command : '';
  if (kind === 'commit') return COMMIT.test(c);
  if (kind === 'pr-merge') return isPrMerge(c);
  return kind === 'subagent';
}

// ---------- where a commit ran ----------

// Reasons a commit's folder is left unresolved. Fixed words, so no command
// text reaches the log through them.
const WHY = {
  variable: 'unknown-folder', // a variable, a substitution, a glob, cd -, a branch or loop that changed folder, a Git Bash mount like /tmp, or a start folder that isn't known
  otherRepo: 'other-repo', // --git-dir, --work-tree, or GIT_DIR / GIT_WORK_TREE set
  unrecognized: 'unrecognized', // git commit in a form not followed (cmd /c, python, a background job)
  nested: 'nested', // shells inside shells, too deep to follow
  tooLong: 'too-long', // the command took too long to read
};

const MAX_DEPTH = 4;
const MAX_UNRESOLVED = 8;
const MAX_LEN = 1024 * 1024;
const STACK_MAX = 32;
const TOO_LONG = Symbol('too long');

const loc0 = (cur) => ({ cur, prev: null, stack: [] });
const copyLoc = (l) => ({ cur: l.cur, prev: l.prev, stack: l.stack.slice() });
const sameLoc = (a, b) => a.cur === b.cur && a.stack.length === b.stack.length && a.stack.every((x, i) => x === b.stack[i]);
// After code that may or may not have run changed the folder.
const unknownLoc = (l) => ({ cur: null, prev: null, stack: l.stack.map(() => null) });

function baseName(word) {
  const parts = String(word).split(/[\\/]/);
  return parts[parts.length - 1];
}

function isGitName(word, platform) {
  const b = baseName(word);
  return platform === 'win32' ? /^git(?:\.exe)?$/i.test(b) : b === 'git';
}

function tick(ctx) {
  if ((++ctx.steps & 511) === 0 && Date.now() > ctx.deadline) throw TOO_LONG;
}

// Absolute folder from a path written in the command, or null when it can't
// be known. `msys` is Git Bash on Windows, where /e/x means E:\x.
function resolveDir(cur, p, ctx, { msys = false, psRoot = false } = {}) {
  if (p === null || p === undefined) return null;
  const home = ctx.home;
  let s = String(p);
  if (s === '~' || s.startsWith('~/') || (ctx.platform === 'win32' && s.startsWith('~\\'))) {
    if (!home) return null;
    s = home + s.slice(1);
  }
  if (ctx.platform !== 'win32') {
    if (s.startsWith('/')) return path.posix.resolve(s);
    return cur ? path.posix.resolve(cur, s) : null;
  }
  const W = path.win32;
  if (msys) {
    const m = /^\/(?:cygdrive\/)?([a-zA-Z])(\/.*)?$/.exec(s);
    if (m) return W.resolve(m[1].toUpperCase() + ':\\' + (m[2] || '').replace(/^\/+/, ''));
    if (/^\/\/[^/]/.test(s)) return W.resolve(s); // //server/share
    if (s.startsWith('/')) return null; // /tmp, /usr: where Git Bash puts them isn't known here
  }
  if (/^[a-zA-Z]:[\\/]/.test(s)) return W.resolve(s);
  if (/^[a-zA-Z]:/.test(s)) return null; // E: or E:rel, the drive's own current folder
  if (/^[\\/]{2}[^\\/]/.test(s)) return W.resolve(s);
  if (/^[\\/]/.test(s)) {
    if (!psRoot || !cur) return null;
    return W.resolve(W.parse(cur).root, s.replace(/^[\\/]+/, ''));
  }
  if (/^[^\\/:]+:/.test(s)) return null; // another provider drive (HKLM:, Env:, Temp:)
  return cur ? W.resolve(cur, s) : null;
}

// git commit options that take the next word as their value, unless written
// --opt=value or, for short ones, -mvalue.
const COMMIT_VALUE_SHORT = new Set(['m', 'F', 'C', 'c', 't']);
const COMMIT_VALUE_LONG = ['--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--author', '--date', '--cleanup', '--trailer', '--template', '--pathspec-from-file'];

// Whether `git commit <rest>` only prints (help, a dry run): a value such as
// the message in -m '--dry-run' doesn't count.
function commitOnlyPrints(rest) {
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    const v = w.v;
    if (w.dyn) continue;
    if (v === '--') break;
    if (v === '-h' && i === 0) return true;
    if (v.startsWith('--')) {
      const eq = v.indexOf('=');
      const name = eq < 0 ? v : v.slice(0, eq);
      if (name.length >= 4 && '--dry-run'.startsWith(name) && name.startsWith('--dr')) return true;
      if (name.length >= 4 && '--help'.startsWith(name) && name.startsWith('--he')) return true;
      if (eq < 0) {
        const hits = COMMIT_VALUE_LONG.filter(o => o.startsWith(name) && name.length >= 4);
        if (hits.length === 1) i++;
      }
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      for (let j = 1; j < v.length; j++) {
        const ch = v[j];
        if (COMMIT_VALUE_SHORT.has(ch)) { if (j === v.length - 1) i++; break; }
        if (ch === 'S' || ch === 'u') break; // optional value, written attached
      }
    }
  }
  return false;
}

// git's global options, then the subcommand. Shared by both shells.
function gitSite(args, dir, ctx, { otherRepo = false, inLoop = false, resolve }) {
  const out = ctx.out;
  let i = 0;
  let unknown = dir === null;
  while (i < args.length) {
    const a = args[i];
    const v = a.v;
    if (a.dyn && /^-/.test(v)) { i++; continue; }
    if (v === '-C') {
      const p = args[i + 1];
      if (!p) return;
      if (p.dyn || p.glob) unknown = true;
      else if (!unknown) { dir = resolve(dir, p.v); if (dir === null) unknown = true; }
      i += 2; continue;
    }
    if (v === '-c' || v === '--config-env' || v === '--namespace' || v === '--super-prefix' || v === '--attr-source' || v === '--list-cmds') { i += 2; continue; }
    if (/^--(?:git-dir|work-tree)$/.test(v)) { otherRepo = true; i += 2; continue; }
    if (/^--(?:git-dir|work-tree)=/.test(v)) { otherRepo = true; i++; continue; }
    if (/^--(?:exec-path|html-path|man-path|info-path|version|help)$/.test(v) || v === '-h' || v === '-v') return; // prints and exits
    if (v.startsWith('-')) { i++; continue; }
    break;
  }
  const sub = args[i];
  if (!sub) return;
  if (sub.dyn) { if (/commit/.test(sub.v)) out.unresolved.push(WHY.variable); return; }
  if (sub.v !== 'commit') return;
  if (commitOnlyPrints(args.slice(i + 1))) return;
  if (otherRepo || ctx.gitVars.size) out.unresolved.push(WHY.otherRepo);
  else if (unknown || dir === null) out.unresolved.push(WHY.variable);
  else { out.sites.push(dir); if (inLoop) out.loops.push(dir); }
}

// A command not followed that may still run git commit: a separate git word
// followed by commit, or a word whose text is a git commit command
// (cmd /c "git commit ...", python -c "...git commit...").
function mentionsCommit(words, from, platform) {
  if (COMMIT.test(words.slice(from, from + 64).map(w => w.v).join(' '))) return true;
  for (let k = from; k < words.length; k++) {
    if (COMMIT.test(words[k].v)) return true;
    if (words[k].dyn || !isGitName(words[k].v, platform)) continue;
    for (let j = k + 1; j < words.length && j <= k + 13; j++) {
      const v = words[j].v;
      if (v === 'commit') return true;
      if (!v.startsWith('-') && !(j > k + 1 && /^-[Cc]$/.test(words[j - 1].v))) break;
    }
  }
  return false;
}

// ---------- Bash ----------

const BASH_META = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
const BASH_WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'env', 'sudo', 'nice', 'timeout', 'xargs', 'stdbuf', 'winpty', 'ionice', 'chronic']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'bash.exe', 'sh.exe']);
const PWSH = new Set(['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe']);
// Commands that print or search text: "git commit" in their arguments is text.
// awk is not one: its system() runs commands.
const BASH_TEXT = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'cat', 'tac', 'head', 'tail',
  'less', 'more', 'wc', 'sort', 'uniq', 'cut', 'tr', 'tee', 'jq', 'yq', 'diff', 'cmp', 'comm', 'ls', 'test', '[', 'true', 'false', ':', 'read',
  'basename', 'dirname', 'realpath', 'readlink', 'stat', 'file', 'which', 'type', 'man', 'column', 'fold', 'fmt', 'nl', 'paste', 'rev', 'gh', 'alias']);
const BASH_DECLARE = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);
// "$@", "$1": inside a function (or after set --), the words it was called
// with. Quoted ("$1") each stays one word; unquoted it is split again on
// blanks, as the shell does, and "$*" joins them into one.
const POSITIONAL = /^\$(?:[@*1-9]|\{[@*1-9]\})$/;

function expandArgs(words, fargs) {
  if (!words.some(w => w.dyn && POSITIONAL.test(w.v))) return words;
  const out = [];
  // An expanded word is never an assignment or a reserved word.
  const add = (a) => out.push({ ...a, assign: false, lit: false });
  for (const w of words) {
    if (!w.dyn || !POSITIONAL.test(w.v)) { out.push(w); continue; }
    const key = w.v.replace(/[${}]/g, '');
    const all = key === '@' || key === '*';
    const got = all ? fargs : fargs.slice(Number(key) - 1, Number(key));
    if (w.q && key === '*') { add({ v: got.map(a => a.v).join(' '), dyn: got.some(a => a.dyn), glob: false }); continue; }
    for (const a of got) {
      if (w.q || a.dyn) add(a);
      else for (const piece of a.v.split(/[ \t\n]+/)) if (piece) add({ ...a, v: piece, glob: a.glob || /[*?[]/.test(piece) });
    }
    if (!got.length && w.q && !all) add({ v: '', dyn: false, glob: false });
  }
  for (const p of ['stdin', 'outFile', 'inFile', 'append']) if (words[p] !== undefined) out[p] = words[p];
  return out;
}
// Commands whose output to a file is known text (see command()).
const TEXT_WRITERS = new Set(['cat', 'echo', 'printf', 'tee']);
// Reserved words a { } group may follow.
const GROUP_AFTER = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'time']);
// What a subshell or a child shell takes from its parent and can't hand back:
// functions, GIT_DIR / GIT_WORK_TREE set (gitVars), CDPATH, shopt lastpipe,
// the positional arguments. Files it writes stay written.
function saveScope(ctx) {
  return { funcs: new Map(ctx.funcs), gitVars: new Set(ctx.gitVars), cdpath: ctx.cdpath, lastpipe: ctx.lastpipe, files: ctx.files, fargs: ctx.fargs };
}
function restoreScope(ctx, s, files = false) {
  ctx.funcs = s.funcs; ctx.gitVars = s.gitVars; ctx.cdpath = s.cdpath; ctx.lastpipe = s.lastpipe; ctx.fargs = s.fargs;
  if (files) ctx.files = s.files;
}

// The text a script record holds: { body, dyn }, { pending: true } while a
// heredoc in it isn't read yet, or null. Records: a heredoc or herestring
// { body, dyn, heredoc? }, echo or printf output { body, dyn }, a file
// appended to { parts }, or a file changed by something else
// { unknown, stale: what it held before }, read as text only.
function recText(rec, depth = 0) {
  if (!rec || depth > 25) return null;
  if (rec.unknown) {
    const st = recText(rec.stale, depth + 1);
    return { body: st && !st.pending ? st.body : '', dyn: true };
  }
  if (rec.parts) {
    let body = '';
    let dyn = false;
    for (const part of rec.parts) {
      const t = recText(part, depth + 1);
      if (!t) continue;
      if (t.pending) return t;
      body += t.body; dyn = dyn || t.dyn;
    }
    return { body, dyn };
  }
  if (rec.body === null || rec.body === undefined) return rec.dyn ? { body: '', dyn: true } : { pending: true };
  return { body: rec.heredoc && rec.body ? rec.body + '\n' : rec.body, dyn: !!rec.dyn };
}

// Backslash escapes as echo -e and printf read them. stop: echo's \c.
function unescapeC(t, forEcho) {
  const map = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', E: '\x1b', '\\': '\\' };
  if (!forEcho) { map['"'] = '"'; map["'"] = "'"; }
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== '\\' || i + 1 >= t.length) { out += c; continue; }
    const n = t[++i];
    if (Object.prototype.hasOwnProperty.call(map, n)) { out += map[n]; continue; }
    if (n === 'c' && forEcho) return { text: out, stop: true };
    const oct = forEcho ? /^0[0-7]{0,3}/.exec(t.slice(i, i + 4)) : /^[0-7]{1,3}/.exec(t.slice(i, i + 3));
    if (oct) { out += String.fromCharCode(parseInt(forEcho ? oct[0].slice(1) || '0' : oct[0], 8) & 255); i += oct[0].length - 1; continue; }
    const hex = n === 'x' && /^[0-9a-fA-F]{1,2}/.exec(t.slice(i + 1, i + 3));
    if (hex) { out += String.fromCharCode(parseInt(hex[0], 16)); i += hex[0].length; continue; }
    out += '\\' + n;
  }
  return { text: out, stop: false };
}

// What echo or printf prints, or null. Words that depend on a variable make
// it known only as text to search for a commit (dyn).
function echoText(name, args) {
  if (args.some(a => a.dyn)) return { body: args.map(a => a.v).join(' '), dyn: true };
  if (name === 'echo') {
    let k = 0;
    let nl = true;
    let esc = false;
    for (; k < args.length && /^-[neE]+$/.test(args[k].v); k++) {
      for (const o of args[k].v.slice(1)) { if (o === 'n') nl = false; else esc = o === 'e'; }
    }
    let body = args.slice(k).map(a => a.v).join(' ');
    if (esc) { const r = unescapeC(body, true); body = r.text; if (r.stop) nl = false; }
    return { body: body + (nl ? '\n' : ''), dyn: false };
  }
  let k = 0;
  if (args[k] && args[k].v === '--') k++;
  if (!args[k] || /^-v/.test(args[k].v)) return null; // printf -v var: prints nothing
  const fmt = args[k].v;
  const rest = args.slice(k + 1).map(a => a.v);
  // %s, %b, %d and %% are worked out; any other conversion leaves the text
  // known only to search.
  const conv = /%(?:%|[-+ #0]*\d*(?:\.\d+)?([a-zA-Z]))/g;
  let m;
  while ((m = conv.exec(fmt))) if (m[1] && !/^[sbdi]$/.test(m[1])) return { body: [fmt, ...rest].join(' '), dyn: true };
  let out = '';
  let used = 0;
  for (let round = 0; round < 1000; round++) {
    let took = 0;
    out += unescapeC(fmt.replace(conv, (all, c) => {
      if (!c) return '%';
      const v = used + took < rest.length ? rest[used + took] : '';
      took++;
      return c === 'b' ? v : v.replace(/\\/g, '\\\\');
    }), false).text;
    used += took;
    if (!took || used >= rest.length) break;
  }
  return { body: out, dyn: false };
}

// Commands that only read the files named in them (sed without -i, sort
// without -o).
const FILE_READERS = new Set(['cat', 'tac', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ls', 'stat', 'file',
  'diff', 'cmp', 'comm', 'test', '[', 'echo', 'printf', 'chmod', 'chown', 'touch', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'bash.exe', 'sh.exe',
  'source', '.', 'basename', 'dirname', 'realpath', 'readlink', 'which', 'type', 'md5sum', 'sha1sum', 'sha256sum', 'cksum', 'od', 'xxd', 'hexdump',
  'nl', 'uniq', 'cut', 'tr', 'jq', 'yq', 'column', 'fold', 'fmt', 'paste', 'rev', 'tee', 'cd', 'pushd', 'popd', 'true', 'false', ':', 'read',
  'export', 'declare', 'typeset', 'local', 'readonly', 'unset', 'shift', 'set', 'eval', 'exit', 'return', 'shopt', 'sed', 'sort', 'alias', 'gh']);
// git subcommands that rewrite files in the working tree.
const GIT_TREE_WRITERS = new Set(['checkout', 'switch', 'restore', 'reset', 'stash', 'apply', 'am', 'pull', 'merge', 'rebase', 'cherry-pick', 'revert', 'mv', 'rm', 'clean']);

// How a script read again runs: 'same' (eval), 'func' (a function call or a
// sourced file, where return ends it), 'subshell' (backticks, a function
// whose body is ( )), 'child' (another shell process).
const SHARED_MODES = new Set(['same', 'func']);

// Reads `text` again with a new parser, from `loc`. Returns the folder it
// ends in; the caller decides whether that counts (eval, a function, a
// sourced file) or not (a subshell or child shell). fargs: the words a
// function or script was called with.
function subParse(parent, text, loc, Kind, inLoop, mode, fargs) {
  const ctx = parent.ctx;
  parent.childStop = null;
  if (parent.stopped) return loc;
  if (parent.depth >= MAX_DEPTH * 4 || ctx.level >= MAX_DEPTH) { ctx.out.unresolved.push(WHY.nested); return unknownLoc(loc); }
  ctx.level++;
  const shared = SHARED_MODES.has(mode);
  const scope = shared ? null : saveScope(ctx);
  if (mode === 'child') { ctx.funcs = new Map(); ctx.lastpipe = false; }
  const fa = ctx.fargs;
  ctx.fargs = fargs !== undefined ? fargs : (mode === 'child' ? null : ctx.fargs);
  try {
    const p = new Kind(text, ctx, loc, parent.depth + 1, inLoop);
    p.shared = shared && parent.shared && parent.subDepth === 0;
    p.fn = mode === 'func' || (mode === 'same' && parent.fn === true);
    p.list('');
    let end = p.loc;
    if (Array.isArray(p.retLocs) && p.retLocs.some(l => !sameLoc(l, end))) end = unknownLoc(end);
    if (shared) parent.childStop = p.stopReason || null;
    return end;
  } finally {
    ctx.level--;
    if (scope) restoreScope(ctx, scope);
    ctx.fargs = fa;
  }
}

class Bash {
  // inLoop: this script runs inside a loop of the code that started it.
  constructor(src, ctx, loc, depth, inLoop = false) {
    this.s = src;
    this.i = 0;
    this.ctx = ctx;
    this.loc = loc;
    this.depth = depth;
    this.heredocs = [];
    this.deferred = [];
    this.cond = [];
    this.loopDepth = 0;
    this.baseLoop = inLoop;
    // shared: a folder change here is the top-level shell's own (not a
    // subshell's or a child shell's). subDepth counts the ( ) and $( ) this
    // parser is inside.
    this.shared = true;
    this.subDepth = 0;
    // A { } group that may not run (after && or ||, in a pipeline).
    this.condNest = 0;
    // return and exit: fn is true in a function body or a sourced file.
    this.fn = false;
    this.stopped = false;
    this.stopReason = null;
    this.pendingStop = null;
    this.retLocs = [];
    this.aoPos = 0;
  }

  get msys() { return this.ctx.platform === 'win32'; }
  get inLoop() { return this.baseLoop || this.loopDepth > 0; }
  // Code here may not run: inside if / case / a loop, a { } group after && or
  // ||, or after && or || itself.
  get maybeHere() { return this.cond.length > 0 || this.condNest > 0 || this.aoPos > 0; }
  resolve(cur, p) { return resolveDir(cur, p, this.ctx, { msys: this.msys }); }

  // ( ), $( ), <( ): runs in a subshell, which keeps its folder, functions
  // and exports to itself, and whose exit or return ends only itself.
  inSubshell(fn) {
    const ctx = this.ctx;
    const saved = copyLoc(this.loc);
    const scope = saveScope(ctx);
    const st = [this.stopped, this.stopReason, this.pendingStop, this.retLocs];
    this.subDepth++;
    this.retLocs = [];
    try { this.nest(fn); } finally {
      this.subDepth--;
      this.loc = saved;
      restoreScope(ctx, scope);
      [this.stopped, this.stopReason, this.pendingStop, this.retLocs] = st;
    }
  }

  stop(reason) { this.stopped = true; this.stopReason = reason; }

  // The shell's own folder may change here, even if to where it is.
  moved() { if (this.shared && this.subDepth === 0) this.ctx.topMoved = true; }

  // Commands until EOF or the closing character (')' for a subshell or $( ),
  // '}' for a group).
  list(closer) {
    const s = this.s;
    const ctx = this.ctx;
    let words = [];
    let redirect = '';
    let pipeStart = copyLoc(this.loc);
    let inPipe = false;
    let pipeOut = null; // what the previous pipeline element writes, when it's a known text
    let orBase = null;
    let funcName = '';
    // An and-or list (a && b || c): a folder change after an element that
    // may fail (test -d x && cd x; ...) may not have happened, so the folder
    // is unknown after the list. Elements that are themselves cd, pushd or
    // popd don't count as may-fail: cd /a && cd sub; ... is taken as done.
    let aoIndex = 0;
    let aoMayFail = false;
    let aoCondChanged = false;
    let locOnly = true;
    const endCommand = () => {
      // > f.sh on its own empties the file.
      if (!words.length && words.outFile && !words.append && !this.stopped) this.writeFile(words.outFile, { body: '', dyn: false });
      if (words.length && !this.stopped) {
        this.lastWasLoc = false;
        this.aoPos = aoIndex;
        const r = this.command(words, inPipe ? pipeOut : null);
        if (!this.lastWasLoc) locOnly = false;
        pipeOut = r || null;
      } else pipeOut = null;
      words = []; redirect = '';
    };
    const endPipeline = (kind) => {
      endCommand();
      const piped = inPipe;
      const pos = aoIndex;
      if ((inPipe && !ctx.lastpipe) || kind === 'bg') this.loc = copyLoc(pipeStart);
      inPipe = false;
      pipeOut = null;
      if (orBase && !sameLoc(orBase, this.loc)) this.loc = unknownLoc(this.loc); // cd a || cd b: either one
      orBase = null;
      if (aoIndex > 0 && aoMayFail && !sameLoc(pipeStart, this.loc)) aoCondChanged = true;
      if (piped || !locOnly) aoMayFail = true;
      locOnly = true;
      if (kind === 'and' || kind === 'or') aoIndex++;
      else {
        if (aoCondChanged) this.loc = unknownLoc(this.loc);
        aoIndex = 0; aoMayFail = false; aoCondChanged = false;
      }
      pipeStart = copyLoc(this.loc);
      groupStop = null;
      this.settleStop(pos, piped || kind === 'bg');
      if (this.shared && this.subDepth === 0 && !sameLoc(this.loc, ctx.startLoc)) ctx.topMoved = true;
    };
    // { ...; }: runs in this shell, but only maybe after && or || or in a
    // pipeline. In a pipeline or in the background it is a subshell, so an
    // exit or return in it ends only the group: known at once when a | comes
    // before it, and when one comes after it (or a &), at that point.
    let groupStop = null;
    const stopState = () => [this.stopped, this.stopReason, this.pendingStop, this.retLocs.slice()];
    const setStop = (st) => { [this.stopped, this.stopReason, this.pendingStop, this.retLocs] = st; };
    const group = () => {
      const maybe = aoIndex > 0 || inPipe;
      const st = stopState();
      if (maybe) this.condNest++;
      try { this.nest(() => this.list('}')); } finally { if (maybe) this.condNest--; }
      locOnly = false;
      if (inPipe) setStop(st);
      else groupStop = st;
    };
    const unGroup = () => { if (groupStop) { setStop(groupStop); groupStop = null; } };
    const maybeDef = () => this.cond.length > 0 || this.condNest > 0 || aoIndex > 0;
    // [then|else|do ...] [function] name: a function definition may follow.
    // kw: the function keyword is there, so name { ... } defines one too.
    const fnHead = () => {
      let j = 0;
      while (j < words.length && words[j].lit && GROUP_AFTER.has(words[j].v)) j++;
      const lead = j;
      const kw = j < words.length && words[j].lit && words[j].v === 'function';
      if (kw) j++;
      return j === words.length - 1 && !words[j].dyn ? { lead, kw } : null;
    };
    // The reserved words before a definition still count (else switches the
    // branch).
    const reserved = (fh) => {
      const lead = words.slice(0, fh.lead);
      words = [];
      if (lead.length && !this.stopped) { this.aoPos = aoIndex; this.command(lead, null); }
    };
    while (this.i < s.length) {
      tick(ctx);
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\r') { this.i++; continue; }
      if (c === '\\' && s[this.i + 1] === '\n') { this.i += 2; continue; }
      if (c === '#') { while (this.i < s.length && s[this.i] !== '\n') this.i++; continue; }
      if (c === '\n') { this.i++; endCommand(); this.readHeredocs(); endPipeline('end'); continue; }
      if (c === ')') {
        this.i++;
        if (closer === ')') { endPipeline('end'); return ')'; }
        endPipeline('end'); continue; // a case pattern, or a stray one
      }
      if (c === ';') {
        const arm = s[this.i + 1] === ';';
        this.i += arm ? 2 : 1;
        if (s[this.i] === '&') this.i++;
        endPipeline('end');
        if (arm) this.condBranch('case');
        continue;
      }
      if (c === '&') {
        if (s[this.i + 1] === '&') { this.i += 2; endPipeline('and'); continue; }
        if (s[this.i + 1] === '>') { const app = s[this.i + 2] === '>'; this.i += app ? 3 : 2; redirect = app ? 'append' : 'out'; continue; }
        this.i++; unGroup(); endPipeline('bg'); continue;
      }
      if (c === '|') {
        if (s[this.i + 1] === '|') {
          this.i += 2;
          endPipeline('or');
          orBase = copyLoc(this.loc);
          continue;
        }
        this.i += s[this.i + 1] === '&' ? 2 : 1;
        unGroup();
        endCommand();
        this.loc = copyLoc(pipeStart);
        inPipe = true;
        continue;
      }
      if (c === '(') {
        this.i++;
        const fh = fnHead();
        if (fh) {
          // name() { ... }: a function definition, not a call.
          let j = this.i; while (s[j] === ' ' || s[j] === '\t') j++;
          if (s[j] === ')') { this.i = j + 1; funcName = words[words.length - 1].v; reserved(fh); continue; }
        }
        if (s[this.i] === '(') { this.skipBalanced('(', ')', 1); continue; } // (( arithmetic ))
        if (funcName) { this.defineFunction(funcName, ')', maybeDef()); funcName = ''; continue; }
        this.inSubshell(() => this.list(')'));
        locOnly = false;
        continue;
      }
      if ((c === '<' || c === '>') && s[this.i + 1] === '(') {
        // Process substitution: a word that runs a list in a subshell.
        this.i += 2;
        this.inSubshell(() => this.list(')'));
        if (!redirect) words.push({ v: '', dyn: true, glob: false, lit: false, assign: false });
        redirect = '';
        continue;
      }
      if (c === '<' || c === '>' || (/[0-9]/.test(c) && /^[0-9]+[<>]/.test(s.slice(this.i, this.i + 12)))) {
        const fdAt = this.i;
        while (/[0-9]/.test(s[this.i])) this.i++;
        const fd = s.slice(fdAt, this.i);
        if (s.startsWith('<<<', this.i)) { this.i += 3; redirect = 'herestring'; continue; }
        if (s.startsWith('<<', this.i)) {
          this.i += 2;
          let strip = false;
          if (s[this.i] === '-') { strip = true; this.i++; }
          while (s[this.i] === ' ' || s[this.i] === '\t') this.i++;
          const d = this.readWord(true);
          // A quoted delimiter ('EOF', "EOF", \EOF) keeps the body as it is;
          // otherwise $ and ` in it are expanded first.
          const rec = { delim: d.v, strip, body: null, quoted: !d.lit, dyn: false, heredoc: true };
          this.heredocs.push(rec);
          words.stdin = rec;
          continue;
        }
        const op = s[this.i];
        this.i++;
        const two = s[this.i] || '';
        if (/[>&|]/.test(two)) this.i++;
        if (s[this.i - 1] === '&' && /[0-9-]/.test(s[this.i] || '')) { while (/[0-9-]/.test(s[this.i] || '')) this.i++; continue; }
        // What a command writes to its standard output, or reads on its input.
        const std = fd === '' || (op === '>' ? fd === '1' : fd === '0');
        if (op === '>' && std) redirect = two === '>' ? 'append' : 'out';
        else if (op === '<' && std && two !== '>') redirect = 'in';
        else redirect = 'file';
        continue;
      }
      const w = this.readWord(false);
      if (redirect) {
        if (redirect === 'herestring') words.stdin = { body: w.v, dyn: w.dyn };
        else if (redirect === 'out' || redirect === 'append') { words.outFile = w; words.append = redirect === 'append'; }
        else if (redirect === 'in') words.inFile = w;
        redirect = '';
        continue;
      }
      const fk = !funcName && w.lit && w.v === '{' ? fnHead() : null;
      if (w.lit && w.v === '{' && (funcName || (fk && fk.kw))) {
        const name = funcName || words[words.length - 1].v;
        if (!funcName) reserved(fk);
        funcName = '';
        this.defineFunction(name, '}', maybeDef());
        continue;
      }
      funcName = '';
      if (w.lit && w.v === '{' && words.every(x => x.lit && GROUP_AFTER.has(x.v))) {
        // A group at the start of a command, also right after then, do, else,
        // ! or time.
        if (words.length && !this.stopped) { this.aoPos = aoIndex; this.command(words, null); }
        words = [];
        group();
        continue;
      }
      if (!words.length && w.lit && w.v === '}') { if (closer === '}') { endPipeline('end'); return '}'; } continue; }
      words.push(w);
    }
    endCommand();
    this.readHeredocs();
    endPipeline('end');
    return '';
  }

  // A return or exit that ran, once its pipeline and and-or position are
  // known. One that surely ran ends this script; one that may have run (in an
  // if, after && or ||) leaves the folder at that point as a possible end.
  // In a pipeline or in the background it ends only that subshell.
  settleStop(pos, piped) {
    const stop = this.pendingStop;
    this.pendingStop = null;
    if (!stop || piped || this.stopped) return;
    const sure = pos === 0 && this.cond.length === 0 && this.condNest === 0;
    if (stop === 'exit') { if (sure) this.stop('exit'); return; }
    if (!this.fn) return; // return outside a function is an error, and the script goes on
    if (sure) this.stop('return');
    else this.retLocs.push(copyLoc(this.loc));
  }

  // A function body runs only when the function is called: its text is kept
  // and read again at each call, in the caller's folder. One defined where it
  // may not run (in an if, after &&) is kept beside what was there before.
  defineFunction(name, closer, maybe) {
    const ctx = this.ctx;
    const start = this.i;
    const out = ctx.out;
    const n = [out.sites.length, out.loops.length, out.unresolved.length];
    const saved = copyLoc(this.loc);
    const scope = saveScope(ctx);
    ctx.files = new Map(ctx.files);
    const st = [this.stopped, this.stopReason, this.pendingStop, this.retLocs, this.cond, this.loopDepth, this.condNest];
    this.subDepth++;
    this.stopped = false; this.stopReason = null; this.pendingStop = null; this.retLocs = []; this.cond = []; this.loopDepth = 0; this.condNest = 0;
    try { this.nest(() => this.list(closer)); } finally {
      this.subDepth--;
      out.sites.length = n[0]; out.loops.length = n[1]; out.unresolved.length = n[2];
      this.loc = saved;
      restoreScope(ctx, scope, true);
      [this.stopped, this.stopReason, this.pendingStop, this.retLocs, this.cond, this.loopDepth, this.condNest] = st;
    }
    if (this.stopped) return;
    const def = { text: this.s.slice(start, Math.max(start, this.i - 1)), subshell: closer === ')' };
    let alts = [def];
    if (maybe) {
      const prev = ctx.funcs.get(name);
      alts = (prev ? prev.alts : [null]).filter(a => !a || a.text !== def.text || a.subshell !== def.subshell).concat(def);
      if (alts.length > 4) alts = [alts[0], ...alts.slice(-3)];
    }
    if (ctx.funcs.size < 200 || ctx.funcs.has(name)) ctx.funcs.set(name, { alts });
  }

  // A call: each body it may have runs from the caller's folder. null stands
  // for "not defined", where the name runs as a command.
  callFunction(f, words, from, k, stdin, inLoop) {
    const base = copyLoc(this.loc);
    const args = words.slice(k + 1);
    const ends = [];
    let stop = null;
    for (const d of f.alts) {
      this.loc = copyLoc(base);
      if (!d) {
        const rest = words.slice(from);
        for (const p of ['stdin', 'outFile', 'inFile', 'append']) if (words[p] !== undefined) rest[p] = words[p];
        this.command(rest, stdin, true);
      } else if (d.subshell) {
        this.sub(d.text, copyLoc(base), Bash, inLoop, 'subshell', args);
      } else {
        this.loc = this.sub(d.text, this.loc, Bash, inLoop, 'func', args);
        if (f.alts.length === 1 && this.childStop === 'exit') stop = 'exit';
      }
      ends.push(this.loc);
    }
    this.loc = ends.every(e => sameLoc(e, ends[0])) ? ends[0] : unknownLoc(base);
    if (stop) this.pendingStop = stop;
  }

  nest(fn) {
    if (this.depth >= MAX_DEPTH * 4) { this.ctx.out.unresolved.push(WHY.nested); this.i = this.s.length; return; }
    this.depth++;
    try { fn(); } finally { this.depth--; }
  }

  skipBalanced(open, close, level) {
    const s = this.s;
    while (this.i < s.length && level > 0) {
      const c = s[this.i++];
      if (c === '\\') this.i++;
      else if (c === "'") { const e = s.indexOf("'", this.i); this.i = e < 0 ? s.length : e + 1; }
      else if (c === open) level++;
      else if (c === close) level--;
    }
  }

  // Heredoc bodies start after the newline that ends the line naming them.
  readHeredocs() {
    const s = this.s;
    while (this.heredocs.length) {
      tick(this.ctx);
      const rec = this.heredocs.shift();
      const lines = [];
      while (this.i < s.length) {
        tick(this.ctx);
        let e = s.indexOf('\n', this.i);
        if (e < 0) e = s.length;
        let line = s.slice(this.i, e).replace(/\r$/, '');
        this.i = Math.min(s.length, e + 1);
        if (rec.strip) line = line.replace(/^\t+/, '');
        if (line === rec.delim) break;
        lines.push(line);
      }
      const raw = lines.join('\n');
      if (rec.quoted || this.stopped) rec.body = raw;
      else {
        // Expanded by this shell when the command runs: a $( ) in it runs
        // here, and a body that depends on a variable is not known.
        const r = this.expandBody(raw);
        rec.body = r.v;
        rec.dyn = r.dyn;
      }
    }
    // A script that came on a heredoc that wasn't read yet (bash <<'EOF' &&
    // ..., cat > f <<'EOF' && bash f), now that it has been.
    const ready = this.deferred.filter(d => !recText(d.rec).pending);
    this.deferred = this.deferred.filter(d => recText(d.rec).pending);
    for (const d of ready) {
      const end = this.runScript(d.rec, d.loc, d.inLoop, d.mode, d.fargs);
      if (SHARED_MODES.has(d.mode) && !sameLoc(end, d.loc)) this.loc = unknownLoc(this.loc);
    }
  }

  // An unquoted heredoc body, expanded like a double-quoted string except
  // that " is plain text there, and $' and $" are too.
  expandBody(text) {
    const p = new Bash(text, this.ctx, copyLoc(this.loc), this.depth + 1, this.inLoop);
    p.shared = this.shared; p.subDepth = this.subDepth; p.fn = this.fn;
    let v = '';
    let dyn = false;
    while (p.i < text.length) {
      tick(this.ctx);
      const c = text[p.i];
      if (c === '\\') {
        const nx = text[p.i + 1];
        if (nx === '\n') { p.i += 2; continue; }
        if (nx === '$' || nx === '`' || nx === '\\') { v += nx; p.i += 2; continue; }
        v += c; p.i++; continue;
      }
      if (c === '$' && text[p.i + 1] !== "'" && text[p.i + 1] !== '"') {
        const r = p.readDollar();
        // In Git Bash, $HOME and $PWD read /c/Users/x, which the script
        // reading this text takes apart differently from C:\Users\x.
        if (r && !r.dyn && this.msys && /^[A-Za-z]:\\/.test(r.v)) r.v = '/' + r.v[0].toLowerCase() + r.v.slice(2).replace(/\\/g, '/');
        // $(git rev-parse --show-toplevel) is the repo, not this folder, so
        // a path built on it isn't known.
        if (r && r.top !== undefined) dyn = true;
        if (r) { v += r.v; dyn = dyn || r.dyn; continue; }
      }
      if (c === '`') { p.readBacktick(); dyn = true; continue; }
      v += c; p.i++;
    }
    return { v, dyn };
  }

  // A script this command has the text of: a heredoc or herestring fed to a
  // shell, or a file it wrote. A script whose text depends on a variable, or
  // a file something else changed since, isn't read: a commit in what is
  // known of it is unresolved, and a cd in it, run in this shell, leaves the
  // folder unknown. Returns the folder it ends in.
  runScript(rec, loc, inLoop, mode, fargs) {
    const t = recText(rec);
    if (!t) return loc;
    if (t.pending) { this.deferred.push({ rec, loc, inLoop, mode, fargs }); return loc; }
    if (t.dyn) {
      if (/\bcommit\b/.test(t.body)) this.ctx.out.unresolved.push(WHY.variable);
      return SHARED_MODES.has(mode) && /\b(?:cd|pushd|popd)\b/.test(t.body) ? unknownLoc(loc) : loc;
    }
    return this.sub(t.body, loc, Bash, inLoop, mode, fargs);
  }

  fileKey(p) { return this.ctx.platform === 'win32' ? p.toLowerCase() : p; }

  // cat > f <<'EOF', echo ... > f, tee f: what a file now holds, for a later
  // bash f, ./f or source f. rec null: written by something else, so not
  // known. append (>>): added to what the file held, which is not known
  // unless this command wrote it.
  writeFile(w, rec, append = false) {
    if (!w || w.dyn || w.glob) return;
    const p = this.resolve(this.loc.cur, w.v);
    if (!p) return;
    const key = this.fileKey(p);
    const files = this.ctx.files;
    const prev = files.get(key) || null;
    let next;
    if (!rec) next = { unknown: true, stale: prev };
    else if (append) {
      const parts = prev ? (prev.parts || [prev]) : [{ unknown: true, stale: null }];
      next = parts.length >= 20 ? { unknown: true, stale: prev } : { parts: parts.concat(rec) };
    } else next = rec;
    if (files.size < 50 || files.has(key)) files.set(key, next);
  }

  knownFile(w) {
    if (!w || w.dyn || w.glob) return null;
    const p = this.resolve(this.loc.cur, w.v);
    return p ? this.ctx.files.get(this.fileKey(p)) || null : null;
  }

  // A command that may change a file named in it (sed -i, mv, cp, rm, a
  // program), or a git command that rewrites the working tree: a file this
  // command wrote no longer holds the text recorded for it.
  touchFiles(name, args) {
    const files = this.ctx.files;
    if (!files.size) return;
    const forget = (key) => { const r = files.get(key); if (r && !r.unknown) files.set(key, { unknown: true, stale: r }); };
    if (isGitName(name, this.ctx.platform)) {
      let i = 0;
      while (i < args.length && /^-/.test(args[i].v)) i += /^-[Cc]$/.test(args[i].v) ? 2 : 1;
      if (args[i] && GIT_TREE_WRITERS.has(args[i].v)) for (const key of [...files.keys()]) forget(key);
      return;
    }
    if (FILE_READERS.has(name) && !(name === 'sed' && args.some(a => /^-[a-zA-Z]*i|^--in-place/.test(a.v))) &&
      !(name === 'sort' && args.some(a => /^-[a-zA-Z]*o|^--output/.test(a.v)))) return;
    for (const a of args) {
      if (a.dyn || a.glob || !a.v) continue;
      const v = a.v.replace(/^--?[A-Za-z-]+=/, '');
      const p = this.resolve(this.loc.cur, v);
      if (p) forget(this.fileKey(p));
    }
  }

  // shift and set -- change "$1" and "$@" (set -e, set -o pipefail don't).
  // Where that may not run, they are no longer known.
  setArgs(name, args) {
    const ctx = this.ctx;
    if (name === 'shift') {
      const n = !args.length ? 1 : (!args[0].dyn && /^\d+$/.test(args[0].v) ? Number(args[0].v) : NaN);
      // shift past the last argument fails and leaves them as they were.
      if (ctx.fargs && Number.isFinite(n) && n > ctx.fargs.length) return;
      ctx.fargs = this.maybeHere || !ctx.fargs || !Number.isFinite(n) ? null : ctx.fargs.slice(n);
      return;
    }
    let k = 0;
    while (k < args.length && !args[k].dyn && /^[-+][a-zA-Z]+$/.test(args[k].v)) k += /^[-+][a-zA-Z]*o$/.test(args[k].v) ? 2 : 1;
    if (k < args.length && !args[k].dyn && (args[k].v === '--' || args[k].v === '-')) k++;
    else if (k >= args.length) return;
    ctx.fargs = this.maybeHere ? null : args.slice(k);
  }

  // One word with quote removal. dyn: it depends on something not known here
  // (a variable, a substitution). glob: unquoted *, ? or [ (or a brace
  // expansion), which the shell would expand. lit: no quoting or expansion at
  // all, as reserved words need.
  readWord(delimiter) {
    const s = this.s;
    const start = this.i;
    let v = '';
    let dyn = false;
    let glob = false;
    let quoted = false;
    let assign = false;
    let nameOk = true;
    let top;
    while (this.i < s.length) {
      const c = s[this.i];
      if (BASH_META.has(c) || c === '\r') break;
      if (c === '\\') {
        if (s[this.i + 1] === '\n') { this.i += 2; continue; }
        if (this.i + 1 < s.length) v += s[this.i + 1];
        this.i += 2; quoted = true; nameOk = false; continue;
      }
      if (c === "'") {
        const e = s.indexOf("'", this.i + 1);
        if (e < 0) this.ctx.unterminated = true;
        v += s.slice(this.i + 1, e < 0 ? s.length : e);
        this.i = e < 0 ? s.length : e + 1; quoted = true; nameOk = false; continue;
      }
      if (c === '"') { this.i++; const r = this.readDouble(); v += r.v; dyn = dyn || r.dyn; quoted = true; nameOk = false; if (r.top !== undefined) top = r.top; continue; }
      if (c === '$' && !delimiter) {
        const r = this.readDollar();
        if (r) { v += r.v; dyn = dyn || r.dyn; quoted = quoted || r.quoted; nameOk = false; if (r.top !== undefined) top = r.top; continue; }
      }
      if (c === '`' && !delimiter) { this.readBacktick(); dyn = true; nameOk = false; continue; }
      if (c === '~' && this.i === start && !delimiter) {
        let j = this.i + 1;
        while (j < s.length && !BASH_META.has(s[j]) && s[j] !== '/' && !/["'`$\\]/.test(s[j])) j++;
        const tail = s.slice(this.i + 1, j);
        if (tail === '' && this.ctx.home) v += this.ctx.home;
        else if (tail === '+' && this.loc.cur) v += this.loc.cur;
        else if (tail === '-' && this.loc.prev) v += this.loc.prev;
        else { v += '~' + tail; dyn = true; }
        this.i = j; nameOk = false; continue;
      }
      if (c === '*' || c === '?' || c === '[') glob = true;
      if (c === '{' || c === '}') { if (this.i !== start || (s[this.i + 1] && !BASH_META.has(s[this.i + 1]))) glob = true; }
      if (c === '=' && nameOk && !assign && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) assign = true;
      v += c;
      this.i++;
    }
    // "$(git rev-parse --show-toplevel)" stands for the current repo, which
    // is all a git call needs, but only as the whole word: with a suffix
    // ("$(...)/sub") the folder would depend on where the top level is.
    if (top !== undefined && v !== top) dyn = true;
    const lit = !quoted && !dyn && s.slice(start, this.i) === v;
    return { v, dyn, glob: glob && !dyn, lit, assign, q: quoted && s[start] === '"' && s[this.i - 1] === '"' };
  }

  readDouble() {
    const s = this.s;
    let v = '';
    let dyn = false;
    let top;
    while (this.i < s.length && s[this.i] !== '"') {
      const c = s[this.i];
      if (c === '\\') {
        const n = s[this.i + 1];
        if (n === '\n') { this.i += 2; continue; }
        if (n === '$' || n === '`' || n === '"' || n === '\\') { v += n; this.i += 2; continue; }
        v += c; this.i++; continue;
      }
      if (c === '$') { const r = this.readDollar(); if (r) { v += r.v; dyn = dyn || r.dyn; if (r.top !== undefined) top = r.top; continue; } }
      if (c === '`') { this.readBacktick(); dyn = true; continue; }
      v += c; this.i++;
    }
    if (this.i >= s.length) this.ctx.unterminated = true;
    this.i++;
    if (top !== undefined && v !== top) return { v, dyn: true };
    return top !== undefined ? { v, dyn, top } : { v, dyn };
  }

  // $..., at this.i. Returns null for a lone '$'.
  readDollar() {
    const s = this.s;
    const n = s[this.i + 1];
    if (n === "'") {
      // ANSI-C quoting.
      let v = '';
      this.i += 2;
      const esc = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' };
      while (this.i < s.length && s[this.i] !== "'") {
        if (s[this.i] === '\\' && this.i + 1 < s.length) {
          const k = s[this.i + 1];
          v += Object.prototype.hasOwnProperty.call(esc, k) ? esc[k] : '\\' + k;
          this.i += 2; continue;
        }
        v += s[this.i++];
      }
      this.i++;
      return { v, dyn: false, quoted: true };
    }
    if (n === '"') { this.i += 2; const r = this.readDouble(); return { v: r.v, dyn: r.dyn, quoted: true }; }
    if (n === '(') {
      if (s[this.i + 2] === '(') { this.i += 3; this.skipBalanced('(', ')', 2); return { v: '', dyn: true }; }
      this.i += 2;
      const from = this.i;
      const saved = copyLoc(this.loc);
      const heredocs = this.heredocs;
      this.heredocs = [];
      this.inSubshell(() => this.list(')'));
      this.heredocs = heredocs.concat(this.heredocs);
      if (saved.cur && /^\s*git\s+rev-parse\s+--show-toplevel\s*$/.test(s.slice(from, this.i - 1))) return { v: saved.cur, dyn: false, top: saved.cur };
      return { v: '', dyn: true };
    }
    if (n === '{') {
      // To the matching }, past quotes, escapes and nested ${ }.
      let j = this.i + 2;
      let level = 1;
      while (j < s.length && level) {
        const ch = s[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === "'") { const e = s.indexOf("'", j + 1); j = e < 0 ? s.length : e + 1; continue; }
        if (ch === '"') { j++; while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1; j++; continue; }
        if (ch === '$' && s[j + 1] === '{') { level++; j += 2; continue; }
        if (ch === '}') level--;
        j++;
      }
      if (level) this.ctx.unterminated = true;
      const inner = s.slice(this.i + 2, Math.max(this.i + 2, j - 1));
      this.i = Math.min(j, s.length);
      if (inner === 'HOME' && this.ctx.home) return { v: this.ctx.home, dyn: false };
      return { v: '${' + inner + '}', dyn: true };
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9?$#@*!-]/.exec(s.slice(this.i + 1, this.i + 200));
    if (!m) return null;
    this.i += 1 + m[0].length;
    if (m[0] === 'HOME' && this.ctx.home) return { v: this.ctx.home, dyn: false };
    if (m[0] === 'PWD' && this.loc.cur) return { v: this.loc.cur, dyn: false };
    return { v: '$' + m[0], dyn: true };
  }

  readBacktick() {
    const s = this.s;
    let j = this.i + 1;
    let body = '';
    while (j < s.length && s[j] !== '`') {
      if (s[j] === '\\' && j + 1 < s.length) { body += s[j + 1]; j += 2; continue; }
      body += s[j++];
    }
    this.i = Math.min(s.length, j + 1);
    this.sub(body, copyLoc(this.loc), Bash, this.inLoop, 'subshell');
  }

  sub(text, loc, Kind = Bash, inLoop = this.inLoop, mode = 'child', fargs) { return subParse(this, text, loc, Kind, inLoop, mode, fargs); }

  // if / while / for / case: code that may run once, many times or not at
  // all. A folder change inside leaves the folder unknown after it.
  condPush(kind) {
    if (this.cond.length >= 64) throw TOO_LONG;
    this.cond.push({ kind, base: copyLoc(this.loc), changed: false });
    if (kind === 'loop') this.loopDepth++;
  }

  condBranch(kind) {
    const top = this.cond[this.cond.length - 1];
    if (!top || top.kind !== kind) return;
    if (!sameLoc(this.loc, top.base)) top.changed = true;
    this.loc = copyLoc(top.base);
  }

  condPop(kind) {
    const k = this.cond.map(c => c.kind).lastIndexOf(kind);
    if (k < 0) return;
    const [top] = this.cond.splice(k, this.cond.length - k);
    if (kind === 'loop') this.loopDepth = Math.max(0, this.loopDepth - 1);
    if (top.changed || !sameLoc(this.loc, top.base)) this.loc = unknownLoc(this.loc);
  }

  // One simple command. stdin: what the previous pipeline element writes,
  // when it's a known text. Returns what this one writes, for the next.
  // noFuncs: run the name as a command even if a function has it.
  command(words, stdin, noFuncs = false) {
    const ctx = this.ctx;
    if (ctx.fargs) words = expandArgs(words, ctx.fargs);
    const n = words.length;
    let k = 0;
    let from = 0; // where the command starts, after reserved words
    const assigns = [];
    for (;;) {
      tick(ctx);
      from = k;
      while (k < n && words[k].assign) assigns.push(words[k++]);
      if (k >= n) {
        // Assignments only: GIT_DIR=... here can change what a later git
        // sees, and CDPATH=... what a later cd does.
        for (const a of assigns) { const m = /^(GIT_(?:DIR|WORK_TREE))=/.exec(a.v); if (m) ctx.gitVars.add(m[1]); }
        if (assigns.some(a => /^CDPATH=./.test(a.v))) ctx.cdpath = true;
        if (words.outFile) this.writeFile(words.outFile, null);
        return null;
      }
      const w = words[k];
      if (!w.lit) break;
      const v = w.v;
      if (v === 'if' || v === 'while' || v === 'until') { this.condPush(v === 'if' ? 'if' : 'loop'); k++; continue; }
      if (v === 'then' || v === 'do' || v === '!' || v === 'time') { k++; continue; }
      if (v === 'else' || v === 'elif') { this.condBranch('if'); k++; continue; }
      if (v === 'fi') { this.condPop('if'); k++; continue; }
      if (v === 'done') { this.condPop('loop'); k++; continue; }
      if (v === 'esac') { this.condPop('case'); k++; continue; }
      if (v === 'for' || v === 'select') { this.condPush('loop'); return null; }
      if (v === 'case') { this.condPush('case'); return null; }
      if (v === '[[' || v === 'in' || v === 'function' || v === 'coproc') return null;
      break;
    }
    // Wrappers that run the rest as a command in the same folder. Any of them
    // skips shell functions; all but command and builtin run a program, so a
    // cd after them is not the shell's.
    let wrapped = false;
    let external = false;
    let execd = false;
    let guard = 0;
    while (k < n && !words[k].dyn && BASH_WRAPPERS.has(baseName(words[k].v)) && guard++ < 6) {
      const name = baseName(words[k].v);
      wrapped = true;
      if (name !== 'command' && name !== 'builtin') external = true;
      if (name === 'exec') execd = true;
      k++;
      if (name === 'command' && k < n && /^-[a-zA-Z]*[vV]/.test(words[k].v)) return null; // command -v: only prints
      while (k < n && (words[k].v.startsWith('-') || (name === 'env' && words[k].assign))) {
        const o = words[k].v;
        if (words[k].assign) assigns.push(words[k]);
        if (name === 'env' && /^(?:-C|--chdir)/.test(o)) { if (mentionsCommit(words, k, ctx.platform)) ctx.out.unresolved.push(WHY.unrecognized); return null; }
        const takesValue = (name === 'nice' && o === '-n') || (name === 'sudo' && /^-[ugpChrt]$/.test(o)) ||
          (name === 'env' && /^-[uS]$/.test(o)) || (name === 'xargs' && /^-[IdEsLnPa]$/.test(o)) || (name === 'timeout' && /^-[sk]$/.test(o));
        k += takesValue ? 2 : 1;
      }
      if (name === 'timeout' && k < n) k++; // the duration
      while (name === 'env' && k < n && words[k].assign) assigns.push(words[k++]);
    }
    if (k >= n) return null;
    // exec <command>: the shell becomes that command, so nothing after it runs.
    if (execd) this.pendingStop = 'exit';
    const head = words[k];
    const inLoop = this.inLoop;
    if (head.dyn) {
      // "$GIT_HOME/bin/git" commit: git by a path.
      if (isGitName(head.v, ctx.platform) && !/[\\/]$/.test(head.v)) {
        const otherRepo = assigns.some(a => /^GIT_(?:DIR|WORK_TREE)=/.test(a.v));
        gitSite(words.slice(k + 1), this.loc.cur, ctx, { otherRepo, inLoop, resolve: (d, p) => this.resolve(d, p) });
        return null;
      }
      if (mentionsCommit(words, k, ctx.platform) || words.slice(k + 1).some(w => w.v === 'commit')) ctx.out.unresolved.push(WHY.unrecognized);
      // $CMD as a command: it can be cd (CMD='cd /x'), so the folder is unknown after it.
      if (/^\$\{?[A-Za-z_]/.test(head.v)) { this.loc = unknownLoc(this.loc); this.moved(); }
      return null;
    }
    const name = head.v;
    const base = baseName(name).toLowerCase();
    const args = words.slice(k + 1);
    // Output to a file: what it then holds is known only for cat, echo,
    // printf and tee (below).
    if (words.outFile && !TEXT_WRITERS.has(name)) this.writeFile(words.outFile, null);
    // A file this command wrote, named by a command that may change it
    // (sed -i, mv, cp, a git checkout): its text is no longer known.
    this.touchFiles(name, args);
    // A function is found before a builtin or a program of the same name.
    if (!noFuncs && !wrapped && !head.glob && ctx.funcs.has(name)) {
      this.callFunction(ctx.funcs.get(name), words, from, k, stdin, inLoop);
      return null;
    }
    if (name === 'return' || name === 'exit') { if (!external) this.pendingStop = name; return null; }
    if (name === 'cd' || name === 'pushd' || name === 'popd') {
      if (external) return null;
      this.lastWasLoc = true;
      this.moved();
      if (name === 'cd') this.cd(args, assigns.some(a => /^CDPATH=/.test(a.v)) || ctx.cdpath);
      else if (name === 'pushd') this.pushd(args);
      else this.popd(args);
      return null;
    }
    if (name === 'shopt' && args.some(a => a.v === '-s') && args.some(a => a.v === 'lastpipe')) { ctx.lastpipe = true; return null; }
    if (name === 'unset') { this.unset(args); return null; }
    if (name === 'shift' || name === 'set') { this.setArgs(name, args); return null; }
    if (isGitName(name, ctx.platform)) {
      const otherRepo = assigns.some(a => /^GIT_(?:DIR|WORK_TREE)=/.test(a.v));
      gitSite(args, this.loc.cur, ctx, { otherRepo, inLoop, resolve: (d, p) => this.resolve(d, p) });
      return null;
    }
    if (BASH_DECLARE.has(name)) {
      for (const a of args) { const m = /^(GIT_(?:DIR|WORK_TREE))(?:=|$)/.exec(a.v); if (m) ctx.gitVars.add(m[1]); }
      if (args.some(a => /^CDPATH=./.test(a.v))) ctx.cdpath = true;
      return null;
    }
    if (name === 'eval') {
      if (args.some(x => x.dyn)) {
        if (mentionsCommit(args, 0, ctx.platform) || /\bcommit\b/.test(args.map(x => x.v).join(' '))) ctx.out.unresolved.push(WHY.variable);
        // eval "$CMD": code from a variable may cd. eval "$(tool)" (ssh-agent,
        // conda, direnv) is taken as setting variables only.
        if (args.some(x => x.dyn && /\$\{?[A-Za-z_]/.test(x.v))) { this.loc = unknownLoc(this.loc); this.moved(); }
        return null;
      }
      this.loc = this.sub(args.map(x => x.v).join(' '), this.loc, Bash, inLoop, 'same');
      if (this.childStop) this.pendingStop = this.childStop;
      return null;
    }
    if ((name === 'source' || name === '.') && !external) {
      // A file this command wrote; any other file is not read.
      const f = this.knownFile(args[0]);
      if (f) {
        this.loc = this.runScript(f, this.loc, inLoop, 'func', args.slice(1));
        if (this.childStop === 'exit') this.pendingStop = 'exit';
      }
      return null;
    }
    if (SHELLS.has(base)) { this.shell(words, k, stdin, inLoop); return null; }
    if (PWSH.has(base)) { pwshCommandLine(args, this, ctx, inLoop); return null; }
    if (/[\\/]/.test(name)) {
      // ./fix.sh: a script this command wrote runs in a child shell.
      const f = this.knownFile(head);
      if (f) { this.runScript(f, copyLoc(this.loc), inLoop, 'child', args); return null; }
    }
    if (BASH_TEXT.has(name)) {
      // What cat <<EOF, echo and tee write, for a shell later in the
      // pipeline or a file a later command runs.
      let text = null;
      if (name === 'cat' && !args.some(a => !/^-/.test(a.v))) text = words.stdin || stdin || null;
      else if (name === 'echo' || name === 'printf') text = echoText(name, args);
      else if (name === 'tee') {
        text = words.stdin || stdin || null;
        const append = args.some(a => /^-[a-z]*a/.test(a.v) || a.v === '--append');
        for (const a of args) if (!/^-/.test(a.v)) this.writeFile(a, text, append);
      }
      if (words.outFile) { this.writeFile(words.outFile, text, words.append); return name === 'tee' ? text : null; }
      return text;
    }
    if (mentionsCommit(words, k + 1, ctx.platform)) ctx.out.unresolved.push(WHY.unrecognized);
    return null;
  }

  // unset -f f, or unset f with no -v (a function when no variable has the
  // name). Where it may not run, the function may still be there. unset
  // GIT_DIR that surely runs undoes an export.
  unset(args) {
    const funcs = this.ctx.funcs;
    let fn = false;
    let vars = false;
    for (const a of args) {
      if (a.lit && /^-[a-z]+$/.test(a.v)) { if (a.v.includes('f')) fn = true; if (a.v.includes('v')) vars = true; continue; }
      if (!fn && !a.dyn && /^GIT_(?:DIR|WORK_TREE)$/.test(a.v) && !this.maybeHere) this.ctx.gitVars.delete(a.v);
      if ((vars && !fn) || a.dyn || !funcs.has(a.v)) continue;
      const f = funcs.get(a.v);
      if (fn && !this.maybeHere) funcs.delete(a.v);
      else if (!f.alts.includes(null)) funcs.set(a.v, { alts: [null, ...f.alts].slice(0, 4) });
    }
  }

  // bash -c 'script', bash <<'EOF' (a heredoc script), bash <<< 'script',
  // cat <<'EOF' | bash, bash < file or bash file. A file is read only when
  // this command wrote it.
  shell(words, k, stdin, inLoop) {
    const ctx = this.ctx;
    let j = k + 1;
    let hasC = false;
    let file = false;
    while (j < words.length && /^[-+]/.test(words[j].v)) {
      const o = words[j].v;
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(o)) { hasC = true; j++; break; }
      if (o === '-s') { j++; continue; }
      j += /^[-+][oO]$/.test(o) ? 2 : 1;
    }
    if (!hasC && j < words.length) file = true;
    if (hasC) {
      const w = words[j];
      if (!w) return;
      if (w.dyn) { if (/\bcommit\b/.test(w.v)) ctx.out.unresolved.push(WHY.variable); return; }
      this.sub(w.v, copyLoc(this.loc), Bash, inLoop, 'child');
      return;
    }
    if (file) { this.runScript(this.knownFile(words[j]), copyLoc(this.loc), inLoop, 'child', words.slice(j + 1)); return; }
    const src = words.stdin || (words.inFile ? this.knownFile(words.inFile) : null) || stdin;
    if (src) this.runScript(src, copyLoc(this.loc), inLoop, 'child');
  }

  // cdpath: CDPATH is set, so a bare relative name may resolve through it.
  cd(args, cdpath = false) {
    let a = args;
    let k = 0;
    while (k < a.length && a[k].lit && /^-[LPe@]+$/.test(a[k].v)) k++;
    if (k < a.length && a[k].lit && a[k].v === '--') k++;
    a = a.slice(k);
    let target;
    if (a.length > 1) target = null; // cd a b: bash refuses (too many arguments), others differ
    else if (!a.length) target = this.ctx.home || null;
    else if (a[0].lit && a[0].v === '-') target = this.loc.prev;
    else if (a[0].dyn || a[0].glob) target = null;
    else if (a[0].v === '') return;
    else if (cdpath && !/^(?:[\\/]|\.{1,2}(?:[\\/]|$)|[a-zA-Z]:)/.test(a[0].v)) target = null;
    else target = this.resolve(this.loc.cur, a[0].v);
    this.loc.prev = this.loc.cur;
    this.loc.cur = target;
  }

  pushd(args) {
    const l = this.loc;
    if (l.stack.length >= STACK_MAX) { this.loc = unknownLoc(l); return; }
    if (!args.length) {
      if (!l.stack.length) return;
      const top = l.stack.pop();
      l.stack.push(l.cur);
      l.prev = l.cur; l.cur = top;
      return;
    }
    const a = args[0];
    if (a.lit && /^(?:-n|[+-][0-9]+)$/.test(a.v)) { this.loc = unknownLoc(l); return; }
    const target = a.dyn || a.glob ? null : this.resolve(l.cur, a.v);
    l.stack.push(l.cur);
    l.prev = l.cur; l.cur = target;
  }

  popd(args) {
    const l = this.loc;
    if (args.length) { this.loc = unknownLoc(l); return; }
    if (!l.stack.length) return; // popd fails: directory stack empty
    l.prev = l.cur; l.cur = l.stack.pop();
  }
}

// ---------- PowerShell ----------

const PS_META = new Set([' ', '\t', '\n', ';', '|', '&', '(', ')', '{', '}', '>']);
const PS_SETLOC = new Set(['cd', 'chdir', 'sl', 'set-location']);
const PS_PUSH = new Set(['pushd', 'push-location']);
const PS_POP = new Set(['popd', 'pop-location']);
const PS_IEX = new Set(['iex', 'invoke-expression']);
const PS_ICM = new Set(['invoke-command', 'icm']);
const PS_KEYWORDS = new Set(['if', 'elseif', 'else', 'foreach', 'for', 'while', 'do', 'until', 'switch', 'try', 'catch', 'finally', 'trap', 'function', 'filter', 'param', 'return', 'throw', 'break', 'continue', 'exit', 'begin', 'process', 'end', 'using', 'class', 'enum', 'data', 'dynamicparam', 'workflow']);
// Script blocks: run over and over, run in another process or later, or run
// only maybe. A block after anything else counts as maybe. Invoke-Command
// runs its block here unless it is sent to another computer (see invoke()).
const PS_LOOP = new Set(['foreach', 'for', 'while', 'do', 'until', 'foreach-object', '%', 'where-object', '?']);
const PS_ELSEWHERE = new Set(['start-job', 'start-threadjob', 'start-process', 'saps', 'start', 'register-objectevent', 'register-engineevent', 'register-scheduledjob', 'new-object']);
const PS_ALWAYS = new Set(['try', 'finally', '&', '.']);
// Cmdlets that run a script block handed to them (others, such as
// Write-Output, only pass it on).
const PS_RUNS_BLOCKS = new Set(['foreach-object', '%', 'foreach', 'where-object', '?', 'where', 'measure-command', 'sort-object', 'sort',
  'group-object', 'group', 'select-object', 'select', 'trace-command']);
const PS_TEXT = new Set(['write-host', 'write-output', 'write-information', 'write-verbose', 'write-warning', 'write-error', 'echo', 'select-string', 'sls',
  'get-content', 'gc', 'cat', 'type', 'out-file', 'set-content', 'sc', 'add-content', 'ac', 'out-string', 'format-table', 'ft', 'format-list', 'fl',
  'measure-object', 'sort-object', 'select-object', 'get-childitem', 'gci', 'ls', 'dir', 'test-path', 'resolve-path', 'split-path', 'join-path', 'write-progress', 'gh']);
// An alias is found before a function of the same name; a function before a
// cmdlet or a program.
const PS_ALIASES = new Set(['cd', 'chdir', 'sl', 'pushd', 'popd', 'iex', 'icm', 'echo', 'sls', 'gc', 'cat', 'type', 'sc', 'ac', 'ft', 'fl', 'gci', 'ls', 'dir', 'saps', 'start', '%', '?']);
// Set-Location / Push-Location / Pop-Location parameters, with aliases.
// Names may be shortened to any unambiguous prefix.
const PS_LOC_PARAMS = {
  path: 'value', literalpath: 'literal', pspath: 'literal', lp: 'literal', stackname: 'value', passthru: 'switch',
  verbose: 'switch', debug: 'switch', whatif: 'whatif', confirm: 'switch',
  erroraction: 'value', ea: 'value', warningaction: 'value', wa: 'value', informationaction: 'value', infa: 'value',
  progressaction: 'value', proga: 'value', errorvariable: 'value', ev: 'value', warningvariable: 'value', wv: 'value',
  informationvariable: 'value', iv: 'value', outvariable: 'value', ov: 'value', outbuffer: 'value', ob: 'value',
  pipelinevariable: 'value', pv: 'value', vb: 'switch', db: 'switch', wi: 'whatif', cf: 'switch',
};

function psParam(name) {
  const n = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PS_LOC_PARAMS, n)) return { name: n, kind: PS_LOC_PARAMS[n] };
  const hits = Object.keys(PS_LOC_PARAMS).filter(k => k.length > 2 && k.startsWith(n));
  if (hits.length === 1) return { name: hits[0], kind: PS_LOC_PARAMS[hits[0]] };
  return { name: n, kind: 'unknown' };
}

// Invoke-Command parameters that keep it in this session. Any other one
// (-ComputerName, -Session, -AsJob, -FilePath, -VMName, ...) may send the
// block elsewhere. [name, shortest prefix, kind]
const PS_ICM_LOCAL = [['scriptblock', 2, 'block'], ['argumentlist', 2, 'value'], ['args', 4, 'value'], ['nonewscope', 2, 'switch'], ['inputobject', 3, 'value'],
  ['verbose', 4, 'switch'], ['vb', 2, 'switch'], ['debug', 4, 'switch'], ['db', 2, 'switch'],
  ['erroraction', 6, 'value'], ['ea', 2, 'value'], ['warningaction', 8, 'value'], ['wa', 2, 'value'], ['informationaction', 12, 'value'], ['infa', 4, 'value'],
  ['progressaction', 9, 'value'], ['proga', 5, 'value'], ['errorvariable', 6, 'value'], ['ev', 2, 'value'], ['warningvariable', 8, 'value'], ['wv', 2, 'value'],
  ['informationvariable', 12, 'value'], ['iv', 2, 'value'], ['outvariable', 4, 'value'], ['ov', 2, 'value'], ['outbuffer', 4, 'value'], ['ob', 2, 'value'],
  ['pipelinevariable', 4, 'value'], ['pv', 2, 'value']];

// Invoke-Command parameters (and aliases) that send the block to another
// computer, a job or a session. A parameter in neither list may be either,
// so the block may or may not run here.
const PS_ICM_REMOTE = ['computername', 'cn', 'session', 'connectionuri', 'uri', 'cu', 'vmname', 'vmid', 'vmguid', 'containerid', 'hostname',
  'sshconnection', 'sshtransport', 'asjob', 'indisconnectedsession', 'disconnected', 'filepath', 'pspath', 'jobname', 'throttlelimit', 'port',
  'usessl', 'credential', 'authentication', 'configurationname', 'applicationname', 'sessionname', 'sessionoption', 'certificatethumbprint',
  'enablenetworkaccess', 'hidecomputername', 'remotedebug', 'username', 'keyfilepath', 'subsystem', 'options', 'runasadministrator',
  'allowredirection', 'connectingtimeout'];

function icmParam(name) {
  const n = name.toLowerCase();
  for (const [full, min, kind] of PS_ICM_LOCAL) if (n === full || (n.length >= min && full.startsWith(n))) return kind;
  if (n.length >= 2 && PS_ICM_REMOTE.some(r => r.startsWith(n))) return 'remote';
  return 'unknown';
}

const PS_SCOPE = /^(?:global|script|local|private):/i;
// function global:Go { } is called as Go.
const psFuncName = (n) => String(n || '').replace(PS_SCOPE, '');
// An assignment's target: $x, [int]$x, $a, $b, $x.Name, $h['k'].
const isPsTarget = (w) => !!w && w.dyn && !w.call && !w.block && /^(?:\[[^\]]*\])*\$/.test(w.v);
const PS_ASSIGN_OP = /^(?:\?\?=|[+\-*/%]?=)(?!=)/;

// The index just past the operator in `$x = <right side>`, or 0.
function psAssignEnd(words) {
  let k = 0;
  while (k < words.length && isPsTarget(words[k])) k++;
  return k > 0 && k < words.length && words[k].assignOp === true ? k + 1 : 0;
}

class Pwsh {
  constructor(src, ctx, loc, depth, inLoop = false) {
    this.s = src;
    this.i = 0;
    this.ctx = ctx;
    this.loc = loc;
    this.depth = depth;
    this.loopDepth = 0;
    this.baseLoop = inLoop;
    // See Bash. In PowerShell the location belongs to the whole session, so
    // only code read aside (a stored block, a function body, a job) and
    // child processes don't share it.
    this.shared = true;
    this.subDepth = 0;
    // Inside a block that may not run (if, a loop, a cmdlet's block).
    this.maybeDepth = 0;
    // return and exit (see Bash): fn in a function body.
    this.fn = false;
    this.stopped = false;
    this.stopReason = null;
    this.retLocs = [];
  }

  get inLoop() { return this.baseLoop || this.loopDepth > 0; }
  resolve(cur, p) { return resolveDir(cur, p, this.ctx, { psRoot: true }); }
  moved() { if (this.shared && this.subDepth === 0) this.ctx.topMoved = true; }

  // Statements until EOF or the closing character. In PowerShell the current
  // location belongs to the whole session, so ( ), $( ) and a block that
  // surely runs don't keep their own: a Set-Location inside still counts
  // afterwards.
  list(closer) {
    const s = this.s;
    const ctx = this.ctx;
    let words = [];
    let redirect = false;
    let call = false;
    let pipeStart = copyLoc(this.loc);
    let orBase = null;
    const afterOp = () => words.length > 0 && words[words.length - 1].assignOp === true;
    const endCommand = () => { if (words.length && !this.stopped) this.command(words); words = []; redirect = false; call = false; };
    const endPipeline = (kind) => {
      endCommand();
      if (kind === 'bg') this.loc = copyLoc(pipeStart); // a background job runs elsewhere
      if (orBase && !sameLoc(orBase, this.loc)) this.loc = unknownLoc(this.loc);
      orBase = null;
      pipeStart = copyLoc(this.loc);
      if (this.shared && this.subDepth === 0 && !sameLoc(this.loc, ctx.startLoc)) ctx.topMoved = true;
    };
    while (this.i < s.length) {
      tick(ctx);
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\r') { this.i++; continue; }
      if (c === '`' && (s[this.i + 1] === '\n' || (s[this.i + 1] === '\r' && s[this.i + 2] === '\n'))) { this.i += s[this.i + 1] === '\r' ? 3 : 2; continue; }
      if (c === '<' && s[this.i + 1] === '#') { const e = s.indexOf('#>', this.i + 2); this.i = e < 0 ? s.length : e + 2; continue; }
      if (c === '#') { while (this.i < s.length && s[this.i] !== '\n') this.i++; continue; }
      if (c === '\n' || c === ';') { this.i++; endPipeline('end'); continue; }
      if (c === closer) { this.i++; endPipeline('end'); return closer; }
      if (c === ')' || c === '}') { this.i++; endPipeline('end'); continue; }
      if (c === '&') {
        if (s[this.i + 1] === '&') { this.i += 2; endPipeline('end'); continue; }
        this.i++;
        // & at the start of a command, or of an assignment's right side, is the call operator.
        if (!words.length || afterOp()) { call = true; continue; }
        endPipeline('bg'); continue;
      }
      if (c === '|') {
        if (s[this.i + 1] === '|') { this.i += 2; endPipeline('end'); orBase = copyLoc(this.loc); continue; }
        this.i++; endCommand(); continue;
      }
      if (c === '(') {
        this.i++;
        this.nest(() => this.list(')'));
        // param(...) is a statement of its own: what follows on the line is the next one.
        if (words.length === 1 && words[0].lit && words[0].v.toLowerCase() === 'param') { words = []; call = false; continue; }
        // & (...): the call operator on what the parentheses give.
        if (words.length || call) words.push({ v: '', dyn: true, glob: false, lit: false, quoted: false, call: call && (!words.length || afterOp()) });
        continue;
      }
      if (c === '{') {
        this.i++;
        const r = this.block(words, call);
        if (r === true) { words = []; call = false; continue; }
        words.push(r || { v: '', dyn: true, glob: false, lit: false, quoted: false, block: true });
        continue;
      }
      if (c === '>' || ((c === '*' || /[0-9]/.test(c)) && s[this.i + 1] === '>')) {
        this.i += c === '>' ? 1 : 2;
        if (s[this.i] === '>') this.i++;
        if (s[this.i] === '&' && /[0-9]/.test(s[this.i + 1] || '')) { this.i += 2; continue; }
        redirect = true;
        continue;
      }
      // $x = ..., $x=..., $n += 1: the operator is a word of its own.
      if (!redirect && words.length && words.every(isPsTarget)) {
        const op = PS_ASSIGN_OP.exec(s.slice(this.i, this.i + 4));
        if (op) { words.push({ v: op[0], dyn: false, glob: false, lit: true, quoted: false, assignOp: true }); this.i += op[0].length; continue; }
      }
      const w = this.readWord();
      if (redirect) { redirect = false; continue; }
      if (call && (!words.length || afterOp())) w.call = true;
      words.push(w);
    }
    endPipeline('end');
    return '';
  }

  // Reads a block without running it: kept for later, or run elsewhere.
  // Returns whether it held a commit.
  aside() {
    const out = this.ctx.out;
    const n = [out.sites.length, out.loops.length, out.unresolved.length];
    const saved = copyLoc(this.loc);
    this.subDepth++;
    try { this.nest(() => this.list('}')); } finally { this.subDepth--; }
    const had = out.sites.length > n[0] || out.unresolved.length > n[2];
    out.sites.length = n[0]; out.loops.length = n[1]; out.unresolved.length = n[2];
    this.loc = saved;
    return had;
  }

  // A { } block, at this.i just past the brace. Returns true when it was a
  // whole statement (a function definition), which ends the words before
  // it; otherwise the word that stands for the block, or null.
  block(words, call) {
    const ctx = this.ctx;
    const out = ctx.out;
    const a = psAssignEnd(words);
    const rest = words.slice(a);
    const lw = rest.map(w => (w.dyn || w.quoted ? '' : w.v.toLowerCase()));
    const head = lw[0] || '';
    // function f { } / filter f { }: kept, read again at each call.
    if (!a && (head === 'function' || head === 'filter') && rest.length >= 2) {
      const start = this.i;
      this.aside();
      const name = psFuncName(lw[1]);
      const text = this.s.slice(start, Math.max(start, this.i - 1));
      // function f($d) or param(...): the call's words are bound to the
      // parameters, so $args and @args are not those words.
      const params = rest.length > 2 || /^\s*(?:\[[^\]]*\]\s*)*param\s*\(/i.test(text);
      if (name && (ctx.psFuncs.size < 200 || ctx.psFuncs.has(name))) ctx.psFuncs.set(name, { text, params });
      return true;
    }
    if (!rest.length && !call) {
      // A script block as a value ({ } alone, $sb = { }): it runs only when
      // called, with & $sb, . $sb, $sb.Invoke() or Invoke-Command $sb.
      const start = this.i;
      const had = this.aside();
      const m = a === 2 && /^\$(?:(?:global|script|local|private):)?(\w+)$/i.exec(words[0].v);
      if (m && (ctx.psBlocks.size < 50 || ctx.psBlocks.has(m[1].toLowerCase()))) {
        ctx.psBlocks.set(m[1].toLowerCase(), { text: this.s.slice(start, Math.max(start, this.i - 1)), had, used: false });
      }
      return null;
    }
    // The keyword or command the block belongs to: the last plain word.
    let kw = '';
    for (let k = lw.length - 1; k >= 0; k--) if (lw[k] && !lw[k].startsWith('-')) { kw = lw[k]; break; }
    if (PS_ICM.has(head)) {
      // Runs here unless a parameter, which may come after the block, sends
      // it to another computer: settled in invoke().
      const n = [out.sites.length, out.loops.length, out.unresolved.length];
      const base = copyLoc(this.loc);
      this.subDepth++;
      try { this.nest(() => this.list('}')); } finally { this.subDepth--; }
      const end = this.loc;
      this.loc = base;
      return { v: '', dyn: true, glob: false, lit: false, quoted: false, block: true, icm: { n, m: [out.sites.length, out.loops.length, out.unresolved.length], end } };
    }
    const parallel = (head === 'foreach-object' || head === '%') && rest.some(w => !w.quoted && /^-pa(?:r(?:a(?:l(?:l(?:e(?:l)?)?)?)?)?)?$/i.test(w.v));
    if (parallel || PS_ELSEWHERE.has(head) || PS_ELSEWHERE.has(kw)) {
      // Runs in another process, or later: its folder is its own.
      if (this.aside()) out.unresolved.push(WHY.unrecognized);
      return null;
    }
    if (call || PS_ALWAYS.has(kw) || PS_ALWAYS.has(head)) {
      const st = [this.stopped, this.stopReason];
      const fin = kw === 'finally';
      // A finally block runs after a return too.
      if (fin) { this.stopped = false; this.stopReason = null; }
      this.nest(() => this.list('}'));
      if (fin) { if (st[0] && !this.stopped) [this.stopped, this.stopReason] = st; }
      // & { return }: the return ends only the block.
      else if (kw !== 'try' && !st[0] && this.stopReason === 'return') { this.stopped = false; this.stopReason = null; }
      return null;
    }
    const loop = PS_LOOP.has(kw) || PS_LOOP.has(head);
    const base = copyLoc(this.loc);
    // A cmdlet's block (ForEach-Object { return }): a return ends only the block.
    const ownReturn = !PS_KEYWORDS.has(kw) && !PS_KEYWORDS.has(head);
    const rets = this.retLocs.length;
    if (loop) this.loopDepth++;
    this.maybeDepth++;
    try { this.nest(() => this.list('}')); } finally { this.maybeDepth--; if (loop) this.loopDepth--; }
    if (ownReturn) this.retLocs.length = rets;
    if (!sameLoc(this.loc, base)) this.loc = unknownLoc(this.loc);
    return null;
  }

  nest(fn) {
    if (this.depth >= MAX_DEPTH * 4) { this.ctx.out.unresolved.push(WHY.nested); this.i = this.s.length; return; }
    this.depth++;
    try { fn(); } finally { this.depth--; }
  }

  readWord() {
    const s = this.s;
    const start = this.i;
    let v = '';
    let dyn = false;
    let glob = false;
    let quoted = false;
    // Here-strings: @' or @" at the end of a line, closed by '@ or "@ at the
    // start of a line.
    if (s[this.i] === '@' && (s[this.i + 1] === "'" || s[this.i + 1] === '"') && /^[ \t]*\r?\n/.test(s.slice(this.i + 2, this.i + 40))) {
      const q = s[this.i + 1];
      const nl = s.indexOf('\n', this.i);
      const endRe = new RegExp(`\\n${q}@`, 'g');
      endRe.lastIndex = nl;
      const m = endRe.exec(s);
      const body = s.slice(nl + 1, m ? m.index : s.length).replace(/\r$/, '');
      this.i = m ? m.index + 3 : s.length;
      if (q === '"' && /[$`]/.test(body)) dyn = true;
      return { v: body, dyn, glob: false, lit: false, quoted: true };
    }
    while (this.i < s.length) {
      const c = s[this.i];
      if (PS_META.has(c) || c === '\r') break;
      // $x=...: the variable ends at the assignment operator.
      if ((c === '=' || s[this.i + 1] === '=') && s[start] === '$' && this.i > start && PS_ASSIGN_OP.test(s.slice(this.i, this.i + 4)) &&
        /^\$(?:\{[^}]*\}|[\w:]+)(?:\.\w+|\[[^\]]*\])*$/.test(s.slice(start, this.i))) break;
      if (c === '`') {
        if (s[this.i + 1] === '\r' && s[this.i + 2] === '\n') { this.i += 3; continue; }
        if (this.i + 1 < s.length && s[this.i + 1] !== '\n') v += s[this.i + 1];
        this.i += 2; quoted = true; continue;
      }
      if (c === "'") {
        this.i++;
        while (this.i < s.length) {
          if (s[this.i] === "'") { if (s[this.i + 1] === "'") { v += "'"; this.i += 2; continue; } this.i++; break; }
          v += s[this.i++];
        }
        quoted = true; continue;
      }
      if (c === '"') { this.i++; const r = this.readDouble(); v += r.v; dyn = dyn || r.dyn; quoted = true; continue; }
      if (c === '$' || (c === '@' && (s[this.i + 1] === '(' || s[this.i + 1] === '{'))) {
        const r = this.readDollar();
        if (r) { v += r.v; dyn = dyn || r.dyn; continue; }
      }
      if (c === '*' || c === '?' || c === '[') glob = true;
      v += c; this.i++;
    }
    const lit = !quoted && !dyn && s.slice(start, this.i) === v;
    return { v, dyn, glob, lit, quoted };
  }

  readDouble() {
    const s = this.s;
    let v = '';
    let dyn = false;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '"') { if (s[this.i + 1] === '"') { v += '"'; this.i += 2; continue; } this.i++; break; }
      if (c === '`') {
        const n = s[this.i + 1] || '';
        const esc = { n: '\n', t: '\t', r: '\r', 0: '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' };
        v += Object.prototype.hasOwnProperty.call(esc, n) ? esc[n] : n;
        this.i += 2; continue;
      }
      if (c === '$') { const r = this.readDollar(); if (r) { v += r.v; dyn = dyn || r.dyn; continue; } }
      v += c; this.i++;
    }
    return { v, dyn };
  }

  // $( ), @( ), $name, ${name}, $env:NAME. Subexpressions run in the same
  // session, so their folder changes count.
  readDollar() {
    const s = this.s;
    const n = s[this.i + 1];
    if (n === '(') {
      this.i += 2;
      this.nest(() => this.list(')'));
      return { v: '', dyn: true };
    }
    if (n === '{' && s[this.i] === '@') {
      this.i += 2;
      let level = 1;
      while (this.i < s.length && level) { const c = s[this.i++]; if (c === '{') level++; else if (c === '}') level--; }
      return { v: '', dyn: true };
    }
    if (s[this.i] === '@') return null;
    if (n === '{') {
      const e = s.indexOf('}', this.i + 2);
      const inner = s.slice(this.i + 2, e < 0 ? s.length : e);
      this.i = e < 0 ? s.length : e + 1;
      return this.variable(inner);
    }
    const m = /^(?:env:)?[A-Za-z_][A-Za-z0-9_]*|^[?$^_]/i.exec(s.slice(this.i + 1, this.i + 200));
    if (!m) return null;
    this.i += 1 + m[0].length;
    return this.variable(m[0]);
  }

  variable(name) {
    const n = name.toLowerCase();
    const home = this.ctx.home;
    if ((n === 'home' || n === 'env:userprofile' || n === 'env:home') && home) return { v: home, dyn: false };
    if (n === 'pwd' && this.loc.cur) return { v: this.loc.cur, dyn: false };
    return { v: '$' + name, dyn: true };
  }

  sub(text, loc, Kind = Pwsh, inLoop = this.inLoop, mode = 'child', fargs) { return subParse(this, text, loc, Kind, inLoop, mode, fargs); }

  // A location path, with PowerShell's own provider prefixes taken off.
  locPath(w, literal) {
    if (w.dyn) return null;
    const p = w.v.replace(/^(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/i, '');
    if (!literal && /[*?[\]]/.test(p)) return null; // -Path takes wildcards
    if (p === '-' || p === '+') return null; // location history (PowerShell 7)
    return this.resolve(this.loc.cur, p);
  }

  // Set-Location / Push-Location arguments: the target, or undefined when the
  // command changes nothing (-WhatIf, or no path).
  locTarget(args) {
    let target;
    let positional = null;
    let literal = false;
    let named = null;
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      const sw = !a.quoted && /^-([A-Za-z][A-Za-z0-9]*):\$(true|false)$/i.exec(a.v);
      if (sw) {
        if (psParam(sw[1]).kind === 'whatif' && sw[2].toLowerCase() === 'true') return { whatif: true };
        continue;
      }
      const m = !a.quoted && !a.dyn && /^-([A-Za-z][A-Za-z0-9]*)(?::(.*))?$/.exec(a.v);
      if (m) {
        const p = psParam(m[1]);
        if (p.kind === 'whatif') return { whatif: true };
        if (p.kind === 'switch' || p.kind === 'unknown') continue;
        const val = m[2] !== undefined ? { ...a, v: m[2] } : args[++k];
        if (!val) continue;
        if (p.name === 'path' || p.kind === 'literal') { named = val; literal = p.kind === 'literal'; }
        if (p.name === 'stackname') return { stack: true };
        continue;
      }
      if (positional === null) positional = a;
    }
    const w = named || positional;
    if (w) target = this.locPath(w, literal);
    return { target, given: !!w };
  }

  // A stored script block named by a word: $sb (asHead: & $sb or . $sb), or
  // $sb.Invoke() as a command of its own.
  storedBlock(w, asHead) {
    if (!w || !w.dyn) return null;
    const re = asHead && !w.call ? /^\$(?:(?:global|script|local|private):)?(\w+)\.(?:invoke|invokereturnasis)$/i : /^\$(?:(?:global|script|local|private):)?(\w+)$/i;
    const m = re.exec(w.v);
    return m ? this.ctx.psBlocks.get(m[1].toLowerCase()) || null : null;
  }

  runStored(b) {
    b.used = true;
    this.loc = this.sub(b.text, this.loc, Pwsh, this.inLoop, 'same');
    this.afterSub();
  }

  // An exit in a block, a function or iex text ends the whole script.
  afterSub() { if (this.childStop === 'exit') { this.stopped = true; this.stopReason = 'exit'; } }

  // Set-Alias / New-Alias name value. One set where it may not run is kept as
  // maybe: a location cmdlet called through it leaves the folder unknown.
  alias(args) {
    let name = null;
    let value = null;
    const pos = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      const m = !a.quoted && !a.dyn && /^-([A-Za-z]+)(?::(.*))?$/.exec(a.v);
      if (!m) { pos.push(a); continue; }
      const n = m[1].toLowerCase();
      const val = m[2] !== undefined ? { ...a, v: m[2] } : null;
      if ('name'.startsWith(n)) name = val || args[++k];
      else if ('value'.startsWith(n)) value = val || args[++k];
      else if (['description', 'option', 'scope'].some(f => f.startsWith(n)) && !val) k++;
    }
    name = name || pos.shift();
    value = value || pos.shift();
    if (!name || !value || name.dyn || this.subDepth > 0) return;
    const n = name.v.toLowerCase();
    const target = value.dyn ? '' : value.v.toLowerCase();
    // Redefining a built-in alias (cd, popd) fails without -Option AllScope
    // -Force, so whether it took isn't known.
    const maybe = this.maybeDepth > 0 || !target || PS_ALIASES.has(n);
    if (this.ctx.psAliases.size < 100 || this.ctx.psAliases.has(n)) this.ctx.psAliases.set(n, { target, maybe });
  }

  // Remove-Item alias:go, Remove-Alias go: the name is gone (where it surely
  // runs), or may be.
  unalias(names) {
    for (const n of names) {
      if (this.subDepth > 0) return;
      const sure = this.maybeDepth === 0;
      const e = this.ctx.psAliases.get(n);
      if (sure && e && !PS_ALIASES.has(n)) this.ctx.psAliases.delete(n);
      else this.ctx.psAliases.set(n, { target: e ? e.target : '', maybe: !sure || (e ? e.maybe : false), gone: sure });
    }
  }

  // What a name means after the aliases this command set or removed: the
  // command, whether that is unsure, and whether the name is gone.
  aliasOf(lname) {
    let n = lname;
    let unsure = false;
    for (let g = 0; g < 4; g++) {
      const e = this.ctx.psAliases.get(n);
      if (!e) break;
      if (e.maybe) unsure = true;
      if (e.gone) return { name: n, unsure, gone: !unsure };
      if (!e.target) return { name: n, unsure: true };
      n = e.target;
    }
    return n === lname && !unsure ? null : { name: n, unsure };
  }

  // Invoke-Command: its block runs here, now, unless a parameter or a second
  // positional argument (a computer name) may send it elsewhere.
  invoke(args) {
    const out = this.ctx.out;
    let remote = false;
    let unsure = false;
    let positional = 0;
    const cands = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      const m = !a.quoted && !a.dyn && /^-([A-Za-z]+)(:.*)?$/.exec(a.v);
      if (m) {
        const p = icmParam(m[1]);
        if (p === 'remote') { remote = true; continue; }
        if (p === 'unknown') { unsure = true; continue; }
        if (p === 'block' && m[2] === undefined && args[k + 1]) cands.push(args[++k]);
        else if (p === 'value' && m[2] === undefined) k++;
        continue;
      }
      positional++;
      cands.push(a);
    }
    const local = !remote && positional <= 1;
    const blk = cands.find(w => w.icm);
    if (blk) {
      const { n, m, end } = blk.icm;
      // A parameter not known: the block may have run here or not.
      if (local && unsure) { if (!sameLoc(end, this.loc)) { this.loc = unknownLoc(this.loc); this.moved(); } return; }
      if (local) { this.loc = end; return; }
      const had = m[0] > n[0] || m[2] > n[2];
      out.sites.splice(n[0], m[0] - n[0]); out.loops.splice(n[1], m[1] - n[1]); out.unresolved.splice(n[2], m[2] - n[2]);
      if (had) out.unresolved.push(WHY.unrecognized);
      return;
    }
    const sb = cands.map(w => this.storedBlock(w, false)).find(Boolean);
    if (sb) {
      if (local && unsure) {
        const before = copyLoc(this.loc);
        this.runStored(sb);
        if (!sameLoc(this.loc, before)) this.loc = unknownLoc(this.loc);
      } else if (local) this.runStored(sb);
      else { sb.used = true; if (sb.had) out.unresolved.push(WHY.unrecognized); }
      return;
    }
    if (mentionsCommit(args, 0, this.ctx.platform)) out.unresolved.push(WHY.unrecognized);
  }

  command(words) {
    const ctx = this.ctx;
    // In a function: @args is the words it was called with, $args[N] one of them.
    if (ctx.fargs && words.some(w => w.v === '@args' || /^\$args\[\d+\]$/i.test(w.v))) {
      const fa = ctx.fargs;
      words = words.flatMap(w => {
        if (w.v === '@args' && !w.quoted) return fa.map(a => ({ ...a, call: false }));
        const m = w.dyn && /^\$args\[(\d+)\]$/i.exec(w.v);
        if (m) return fa[Number(m[1])] ? [{ ...fa[Number(m[1])], call: false }] : [];
        return [w];
      });
      if (!words.length) return;
    }
    let head = words[0];
    // $env:GIT_DIR = ... changes what a later git sees; = $null or '' and
    // Remove-Item Env:GIT_DIR, where they surely run, undo it.
    const envSet = /^\$env:(GIT_(?:DIR|WORK_TREE))$/i.exec(head.v);
    if (envSet && words[1] && words[1].assignOp) {
      const name = envSet[1].toUpperCase();
      const v = words[2];
      const clears = words.length === 3 && v && (v.v === '$null' || (v.quoted && !v.dyn && v.v === ''));
      if (!clears) ctx.gitVars.add(name);
      else if (this.subDepth === 0 && this.maybeDepth === 0) ctx.gitVars.delete(name);
      return;
    }
    if (words.some(w => /env:GIT_(?:DIR|WORK_TREE)\b|SetEnvironmentVariable\W+GIT_(?:DIR|WORK_TREE)/i.test(w.v))) {
      const a0 = words[psAssignEnd(words)] || head;
      const lname0 = a0.dyn ? '' : a0.v.toLowerCase();
      if (/^(?:remove-item|ri|rm|del|erase|rd|rmdir)$/.test(lname0)) {
        if (this.subDepth === 0 && this.maybeDepth === 0) {
          for (const w of words) { const m = /^env:(GIT_(?:DIR|WORK_TREE))$/i.exec(w.v); if (m) ctx.gitVars.delete(m[1].toUpperCase()); }
        }
        return;
      }
      if (/^(?:set-item|si|new-item|ni|set-variable|sv)$/.test(lname0) || /SetEnvironmentVariable/i.test(words.map(w => w.v).join(' '))) {
        for (const w of words) { const m = /GIT_(?:DIR|WORK_TREE)/i.exec(w.v); if (m) ctx.gitVars.add(m[0].toUpperCase()); }
        return;
      }
    }
    // $x = <command>: the command runs, and its output is what's stored.
    const a = psAssignEnd(words);
    if (a) {
      const targets = words.slice(0, a - 1);
      words = words.slice(a);
      if (!words.length) return;
      head = words[0];
      // $sb2 = $sb: the same block under another name.
      const src = words.length === 1 && this.storedBlock(head, false);
      const tm = targets.length === 1 && /^\$(?:(?:global|script|local|private):)?(\w+)$/i.exec(targets[0].v);
      if (src && tm) { if (ctx.psBlocks.size < 50 || ctx.psBlocks.has(tm[1].toLowerCase())) ctx.psBlocks.set(tm[1].toLowerCase(), src); return; }
    }
    // . <block, $sb or script>: runs here, like &.
    if (head.lit && head.v === '.' && words.length > 1) {
      words = words.slice(1);
      head = { ...words[0], call: true };
      words[0] = head;
    }
    if (head.dyn) {
      // & $sb, . $sb, $sb.Invoke(): a stored script block runs here.
      const sb = this.storedBlock(head, true);
      if (sb) { this.runStored(sb); return; }
      // & "$env:ProgramFiles\Git\bin\git.exe" commit: git by a path.
      if (isGitName(head.v, ctx.platform)) { gitSite(words.slice(1), this.loc.cur, ctx, { inLoop: this.inLoop, resolve: (d, p) => this.resolve(d, p) }); return; }
      if (mentionsCommit(words, 0, ctx.platform) || words.slice(1).some(w => w.v === 'commit')) ctx.out.unresolved.push(WHY.unrecognized);
      // & $x, . $x, & (...): code not known here runs in this session and
      // may change the location. (. { } was read where it stands.)
      if (head.call && !head.block) { this.loc = unknownLoc(this.loc); this.moved(); }
      return;
    }
    const name = head.v;
    let lname = name.toLowerCase();
    // Microsoft.PowerShell.Management\Set-Location: that module's cmdlet,
    // never a function or an alias.
    const qualified = !head.quoted && /^[a-z][\w.]*\\([a-z][\w-]*)$/i.exec(name);
    if (qualified) lname = qualified[1].toLowerCase();
    // return and exit: see Bash. A return in a block that may not run leaves
    // the folder at that point as a possible end of the function.
    if (!head.call && (lname === 'return' || lname === 'exit')) {
      if (this.subDepth > 0) return;
      if (this.maybeDepth === 0) { this.stopped = true; this.stopReason = lname; }
      else if (lname === 'return' && this.fn) this.retLocs.push(copyLoc(this.loc));
      return;
    }
    if (!head.call && PS_KEYWORDS.has(lname)) return;
    const isLocCmd = (n) => PS_SETLOC.has(n) || PS_PUSH.has(n) || PS_POP.has(n);
    const ra = qualified ? null : this.aliasOf(lname);
    if (ra) {
      // A name that is gone runs nothing; one that may mean a location
      // cmdlet, or may not, leaves the folder unknown.
      if (ra.gone) { if (mentionsCommit(words, 1, ctx.platform)) ctx.out.unresolved.push(WHY.unrecognized); return; }
      if (ra.unsure && (isLocCmd(lname) || isLocCmd(ra.name) || ra.name === lname)) {
        this.loc = unknownLoc(this.loc); this.moved();
        if (mentionsCommit(words, 1, ctx.platform) || isGitName(ra.name, ctx.platform)) ctx.out.unresolved.push(WHY.unrecognized);
        return;
      }
      lname = ra.name;
    }
    const base = baseName(lname);
    const args = words.slice(1);
    if (/^(?:set-alias|sal|new-alias|nal)$/.test(lname)) { this.alias(args); return; }
    if (lname === 'remove-alias' || /^(?:remove-item|ri|rm|del|erase|rd|rmdir)$/.test(lname)) {
      const names = lname === 'remove-alias'
        ? args.filter(a => !a.dyn && !/^-/.test(a.v)).map(a => a.v.toLowerCase())
        : args.map(a => /^alias:(.+)$/i.exec(a.v)).filter(Boolean).map(m => m[1].toLowerCase());
      if (names.length) { this.unalias(names); return; }
    }
    const fname = psFuncName(lname);
    if (!qualified && ctx.psFuncs.has(fname) && !PS_ALIASES.has(lname)) {
      const f = ctx.psFuncs.get(fname);
      this.loc = this.sub(f.text, this.loc, Pwsh, this.inLoop, 'func', f.params ? null : args);
      this.afterSub();
      return;
    }
    const l = this.loc;
    if (PS_SETLOC.has(lname) || PS_PUSH.has(lname) || PS_POP.has(lname)) this.moved();
    if (PS_SETLOC.has(lname)) {
      const t = this.locTarget(args);
      if (t.whatif || t.stack) return;
      if (!t.given) { this.loc = unknownLoc(l); return; } // no path: home in PowerShell 7, nothing in 5.1
      l.prev = l.cur; l.cur = t.target;
      return;
    }
    if (PS_PUSH.has(lname)) {
      const t = this.locTarget(args);
      if (t.whatif) return;
      if (l.stack.length >= STACK_MAX) { this.loc = unknownLoc(l); return; }
      l.stack.push(t.stack ? null : l.cur);
      if (t.given) { l.prev = l.cur; l.cur = t.target; }
      return;
    }
    if (PS_POP.has(lname)) {
      const t = this.locTarget(args);
      if (t.whatif) return;
      if (t.stack) { this.loc = unknownLoc(l); return; }
      if (!l.stack.length) return;
      l.prev = l.cur; l.cur = l.stack.pop();
      return;
    }
    if (PS_ICM.has(lname)) { this.invoke(args); return; }
    if (isGitName(lname, ctx.platform)) {
      gitSite(args, l.cur, ctx, { inLoop: this.inLoop, resolve: (d, p) => this.resolve(d, p) });
      return;
    }
    if (PS_IEX.has(lname)) {
      const rest = args.filter(x => !/^-command$/i.test(x.v));
      if (rest.length !== 1 || rest[0].dyn) {
        if (/\bcommit\b/.test(rest.map(x => x.v).join(' '))) ctx.out.unresolved.push(WHY.variable);
        // iex $cmd: code from a variable may change the location.
        if (rest.some(x => x.dyn && /\$/.test(x.v))) { this.loc = unknownLoc(this.loc); this.moved(); }
        return;
      }
      this.loc = this.sub(rest[0].v, this.loc, Pwsh, this.inLoop, 'same');
      this.afterSub();
      return;
    }
    if (PWSH.has(base)) { pwshCommandLine(args, this, ctx, this.inLoop); return; }
    if (SHELLS.has(base)) {
      let k = 1;
      let hasC = false;
      while (k < words.length && /^-/.test(words[k].v)) { if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(words[k].v)) { hasC = true; k++; break; } k++; }
      if (hasC && words[k] && !words[k].dyn) this.sub(words[k].v, copyLoc(l), Bash, this.inLoop, 'child');
      else if (hasC && words[k] && /\bcommit\b/.test(words[k].v)) ctx.out.unresolved.push(WHY.variable);
      return;
    }
    // A stored block handed to a cmdlet (ForEach-Object $sb, Where-Object
    // -FilterScript $sb) may run here, once, many times or not at all; one
    // handed to Start-Job and the like runs elsewhere.
    const passed = PS_RUNS_BLOCKS.has(lname) || PS_ELSEWHERE.has(lname) ? args.map(w => this.storedBlock(w, false)).filter(Boolean) : [];
    if (passed.length) {
      for (const b of passed) {
        b.used = true;
        if (PS_ELSEWHERE.has(lname)) { if (b.had) ctx.out.unresolved.push(WHY.unrecognized); continue; }
        const before = copyLoc(this.loc);
        this.loc = this.sub(b.text, this.loc, Pwsh, true, 'same');
        if (!sameLoc(this.loc, before)) this.loc = unknownLoc(this.loc);
      }
      return;
    }
    if (PS_TEXT.has(lname)) return;
    if (mentionsCommit(words, 1, ctx.platform)) ctx.out.unresolved.push(WHY.unrecognized);
  }
}

// pwsh / powershell arguments: -Command runs the rest as PowerShell, in a new
// process that starts in the current folder (or -WorkingDirectory).
function pwshCommandLine(args, from, ctx, inLoop) {
  const VALUE = /^-(?:executionpolicy|ex|ep|windowstyle|w|inputformat|inf|if|outputformat|of|o|version|v|configurationname|config|custompipename|settingsfile|settings|workingdirectory|wd|wo)$/i;
  let k = 0;
  let start = from.loc.cur;
  while (k < args.length) {
    const v = args[k].v;
    if (/^-(?:command|c)$/i.test(v)) { k++; break; }
    if (/^-(?:file|f|encodedcommand|e|ec|enc)$/i.test(v)) return;
    if (/^-(?:workingdirectory|wd|wo)$/i.test(v)) {
      const d = args[k + 1];
      start = d && !d.dyn ? resolveDir(from.loc.cur, d.v, ctx, { psRoot: true }) : null;
    }
    if (!v.startsWith('-')) break; // a bare first argument is the command too
    k += VALUE.test(v) ? 2 : 1;
  }
  const rest = args.slice(k);
  if (!rest.length) return;
  if (rest.some(x => x.dyn)) { if (/\bcommit\b/.test(rest.map(x => x.v).join(' '))) ctx.out.unresolved.push(WHY.variable); return; }
  from.sub(rest.map(x => x.v).join(' '), loc0(start), Pwsh, inLoop);
}

function parse(text, shell, start, platform, home, deadlineMs) {
  const out = { sites: [], loops: [], unresolved: [] };
  const ctx = {
    platform, home, out, level: 0, steps: 0, deadline: Date.now() + deadlineMs,
    funcs: new Map(), psFuncs: new Map(), psBlocks: new Map(), psAliases: new Map(), files: new Map(), fargs: null,
    gitVars: new Set(), cdpath: false, lastpipe: false, startLoc: loc0(start), topMoved: false,
  };
  const Kind = shell === 'powershell' ? Pwsh : Bash;
  const p = new Kind(text, ctx, loc0(start), 0);
  try {
    p.list('');
  } catch (e) {
    // Too slow, or a fault in the parser: a commit is never lost silently.
    out.unresolved.push(e === TOO_LONG ? WHY.tooLong : WHY.unrecognized);
  }
  // A quote or ${ } that never closed swallowed the rest of the command as
  // text. The shell would have refused it, so this is the parser reading it
  // wrong: say so rather than lose a commit after it.
  if (ctx.unterminated && !out.sites.length && !out.unresolved.length && COMMIT.test(text)) out.unresolved.push(WHY.unrecognized);
  // A stored PowerShell block with a commit in it, used again in a way not
  // followed (passed to a cmdlet or a function).
  for (const [name, b] of ctx.psBlocks) {
    if (!b.had || b.used) continue;
    const refs = text.match(new RegExp(String.raw`\$(?:(?:global|script|local|private):)?(?:${name}|\{${name}\})(?![\w])`, 'gi')) || [];
    if (refs.length > 1) out.unresolved.push(WHY.unrecognized);
  }
  // Each reason is one log line, and the list travels in an environment
  // variable: "nested" and "too-long" once each, and at most MAX_UNRESOLVED.
  const once = new Set();
  out.unresolved = out.unresolved.filter(w => (w === WHY.nested || w === WHY.tooLong ? (once.has(w) ? false : once.add(w)) : true)).slice(0, MAX_UNRESOLVED);
  return { out, final: p.loc.cur, topMoved: ctx.topMoved };
}

// Where each git commit in `command` ran, in order. shell: 'bash' (Git Bash on
// Windows) or 'powershell'. cwd: the folder the command started in.
// startKnown false: cwd is where the command ended (Claude Code's PostToolUse
// cwd). It is the start folder too only if the command never moves the
// shell's own folder; otherwise the start folder is taken as unknown, and a
// commit whose folder depends on it is unresolved. (Ending where it began is
// not enough: git commit && cd /abs/other, read from /abs/other, ends there.)
// Returns { sites: [folder, ...], loops: [folder of a commit inside a loop, ...],
//           unresolved: [reason, ...], end?, startUnknown? }.
function commitSites(command, { shell = 'bash', cwd = process.cwd(), platform = process.platform, home = os.homedir(), startKnown = true, deadlineMs = 1500 } = {}) {
  const text = typeof command === 'string' ? command.slice(0, MAX_LEN) : '';
  if (!text) return { sites: [], loops: [], unresolved: [] };
  const P = platform === 'win32' ? path.win32 : path.posix;
  const start = cwd ? P.resolve(String(cwd)) : null;
  const h = home ? P.resolve(String(home)) : '';
  // Past MAX_LEN the command isn't read: a commit there would be missed.
  const cut = (out) => (command.length > MAX_LEN && !out.unresolved.includes(WHY.tooLong) ? { ...out, unresolved: [...out.unresolved, WHY.tooLong] } : out);
  const first = parse(text, shell, start, platform, h, deadlineMs);
  // end: the folder the command ends in, as read (null when not known).
  if (startKnown || (first.final === start && !first.topMoved)) return cut({ ...first.out, end: first.final });
  const second = parse(text, shell, null, platform, h, deadlineMs);
  return cut({ ...second.out, startUnknown: true });
}

module.exports = { isMilestoneCommand, commitSites, resolveDir, WHY };
