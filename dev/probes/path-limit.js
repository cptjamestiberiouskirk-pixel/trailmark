// Where the writer's sandbox stops letting `trailmark.js init` set a repo up
// as the memory folder's path grows (Windows; dev/release-state.md, "From the
// round-7 reruns"). For each wanted length of <memory folder>\archive, makes a
// repo and a Claude config folder under a padded folder in <parent>, runs
// init from the plugin copy given, and prints the lengths, the exit status
// and any refusal. Removes every folder it made; writes nothing else.
//
//   node dev/probes/path-limit.js plugins/trailmark <parent> [lengths]
//
// <parent> should be short, such as a fresh `mktemp -d` folder; lengths are a
// comma list (default 258,262,266,270,274,276,280). Only even lengths can be
// built: the repo path appears twice in the archive path.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const [copy, parentArg, list] = process.argv.slice(2);
if (!copy || !parentArg) { console.error('usage: node dev/probes/path-limit.js <plugin copy> <parent> [lengths]'); process.exit(2); }
const JBM = path.resolve(copy, 'scripts', 'trailmark.js');
const parent = fs.realpathSync.native(parentArg);
const wants = (list || '258,262,266,270,274,276,280').split(',').map(Number);
for (const want of wants) {
  // archive path = base + '\cfg\projects\' + (base + '\repo' as a name) + '\memory\archive'
  //             = 2 * len(base) + 34, with base = parent + '\' + pad + '\jbmem-x'
  const baseLen = Math.floor((want - 34) / 2);
  const padLen = baseLen - parent.length - 1 - '\\jbmem-x'.length;
  if (padLen < 1) { console.log(`${want}: parent too long`); continue; }
  const top = path.join(parent, 'p'.repeat(padLen));
  const base = path.join(top, 'jbmem-x');
  const cfg = path.join(base, 'cfg');
  const repo = path.join(base, 'repo');
  try {
    fs.mkdirSync(repo, { recursive: true });
    const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a'), 'a'); g('add', 'a'); g('commit', '-qm', 'init');
    const proj = path.join(cfg, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(proj, { recursive: true });
    const archive = path.join(proj, 'memory', 'archive');
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
    delete env.JBMEM_DIR; delete env.CLAUDE_CODE_PROJECT_DIR_NAME; delete env.CLAUDE_CODE_ENTRYPOINT;
    const r = spawnSync(process.execPath, [JBM, 'init', '--force'], { cwd: repo, env, encoding: 'utf8' });
    const refused = /refused \S+ to (\S+?)\.?\s/.exec(`${r.stderr || ''} `);
    console.log(`archive ${archive.length} chars, folder holding memory ${proj.length}: exit ${r.status}${refused ? `, refused ${refused[1].replace(/^\\\\\?\\/, '').length}-char path` : ''}`);
  } catch (e) {
    console.log(`${want}: setup failed: ${e.message.split('\n')[0]}`);
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
}
