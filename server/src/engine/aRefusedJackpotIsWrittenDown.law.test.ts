/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A REFUSED JACKPOT IS WRITTEN DOWN, WITH THE GATE THAT REFUSED IT
 *  CLAUDE.md 10.86 - a signal must not answer when it cannot tell
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS LAW EXISTS, measured on production 2026-09-07.
 *
 * The main Bad Beat Jackpot last paid on 2026-08-21 06:04:16. In the seventeen
 * days since it paid NOTHING, while the drop kept coming in at the highest
 * volume in the platform's history:
 *
 *   week of 2026-08-17   175,939 contribution rows   9 hits
 *   week of 2026-08-24   116,351 contribution rows   0 hits
 *   week of 2026-08-31   277,332 contribution rows   0 hits
 *
 * At the 08-17 rate the week of 08-31 alone expected about fourteen. Nobody
 * could say whether the rules were working or broken, because the database held
 * no difference between "no qualifying hand occurred" and "a qualifying hand
 * occurred and a gate refused it".
 *
 * The detector was not missing. `detectBBJNearMiss` had been running on every
 * showdown since 2026-08-18 and knew the answer every time - and sent it to a
 * `console.log` and a hub event that expires in seconds. `bbj_hand_evidence_log`
 * looks like where this would live and is written only by triggers on the
 * PAYOUT path, so it is empty by construction exactly when nothing pays.
 *
 * That is 10.86 rule 3 in its purest form: a guard with no reader. The fix is
 * a row, and this law is what stops the row quietly going away again.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const settlement = readFileSync(join(here, 'ServerTableEngineSettlement.ts'), 'utf8');
const bbjService = readFileSync(join(here, '..', 'services', 'supabase', 'bbj.ts'), 'utf8');

describe('the near miss reaches a table, not just a console', () => {
  it('settlement imports the recorder and calls it where the near miss is detected', () => {
    expect(settlement).toMatch(/\brecordBBJNearMiss\b/);
    const branch = settlement.slice(
      settlement.indexOf('if (nearMiss.nearMiss) {'),
      settlement.indexOf("type: 'bbj_near_miss'")
    );
    expect(branch).toMatch(/recordBBJNearMiss\(\{/);
  });

  it('carries the gate that refused it - a near miss with no reason is 10.86 all over again', () => {
    const branch = settlement.slice(
      settlement.indexOf('if (nearMiss.nearMiss) {'),
      settlement.indexOf("type: 'bbj_near_miss'")
    );
    expect(branch).toMatch(/reason: nearMiss\.reason,/);
    expect(bbjService).toMatch(/reason: params\.reason \?\? 'unspecified',/);
  });

  it('cannot break settlement: fire-and-forget, and its own failure is reported', () => {
    const branch = settlement.slice(
      settlement.indexOf('if (nearMiss.nearMiss) {'),
      settlement.indexOf("type: 'bbj_near_miss'")
    );
    // `void ... .catch()` - never awaited, never able to reject into settlement.
    expect(branch).toMatch(/void recordBBJNearMiss\(\{/);
    expect(branch).toMatch(/\}\)\.catch\(\(\) => undefined\);/);
    // But a write that fails is not allowed to be silent either.
    expect(bbjService).toMatch(/reportError\(error, 'bbj\.near_miss_not_recorded'/);
  });

  it('writes to bbj_near_misses and nothing else', () => {
    expect(bbjService).toMatch(/\.from\('bbj_near_misses'\)\s*\.insert\(/);
  });

  it('moves no money and gates nothing - it is an instrument, not a repair (10.12)', () => {
    const fn = bbjService.slice(bbjService.indexOf('export async function recordBBJNearMiss'));
    for (const forbidden of [
      'bbj_atomic_payout_v2',
      'fn_bbj_mini_payout',
      'bbj_credit_one_recipient',
      'club_members',
      'table_seats',
      'chip_balance',
    ]) {
      expect(fn).not.toContain(forbidden);
    }
  });
});

describe('a refused MINI is written down too (2026-09-09)', () => {
  // Measured two days after launch: 12 of the first 14 minis drained one
  // club's reserve at 3,642 chips a day against a 5,000 floor. At the floor
  // every mini at those tables is refused by design, and a refusal that only
  // reaches console.warn is the absence-of-hits trap all over again.
  const miniStep = settlement.slice(
    settlement.indexOf('await processMiniBBJPayout('),
    settlement.indexOf('mini jackpot paid ${outcome.total}')
  );

  it('a skipped mini reaches bbj_near_misses with the refusal reason', () => {
    expect(miniStep).toMatch(/if \(outcome\.status === 'skipped'\) \{/);
    expect(miniStep).toMatch(/void recordBBJNearMiss\(\{/);
    expect(miniStep).toMatch(/reason: `mini_refused:\$\{outcome\.reason \|\| 'unspecified'\}`/);
  });

  it('a queued mini is NOT recorded as refused - the write-ahead row resolves it', () => {
    const skippedBranch = miniStep.slice(miniStep.indexOf("outcome.status === 'skipped'"));
    expect(skippedBranch).not.toMatch(/status === 'queued'/);
    // and the recorder sits inside the not-paid branch, after the warn
    expect(miniStep.indexOf('mini jackpot not paid for hand')).toBeLessThan(
      miniStep.indexOf("outcome.status === 'skipped'")
    );
  });

  it('cannot break settlement', () => {
    const skippedBranch = miniStep.slice(miniStep.indexOf("outcome.status === 'skipped'"));
    expect(skippedBranch).toMatch(/\}\)\.catch\(\(\) => undefined\);/);
  });
});
