#!/usr/bin/env node
/**
 * check-doctrine-freshness.mjs - refuse to enforce a law you read in a stale tree.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * CLAUDE.md 10.8.1 already says it: "Laws are read from `origin/main`, never
 * from your local tree. Worktrees go stale by hundreds of commits; a stale
 * tree carrying a retired law is how the revert war sustained itself." Nothing
 * checked. Measured on this machine on 2026-09-04, AFTER pruning 51 worktrees:
 *
 *   160 Club Arena worktrees
 *   154 whose CLAUDE.md differs from origin/main
 *   102 that still contain `bash scripts/sync-club-arena.sh` or the heading
 *       "The Only Deploy Path" - a command deleted from main on 2026-09-02,
 *       whose directory Next.js would serve BEFORE the rewrite, so running it
 *       does not duplicate the live bundle, it SHADOWS it
 *
 * Those trees are not old. Most are days old; the doctrine simply moved faster
 * than they did. Pruning cannot fix that - `prune-stale-worktrees.sh` only
 * removes what is clean, pushed and idle for 72 hours, and it is right to.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT BLOCKS ONLY SOMETIMES, AND WHY THAT IS NOT A FUDGE
 * ═══════════════════════════════════════════════════════════════════════════
 * Blocking every push from a stale tree would stall a hundred in-flight
 * branches behind a `git merge origin/main` that can conflict - and CLAUDE.md
 * section 12 exists entirely because merge surgery in a stale tree is how this
 * estate loses work. The cure would be worse.
 *
 * But the HARM is specific. A stale CLAUDE.md is only dangerous when the agent
 * acts on doctrine: writes a law, edits CLAUDE.md, changes a workflow, reverts
 * someone's guard. That is the exact motion of the hamburger revert war, and
 * of every "I'm restoring the documented deploy path" commit since. Ordinary
 * feature work in a stale tree is not the failure mode.
 *
 * So: BLOCK when the diff touches doctrine, WARN otherwise. The warning is
 * loud and names the exact stale lines, because an agent that reads it and
 * merges origin/main has fixed the problem for its whole branch.
 *
 * FAILS OPEN. Any internal error exits 0 with a note. A freshness advisor that
 * can wedge every push in the estate is a worse bug than the staleness it
 * detects.
 *
 * Usage:  node scripts/ci/check-doctrine-freshness.mjs [--base <ref>]
 * Exit:   0 fresh, or stale-but-not-acting-on-doctrine, or internal error
 *         1 stale AND the diff touches doctrine
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const RESET = '[0m';
const RED = '[1;31m';
const YELLOW = '[1;33m';
const GREEN = '[0;32m';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Instructions that were REMOVED from doctrine and are dangerous to follow.
 * Each is checked against origin/main too - if main still says it, it is not
 * retired and this script has no opinion. That is what keeps this list from
 * becoming its own stale law.
 */
const RETIRED = [
  {
    pattern: /bash\s+scripts\/sync-club-arena\.sh|scripts\/sync-club-arena\.sh\s*"/,
    what: 'invokes scripts/sync-club-arena.sh',
    why: 'deleted 2026-09-02. Running it re-vendors the bundle into the World Hub, and Next serves public/ BEFORE the rewrite, so it SHADOWS the live bundle instead of duplicating it',
  },
  {
    pattern: /The Only Deploy Path/i,
    what: 'has a heading "The Only Deploy Path"',
    why: 'that section described the World Hub sync, which is gone. The route is: push a branch, and stop',
  },
  {
    pattern: /build-for-world-hub/,
    what: 'names build-for-world-hub as the publisher',
    why: 'renamed to publish-club-arena.yml on 2026-09-03, and it no longer commits anything to the World Hub',
  },
  {
    pattern: /engine restarts? (at )?7\s*am|five Chicago windows/i,
    what: 'describes the old engine-restart schedule',
    why: 'the engine restarts at :55 of EVERY hour inside an announced five-minute break (CLAUDE.md section 13)',
  },
];

