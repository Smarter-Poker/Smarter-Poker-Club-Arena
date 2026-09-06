/**
 * A DETECTED JACKPOT IS NEVER LOST
 * ═══════════════════════════════════════════════════════════════════════════
 * BBJ build plan phase 2 (docs/BBJ-BUILD-PLAN.md), 2026-09-06.
 *
 * Phase 1 made a failed payout retry and, after four attempts, queue itself.
 * Phase 2 closes what was still open around that, and these pins are the
 * whole of it read from the SOURCE of the settlement step and its
 * collaborators, because the behaviour lives in the seam between them:
 *
 *   2.1  the queue row is written BEFORE the first attempt, not after the
 *        fourth. A process killed between detecting a jackpot and paying it
 *        used to leave nothing behind that knew a jackpot was owed - the one
 *        gap the queue itself could not close.
 *   2.2  a payout that cannot land NOW is announced to the table as pending
 *        rather than leaving it silent, and announced again when the drain
 *        lands it. The :55 maintenance freeze refuses every money write for
 *        five minutes, so this is the ordinary case, not the exotic one.
 *   2.3  one recipient with no club wallet parks their share instead of
 *        raising, which used to roll back the ENTIRE jackpot for everyone.
 *   2.4  the path is counted, so "did it work" is answerable from a graph
 *        rather than by reading the ledger after somebody notices.
 *
 * These are source pins rather than a live settlement run for the reason the
 * rest of this suite is: `completeHandInner` needs a dealt hand, a hub, a
 * pool and a database. The behaviour each one guards is exercised for real
 * in BBJPayoutIsPaidOrQueued and FeeReconcilerRedrivesJackpots; what is
 * pinned HERE is that the settlement step is wired to it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sliceBetween, sliceEnclosingBlock } from '../../../tests/helpers/sourceWindow';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');
const settlement = read('./ServerTableEngineSettlement.ts');
const payout = read('../services/supabase/bbj.ts');
const reconciler = read('../services/FeeReconciler.ts');
const instruments = read('../observability/engineInstruments.ts');

/**
 * The bbj_payout settlement step, bounded by the step that follows it rather
 * than by a byte count - see tests/helpers/sourceWindow for why a magic
 * number here once stopped the whole estate publishing for 39 minutes.
 */
function bbjPayoutStep(): string {
  return sliceBetween(
    settlement,
    "await runStep('bbj_payout'",
    "await runStep('tournament_chip_sync'"
  );
}

describe('2.1 the intent is durable before the money is attempted', () => {
  it('processBBJPayout claims BEFORE the attempt loop, not after it', () => {
    const claimAt = payout.indexOf("claim(params, 'write-ahead");
    const loopAt = payout.indexOf('for (let attempt = 1; attempt <= BBJ_PAYOUT_ATTEMPTS');
    expect(claimAt).toBeGreaterThan(0);
    expect(loopAt).toBeGreaterThan(0);
    expect(claimAt).toBeLessThan(loopAt);
  });

  it('every terminal outcome closes the claim, so a settled hand is never re-driven', () => {
    // paid / already paid, and "nothing will ever be owed" alike.
    expect(payout).toMatch(/settle\(\s*\n?\s*params,\s*\n?\s*outcome\.status === 'paid'/);
    expect(payout).toMatch(/nothing to pay \(\$\{e\.reason\}\)/);
  });

  it('a re-drive from the queue neither claims nor settles - the reconciler owns the row', () => {
    expect(payout).toMatch(/const owned = options\.fromQueue !== true;/);
    expect(payout).toMatch(/if \(owned\) \{/);
  });

  it('bookkeeping can never stop the money', () => {
    // Every queue call goes through the wrapper that swallows and reports.
    expect(payout).toMatch(/async function queueSafely\(/);
    expect(payout).not.toMatch(/await bbjPayoutQueue!\.(claim|settle)\([^)]*\);(?!\s*\},)/);
  });
});

describe('2.2 the table is told, whether the money is now or later', () => {
  const step = bbjPayoutStep();

  it('a queued payout announces bbj_payout_pending from the settlement step', () => {
    expect(step).toMatch(/outcome\.status === 'queued'/);
    expect(step).toMatch(/type: 'bbj_payout_pending'/);
  });

  it('that announcement is retained, like every other jackpot beat', () => {
    expect(sliceEnclosingBlock(step, "type: 'bbj_payout_pending'")).toMatch(
      /replay_until: Date\.now\(\) \+ 60_000/
    );
  });

  it('the reconciler announces bbj_payout_paid when it lands one late', () => {
    expect(reconciler).toMatch(/type: 'bbj_payout_paid'/);
    expect(reconciler).toMatch(/paidLate/);
  });

  it('the late announcement cannot fail the drain, and imports the hub lazily', () => {
    const around = sliceEnclosingBlock(reconciler, "type: 'bbj_payout_paid'", 0, 3);
    expect(around).toMatch(/try \{/);
    // A static import pulls the transport into module-init for every consumer.
    expect(around).toMatch(/await import\('\.\.\/transport\/TableStateHub\.js'\)/);
    expect(reconciler).not.toMatch(/^import \{ tableStateHub \}/m);
  });

  it('the client handles both, and refuses a stale replay of either', () => {
    const page = read('../../../src/pages/TablePage.tsx');
    for (const t of ['bbj_payout_pending', 'bbj_payout_paid']) {
      expect(sliceEnclosingBlock(page, `eventType === '${t}'`), t).toMatch(
        /shouldAnnounceBbjHit\(/
      );
    }
  });
});

describe('2.3 one unpayable share does not cost everyone else theirs', () => {
  it('a parked share is reported, never silent', () => {
    expect(payout).toMatch(/from\('bbj_unclaimed_shares'\)/);
    expect(payout).toMatch(/processBBJPayout\.share_parked/);
  });

  it('the alert names who is owed what, so the debt is actionable', () => {
    const block = sliceEnclosingBlock(payout, 'processBBJPayout.share_parked', 0, 2);
    expect(block).toMatch(/parked: parked\.map/);
    expect(block).toMatch(/fn_bbj_unclaimed_shares\(\)/);
  });
});

describe('2.4 the whole path is counted', () => {
  it('declares detected, paid, queued and parked', () => {
    for (const m of [
      'poker_bbj_hits_detected_total',
      'poker_bbj_payouts_paid_total',
      'poker_bbj_payouts_queued_total',
      'poker_bbj_shares_parked_total',
    ]) {
      expect(instruments, m).toContain(m);
    }
  });

  it('the engine counts a detection where it emits bbj_hit, and a payout where it lands', () => {
    expect(sliceEnclosingBlock(settlement, "type: 'bbj_hit'", 0, 2)).toMatch(
      /bbjHitsDetectedTotal\.inc\(/
    );
    const step = bbjPayoutStep();
    expect(step).toMatch(/bbjPayoutsPaidTotal\.inc\(/);
    expect(step).toMatch(/bbjPayoutsQueuedTotal\.inc\(/);
  });

  it('detected and paid are counted on DIFFERENT outcomes, so a gap between them is visible', () => {
    const step = bbjPayoutStep();
    const paidAt = step.indexOf('bbjPayoutsPaidTotal.inc(');
    const queuedAt = step.indexOf('bbjPayoutsQueuedTotal.inc(');
    expect(paidAt).toBeGreaterThan(0);
    expect(queuedAt).toBeGreaterThan(0);
    expect(paidAt).not.toBe(queuedAt);
  });
});
