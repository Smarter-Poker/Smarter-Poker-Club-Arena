#!/usr/bin/env node
/**
 * NO SKIP MARKERS ON CLUB ARENA MAIN (added 2026-09-02)
 *
 * GitHub honours `[skip ci]`, `[skip actions]`, `[no ci]` and friends by
 * starting NO workflow run at all for that push. In most repositories that is
 * a harmless cost saving. In this one it means the publisher never runs, so
 * the commit merges, main moves, every check is green, and the bundle is
 * simply never built. Nothing is red. Nobody is told.
 *
 * It has already happened here: 454fa1da4,
 *   "fix(table): third deep sweep, eradicate legacy roomservice text
 *    injection, strip dead imports [skip ci]"
 * is a real table fix that shipped to main and started no publish.
 *
 * Every other net in the estate is a RECOVERY - the catch-up cron, the
 * convergence chain, the watchdog. They all close the gap eventually. This
 * one prevents the gap, which is cheaper than detecting it.
 *
 * Usage:
 *   node scripts/ci/check-no-skip-markers.mjs [range]     # default origin/main..HEAD
 */
import { execFileSync } from 'node:child_process';

const RANGE = process.argv[2] || 'origin/main..HEAD';

// The full set GitHub recognises, matched case-insensitively. `***NO_CI***`
// is the legacy form and is still honoured.
const MARKERS = [
  /\[skip[ _-]ci\]/i,
  /\[ci[ _-]skip\]/i,
  /\[skip[ _-]actions\]/i,
  /\[actions[ _-]skip\]/i,
  /\[no[ _-]ci\]/i,
  /\*\*\*NO_CI\*\*\*/i,
];

let log = '';
try {
  // %H then the full message, NUL-delimited so a body containing blank lines
  // cannot be mistaken for a record boundary.
  log = execFileSync('git', ['log', '--format=%H%x1f%B%x00', RANGE], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {
  console.error(`check-no-skip-markers FAILED: could not read required range \`${RANGE}\`.`);
  process.exit(1);
}

const offenders = [];
for (const record of log.split('\0')) {
  if (!record.trim()) continue;
  const [sha, message = ''] = record.split('\x1f');
  const hit = MARKERS.find((m) => m.test(message));
  if (hit) {
    offenders.push({
      sha: sha.trim().slice(0, 9),
      subject: message.trim().split('\n')[0],
      marker: message.match(hit)[0],
    });
  }
}

if (offenders.length === 0) {
  console.log('check-no-skip-markers: OK - no commit suppresses its own publish.');
  process.exit(0);
}

console.error('');
console.error('check-no-skip-markers FAILED: a commit would suppress its own publish.');
console.error('');
for (const o of offenders) {
  console.error(`  ${o.sha}  ${o.marker}  ${o.subject.slice(0, 80)}`);
}
console.error('');
console.error('GitHub starts NO workflow run for a push carrying one of these, so the');
console.error('Club Arena bundle is never built and production keeps serving the previous');
console.error('one. Nothing goes red. This happened for real on 454fa1da4.');
console.error('');
console.error('Fix: reword the commit.');
console.error('  git commit --amend            (the tip)');
console.error('  For an older commit, create a fresh branch from origin/main and carry');
console.error('  the intended changes forward with publishable commit messages.');
console.error('');
process.exit(1);
