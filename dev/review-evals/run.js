#!/usr/bin/env node
// Runs the regression reviewer of .github/workflows/auto-review.yml on past
// bugs and counts how many it catches. Each case in cases.json names the merge
// commit of the PR that brought a bug in, and the file and lines (in that
// commit's copy) that a later fix changed. The reviewer works in a detached
// worktree at the merge's first parent, with this checkout's REVIEW.md, and
// gets the PR as data in .review/ the way the workflow writes it. A case is
// caught when a blocking finding names the file within 10 lines of a line the
// fix changed.
//   node dev/review-evals/run.js <cases.json> <work dir> [case id ...]
// Environment: CLAUDE_BIN, MODEL_REGRESSION, TOOLS, READ_TOOLS, DENY_TOOLS
// (the workflow's values), EVAL_JOBS (cases at once, default 3).
// Writes <work dir>/results.json and a summary (also to GITHUB_STEP_SUMMARY).
// Exit 0 at or above "evalFloor" of dev/risk-tiers.json, 1 below it, 2 when
// any case could not run (no PR text, no usable output): a partial run is no
// score. It removes each worktree it made, and on Ctrl+C stops the reviewers
// first (not run by a test). It makes each case's folder itself with a create
// that fails if the folder is there, and removes only folders it made that
// way: a folder of a case's name made by anything else, an earlier run's
// worktree included, stops that case. The score is the reviewer's alone: in the workflow two
// verifiers must also confirm a finding.
'use strict';
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const NEAR = 10;
const LIMIT_MS = 25 * 60 * 1000;

// The reviewer's prompt, word for word as the workflow builds it for one lens.
const reviewerPrompt = (lens, pr) => `You are the ${lens} reviewer for PR ${pr}. Follow REVIEW.md sections "Every reviewer" and "Lens: ${lens}" exactly. Your final message is the JSON object REVIEW.md describes and nothing else.`;
const reviewerArgs = (env, prompt) => ['-p', prompt, '--model', env.MODEL_REGRESSION, '--tools', env.TOOLS, '--restricted', '--strict-mcp-config',
  '--allowedTools', env.READ_TOOLS, '--disallowedTools', env.DENY_TOOLS, '--max-turns', '80', '--output-format', 'json'];

const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 256 << 20 });
const gitBuf = (...a) => execFileSync('git', ['-C', ROOT, ...a], { maxBuffer: 256 << 20 });

// The PR's files as data, as the workflow's "Write the PR's files as data"
// step writes them: regular files only, no instruction or server files.
const SKIPPED = /(^|\/)(claude[^/]*\.md|agents[^/]*\.md|\.mcp\.json)$|(^|\/)\.claude(\/|$)/i;
// A tree name comes from the repo and is not trusted. It is written only when
// each part is a plain name on every system: no `\` or `:` (a separator,
// drive or stream mark on Windows), no empty part, and no part that ends in
// `.` or a space (Windows drops those, so `.. ` opens as `..`). The case
// stops on any other name, and the written path must still fall inside `dir`.
const unsafePath = (p) => /[\\:]/.test(p) || p.split('/').some((s) => s === '' || /[. ]$/.test(s));
// `opts.lsTree` and `opts.blob` stand in for git in tests.
function writeHead(sha, dir, opts = {}) {
  const lsTree = opts.lsTree || ((s) => git('ls-tree', '-r', '-z', '--full-tree', s));
  const blob = opts.blob || ((o) => gitBuf('cat-file', 'blob', o));
  const top = path.resolve(dir) + path.sep;
  const notWritten = [];
  for (const entry of lsTree(sha).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, , obj] = entry.slice(0, tab).split(' ');
    const p = entry.slice(tab + 1);
    if (unsafePath(p) || !path.resolve(dir, p).startsWith(top)) throw new Error(`unsafe path ${JSON.stringify(p)}`);
    if (mode !== '100644' && mode !== '100755') { notWritten.push(`${mode} ${p}`); continue; }
    if (SKIPPED.test(p)) continue;
    fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), blob(obj));
  }
  return notWritten;
}

// The PR's file list the way GitHub's "list pull request files" API gives it.
function fileList(a, b) {
  const STATUS = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied', T: 'changed' };
  const ns = git('diff', '--name-status', '-z', '-M', a, b).split('\0').filter((x) => x !== '');
  const files = [];
  for (let i = 0; i < ns.length;) {
    const k = ns[i++][0];
    const prev = k === 'R' || k === 'C' ? ns[i++] : null;
    const name = ns[i++];
    const diff = git('diff', '-M', a, b, '--', ...(prev ? [prev, name] : [name]));
    const at = diff.indexOf('\n@@');
    const f = { filename: name, status: STATUS[k] || 'modified',
      patch: at >= 0 ? diff.slice(at + 1).replace(/\n$/, '') : (/Binary files/.test(diff) ? null : '') };
    if (prev) f.previous_filename = prev;
    files.push(f);
  }
  return files;
}

