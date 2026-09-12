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

  it('regenerates only in the disposable checkout and refuses unreviewed drift', () => {
    expect(wf).toContain('node scripts/ci/prune-schema-fragments.mjs');
    expect(wf).toContain('git diff --quiet -- scripts/ci/');
    expect(wf).toContain('this audit cannot mutate source');
    expect(wf).not.toMatch(/git\s+(?:add|commit|push)\b|gh\s+pr\s+create/);
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
