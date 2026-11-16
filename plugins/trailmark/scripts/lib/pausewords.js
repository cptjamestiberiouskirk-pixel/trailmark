// The pause watch, launcher side: does the user's prompt say they are about
// to reboot, restart, shut down or close this session? Read before the
// sandbox, on the prompt, which is untrusted text of any size. Only one word
// from WORDS comes out; nothing of the prompt goes further.
//
// English only. A clause matches when it holds a trigger word and every other
// word in it is on ALLOWED, so "restart the server" (server) and "don't
// reboot" (don't) do not. The note this leads to asks Claude to judge, so the
// lists lean to matching less. dev/pause-watch-design.md has the reasons.

'use strict';

const fs = require('fs');

// Only a prompt this long or shorter is read: a statement that one is about
// to reboot is short, and a long prompt that mentions a restart is a task.
const MAX_CHARS = 2000;
// A clause with more words than this is a sentence about something else.
const MAX_WORDS = 16;

// The canonical words that can come out, and the only ones the sandboxed
// hook accepts.
const WORDS = ['reboot', 'restart', 'shut down', 'power off', 'log off', 'sign off', 'turn off', 'close', 'quit', 'exit', 'end'];

// A trigger on its own.
const TRIGGERS = new Map([
  ['reboot', 'reboot'], ['reboots', 'reboot'], ['rebooting', 'reboot'],
  ['restart', 'restart'], ['restarts', 'restart'], ['restarting', 'restart'],
]);
// Two words read as one trigger: first word, then the second word's canonical.
// Maps all the way down: a plain object would answer `constructor` and the
// other names every object has (security review, round 1).
const pair = o => new Map(Object.entries(o));
const PAIRS = new Map([
  ['shut', pair({ down: 'shut down' })], ['shutting', pair({ down: 'shut down' })],
  ['power', pair({ off: 'power off', down: 'power off' })], ['powering', pair({ off: 'power off', down: 'power off' })],
  ['log', pair({ off: 'log off', out: 'log off' })], ['logging', pair({ off: 'log off', out: 'log off' })],
  ['sign', pair({ off: 'sign off', out: 'sign off' })], ['signing', pair({ off: 'sign off', out: 'sign off' })],
  ['turn', pair({ off: 'turn off' })], ['turning', pair({ off: 'turn off' })],
]);
TRIGGERS.set('shutdown', 'shut down');
// A trigger only with a session word in the same clause.
const NEEDS_SESSION = new Map([
  ['close', 'close'], ['closing', 'close'], ['quit', 'quit'], ['quitting', 'quit'],
  ['exit', 'exit'], ['exiting', 'exit'], ['end', 'end'], ['ending', 'end'],
]);
const SESSION = new Set(['session', 'chat', 'conversation', 'claude', 'codex', 'terminal', 'window', 'ide', 'editor', 'vscode']);

// Every other word a matching clause may hold. Left out on purpose: negations
// (not, don't, no, never, without), questions (should, can, could), time
// before or after (after, before, since, if, when), past forms (rebooted),
// and things in a project that restart (server, app, service, it).
const ALLOWED = new Set([
  // people and helpers
  'i', "i'm", 'im', "i'll", "i'd", 'we', "we're", "we'll", "let's", 'lets', 'let', 'me', 'us', 'you',
  'am', 'is', 'are', 'be', 'will', 'going', 'gonna', 'to', 'about', 'need', 'needs', 'have', 'has', 'got', 'gotta', 'must', 'want', 'wanna', 'just', 'do', 'doing', 'time',
  // time
  'now', 'soon', 'shortly', 'quick', 'quickly', 'real', 'right', 'away', 'asap', 'later', 'today', 'tonight', 'night', 'day', 'weekend',
  'in', 'for', 'a', 'an', 'few', 'couple', 'of', 'min', 'mins', 'minute', 'minutes', 'sec', 'secs', 'second', 'seconds', 'moment', 'bit', 'while',
  'back', 'brb', 'bbl', 'afk',
  // filler
  'ok', 'okay', 'alright', 'k', 'cool', 'great', 'thanks', 'thank', 'ty', 'heads', 'up', 'fyi', 'btw', 'well', 'pause', 'pausing', 'break',
  // the machine and the session
  'the', 'my', 'this', 'our', 'your', 'pc', 'computer', 'machine', 'laptop', 'desktop', 'box', 'system', 'os', 'windows', 'mac', 'macbook', 'linux', 'wsl',
  'session', 'sessions', 'chat', 'conversation', 'claude', 'code', 'codex', 'vs', 'vscode', 'terminal', 'shell', 'ide', 'editor', 'window', 'everything', 'all',
  // the usual reasons
  'update', 'updates', 'updating', 'install', 'installing', 'driver', 'drivers', 'apply', 'changes', 'load', 'reload', 'plugin', 'plugins', 'settings',
]);
// A number of one to three digits ("rebooting in 5 minutes").
const NUMBER = /^[0-9]{1,3}$/;
const SPLIT_WORDS = new Set(['and', 'then', 'so', 'but', 'also', 'plus']);