/** A diff that touches any of these is an agent acting ON doctrine. */
const DOCTRINE_PATHS = [
  /^CLAUDE\.md$/,
  /^AGENT-PLAYBOOK\.md$/,
  /^docs\/LAWS\.md$/,
  /\.law\.test\.[a-z]+$/,
  /^\.github\/workflows\//,
  /^\.agent\//,
  /^docs\/HANDOFF/,
  /^\.husky\//,
];

function main() {
  if (!existsSync('CLAUDE.md')) return 0;

  let canonical;
  try {
    canonical = git(['show', 'origin/main:CLAUDE.md']);
  } catch {
    console.log('[doctrine] origin/main:CLAUDE.md unreadable (offline?) - skipping.');
    return 0;
  }
  const local = readFileSync('CLAUDE.md', 'utf8');

  // Same file: nothing to say, and no cost.
  if (local === canonical) {
    console.log(`${GREEN}[doctrine] CLAUDE.md matches origin/main.${RESET}`);
    return 0;
  }

  const findings = [];
  for (const rule of RETIRED) {
    // If main STILL says it, it is not retired - say nothing.
    if (rule.pattern.test(canonical)) continue;
    const lines = local.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (rule.pattern.test(lines[i])) {
        findings.push({ line: i + 1, text: lines[i].trim().slice(0, 100), ...rule });
        break; // one example per rule is enough to make the point
      }
    }
  }

  if (findings.length === 0) {
    console.log(
      '[doctrine] CLAUDE.md differs from origin/main but carries no retired instruction.'
    );
    return 0;
  }

  let touchingDoctrine = [];
  try {
    const base = git(['merge-base', 'HEAD', 'origin/main']).trim();
    const changed = git(['diff', '--name-only', `${base}..HEAD`])
      .split('\n')
      .filter(Boolean);
    touchingDoctrine = changed.filter((f) => DOCTRINE_PATHS.some((re) => re.test(f)));
  } catch {
    /* cannot classify the diff - warn rather than block */
  }

  const blocking = touchingDoctrine.length > 0;
  const colour = blocking ? RED : YELLOW;
  console.log('');
  console.log(`${colour}${'='.repeat(72)}${RESET}`);
  console.log(
    `${colour}  ${blocking ? 'BLOCKED' : 'WARNING'}: this worktree's CLAUDE.md is stale${RESET}`
  );
  console.log(`${colour}${'='.repeat(72)}${RESET}`);
  console.log('');
  for (const f of findings) {
    console.log(`  CLAUDE.md:${f.line} ${f.what}`);
    console.log(`    ${f.text}`);
    console.log(`    ${f.why}`);
    console.log('');
  }
  console.log('  Fix, from this worktree:');
  console.log('');
  console.log('      git merge origin/main');
  console.log('');

  if (!blocking) {
    console.log('  Not blocking: your diff does not touch doctrine. But you are reading');
    console.log('  instructions that were retired, so read CLAUDE.md on origin/main before');
    console.log('  you act on anything it says about deploys, laws or the engine restart.');
    console.log('');
    return 0;
  }

  console.log('  BLOCKING, because this push changes doctrine itself:');
  for (const f of touchingDoctrine.slice(0, 10)) console.log(`      ${f}`);
  console.log('');
  console.log('  CLAUDE.md 10.8.1: laws are read from origin/main, never from your local');
  console.log('  tree. Enforcing a law you read in a stale worktree is how the hamburger');
  console.log('  revert war ran for two days - each agent reverting the last one back to');
  console.log('  the rule its own copy still carried.');
  console.log('');
  return 1;
}

let code = 0;
try {
  code = main();
} catch (err) {
  console.log(`[doctrine] check skipped (${err?.message || err}).`);
  code = 0;
}
process.exit(code);
