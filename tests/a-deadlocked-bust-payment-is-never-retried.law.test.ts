/**
 * A DEADLOCKED BUST PAYMENT IS NEVER RETRIED.
 *
 * Measured 2026-10-22 06:11:38-06:11:42 UTC: four retries of one deadlocked
 * payment each deadlocked again, because the cycle partner waits on a lock
 * the bust's transaction holds at top level, which a subtransaction retry can
 * never release. Retrying only held the engine's hand commit four seconds.
 * The latest definition of the deferred payer wrapper must therefore never
 * retry 40P01; only a lock timeout or serialization failure retries.
 *
 * Registry: docs/laws.d/a-deadlocked-bust-payment-is-never-retried.md
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const HEAD = 'CREATE OR REPLACE FUNCTION public.trg_ca_pay_tournament_finishers_at_commit(';
const latest = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .filter((name) => readFileSync(join(MIGRATIONS, name), 'utf8').includes(HEAD))
  .at(-1);
const RAW = latest ? readFileSync(join(MIGRATIONS, latest), 'utf8') : '';
const SQL = RAW.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const start = SQL.indexOf(HEAD);
const WRAPPER = start >= 0 ? SQL.slice(start, SQL.indexOf('$function$;', start)) : '';

describe('a deadlocked bust payment is never retried', () => {
  it('the latest payer wrapper exists', () => {
    expect(latest, 'no migration defines the wrapper').toBeTruthy();
    expect(WRAPPER).toMatch(/fn_ca_pay_tournament_finishers_now\(v_tournament_id\)/);
  });

  it('retries only lock timeouts and serialization failures, boundedly', () => {
    expect(WRAPPER).not.toMatch(/'40P01'/);
    expect(WRAPPER).toMatch(/v_state NOT IN \('55P03', '40001'\)/);
    expect(WRAPPER).toMatch(/v_attempt >= 4/);
  });

  it('still records a payment that was not made at the bust', () => {
    expect(WRAPPER).toMatch(/'tournament\.real_time_payout_refused'/);
  });
});
