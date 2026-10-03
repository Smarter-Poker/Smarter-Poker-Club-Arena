/**
 * JACKPOT FACTS READ CLOSED HOURS ONCE.
 *
 * fn_bbj_pool_facts (called by the Bad Beat Jackpot page on every load and
 * every HAND_COMPLETED tick, per viewer) counted and summed every contribution
 * the pool ever received: 1,171,516 rows, 5.6 s, for the union pool on
 * 2026-10-03. Closed UTC hours are now cached in bbj_pool_contribution_hours
 * and only the open tail is read live (3.5 ms measured). A contribution
 * stamped before the current hour (fn_bbj_repair_unbanked) drops the pool's
 * cached hours from that hour onward; an UPDATE/DELETE/TRUNCATE drops the
 * pool's cache. This law keeps those guards and keeps a later redefinition of
 * fn_bbj_pool_facts from silently going back to the full scan.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const ALL = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const NAME = ALL.filter((f) => f.endsWith('_jackpot_facts_read_closed_hours_once.sql')).at(-1);
if (!NAME) throw new Error('the jackpot facts cache migration is missing');
const code = (file: string): string =>
  readFileSync(join(MIGRATIONS, file), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
const SQL = code(NAME);

describe('jackpot facts read closed hours once', () => {
  it('is one transaction that fills the cache before it takes the trigger lock', () => {
    expect(SQL).toMatch(/^BEGIN;/m);
    expect(SQL).toMatch(/^COMMIT;/m);
    const fill = SQL.indexOf(
      'INSERT INTO public.bbj_pool_contribution_hours (pool_id, hour_start, hands, total, first_at)\nSELECT'
    );
    const trigger = SQL.indexOf('CREATE TRIGGER bbj_contribution_backdated_drops_cached_hours');
    expect(fill).toBeGreaterThan(0);
    expect(trigger).toBeGreaterThan(fill);
  });

  it('buckets by UTC hour everywhere and caches only hours closed 15 minutes ago', () => {
    const all = SQL.match(/date_trunc\('hour',/g)?.length ?? 0;
    const utc =
      SQL.match(
        /date_trunc\('hour', (now\(\)( - interval '15 minutes')?|c\.created_at|NEW\.created_at), 'UTC'\)/g
      )?.length ?? 0;
    expect(all).toBeGreaterThan(0);
    expect(utc).toBe(all);
    expect(SQL).toMatch(/date_trunc\('hour', now\(\) - interval '15 minutes', 'UTC'\)/);
  });

  it('drops cached hours for backdated inserts and for any rewrite of contributions', () => {
    expect(SQL).toMatch(
      /AFTER INSERT ON public\.bbj_contributions\s+FOR EACH ROW\s+WHEN \(NEW\.created_at < date_trunc\('hour', now\(\), 'UTC'\)\)/
    );
    expect(SQL).toMatch(
      /AFTER UPDATE ON public\.bbj_contributions\s+REFERENCING OLD TABLE AS old_rows/
    );
    expect(SQL).toMatch(
      /AFTER DELETE ON public\.bbj_contributions\s+REFERENCING OLD TABLE AS old_rows/
    );
    expect(SQL).toMatch(/AFTER TRUNCATE ON public\.bbj_contributions/);
    // The reader and the invalidator share one per-pool key.
    expect(SQL.match(/'bbj-facts-hours:' \|\| /g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the facts function signature, return shape and grants', () => {
    expect(SQL).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_bbj_pool_facts\(p_pool_id uuid\)\s+RETURNS TABLE\(hands_contributed bigint, total_contributed numeric, first_contribution_at timestamp with time zone\)/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_bbj_pool_facts\(uuid\) TO authenticated, service_role;/
    );
  });

  it('no later migration redefines the facts without the cache', () => {
    for (const file of ALL.slice(ALL.indexOf(NAME) + 1)) {
      const sql = code(file);
      const re =
        /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_bbj_pool_facts\s*\([\s\S]*?\$function\$([\s\S]*?)\$function\$/gi;
      for (const m of sql.matchAll(re)) {
        expect(m[1], `${file} redefines fn_bbj_pool_facts without the hour cache`).toMatch(
          /bbj_pool_contribution_hours/
        );
      }
    }
  });
});
