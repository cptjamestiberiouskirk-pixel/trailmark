// What differs for the ChatGPT desktop app's Codex mode (and the Codex CLI),
// in one place. The rest of the code is shared with trailmark for Claude Code,
// and this copy writes to the same memory folder, so one handoff serves both.
//
// Skill names carry a tm- prefix: Codex lists every installed plugin's
// skills by name, and a plain "checkpoint" could be another plugin's.

'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LAUNCHER = path.join(ROOT, 'scripts', 'trailmark.js');
const skill = (n) => `tm-${n}`;
const skillFile = (n) => path.join(ROOT, 'skills', skill(n), 'SKILL.md');

const CHECKPOINT_SKILL = skill('checkpoint');
// The rule names the skill's file and the launcher by the folder this copy was
// installed in. store.js passes its usablePath as asPath, so each path is
// written only as it is on disk. When either can't be, the rule says so and
// asks for a plain install folder instead of naming a file that isn't there.
const skillRule = (asPath) => {
  const file = asPath(skillFile('checkpoint')), launcher = asPath(LAUNCHER);
  return file && launcher
    ? `Its instructions are in ${file}; follow them, and run trailmark only through ${launcher}. If that fails, tell the user; don't look for or run another trailmark.js.`
    : `Its instructions and the launcher are in the folder trailmark is installed in, whose path isn't written here (it holds characters trailmark doesn't pass on, or is too long), so it can't be run from this session: tell the user to install trailmark in a folder with a plain path, and don't look for or run a trailmark.js.`;
};

const CONTEXT_CHARS = 9000;

module.exports = { HOST: 'codex', AGENT: 'Codex', CONTEXT_CHARS, NAME: 'trailmark-codex', ROOT, LAUNCHER, skill, skillFile, CHECKPOINT_SKILL, skillRule };