// The causing PR's own title and body, as the workflow gives them, so the
// reviewer can read the reasons the PR gave. Without them the case does not
// run: the case's own title names the bug and would give the answer away.
function prText(c) {
  let out;
  try {
    out = execFileSync('gh', ['pr', 'view', String(c.causePr), '--json', 'title,body'],
      { cwd: ROOT, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { throw new Error(`no PR text for #${c.causePr}: ${String(e.stderr || e.message).trim().slice(0, 200)}`); }
  const j = JSON.parse(out);
  if (typeof j.title !== 'string') throw new Error(`no PR title for #${c.causePr}`);
  return { title: j.title, body: String(j.body || '') };
}

// A case id names its folder under the work dir, so it is one plain name.
const ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
function checkId(c) {
  if (!c || typeof c.id !== 'string' || !ID.test(c.id)) throw new Error(`bad case id ${JSON.stringify(c && c.id)}`);
}
// Worktrees this run made and has not removed yet, and the reviewers it
// started, for the end of the run and for Ctrl+C. A folder joins `live` only
// once `git worktree add` has made it, and only a folder in `live` is ever
// deleted.
const live = new Set();
const children = new Set();
function dropWorktree(ws) {
  if (!live.has(ws)) return;
  try {
    execFileSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', ws], { stdio: 'ignore' });
  } catch { /* git has not made it a worktree: the folder alone goes */ }
  fs.rmSync(ws, { recursive: true, force: true });
  live.delete(ws);
}

// `opts.prText` stands in for the gh call in tests.
function prepare(c, work, opts = {}) {
  checkId(c);
  const ws = path.join(work, c.id);
  // A folder that is already there is never this run's, so the case stops.
  if (fs.existsSync(ws)) {
    throw new Error(`${ws} is already there; if an earlier run left it, remove it with: git worktree remove --force "${ws}"`);
  }
  const pr = (opts.prText || prText)(c);
  // git worktree add takes over an empty folder, so a folder made by anything
  // else while gh ran would pass for this run's. The folder is made here
  // instead, with a create that fails if it is there (EEXIST), and joins
  // `live` in the same step; git then fills the empty folder.
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(ws);
  live.add(ws);
  git('worktree', 'add', '--detach', ws, `${c.causeMerge}^1`);
  fs.copyFileSync(path.join(ROOT, 'REVIEW.md'), path.join(ws, 'REVIEW.md'));
  const r = path.join(ws, '.review');
  fs.mkdirSync(path.join(r, 'head'), { recursive: true });
  const notWritten = writeHead(c.causeMerge, path.join(r, 'head'));
  if (notWritten.length) fs.writeFileSync(path.join(r, 'not-written.txt'), notWritten.join('\n') + '\n');
  fs.writeFileSync(path.join(r, 'diff.patch'), gitBuf('diff', '--text', '--no-ext-diff', '--no-textconv', `${c.causeMerge}^1`, c.causeMerge));
  fs.writeFileSync(path.join(r, 'commits.txt'), git('log', '--no-ext-diff', '--format=%h %s%n%b', `${c.causeMerge}^1..${c.causeMerge}`));
  const files = fileList(`${c.causeMerge}^1`, c.causeMerge);
  fs.writeFileSync(path.join(r, 'files.jsonl'), files.map((f) => JSON.stringify(f) + '\n').join(''));
  const tier = require(path.join(ROOT, 'dev', 'tier.js'));
  const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'risk-tiers.json'), 'utf8'));
  fs.writeFileSync(path.join(r, 'tier.json'), JSON.stringify(tier.classify(files, rules, files.length)));
  fs.writeFileSync(path.join(r, 'pr.json'), JSON.stringify(pr));
  fs.writeFileSync(path.join(r, 'prior.json'), '[]');
  return ws;
}

function runReviewer(c, ws, env, out) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env };
    delete childEnv.CLAUDECODE;
    // The workflow gives the reviewer no GitHub token; neither does this.
    delete childEnv.GH_TOKEN;
    delete childEnv.GITHUB_TOKEN;
    const raw = fs.openSync(path.join(out, `raw-${c.id}.json`), 'w');
    const err = fs.openSync(path.join(out, `err-${c.id}.txt`), 'w');
    const p = spawn(env.CLAUDE_BIN, reviewerArgs(env, reviewerPrompt('regression', c.causePr)),
      { cwd: ws, env: childEnv, stdio: ['ignore', raw, err] });
    children.add(p);
    const timer = setTimeout(() => p.kill('SIGKILL'), LIMIT_MS);
    p.on('error', (e) => { clearTimeout(timer); children.delete(p); resolve({ code: null, error: e.message }); });
    p.on('exit', (code, signal) => { clearTimeout(timer); children.delete(p); fs.closeSync(raw); fs.closeSync(err); resolve({ code, signal }); });
  });
}

