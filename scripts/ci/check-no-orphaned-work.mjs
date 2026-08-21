#!/usr/bin/env node
/**
 * check-no-orphaned-work.mjs — the guard for the hole the others could not see
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT HAPPENED (2026-08-21, third throwables regression)
 * The first two regressions were STALE BUNDLES: old build output committed over
 * new. Provenance and feature-marker gates now stop those cold.
 *
 * This one was different, and slipped past every one of them. Commit db61c77
 * (voices, captions, 30+ per-item signatures) was pushed to main, verified in
 * the deployed bundle... and later stopped being an ancestor of main at all.
 * History was rewritten underneath it — a force-push, or a merge resolved by
 * taking a stale side — and the commit was orphaned.
 *
 * Why nothing fired: the resulting main was INTERNALLY CONSISTENT. The source
 * file, its imports and its protected-features registry entry all vanished
 * together, so:
 *   - the source guard saw a registry that did not mention the feature
 *   - the bundle guard saw a bundle whose registry did not mention it either
 *   - the provenance gate saw a build from a NEWER commit, moving forward
 * Every gate was satisfied. The work was simply gone.
 *
 * The lesson: guarding CONTENT is not enough if COMMITS can silently stop
 * existing. This guards the history itself.
 *
 * WHAT IT DOES
 * Reads .agent/protected-commits.json — a list of commits whose work must
 * remain on main — and fails if any of them is no longer an ancestor of HEAD.
 *
 * Being an ancestor is the right test, not "the file exists": a commit can be
 * legitimately superseded (reverted on purpose, refactored away) but that is a
 * decision someone makes and records by removing the entry here, in the same
 * commit, with a reason. Silence is not a decision.
 *
 * ADDING A COMMIT: append { sha, note } after landing work you cannot afford
 * to lose. REMOVING one is a deliberate, reviewable act.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const REL = '.agent/protected-commits.json';
const ABS = path.join(process.cwd(), REL);

if (!existsSync(ABS)) {
  console.log(`✓ ${REL} not present; nothing pinned yet.`);
  process.exit(0);
}

let pinned;
try {
  const raw = JSON.parse(readFileSync(ABS, 'utf8'));
  pinned = Array.isArray(raw?.commits) ? raw.commits : [];
} catch (err) {
  console.error(`✗ ${REL} is unreadable (${err.message}).`);
  process.exit(1);
}

if (!pinned.length) {
  console.log('✓ No protected commits pinned.');
  process.exit(0);
}

const missing = [];
const unknown = [];
const moved = [];

/** Stable patch-id of one commit, or null when it cannot be computed. */
function patchId(sha) {
  try {
    const out = execSync(`git show ${sha} | git patch-id --stable`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString()
      .trim();
    return out.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

/**
 * Patch-ids of recent history, computed once and cached. The window is
 * generous because this repo lands a lot of commits in a day; it is bounded
 * because hashing all history on every push would be wasteful.
 */
let _recent = null;
function recentPatchIds() {
  if (_recent) return _recent;
  _recent = new Set();
  try {
    const shas = execSync('git log --format=%H -n 400 HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .split('\n')
      .filter(Boolean);
    for (const s of shas) {
      const id = patchId(s);
      if (id) _recent.add(id);
    }
  } catch {
    /* leave the set empty: we simply cannot prove equivalence */
  }
  return _recent;
}

/** A shallow clone cannot answer ancestry questions past its boundary. */
function isShallow() {
  try {
    return execSync('git rev-parse --is-shallow-repository', { encoding: 'utf8' }).trim() === 'true';
  } catch {
    return false;
  }
}

for (const entry of pinned) {
  const sha = String(entry?.sha ?? '').trim();
  if (!sha) continue;
  // Is the object even present in this clone? A shallow CI checkout may not
  // have it; that is "cannot verify", not "lost", and must not fail the build.
  try {
    execSync(`git cat-file -e ${sha}^{commit}`, { stdio: 'ignore' });
  } catch {
    unknown.push(entry);
    continue;
  }
  try {
    execSync(`git merge-base --is-ancestor ${sha} HEAD`, { stdio: 'ignore' });
    continue; // still on main by SHA: the simple, happy case
  } catch {
    /* not an ancestor — but in a SHALLOW clone that proves nothing */
  }

  // THE SHALLOW TRAP (2026-08-21). The check above already skips a commit whose
  // OBJECT is missing. This is the other half: in a shallow clone the object can
  // be present - fetched along with some ref - while the ancestry chain between
  // it and HEAD is cut by the shallow boundary. merge-base then answers "not an
  // ancestor" for a commit that is sitting on main perfectly happily, and the
  // patch-id fallback below cannot rescue it either, because `git log -n 400`
  // also stops at that boundary.
  //
  // Measured: at --depth 50 this guard reported four commits as lost and
  // refused the push twice; at --depth 135 all four resolved as ancestors. They
  // had never left main. Every agent working from a shallow checkout - which is
  // most of them, and CI - would hit this.
  //
  // So: deepen once, and re-ask. A guard that cries wolf gets switched off,
  // which is how you lose the work for real.
  if (isShallow()) {
    try {
      execSync('git fetch --quiet --deepen 250 origin', { stdio: 'ignore' });
    } catch {
      /* offline or no remote: fall through, we will classify as unverifiable */
    }
    try {
      execSync(`git merge-base --is-ancestor ${sha} HEAD`, { stdio: 'ignore' });
      continue; // it was there all along
    } catch {
      /* still not an ancestor - now the patch-id check is worth running */
    }
  }
  // NOT an ancestor. Before crying wolf, check whether the same WORK is on
  // main under a different SHA. This repo does that routinely and by design:
  // CLAUDE.md documents that agents land identical content through different
  // paths, and a cherry-pick recovery (exactly what fixed this regression)
  // necessarily produces a new SHA. A guard that cannot tell "restored" from
  // "lost" would false-alarm on its own fix, and a guard that cries wolf gets
  // switched off — which is how you lose the work for real.
  if (isShallow()) {
    // Deepening did not settle it and we are still shallow: say so, do not
    // accuse. Full clones (a developer machine) still get the hard failure.
    unknown.push(entry);
    continue;
  }
  const id = patchId(sha);
  if (id && recentPatchIds().has(id)) {
    moved.push(entry);
    continue;
  }
  missing.push(entry);
}

if (unknown.length) {
  console.warn(
    `! ${unknown.length} protected commit(s) not present in this clone ` +
      `(shallow checkout?); skipped: ${unknown.map((e) => String(e.sha).slice(0, 8)).join(', ')}`
  );
}

if (moved.length) {
  console.warn(
    `! ${moved.length} protected commit(s) are no longer ancestors, but the same\n` +
      `  patch IS on main under a different SHA (restored or re-landed):\n` +
      moved.map((e) => `    ${String(e.sha).slice(0, 8)}  ${e.note ?? ''}`).join('\n') +
      `\n  Consider repinning to the current SHA so the next check is exact.\n`
  );
}

if (missing.length) {
  console.error('\n✗ PROTECTED WORK HAS BEEN ORPHANED FROM main\n');
  for (const e of missing) {
    console.error(`  ${String(e.sha).slice(0, 8)}  ${e.note ?? '(no note)'}`);
  }
  console.error(
    '\n  These commits are no longer ancestors of HEAD. That is not a revert —\n' +
      '  a revert leaves the commit in history. Something rewrote history over\n' +
      '  the top of them: a force-push, or a merge resolved by taking a stale\n' +
      '  side.\n\n' +
      '  RECOVER: the commits still exist. Restore with\n' +
      '      git cherry-pick <sha>\n' +
      '  and push. If a commit was superseded ON PURPOSE, delete its entry from\n' +
      `      ${REL}\n` +
      '  in the same commit, with the reason in the message.\n'
  );
  process.exit(1);
}

console.log(`✓ All ${pinned.length} protected commit(s) still on main.`);
process.exit(0);
