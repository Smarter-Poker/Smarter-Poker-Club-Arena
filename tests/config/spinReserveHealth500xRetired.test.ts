/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE 500x TIER IS RETIRED — and a column drop is a two-step, always
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PostgREST does not quietly ignore an unknown column in a select. It refuses
 * the ENTIRE request with 42703. On 2026-08-21 can_draw_500x was dropped from
 * v_spin_tier_availability while a deployed bundle still selected it, and the
 * Spin badge went dark for every club at once - from a failure that looked
 * nothing like its cause, because the hook swallowed the error.
 *
 * The same three columns survived on v_spin_reserve_health for a year of
 * calendar days longer than the tier did, for exactly that reason: the World
 * Hub's /api/cron/spin-sweep still named can_draw_500x in its select, and that
 * cron is the only thing watching whether a reserve pool can still pay its
 * ladder. Dropping the column underneath it would have blinded the alarm.
 *
 * So the reader shipped first (World Hub 0162ff08da, live in production
 * 80a29487 at 2026-08-22 19:57 UTC) and the columns followed.
 *
 * What is pinned here:
 *
 *   1. The migration drops the three retired columns and NOTHING ELSE. Every
 *      column the cron selects has to survive - losing one of those is the
 *      outage this migration exists to avoid, arrived at from the other side.
 *
 *   2. No Club Arena source selects a retired column. The view is service-role
 *      only, so a client cannot read it at all, but a select naming a dead
 *      column is the shape that caused the incident and it stays banned.
 *
 *   3. The view does not become client-readable by being recreated. DROP and
 *      CREATE resets grants, and a view carrying every club's balance must not
 *      quietly acquire an anon grant on its way past.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const sqlCode = (src: string) => src.replace(/^[ \t]*--.*$/gm, '');

const MIGRATION = 'supabase/migrations/20260822220000_retire_500x_reserve_health_columns.sql';
const migration = sqlCode(read(MIGRATION));

const RETIRED = ['top_jackpot', 'need_for_500x', 'can_draw_500x'];

/** Columns /api/cron/spin-sweep selects and acts on. */
const CRON_COLUMNS = [
  'club_id',
  'club_name',
  'balance',
  'highest_stake',
  'can_draw_100x',
  'is_thin',
  'shortfall_events',
  'unbooked_24h',
  'null_multiplier_24h',
];

/** The CREATE VIEW body, which is the definition this migration installs. */
function viewBody(): string {
  const start = migration.indexOf('CREATE VIEW public.v_spin_reserve_health AS');
  expect(start, 'the migration does not recreate v_spin_reserve_health').toBeGreaterThan(-1);
  const end = migration.indexOf('COMMENT ON VIEW', start);
  return migration.slice(start, end > -1 ? end : migration.length);
}

describe('the view loses the retired tier and keeps everything else', () => {
  const body = viewBody();

  it('publishes none of the three retired columns', () => {
    for (const col of RETIRED) {
      expect(body, `${col} is still selected by the view`).not.toContain(col);
    }
  });

  it('still publishes every column the reserve alarm reads', () => {
    for (const col of CRON_COLUMNS) {
      expect(body, `v_spin_reserve_health would lose ${col}, which spin-sweep selects`).toContain(
        col
      );
    }
  });

  it('keeps the 100x gate, which is the live tier', () => {
    expect(body).toMatch(/need_for_100x/);
    expect(body).toMatch(/can_draw_100x/);
  });

  it('drops the view only immediately before recreating it', () => {
    const drop = migration.indexOf('DROP VIEW IF EXISTS public.v_spin_reserve_health');
    const create = migration.indexOf('CREATE VIEW public.v_spin_reserve_health');
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
    // CASCADE would take any dependent object with it, silently.
    expect(migration).not.toMatch(/DROP VIEW[^;]*CASCADE/i);
  });

  it('does not let the recreated view become client-readable', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON public\.v_spin_reserve_health FROM anon, authenticated/
    );
    expect(migration).toMatch(/GRANT SELECT ON public\.v_spin_reserve_health TO service_role/);
    expect(migration).not.toMatch(/GRANT SELECT ON public\.v_spin_reserve_health[^;]*anon/);
  });

  it('asserts its own outcome rather than trusting the apply', () => {
    expect(migration).toMatch(/a retired 500x column survived/);
    expect(migration).toMatch(/which \/api\/cron\/spin-sweep selects/);
  });
});

describe('no Club Arena source asks the database for a retired column', () => {
  const SOURCE_DIRS = ['src', 'server/src', 'scripts'];
  const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

  function walk(dir: string, out: string[] = []): string[] {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (EXT.has(extname(name))) out.push(full);
    }
    return out;
  }

  const files = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d)));

  it('finds source to scan', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('has no .select() naming a retired column', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (!RETIRED.some((c) => src.includes(c))) continue;
      // Prose is fine and necessary - useSpinTierAvailability.ts explains why
      // it stopped asking. Only a select argument is a query.
      const re = /\.select\(\s*(['"`])([\s\S]*?)\1/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        for (const col of RETIRED) {
          if (m[2].includes(col)) offenders.push(`${file.slice(ROOT.length + 1)} selects ${col}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