// The reviewer's JSON as the workflow reads it: the result field, with fence lines dropped.
function parseResult(rawText) {
  try {
    const res = JSON.parse(rawText).result || '';
    return JSON.parse(res.split('\n').filter((l) => !l.startsWith('```')).join('\n'));
  } catch { return null; }
}
const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\.review\/head\//, '');
function caught(c, findings) {
  return (findings || []).some((f) => f.severity === 'blocking' && normPath(f.path) === c.file
    && Number.isInteger(f.line) && c.lines.some((l) => Math.abs(l - f.line) <= NEAR));
}

// 2 when any case has no result (or there are none): a partial run is no
// score. Otherwise 0 at or above the floor, 1 below it.
function exitCode(results, floor) {
  if (results.length === 0 || results.some((r) => r.noResult)) return 2;
  return results.filter((r) => r.caught).length / results.length >= floor ? 0 : 1;
}

function stop() {
  for (const p of children) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  for (const ws of [...live]) {
    try { dropWorktree(ws); } catch (e) { console.error(`worktree ${ws} not removed: ${e.message}`); }
  }
  try { git('worktree', 'prune'); } catch (e) { console.error(`git worktree prune failed: ${e.message}`); }
  process.exit(130);
}

async function main() {
  const [casesPath, workArg, ...only] = process.argv.slice(2);
  if (!casesPath || !workArg) { console.error('usage: node dev/review-evals/run.js <cases.json> <work dir> [case id ...]'); process.exit(2); }
  const env = process.env;
  for (const k of ['CLAUDE_BIN', 'MODEL_REGRESSION', 'TOOLS', 'READ_TOOLS', 'DENY_TOOLS']) {
    if (!env[k]) { console.error(`${k} is not set`); process.exit(2); }
  }
  const all = JSON.parse(fs.readFileSync(casesPath, 'utf8')).cases;
  const cases = only.length ? all.filter((c) => only.includes(c.id)) : all;
  if (cases.length === 0) { console.error('no cases'); process.exit(2); }
  for (const c of cases) {
    try { checkId(c); } catch (e) { console.error(e.message); process.exit(2); }
  }
  if (new Set(cases.map((c) => c.id)).size !== cases.length) { console.error('two cases share an id'); process.exit(2); }
  const work = path.resolve(workArg);
  fs.mkdirSync(work, { recursive: true });
  const results = [];
  process.on('SIGINT', stop);
  let next = 0;
  const one = async () => {
    while (next < cases.length) {
      const c = cases[next++];
      const ws = path.join(work, c.id);
      try {
        prepare(c, work);
        const run = await runReviewer(c, ws, env, work);
        const out = parseResult(fs.readFileSync(path.join(work, `raw-${c.id}.json`), 'utf8'));
        const findings = out && Array.isArray(out.findings) ? out.findings : null;
        results.push({ id: c.id, caught: findings ? caught(c, findings) : false, noResult: !findings, exit: run.code,
          blocking: (findings || []).filter((f) => f.severity === 'blocking').map((f) => ({ path: normPath(f.path), line: f.line, title: String(f.title || '').slice(0, 200) })) });
      } catch (e) {
        results.push({ id: c.id, caught: false, noResult: true, error: e.message });
      } finally {
        if (live.has(ws)) {
          try { dropWorktree(ws); } catch (e) { console.error(`worktree ${ws} not removed: ${e.message}`); }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(env.EVAL_JOBS) || 3) }, one));
  git('worktree', 'prune');
  results.sort((a, b) => a.id.localeCompare(b.id));
  const hits = results.filter((r) => r.caught).length;
  const rate = hits / results.length;
  const floor = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'risk-tiers.json'), 'utf8')).evalFloor;
  fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify({ rate, floor, hits, cases: results.length, results }, null, 2));
  const lines = [`review evals: caught ${hits} of ${results.length} (${rate.toFixed(2)}), floor ${floor}`,
    ...results.map((r) => `- ${r.id}: ${r.caught ? 'caught' : r.noResult ? `no result${r.error ? ` (${r.error})` : ''}` : 'missed'}, ${(r.blocking || []).length} blocking`)];
  console.log(lines.join('\n'));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  process.exit(exitCode(results, floor));
}

module.exports = { reviewerPrompt, reviewerArgs, caught, normPath, parseResult, prText, prepare, dropWorktree, live, checkId, exitCode, writeHead };

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
