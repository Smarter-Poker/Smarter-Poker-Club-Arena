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

describe('an agent can declare a new object without touching a shared file', () => {
  it('unions every fragment into the base snapshot', () => {
    const base = JSON.parse(read('scripts/ci/supabase-schema-manifest.json'));
    const merged = loadSchemaManifest(root);
    // The overlay may only ADD. Losing a base name would silently switch off
    // the phantom-reference gate for whatever it dropped.
    for (const t of base.tables ?? []) expect(merged.tables).toContain(t);
    for (const f of base.functions ?? []) expect(merged.functions).toContain(f);
    expect(merged.tables.length).toBeGreaterThanOrEqual((base.tables ?? []).length);
  });

  it('carries column declarations through the same overlay', () => {
    const merged = loadColumnsManifest(root);
    expect(Object.keys(merged.columns).length).toBeGreaterThan(0);
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
      expect(src).toContain("from './schema-manifest.mjs'");
      expect(src).not.toMatch(/JSON\.parse\(\s*readFileSync\(\s*MANIFEST/);
    });
  }
});

describe('fragments are temporary, and a lying one is found', () => {
  const wf = read('.github/workflows/schema-manifest-refresh.yml');

  it('the nightly refresh absorbs and retires them', () => {
    expect(wf).toContain('node scripts/ci/prune-schema-fragments.mjs');
    // Deletions have to be staged, or an absorbed fragment survives the refresh
    // and the directory grows forever.
    expect(wf).toContain('git add -A scripts/ci/');
  });

  it('a fragment production cannot corroborate eventually goes red', () => {
    expect(wf).toContain('A stale fragment is an open hole');
    const prune = read('scripts/ci/prune-schema-fragments.mjs');
    // Warn while it may still be landing; fail once it cannot be.
    expect(prune).toContain('STALE_AFTER_MS');
    expect(prune).toContain('process.exit(stale.length ? 1 : 0)');
  });
});
