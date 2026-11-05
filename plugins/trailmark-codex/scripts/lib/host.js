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
// installed in. store.js passes its fieldText as asData, so those paths reach
// Codex as data (control and invisible characters dropped, bidi overrides
// among them).
const skillRule = (asData) => `Its instructions are in ${asData(skillFile('checkpoint'))}; follow them, and run trailmark only through ${asData(LAUNCHER)}. If that fails, tell the user; don't look for or run another trailmark.js.`;

const CONTEXT_CHARS = 9000;

module.exports = { HOST: 'codex', AGENT: 'Codex', CONTEXT_CHARS, NAME: 'trailmark-codex', ROOT, LAUNCHER, skill, skillFile, CHECKPOINT_SKILL, skillRule };
