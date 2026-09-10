#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DEV SERVER MUST NOT SERVE CODE THAT IS DAYS OLD WITHOUT SAYING SO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-08-23)
 *
 * Dan spent two days reporting that agent work "never makes it to production".
 * It always had. Every change was merged and live on smarter.poker within
 * minutes. What he was looking at was `npm run dev` in a SECOND clone -
 * ~/Documents/Smarter-Poker-Club-Arena - that had not been pulled since the
 * 21st and was 293 COMMITS BEHIND. A Vite process from Thursday night kept
 * serving that snapshot for days.
 *
 * Nothing was broken. Nothing said anything either. Vite starts happily on a
 * tree from any point in history, prints the same cheerful localhost URL, and
 * gives no hint that what it compiled bears no relation to what is on main.
 * Days of "it's still not working" came out of that silence, and the agents
 * looked incompetent for shipping work that was, in fact, already shipped.
 *
 * The advice that followed was "remember to git pull before starting the dev
 * server". That is a manual human step, which AGENT-PLAYBOOK.md and World Hub
 * RULE 0 both forbid for exactly this reason: a step a human must remember is
 * a step that gets forgotten, and the failure is silent and expensive.
 *
 * So the dev server now checks, and fixes what it safely can:
 *
 *   behind + clean tree   fast-forwards, prints what arrived, carries on. This
 *                         is the overwhelmingly common case and needs nobody.
 *   behind + dirty tree   REFUSES. Merging over uncommitted work is the one
 *                         decision that is genuinely a human's, so it prints
 *                         the two commands and stops.
 *   ahead                 warns about unpushed commits and continues - stale
 *                         is the hazard here, not local work.
 *   offline / no git      says so and continues. A freshness check must never
 *                         be the reason nobody can work.
 */
import { execFileSync } from 'node:child_process';

const git = (args, opts = {}) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

const say = (s = '') => process.stdout.write(`${s}\n`);

try {
  git(['rev-parse', '--git-dir']);
} catch {
  say('[dev] not a git checkout - skipping the freshness check.');
  process.exit(0);
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);

try {
  execFileSync('git', ['fetch', '--quiet', 'origin', 'main'], { stdio: 'ignore', timeout: 20000 });
} catch {
  say('[dev] could not reach origin (offline?) - starting anyway, but this tree may be stale.');
  process.exit(0);
}

let behind = '0';
let ahead = '0';
try {
  [behind, ahead] = git(['rev-list', '--left-right', '--count', 'origin/main...HEAD']).split(/\s+/);
} catch {
  process.exit(0);
}

if (ahead !== '0') {
  say(`[dev] note: ${ahead} local commit(s) not on origin/main. Push the isolated feature branch through normal hooks.`);
}

if (behind === '0') {
  say(`[dev] up to date with origin/main.`);
  process.exit(0);
}

const dirty = git(['status', '--porcelain']).length > 0;

if (dirty) {
  say('');
  say('  ─────────────────────────────────────────────────────────────────────');
  say(`  REFUSING TO START. This tree is ${behind} commit(s) behind origin/main`);
  say('  and has uncommitted changes.');
  say('');
  say('  Starting now would serve you code that is missing everything below,');
  say('  and you would have no way to tell from the browser. That is exactly');
  say('  how a clone sat 293 commits behind for two days while everyone');
  say('  believed the deploys were broken.');
  say('');
  say('  Merging over your uncommitted work is your call, not mine:');
  say('');
  say('      git stash && git merge --ff-only origin/main && git stash pop');
  say('        or commit them first, then re-run npm run dev');
  say('');
  say(`  On branch ${branch}. What you are missing:`);
  try {
    say(git(['log', '--oneline', '--max-count=10', 'HEAD..origin/main']).split('\n').map((l) => `      ${l}`).join('\n'));
  } catch { /* nothing to show */ }
  say('  ─────────────────────────────────────────────────────────────────────');
  say('');
  process.exit(1);
}

// Clean and behind: this is safe to fix, so fix it rather than reporting it.
try {
  git(['merge', '--ff-only', 'origin/main']);
  say(`[dev] this tree was ${behind} commit(s) behind - fast-forwarded to origin/main:`);
  say(git(['log', '--oneline', '--max-count=8', `HEAD@{1}..HEAD`]).split('\n').map((l) => `        ${l}`).join('\n'));
  say('[dev] now current. Starting Vite.');
} catch {
  say(`[dev] this tree is ${behind} commit(s) behind and could not fast-forward`);
  say(`[dev] (${branch} has diverged from main). Run: bash scripts/git-unstick.sh`);
  process.exit(1);
}
