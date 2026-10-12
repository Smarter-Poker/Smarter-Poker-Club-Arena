/**
 * THE SCHEMA MANIFEST STOPPED BEING A MERGE QUEUE.
 *
 * Measured on 2026-09-01: `scripts/ci/supabase-schema-manifest.json` was the
 * single most-changed file on main - 25 commits in 24 hours, ahead of every
 * source file in the repo - with `supabase-columns-manifest.json` third at 14.
 * Both are sorted JSON arrays that every agent shipping a migration has to
 * append its own names to, so any two such branches conflict by construction.
 * Main takes a commit every seven minutes here, and a branch that has to merge
 * main, re-resolve the manifest, wait three minutes for the pre-push hook and
 * twenty-five for CI loses that race about half the time. One PR that morning
 * went `dirty` twice inside twenty-five minutes without a line of its own code
 * changing.
 *
 * This is CLAUDE.md rule 10.9 again - MIGRATION-CHANGELOG.md, 18 of 108
 * conflicting pull requests, fixed by giving every agent its own file. The
 * cure is the same one: scripts/ci/schema-manifest.d/<slug>.json.
 *
 * Every pin here is a way that cure could quietly stop working.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadSchemaManifest,
  loadColumnsManifest,
  readFragments,
} from '../../scripts/ci/schema-manifest.mjs';

const root = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('an agent can declare a schema change without touching a shared file', () => {
  it('applies fragment additions and explicit retirement tombstones', () => {
    const base = JSON.parse(read('scripts/ci/supabase-schema-manifest.json'));
    const merged = loadSchemaManifest(root);
    const fragments = readFragments(root);
    const removedTables = new Set(fragments.flatMap(({ data }) => data.removedTables ?? []));
    const removedFunctions = new Set(fragments.flatMap(({ data }) => data.removedFunctions ?? []));

    for (const t of base.tables ?? []) {
      expect(merged.tables.includes(t), t).toBe(!removedTables.has(t));
    }
    for (const f of base.functions ?? []) {
      expect(merged.functions.includes(f), f).toBe(!removedFunctions.has(f));
    }
    expect(merged.removedByFragments).toBe(removedTables.size + removedFunctions.size);
  });

  it('carries column declarations through the same overlay', () => {
    const merged = loadColumnsManifest(root);
    const fragments = readFragments(root);
    const removedTables = new Set(fragments.flatMap(({ data }) => data.removedTables ?? []));
    expect(Object.keys(merged.columns).length).toBeGreaterThan(0);
    for (const table of removedTables) {
      expect(merged.columns).not.toHaveProperty(table);
    }
    expect(merged.removedByFragments).toBe(removedTables.size);
  });

  it('refuses a fragment it cannot understand, instead of ignoring it', () => {
    // A fragment that is silently skipped sends its author back to editing the
    // shared file, which is the whole problem.
    expect(() => readFragments(root)).not.toThrow();
    const dir = resolve(root, 'scripts/ci/schema-manifest.d');
    expect(existsSync(dir), 'the fragment directory must exist').toBe(true);
    expect(existsSync(resolve(dir, 'README.md')), 'it must tell an agent what to write').toBe(true);
  });
});

describe('the CI gates read the overlay, not the raw base file', () => {
  // If a gate goes back to readFileSync on the base, fragments become
  // decoration and every migration author is pushed back into the shared file.
  for (const script of [
    'scripts/ci/check-phantom-tables.mjs',
    'scripts/ci/check-phantom-columns.mjs',
    'scripts/ci/check-migrations-applied.mjs',
  ]) {
    it(`${script} loads through schema-manifest.mjs`, () => {
      const src = read(script);
      expect(src).toMatch(/\bfrom\s+(['"])\.\/schema-manifest\.mjs\1/);
      expect(src).not.toMatch(/JSON\.parse\(\s*readFileSync\(\s*MANIFEST/);
    });
  }
});

describe('the schema audit is read-only, and a lying fragment is found', () => {
  const wf = read('.github/workflows/schema-manifest-refresh.yml');
  /**
   * The same file with every full-line comment removed. A pin that a command is
   * GONE must not be satisfied - or broken - by prose explaining why it went,
   * and the header below deliberately still names what it replaced. The anchor
   * job's law does the same thing to its own step for the same reason.
   */
  const wfCode = wf
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  it('regenerates only in the disposable checkout and never writes source', () => {
    expect(wf).toContain('node scripts/ci/prune-schema-fragments.mjs');
    expect(wfCode).not.toMatch(/git\s+(?:add|commit|push)\b|gh\s+pr\s+create/);
  });

  /**
   * THE DRIFT REFUSAL WAS A CHECK WITH ONE OUTCOME (replaced 2026-10-03).
   *
   * `git diff --quiet -- scripts/ci/` after the regeneration failed on ANY
   * difference between the committed manifests and live production, and told
   * the reader to regenerate the base in a reviewed change. The pin above used
   * to require that command. It cannot pass in this repository: the base is
   * read-only to agents for the reason this whole file exists, so the only act
   * that satisfies a byte-diff is the one the fragment system forbids.
   *
   * Measured: the `refresh` job RAN sixteen times between 2026-09-13 and
   * 2026-10-02 and FAILED all sixteen, while prune in the last of them reported
   * `445 absorbed, 10 trimmed, 10 still landing, 0 stale`.
   */
  it('refuses a phantom rather than any difference at all', () => {
    expect(wfCode).not.toContain('git diff --quiet -- scripts/ci/');
    // And the header still says what it replaced, so the next reader knows why.
    expect(wf).toContain('git diff --quiet -- scripts/ci/');
    expect(wf).toContain('node scripts/ci/check-schema-contract.mjs');
    // And only when the regeneration actually happened: without that condition
    // the "live" files on disk are the committed ones out of the checkout, and
    // the comparison would be the contract against itself.
    expect(wf).toContain("steps.regenerate.outcome == 'success'");
  });

  it('the contract check tells its three outcomes apart', () => {
    const src = read('scripts/ci/check-schema-contract.mjs');
    // Production ahead of the contract is the steady state here, not a failure.
    expect(src).toMatch(/BEHIND/);
    // The contract blessing what production lacks is the phantom the gates
    // would approve and runtime would refuse.
    expect(src).toMatch(/PHANTOM/);
    expect(src).toMatch(/phantomCount > 0[\s\S]{0,1200}process\.exit\(1\)/);
    // An unreadable or implausible answer is never one of the other two
    // (CLAUDE.md 10.86 rules 1 and 2).
    expect(src).toContain('COULD NOT TELL');
    expect(src).toContain('process.exit(2)');
    expect(src).toContain('MIN_LIVE_TABLES');
    // The committed side comes out of HEAD, so prune's deletions in the same
    // job cannot move the verdict and neither step can mask the other.
    expect(src).toContain("'show', `HEAD:${path}`");
    // It writes nothing: the audit stays read-only.
    expect(src).not.toMatch(/writeFileSync|rmSync/);
  });

  it('a fragment production cannot corroborate eventually goes red', () => {
    expect(wf).toContain('A stale fragment is an open hole');
    const prune = read('scripts/ci/prune-schema-fragments.mjs');
    // Warn while it may still be landing; fail once it cannot be.
    expect(prune).toContain('STALE_AFTER_MS');
    expect(prune).toContain('keepRemovedFns');
    expect(prune).toContain('process.exit(stale.length ? 1 : 0)');
  });
});
