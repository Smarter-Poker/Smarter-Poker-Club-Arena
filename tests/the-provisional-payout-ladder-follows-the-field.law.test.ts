/**
 * THE PROVISIONAL PAYOUT LADDER FOLLOWS THE FIELD.
 *
 * Dan, 2026-10-21, on the live Midweek Bounty showing 16 paid places for 188
 * entries ("8.7% Of The Field Paid"): "ADJUST THIS LIVE TOURNAMENT TO PAY OUT
 * 12.5% OF THE FIELD. FIX THIS".
 *
 * The paid depth was already 12.5% and the entry-close finalization rebuilds
 * the ladder from the final field. What players saw in between was the ladder
 * written once at launch for a smaller field. The stored provisional ladder now
 * equals the paid depth of the CURRENT field, refreshed in the same
 * transaction as every entry or removal, until the pool is finalized.
 *
 * Registry: docs/laws.d/the-provisional-payout-ladder-follows-the-field.md
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const file = readdirSync(MIGRATIONS)
  .filter((name) =>
    name.endsWith('_the_provisional_payout_ladder_follows_the_field_during_late_.sql')
  )
  .sort()
  .at(-1);
const RAW = file ? readFileSync(join(MIGRATIONS, file), 'utf8') : '';
const SQL = RAW.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const between = (start: string, end: string): string => {
  const a = SQL.indexOf(start);
  const b = SQL.indexOf(end, a + start.length);
  return a >= 0 && b > a ? SQL.slice(a, b) : '';
};
const DERIVE = between(
  'CREATE OR REPLACE FUNCTION public.fn_ca_provisional_payout_structure(',
  '$function$;'
);
const REFRESH = between(
  'CREATE OR REPLACE FUNCTION public.fn_ca_refresh_provisional_payout_structure(',
  '$function$;'
);
const WRAPPER = between(
  'CREATE OR REPLACE FUNCTION public.trg_ca_refresh_provisional_payout_structure(',
  '$function$;'
);

describe('the provisional payout ladder follows the field', () => {
  it('exists as one transaction', () => {
    expect(file, 'migration not found').toBeTruthy();
    expect(SQL).toMatch(/^\s*BEGIN;/m);
    expect(SQL).toMatch(/COMMIT;\s*$/);
    expect(DERIVE && REFRESH && WRAPPER).toBeTruthy();
  });

  it('derives the ladder from the current field at the paid depth', () => {
    expect(DERIVE).toMatch(/public\.fn_ca_payout_structure\(/);
    expect(DERIVE).toMatch(/count\(\*\)::integer FROM public\.tournament_players/);
    expect(DERIVE).toMatch(/fn_ca_effective_payout_depth\(t\.payout_depth_percent, t\.payout_percent\)/);
  });

  it('never touches a finalized pool, a Spin or a satellite', () => {
    expect(DERIVE).toMatch(/NOT COALESCE\(t\.prize_pool_finalized, false\)/);
    expect(DERIVE).toMatch(/'spin', 'sng', 'satellite'/);
    expect(DERIVE).toMatch(/t\.satellite_target_id IS NULL/);
    expect(REFRESH).toMatch(/NOT COALESCE\(t\.prize_pool_finalized, false\)/);
    expect(REFRESH).toMatch(/SET payout_structure = v_ladder::text/);
  });

  it('refreshes in the same transaction as every entry and removal', () => {
    expect(SQL).toMatch(
      /CREATE TRIGGER zzz_provisional_ladder_follows_entries\s+AFTER INSERT ON public\.tournament_players\s+REFERENCING NEW TABLE AS new_rows\s+FOR EACH STATEMENT/
    );
    expect(SQL).toMatch(
      /CREATE TRIGGER zzz_provisional_ladder_follows_removals\s+AFTER DELETE ON public\.tournament_players\s+REFERENCING OLD TABLE AS old_rows\s+FOR EACH STATEMENT/
    );
  });

  it('can never cost a player their entry', () => {
    expect(WRAPPER).toMatch(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/);
    expect(WRAPPER).not.toMatch(/RAISE EXCEPTION/);
  });

  it('opens the lifecycle guard for exactly the derived ladder and nothing else', () => {
    expect(RAW).toMatch(/CONTINUE WHEN v_key = ''payout_structure''/);
    expect(RAW).toMatch(
      /IS NOT DISTINCT FROM public\.fn_ca_provisional_payout_structure\(NEW\.id\)/
    );
    expect(RAW).toMatch(/lifecycle guard anchor not found exactly once/);
  });

  it('declares both money-table triggers and keeps the browser out', () => {
    expect(SQL).toMatch(/'zzz_provisional_ladder_follows_entries'/);
    expect(SQL).toMatch(/'zzz_provisional_ladder_follows_removals'/);
    for (const fn of [
      'fn_ca_provisional_payout_structure(uuid)',
      'fn_ca_refresh_provisional_payout_structure(uuid)',
    ]) {
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`);
    }
  });
});
