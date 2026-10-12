/**
 * A HAND COMMIT STARTS NO PARALLEL WORKERS.
 *
 * Every raked cash hand's post-commit transaction runs the club-rake-daily
 * rollup at COMMIT (ca_club_rake_daily_at_commit -> fn_ca_club_rake_daily_apply
 * -> fn_ca_club_rake_daily_compute). The compute function is LANGUAGE sql and
 * is planned without its arguments, so it chose a two-worker Gather for a
 * one-row primary-key lookup: 14-30 ms per hand instead of ~2 ms, inside the
 * COMMIT that still holds the union's single union_wallets row (production,
 * 2026-10-03). The per-commit apply path runs with
 * max_parallel_workers_per_gather = 0; this law keeps that setting, and keeps
 * any later CREATE OR REPLACE of the apply function from silently dropping it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const ALL = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const NAME = ALL.filter((f) => f.endsWith('_a_hand_commit_starts_no_parallel_workers.sql')).at(-1);
if (!NAME) throw new Error('the hand-commit parallel-worker migration is missing');
const code = (file: string): string =>
  readFileSync(join(MIGRATIONS, file), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

describe('a hand commit starts no parallel workers', () => {
  it('sets max_parallel_workers_per_gather = 0 on the per-commit apply path, in one asserted transaction', () => {
    const sql = code(NAME);
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
    expect(sql).toMatch(
      /ALTER FUNCTION public\.fn_ca_club_rake_daily_apply\(uuid\[\]\) SET max_parallel_workers_per_gather = 0;/
    );
    expect(sql).toMatch(/'max_parallel_workers_per_gather=0' = ANY \(v_cfg\)/);
    expect(sql).toMatch(/'search_path=public' = ANY \(v_cfg\)/);
    // Configuration only: no body, grant or owner change rides along.
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/\b(GRANT|REVOKE)\b/);
  });

  it('no later migration redefines the apply function without the setting', () => {
    const later = ALL.slice(ALL.indexOf(NAME) + 1);
    for (const file of later) {
      const sql = code(file);
      const re =
        /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_ca_club_rake_daily_apply\s*\(([\s\S]*?)\$(\w*)\$/gi;
      for (const m of sql.matchAll(re)) {
        expect(
          m[1],
          `${file} redefines fn_ca_club_rake_daily_apply without max_parallel_workers_per_gather = 0`
        ).toMatch(/SET\s+max_parallel_workers_per_gather\s*(=|TO)\s*'?0'?/i);
      }
      expect(sql, `${file} resets the apply function's parallel setting`).not.toMatch(
        /ALTER\s+FUNCTION\s+public\.fn_ca_club_rake_daily_apply[\s\S]{0,80}?RESET\s+(ALL|max_parallel_workers_per_gather)/i
      );
    }
  });
});
