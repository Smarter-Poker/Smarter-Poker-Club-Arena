/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A GUARD WITH NO READER IS NOT A GUARD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md 10.86 rule 3: "A guard must have a reader, and you must name them.
 * Ask, before you merge it: who sees this when it fires, and by what path?"
 *
 * On 2026-09-06 a sweep of `scripts/ci/` found 70 scripts and THREE checks
 * that matched only themselves in a grep of `.github`, `.husky`, `package.json`
 * and `scripts/`:
 *
 *   check-realtime-publication.mjs          merged hours earlier, by the agent
 *                                           quoting rule 3 in its own header
 *   check-bbj-functions-match-production    the BBJ money path against production
 *   check-cosmetic-catalog-drift            the price list against the trigger
 *
 * Two of them guard money. All three ran nowhere. And the cosmetic one was
 * additionally reporting an eighteen-line false positive nobody had ever seen,
 * because a regex without a word boundary read `table_id: 'classic_green'` as
 * an `id:`, so it compared felt asset names against theme ids.
 *
 * A check nobody runs decays silently, and when somebody finally wires it the
 * backlog of false positives teaches everyone to ignore it. This law makes the
 * omission impossible to repeat: a `check-*.mjs` is referenced by something
 * that runs it, or it is named here as a deliberately manual tool.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

/**
 * Scripts that are deliberately run BY HAND and have no automated reader.
 * Each needs a reason: an operator runs it, and knowing that is the point.
 */
const MANUAL_TOOLS = new Map([
  [
    'apply-main-ruleset.mjs',
    'one-shot: applies the main branch ruleset, run by a human with a PAT that has Administration scope (CLAUDE.md 1.1.5)',
  ],
  [
    'backfill-unrecorded-migrations.mjs',
    'repair tool: reconstructs repo files for applied migrations that lost one, run deliberately during a ledger cleanup',
  ],
  ['triage-open-prs.mjs', 'operator convenience: summarises the open pull requests, run by hand'],
]);

/** Everywhere a script could legitimately be invoked from. */
const READER_DIRS = ['.github', '.husky', 'scripts'];
const READER_FILES = ['package.json'];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const readerText = (() => {
  const parts: string[] = [];
  for (const d of READER_DIRS) {
    for (const f of walk(join(ROOT, d))) {
      // A script referencing itself is not a reader.
      if (f.includes('/scripts/ci/')) continue;
      parts.push(readFileSync(f, 'utf8'));
    }
  }
  for (const f of READER_FILES) {
    const p = join(ROOT, f);
    if (existsSync(p)) parts.push(readFileSync(p, 'utf8'));
  }
  return parts.join('\n');
})();

const checks = readdirSync(join(ROOT, 'scripts', 'ci'))
  .filter((f) => f.startsWith('check-') && f.endsWith('.mjs'))
  .sort();

describe('every guard has a reader', () => {
  it('there are guards to check', () => {
    expect(checks.length).toBeGreaterThan(10);
  });

  it.each(checks)('%s is run by something, or is a named manual tool', (file) => {
    if (MANUAL_TOOLS.has(file)) {
      expect(
        MANUAL_TOOLS.get(file)!.length,
        `${file} is on the manual list with an empty reason`
      ).toBeGreaterThan(20);
      return;
    }
    expect(
      readerText.includes(file),
      `scripts/ci/${file} is not referenced by any workflow, hook, script or npm ` +
        `script. A check nobody runs is not a check (CLAUDE.md 10.86 rule 3): it ` +
        `decays silently, and whoever finally wires it inherits a backlog of ` +
        `failures that teaches everyone to ignore it. Wire it to a reader, or add ` +
        `it to MANUAL_TOOLS in this law with the reason a person runs it by hand.`
    ).toBe(true);
  });

  it('nothing on the manual list has quietly gained a reader without being taken off it', () => {
    for (const [file, reason] of MANUAL_TOOLS) {
      expect(existsSync(join(ROOT, 'scripts', 'ci', file)), `${file} (${reason}) is gone`).toBe(
        true
      );
    }
  });
});

describe('the three that had no reader now do', () => {
  it.each([
    'check-realtime-publication.mjs',
    'check-bbj-functions-match-production.mjs',
    'check-cosmetic-catalog-drift.mjs',
  ])('%s is wired into the publish watchdog', (file) => {
    const wf = readFileSync(join(ROOT, '.github/workflows/publish-watchdog.yml'), 'utf8');
    expect(wf).toContain(file);
  });

  it('their job reports "could not ask" as loudly as a failure (10.86 rule 1)', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/publish-watchdog.yml'), 'utf8');
    const job = wf.slice(wf.indexOf('  live_drift:'), wf.indexOf('  main_is_green:'));
    // The alarm fires on any non-zero code, not only on 1.
    expect(job).toContain("steps.realtime.outputs.code != '0'");
    expect(job).toContain("steps.bbj.outputs.code != '0'");
    expect(job).toContain("steps.cosmetics.outputs.code != '0'");
    expect(job).toContain('Exit 2 is not a pass');
  });
});
