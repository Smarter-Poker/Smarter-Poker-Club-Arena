/**
 * THE SEED COPY EQUALS THE MIGRATION.
 *
 * scripts/ci/fixtures/capability-registry/seeds.json is a JSON copy of the
 * registry migration's seed rows and its readiness and scope CHECKs. The
 * client mirror (src/config/platformCapabilities.ts) ships with its first
 * consumer, which may land in a tree without the migration; there
 * tests/one-capability-registry.law.test.ts compares the mirror to this copy.
 * This pins the copy to the migration, field by field, so the two cannot
 * drift: a change to the seed block is a change to the copy in the same
 * commit.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const sql = readFileSync(
  join(
    ROOT,
    'supabase/migrations/20260924025555_one_capability_registry_and_accepted_event_continuation.sql'
  ),
  'utf8'
);
const fixture = JSON.parse(
  readFileSync(join(ROOT, 'scripts/ci/fixtures/capability-registry/seeds.json'), 'utf8')
) as {
  readiness: string[];
  scopes: string[];
  seeds: Array<{
    id: string;
    rule_version: string;
    title: string;
    scope: string;
    supported_variants: string[];
    compatibility: Record<string, unknown>;
    readiness: string;
  }>;
};

function quotedList(text: string): string[] {
  return [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

const ddl = (() => {
  const m = /CREATE TABLE public\.platform_capabilities \(([\s\S]*?)\n\);/.exec(sql);
  if (!m) throw new Error('CREATE TABLE public.platform_capabilities not found in the migration');
  return m[1].replace(/--[^\n]*/g, '');
})();

function checkList(column: string): string[] {
  const m = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(ddl);
  if (!m) throw new Error(`CHECK on ${column} not found`);
  return quotedList(m[1]);
}

const insert = (() => {
  const m = /INSERT INTO public\.platform_capabilities\s*\(([^)]*)\)\s*VALUES([\s\S]*?);\s*\n/.exec(
    sql
  );
  if (!m) throw new Error('seed INSERT INTO public.platform_capabilities not found');
  return { columns: m[1].replace(/\s+/g, ' ').trim(), values: m[2] };
})();

const migrationSeeds = (() => {
  return [
    ...insert.values.matchAll(
      /\(\s*'([a-z0-9_.]+)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'/g
    ),
  ].map((r) => ({
    id: r[1],
    rule_version: r[2],
    title: r[3],
    scope: r[4],
    supported_variants: r[5]
      .replace(/^\{|\}$/g, '')
      .split(',')
      .filter((v) => v !== ''),
    compatibility: JSON.parse(r[6]) as Record<string, unknown>,
    readiness: r[7],
  }));
})();

describe('the capability registry seed copy', () => {
  it('carries every seed row of the migration, in order, field for field', () => {
    // The copy's field order is the INSERT's column order (evidence omitted).
    expect(insert.columns).toBe(
      'capability_id, rule_version, title, scope, supported_variants, compatibility, readiness, readiness_evidence'
    );
    expect(migrationSeeds.length).toBeGreaterThan(0);
    expect(fixture.seeds).toEqual(migrationSeeds);
  });

  it('carries the readiness and scope CHECKs of the migration, in order', () => {
    expect(fixture.readiness).toEqual(checkList('readiness'));
    expect(fixture.scopes).toEqual(checkList('scope'));
  });
});
