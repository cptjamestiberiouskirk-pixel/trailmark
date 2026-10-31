#!/usr/bin/env node
// PreCompact hook: snapshot git state next to the handoff before compaction.
// One snapshot per session (snapshots/<session id>.md), so sessions compacting
// at the same time don't overwrite each other's. Never touches handoff.md.
// SessionStart injects the snapshot, so it holds no commit subject or other
// free text from the repo: only the branch name (flattened to one word by
// gitfacts.js) and file paths, and the injection marks them as repo data.
// PreCompact cannot add context; the SessionStart hook that fires with
// source=compact picks the snapshot up. Normally started by trailmark.js under the sandbox.

'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./lib/store');
const { readPayload, memoryDirOrExit, facts, guard } = require('./lib/hookio');

guard(() => {
  const payload = readPayload();
  const { dir, cwd } = memoryDirOrExit(payload);
  const trigger = payload.trigger === 'manual' ? 'manual' : 'auto';
  const session = S.cleanSession(payload.session_id);
  const now = new Date();

  const f = facts(cwd, ['branch', 'head', 'status', 'toplevel']);
  const branch = f.branch || 'unknown';
  const head = f.head || 'none';
  const status = Array.isArray(f.status) ? f.status : [];
  // Status not read: the repo names a filter whose name couldn't be checked,
  // or git failed (gitfacts.js). A fixed word, never repo text.
  const refused = typeof f.gitRefused === 'string' && /^[a-z][a-z-]{0,23}$/.test(f.gitRefused) ? f.gitRefused : '';
  const skipped = refused ? `git kept out: ${refused}` : (typeof f.statusSkipped === 'string' && /^[a-z][a-z-]{0,23}$/.test(f.statusSkipped) ? f.statusSkipped : '');
  // gitfacts passes only the first lines of a long status, plus the full count.
  const count = typeof f.statusCount === 'number' ? f.statusCount : status.length;
  const shown = skipped ? [] : status.slice(0, 20).map(l => '  ' + S.oneLine(l, 120));
  if (!skipped && count > shown.length) shown.push(`  ... ${count - shown.length} more`);
  // Files whose filter the repo itself defines: it was off for the check
  // (gitfacts.filterOverrides), so they can show as modified when they aren't.
  const filtersOff = !skipped && Number.isInteger(f.statusFiltersOff) && f.statusFiltersOff > 0 ? f.statusFiltersOff : 0;

  const handoff = path.join(dir, S.HANDOFF);
  const age = S.plainExists(handoff)
    ? `${Math.round((now - S.plainStat(handoff).mtimeMs) / 60000)} min`
    : 'no handoff';

  const body = [
    '---',
    `name: ${session ? 'snapshot-' + session.slice(0, 8) : 'precompact'}`,
    `description: Git snapshot taken before compaction at ${S.localDate(now)} ${S.localTime(now)}`,
    'type: project',
    `worktree: ${S.oneLine(f.toplevel || cwd, 400)}`,
    '---',
    `Compaction (${trigger}) at ${S.localDate(now)} ${S.localTime(now)}${session ? ` in session ${session.slice(0, 8)}` : ''}. Last handoff write: ${age} earlier.`,
    `Branch: ${branch}  HEAD: ${head}`,
    `Uncommitted files: ${skipped ? `not read (${skipped})` : count}`,
    ...shown,
    ...(filtersOff ? [`  (${filtersOff} tracked file(s) use a filter the repo's own config defines; it was off for this check, so they can show as modified when they aren't)`] : []),
    '',
  ].join('\n');

  S.writeSnapshot(dir, session, body, now.getTime());
  S.note(dir, `PRE_COMPACT trigger=${trigger} branch=${branch} head=${head} uncommitted=${skipped ? 'unknown' : count}`, session);
});
