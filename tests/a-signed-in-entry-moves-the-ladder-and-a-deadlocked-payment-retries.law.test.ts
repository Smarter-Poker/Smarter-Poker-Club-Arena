/**
 * A SIGNED-IN ENTRY MOVES THE PROVISIONAL LADDER, AND A DEADLOCKED BUST
 * PAYMENT RETRIES INSIDE ITS OWN TRANSACTION.
 *
 * Dan, 2026-10-21: "it should 100% always display it as 12.5% payout".
 * Measured 2026-10-22: every browser registration had its ladder refresh
 * refused by fn_guard_registered_tournament_contract (auth.uid() is set in the
 * player's own request), so only horse and engine entries moved the ladder.
 * The same night a bust payment lost a deadlock (40P01) to another table's
 * commit and was dropped instead of retried.
 *
 * Registry: docs/laws.d/a-signed-in-entry-moves-the-ladder-and-a-deadlocked-payment-retries.md
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const file = readdirSync(MIGRATIONS)
  .filter((name) =>
    name.endsWith('_a_registering_player_refreshes_the_provisional_ladder_and_a_.sql')
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
const GUARD = between(
  'CREATE OR REPLACE FUNCTION public.fn_guard_registered_tournament_contract(',
  '$function$;'
);
const PAYER_WRAPPER = between(
  'CREATE OR REPLACE FUNCTION public.trg_ca_pay_tournament_finishers_at_commit(',
  '$function$;'
);

describe('a signed-in entry moves the ladder and a deadlocked payment retries', () => {
  it('exists as one transaction', () => {
    expect(file, 'migration not found').toBeTruthy();
    expect(SQL).toMatch(/^\s*BEGIN;/m);
    expect(SQL).toMatch(/COMMIT;\s*$/);
    expect(GUARD && PAYER_WRAPPER).toBeTruthy();
  });

  it('the registered-contract guard admits only the derived provisional ladder', () => {
    expect(GUARD).toMatch(/NOT COALESCE\(OLD\.prize_pool_finalized, false\)/);
    expect(GUARD).toMatch(/NOT COALESCE\(NEW\.prize_pool_finalized, false\)/);
    expect(GUARD).toMatch(
      /fn_safe_jsonb_array\(NEW\.payout_structure::text\)\s+IS NOT DISTINCT FROM public\.fn_ca_provisional_payout_structure\(NEW\.id\)/
    );
    expect(GUARD).toMatch(/v_old := v_old - 'payout_structure'/);
    expect(GUARD).toMatch(/v_new := v_new - 'payout_structure'/);
  });

  it('every other contract change is still refused for a signed-in caller', () => {
    expect(GUARD).toMatch(/auth\.uid\(\) IS NOT NULL AND v_old IS DISTINCT FROM v_new/);
    expect(GUARD).toMatch(/Tournament contract cannot be modified after a player has registered/);
  });

  it('the bust payment retries only transient lock outcomes, a bounded number of times', () => {
    expect(PAYER_WRAPPER).toMatch(/LOOP/);
    expect(PAYER_WRAPPER).toMatch(/v_state NOT IN \('40P01', '55P03', '40001'\)/);
    expect(PAYER_WRAPPER).toMatch(/v_attempt >= 4/);
    expect(PAYER_WRAPPER).toMatch(/fn_ca_pay_tournament_finishers_now\(v_tournament_id\)/);
  });

  it('a refusal that survives every attempt is still recorded once per event', () => {
    expect(PAYER_WRAPPER).toMatch(/'tournament\.real_time_payout_refused'/);
    expect(PAYER_WRAPPER).toMatch(/NOT fa\.resolved/);
  });

  it('names its grants', () => {
    expect(RAW).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_guard_registered_tournament_contract\(\) FROM PUBLIC, anon, authenticated;/
    );
    expect(RAW).toMatch(
      /REVOKE ALL ON FUNCTION public\.trg_ca_pay_tournament_finishers_at_commit\(\) FROM PUBLIC, anon, authenticated;/
    );
  });
});
