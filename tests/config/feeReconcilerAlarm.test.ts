/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FEE RECONCILER — the safety net was a single attempt, and it cried wolf
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `queueUnbankedFee` is the last line of defence in the A5 chain. Rake and the
 * BBJ slice have already left the pot; if the banking call failed and this
 * queue insert also fails, the chips are recoverable only by hand. The comment
 * on the function said exactly that — and the insert was a SINGLE ATTEMPT.
 *
 * Measured across 2026-08-20 to 2026-08-22:
 *
 *   988  critical FeeReconciler.queue_failed alerts, none resolved
 *   938  of them saying `supabase_timeout`
 *
 * The net was being dropped by precisely the transient condition it exists to
 * survive. The insert is idempotent — a partial unique index on (hand_id, kind)
 * where resolved_at is null — so retrying it costs nothing.
 *
 * The second half matters as much. Of the 127 alerts carrying a hand id, 118
 * had a `rake_records` row for that hand: the banking call had SUCCEEDED and
 * only its response was lost. Nine had not, worth 29.44 chips. So 93% of a
 * critical money alarm was noise — and 988 unresolved criticals is how the nine
 * real ones stay invisible.
 *
 * Source-level, like the rest of tests/config: exercising this needs a live
 * Postgres and an induced timeout.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(
  resolve(__dirname, '../../server/src/services/FeeReconciler.ts'),
  'utf8'
);
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('the queue insert survives a blip', () => {
  it('retries rather than escalating on the first transient error', () => {
    expect(code).toMatch(/for \(let attempt = 1; attempt <= QUEUE_INSERT_ATTEMPTS; attempt\+\+\)/);
    expect(code).toMatch(/const QUEUE_INSERT_ATTEMPTS = \d+;/);
  });

  it('recognises a timeout as transient', () => {
    // The literal string 938 of the 988 alerts carried.
    expect(code).toMatch(/TRANSIENT_DB_ERROR\s*=[\s\S]{0,400}timeout/);
  });

  it('treats a duplicate as success — it means the row is already queued', () => {
    expect(code).toMatch(/if \(\/duplicate\|unique\/i\.test\(error\.message \|\| ''\)\) return;/);
  });

  it('does not retry an error that is not transient', () => {
    expect(code).toMatch(
      /if \(!TRANSIENT_DB_ERROR\.test\(lastError\) \|\| attempt === QUEUE_INSERT_ATTEMPTS\) break;/
    );
  });
});

describe('it asks whether the fee landed before calling the chips lost', () => {
  it('checks before raising the critical', () => {
    const check = code.indexOf('feeAlreadyBanked(kind, fee)');
    const alarm = code.indexOf("raiseFinancialAlert('critical'");
    expect(check, 'the verification must exist').toBeGreaterThan(-1);
    expect(alarm).toBeGreaterThan(-1);
    expect(check, 'and it must come first, or it is decoration').toBeLessThan(alarm);
  });

  it('returns without alarming when the fee is already banked', () => {
    expect(code).toMatch(/if \(await feeAlreadyBanked\(kind, fee\)\) \{[\s\S]{0,400}return;\s*\}/);
  });

  it('looks in the right place for each kind', () => {
    const fn = code.slice(code.indexOf('async function feeAlreadyBanked'));
    expect(fn).toMatch(/from\('rake_records'\)[\s\S]{0,200}eq\('hand_id', fee\.handId\)/);
    // hand_id is null on the outage case — the number is the fallback, scoped
    // by table so it cannot match another table's hand.
    expect(fn).toMatch(/eq\('global_hand_id', fee\.handNumber\)/);
    expect(fn).toMatch(/eq\('table_id', fee\.tableId\)/);
    expect(fn).toMatch(/from\('bbj_contributions'\)[\s\S]{0,200}eq\('hand_number', fee\.handNumber\)/);
  });

  it('fails CLOSED — anything unknown still raises the alarm', () => {
    const fn = code.slice(code.indexOf('async function feeAlreadyBanked'));
    // A thrown query must not be read as "it was banked".
    expect(fn).toMatch(/catch \{\s*return false;\s*\}/);
    // And a missing hand number is not evidence of anything either.
    expect(fn).toMatch(/if \(!\(Number\(fee\.handNumber\) > 0\)\) return false;/);
  });

  it('uses .maybeSingle(), never .single()', () => {
    const fn = code.slice(code.indexOf('async function feeAlreadyBanked'));
    expect(fn).not.toMatch(/\.single\(\)/);
    expect((fn.match(/\.maybeSingle\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('the alarm still fires when chips really are at risk', () => {
  it('the critical alert is still raised, and says it was verified', () => {
    expect(code).toMatch(/raiseFinancialAlert\('critical', 'FeeReconciler\.queue_failed'/);
    expect(code).toMatch(/verifiedUnbanked: true/);
  });

  it('the wording that tells an operator what is at stake is unchanged', () => {
    expect(src).toMatch(/These chips left the pot and/);
    expect(src).toMatch(/recoverable only by hand/);
  });
});
