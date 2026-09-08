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

const src = readFileSync(resolve(__dirname, '../../server/src/services/FeeReconciler.ts'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('the queue insert survives a blip', () => {
  it('retries rather than escalating on the first transient error', () => {
    expect(code).toMatch(/for \(let attempt = 1; attempt <= QUEUE_INSERT_ATTEMPTS; attempt\+\+\)/);
    expect(code).toMatch(/const QUEUE_INSERT_ATTEMPTS = \d+;/);
  });

  it('treats a PostgREST schema-cache reload as transient', () => {
    /**
     * Found by the reporting the previous PR added, in its own output. Over
     * 2026-08-22 20:30Z onward, with the noise gone, 16 of the ~40 remaining
     * alerts said:
     *
     *   "Could not query the database for the schema cache. Retrying."
     *
     * The message ends in the word "Retrying" and the original
     * TRANSIENT_DB_ERROR matched none of it, so it escalated to a critical
     * money alarm on the FIRST attempt without retrying once. It is not only
     * transient, it is SELF-INFLICTED: every apply_migration reloads that
     * cache, and five migrations went out that day.
     */
    expect(code).toMatch(/TRANSIENT_DB_ERROR\s*=[\s\S]{0,400}schema cache/);
    expect(code).toMatch(/TRANSIENT_DB_ERROR\s*=[\s\S]{0,400}PGRST002/);
  });

  it('backs off far enough for that reload to finish', () => {
    // 300ms/900ms/2.7s, not a flat 1.5s of total patience. Free on a path
    // that only runs when banking has already failed.
    expect(code).toMatch(/QUEUE_BACKOFF_MS = \(attempt: number\): number => 100 \* 3 \*\* attempt/);
    expect(code).toMatch(/setTimeout\(r, QUEUE_BACKOFF_MS\(attempt\)\)/);
  });

  it('recognises a timeout as transient', () => {
    // The literal string 938 of the 988 alerts carried.
    expect(code).toMatch(/TRANSIENT_DB_ERROR\s*=[\s\S]{0,400}timeout/);
  });

  it('treats a duplicate as success — it means the row is already queued', () => {
    // Moved into insertOnce() on 2026-09-08 so the inline ladder and the
    // off-path retry share one attempt. Same guarantee, one caller more.
    expect(code).toMatch(
      /if \(\/duplicate\|unique\/i\.test\(error\.message \|\| ''\)\) return \{ done: true, error: '' \};/
    );
  });

  it('does not retry an error that is not transient', () => {
    expect(code).toMatch(
      /if \(!TRANSIENT_DB_ERROR\.test\(lastError\) \|\| attempt === QUEUE_INSERT_ATTEMPTS\) break;/
    );
  });
});

describe('it asks whether the fee landed before calling the chips lost', () => {
  it('checks before raising the critical', () => {
    const check = code.indexOf('feeIsAccountedFor(kind, fee)');
    const alarm = code.indexOf("raiseFinancialAlert('critical'");
    expect(check, 'the verification must exist').toBeGreaterThan(-1);
    expect(alarm).toBeGreaterThan(-1);
    expect(check, 'and it must come first, or it is decoration').toBeLessThan(alarm);
  });

  it('returns without alarming when the fee is already queued or banked', () => {
    // Tri-state since 2026-09-08: only a definite 'yes' returns early.
    expect(code).toMatch(/const verdict = await feeIsAccountedFor\(kind, fee\);/);
    expect(code).toMatch(/if \(verdict === 'yes'\) \{[\s\S]{0,400}return;\s*\}/);
  });

  it('checks the QUEUE first — a timed-out insert usually committed', () => {
    // 830 of the 1,020 open alerts on 2026-08-22 referred to a fee that was
    // already sitting in pending_fee_distributions. The duplicate-key path
    // only catches that when Postgres gets to answer; a timeout is exactly
    // when it does not.
    const fn = code.slice(code.indexOf('async function feeIsAccountedFor'));
    const queue = fn.indexOf("from('pending_fee_distributions')");
    const rake = fn.indexOf("from('rake_records')");
    expect(queue).toBeGreaterThan(-1);
    expect(queue).toBeLessThan(rake);
  });

  it('looks in the right place for each kind', () => {
    const fn = code.slice(code.indexOf('async function feeIsAccountedFor'));
    expect(fn).toMatch(/from\('rake_records'\)[\s\S]{0,200}eq\('hand_id', fee\.handId\)/);
    // hand_id is null on the outage case — the number is the fallback, scoped
    // by table so it cannot match another table's hand.
    expect(fn).toMatch(/eq\('global_hand_id', fee\.handNumber\)/);
    expect(fn).toMatch(/eq\('table_id', fee\.tableId\)/);
    expect(fn).toMatch(
      /from\('bbj_contributions'\)[\s\S]{0,200}eq\('hand_number', fee\.handNumber\)/
    );
  });

  it('fails CLOSED — anything unknown still raises the alarm', () => {
    const fn = code.slice(code.indexOf('async function feeIsAccountedFor'));
    // A thrown query must not be read as "it was banked". Same guarantee as
    // before 2026-09-08, expressed through the tri-state: the catch records
    // that we could not ask and returns a non-affirmative answer. What it may
    // NEVER do is return 'yes'.
    expect(fn).toMatch(/catch \{\s*couldNotAsk = true;\s*return false;\s*\}/);
    // 'unknown' is not 'yes': it never short-circuits as accounted-for.
    expect(fn).toMatch(/return couldNotAsk \? 'unknown' : 'no';/);

    // And the alarm still fires on it. Only a definite 'yes' returns early;
    // 'unknown' falls through to raiseFinancialAlert exactly as 'no' does.
    const alarm = code.slice(code.indexOf('async function alarmUnqueueableFee'));
    expect(alarm).toMatch(/if \(verdict === 'yes'\)/);
    expect(alarm).not.toMatch(/if \(verdict === 'unknown'\)\s*\{[\s\S]{0,400}?return;/);
    expect(alarm).toContain("raiseFinancialAlert('critical', 'FeeReconciler.queue_failed'");
  });

  it('does not claim it verified something it could not check', () => {
    // `verifiedUnbanked: true` used to be written unconditionally, including
    // on the path where feeIsAccountedFor could not reach the database at all.
    const alarm = code.slice(code.indexOf('async function alarmUnqueueableFee'));
    expect(alarm).toMatch(/const verified = verdict === 'no';/);
    expect(alarm).toMatch(/verifiedUnbanked: verified,/);
    expect(alarm).not.toMatch(/verifiedUnbanked: true/);
  });

  it('uses .maybeSingle(), never .single()', () => {
    const fn = code.slice(code.indexOf('async function feeIsAccountedFor'));
    expect(fn).not.toMatch(/\.single\(\)/);
    expect((fn.match(/\.maybeSingle\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('the alarm carries what it takes to put the chips back', () => {
  /**
   * An alarm that says money is missing and cannot say how to return it is
   * half an alarm. `atomic_distribute_rake` needs pot, num_players and the
   * per-player `contributions` split; `auditBBJDrift` in the same file spells
   * out what happens without the last one — "guessing it would corrupt
   * rakeback attribution". The 190 alerts open on 2026-08-22 name chips
   * nobody can safely re-drive purely because the context summarised a
   * payload the function was already holding in full.
   */
  const REQUIRED = ['pot', 'numPlayers', 'contributions', 'tournamentId', 'bigBlind'];

  it('queue_failed carries the full re-drive payload', () => {
    const i = code.indexOf("raiseFinancialAlert('critical', 'FeeReconciler.queue_failed'");
    expect(i).toBeGreaterThan(-1);
    const ctx = code.slice(i, code.indexOf('});', i));
    for (const k of REQUIRED)
      expect(ctx, `queue_failed context missing ${k}`).toMatch(new RegExp(`\\b${k}:`));
  });

  it('exhausted carries it too', () => {
    const i = code.indexOf("raiseFinancialAlert('critical', 'FeeReconciler.exhausted'");
    expect(i).toBeGreaterThan(-1);
    const ctx = code.slice(i, code.indexOf('});', i));
    for (const k of REQUIRED)
      expect(ctx, `exhausted context missing ${k}`).toMatch(new RegExp(`\\b${k}:`));
  });

  it('contributions is never left undefined', () => {
    // A missing key and an empty map are different claims. `?? {}` says
    // "there were none", `undefined` says "I did not record it".
    expect(code).toMatch(/contributions: fee\.contributions \?\? \{\}/);
    expect(code).toMatch(/contributions: row\.contributions \?\? \{\}/);
  });
});

describe('the alarm still fires when chips really are at risk', () => {
  it('the critical alert is still raised, and says whether it was verified', () => {
    expect(code).toMatch(/raiseFinancialAlert\('critical', 'FeeReconciler\.queue_failed'/);
    // Was a literal `true` until 2026-09-08, written on every path including
    // the one where the check could not reach the database at all. It now
    // carries the answer it actually got.
    expect(code).toMatch(/verifiedUnbanked: verified,/);
    expect(code).toMatch(/verificationUnavailable: !verified,/);
  });

  it('the wording that tells an operator what is at stake is unchanged', () => {
    expect(src).toMatch(/These chips left the pot and/);
    expect(src).toMatch(/recoverable only by hand/);
  });
});