// One clause's words: the canonical trigger it holds, or ''.
function clauseWord(words) {
  if (!words.length || words.length > MAX_WORDS) return '';
  let found = '';
  let needsSession = '';
  let hasSession = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const seconds = PAIRS.get(w);
    const second = seconds && i + 1 < words.length ? seconds.get(words[i + 1]) : undefined;
    if (second) { found = found || second; i++; continue; }
    if (TRIGGERS.has(w)) { found = found || TRIGGERS.get(w); continue; }
    if (NEEDS_SESSION.has(w)) { needsSession = needsSession || NEEDS_SESSION.get(w); continue; }
    if (SESSION.has(w)) hasSession = true;
    if (!ALLOWED.has(w) && !NUMBER.test(w)) return '';
  }
  if (found) return found;
  return needsSession && hasSession ? needsSession : '';
}

// The canonical word for a prompt that says the user is about to reboot,
// restart, shut down or close the session, or ''.
function pauseWord(prompt) {
  if (typeof prompt !== 'string' || !prompt || prompt.length > MAX_CHARS) return '';
  // Text between backticks is code or a pasted command.
  const plain = prompt.split('`').filter((_, i) => i % 2 === 0).join('\n');
  const lines = plain.toLowerCase().replace(/[‘’]/g, "'").split(/\r?\n/).filter(l => !/^\s*>/.test(l));
  for (const line of lines) {
    for (const part of line.split(/[.!?;:,()[\]{}"]+/)) {
      const words = part.match(/[a-z0-9]+(?:'[a-z]+)?/g) || [];
      let clause = [];
      for (const w of [...words, 'and']) {
        if (!SPLIT_WORDS.has(w)) { clause.push(w); continue; }
        const got = clauseWord(clause);
        if (got) return got;
        clause = [];
      }
    }
  }
  return '';
}

// The launcher's first step for this hook, run before it loads anything
// else: reads the payload, and exits 0 (silent) unless this is a main-thread
// prompt that says the user is about to pause. Returns what the rest of the
// launcher needs; the prompt is not part of it.
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fastPath() {
  let raw;
  try { raw = fs.readFileSync(0); } catch { process.exit(0); }
  let payload;
  try { payload = JSON.parse(raw.toString('utf8').replace(/^﻿/, '') || '{}'); } catch { process.exit(0); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) process.exit(0);
  if (payload.hook_event_name !== 'UserPromptSubmit') process.exit(0);
  if (payload.agent_id || payload.agent_type) process.exit(0); // a subagent's prompt
  if (typeof payload.session_id !== 'string' || !SESSION_RE.test(payload.session_id)) process.exit(0);
  const word = pauseWord(payload.prompt);
  if (!WORDS.includes(word)) process.exit(0);
  return { payload, word };
}

module.exports = { fastPath, pauseWord, WORDS, MAX_CHARS, MAX_WORDS };
