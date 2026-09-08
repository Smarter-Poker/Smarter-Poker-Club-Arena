/**
 * A GUARANTEE IS A PROMISE - PHASE 6.
 *
 * applyPrizeGuarantee had exactly two triggers, and between them they miss an
 * entire shape of event:
 *
 *   start()        only when late_reg_levels <= 0
 *   level change   only when currentLevel >= late_reg_levels
 *
 * An event with a late-reg window that FINISHES BELOW THAT LEVEL calls it zero
 * times. Twelve of the fourteen short events died exactly there. Nine were
 * freerolls, whose pool is 0 by construction and whose guarantee is the only
 * money they will ever have: they ranked a full field - 313 and 326 players
 * among them - stamped a winner, and paid nobody a chip.
 *
 * TournamentManagerBase's own comment promises `fn_sweep_unfunded_guarantees`
 * as the safety net for this. It was never written. These pins hold the net
 * that replaced it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ELIM = fs.readFileSync(path.join(HERE, 'TournamentManagerEliminations.ts'), 'utf8');
const RECOVERY = fs.readFileSync(path.join(HERE, 'tournamentRecovery.ts'), 'utf8');
const RECONCILER = fs.readFileSync(path.join(HERE, '../services/FeeReconciler.ts'), 'utf8');
const GAMESERVER = fs.readFileSync(path.join(HERE, '../GameServer.ts'), 'utf8');

/** The file with comments stripped, so a pin cannot pass on prose. */
function executable(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}
const CODE = executable(ELIM);
const RECOVERY_CODE = sliceMethod(
  executable(RECOVERY),
  'export async function recoverStuckCompletingTournaments('
);

describe('the finish path funds the guarantee', () => {
  it('calls applyPrizeGuarantee with a finish-specific source', () => {
    expect(CODE).toMatch(/applyPrizeGuarantee\('finish_fallback'\)/);
  });

  it('funds BEFORE the winner prize is priced, or it would price off a stale pool', () => {
    const fund = CODE.indexOf("applyPrizeGuarantee('finish_fallback')");
    const price = CODE.indexOf('let winnerPrize = 0;');
    expect(fund).toBeGreaterThan(-1);
    expect(price).toBeGreaterThan(-1);
    expect(fund).toBeLessThan(price);
  });

  it('uses the validated funding receipt instead of the stale local snapshot', () => {
    const tail = CODE.slice(CODE.indexOf("applyPrizeGuarantee('finish_fallback')"));
    const window = tail.slice(0, tail.indexOf('let winnerPrize = 0;'));
    expect(window).toMatch(/from\('tournaments'\)/);
    expect(window).toMatch(/select\('prize_pool, guaranteed_prize, prize_pool_finalized'\)/);
    expect(window).toMatch(/prize_pool_finalized !== true/);
    expect(window).toMatch(/refreshedPool \+ 0\.005 < refreshedGuarantee/);
  });

  it('is NOT gated on prize_pool or buy_in_amount - the two filters that hid the freerolls', () => {
    const tail = CODE.slice(CODE.indexOf('const isSatelliteFinish'));
    const window = tail.slice(0, tail.indexOf('let winnerPrize = 0;'));
    expect(window).not.toMatch(/prize_pool\s*[><]/);
    expect(window).not.toMatch(/buy_in_amount/);
  });

  it('skips satellites, which award seats rather than structure cash', () => {
    const tail = CODE.slice(CODE.indexOf('const isSatelliteFinish'));
    const window = tail.slice(0, tail.indexOf('let winnerPrize = 0;'));
    expect(window).toMatch(/!isSatelliteFinish/);
  });

  it('a funding failure leaves the tournament COMPLETING instead of paying below the promise', () => {
    const tail = CODE.slice(CODE.indexOf("applyPrizeGuarantee('finish_fallback')"));
    const window = tail.slice(0, tail.indexOf('let winnerPrize = 0;'));
    expect(window).toMatch(/catch/);
    expect(window).toMatch(/guarantee_finish_fallback_failed/);
    expect(window).toMatch(/funded === null[\s\S]*?tournamentFinished = false;[\s\S]*?return;/);
    expect(window).toMatch(
      /guarantee_finish_fallback_failed[\s\S]*?tournamentFinished = false;[\s\S]*?return;/
    );
  });

  it('re-prices zero-recorded finishers after a late guarantee arrives', () => {
    const recalcStart = CODE.indexOf('recalculateEliminatedPrizes(finalPrizePool: number)');
    const recalcEnd = CODE.indexOf('protected tournamentFinished', recalcStart);
    const recalc = CODE.slice(recalcStart, recalcEnd);
    const finishTail = CODE.slice(CODE.indexOf("applyPrizeGuarantee('finish_fallback')"));
    const finishWindow = finishTail.slice(
      0,
      finishTail.indexOf('settleTournamentPlacesAtomically(')
    );

    expect(recalc).not.toMatch(/\.gt\('prize',\s*0\)/);
    expect(recalc).toMatch(/payouts\.find/);
    expect(finishWindow).toMatch(/recalculateEliminatedPrizes\(refreshedPool\)/);
    expect(finishWindow.indexOf('fn_normalize_tournament_final_standings')).toBeLessThan(
      finishWindow.indexOf('recalculateEliminatedPrizes(refreshedPool)')
    );
  });
});

describe('the recovery path proves a result before it funds the guarantee', () => {
  it('keeps satellite and final-table-deal exits ahead of normal guarantee funding', () => {
    const satelliteExit = RECOVERY_CODE.indexOf(
      'GameServer.recoverStuckCompleting_satellite_skipped'
    );
    const dealExit = RECOVERY_CODE.indexOf('GameServer.recoverStuckCompleting_chopped_skipped');
    const funding = RECOVERY_CODE.indexOf("'fn_apply_prize_guarantee'");

    expect(satelliteExit).toBeGreaterThan(-1);
    expect(dealExit).toBeGreaterThan(satelliteExit);
    expect(funding).toBeGreaterThan(dealExit);
  });

  it('runs every read-only ranking and result gate before the money-moving RPC', () => {
    const funding = RECOVERY_CODE.indexOf("'fn_apply_prize_guarantee'");
    const readOnlyProofs = [
      RECOVERY_CODE.indexOf(".select('id, user_id, status, position, prize, chips')"),
      RECOVERY_CODE.indexOf('if (playersErr || !Array.isArray(players))'),
      RECOVERY_CODE.indexOf('resolvePayoutStructure('),
      RECOVERY_CODE.indexOf('fieldIsStillLive({ livePlayers, paidPlaces })'),
      RECOVERY_CODE.indexOf('if (alive.length > 1)'),
      RECOVERY_CODE.indexOf('if (alive.length > 0 && !anyDealtIn)'),
      RECOVERY_CODE.indexOf('if (chipsCannotRank(alive))'),
      RECOVERY_CODE.indexOf('if (handErr)'),
      RECOVERY_CODE.indexOf('noHandWasEverDealt({'),
      RECOVERY_CODE.indexOf('if (collisions.length > 0)'),
    ];

    expect(funding).toBeGreaterThan(-1);
    for (const proof of readOnlyProofs) {
      expect(proof).toBeGreaterThan(-1);
      expect(proof).toBeLessThan(funding);
    }
  });

  it('proves the funded row before amount-dependent pricing, result writes and settlement', () => {
    const funding = RECOVERY_CODE.indexOf("'fn_apply_prize_guarantee'");
    const finalProof = RECOVERY_CODE.indexOf('fundedRow.prize_pool_finalized !== true', funding);
    const floorProof = RECOVERY_CODE.indexOf('fundedPool + 0.005 < fundedGuarantee', finalProof);
    const pricing = RECOVERY_CODE.indexOf('const prizeFor =', floorProof);
    const resultWrite = RECOVERY_CODE.indexOf('const owed = prizeFor(place)', pricing);
    const settlement = RECOVERY_CODE.indexOf('settleTournamentPlacesAtomically(', resultWrite);

    expect(finalProof).toBeGreaterThan(funding);
    expect(floorProof).toBeGreaterThan(finalProof);
    expect(pricing).toBeGreaterThan(floorProof);
    expect(resultWrite).toBeGreaterThan(pricing);
    expect(settlement).toBeGreaterThan(resultWrite);
  });
});

describe('a winner paid nothing says so', () => {
  it('alerts when the winner prize is zero', () => {
    expect(CODE).toMatch(/winnerPrize <= 0 && !isSatelliteFinish/);
    expect(CODE).toMatch(/Tournament\.winner_paid_nothing/);
  });

  it('the alert is emitted before the atomic batch is asked to settle', () => {
    const zero = CODE.indexOf('winnerPrize <= 0 && !isSatelliteFinish');
    const settle = CODE.indexOf('settleTournamentPlacesAtomically(');
    expect(zero).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(zero);
  });

  it('an unfunded guarantee is critical; a genuinely poolless event is a warning', () => {
    const tail = CODE.slice(CODE.indexOf('winnerPrize <= 0 && !isSatelliteFinish'));
    const window = tail.slice(0, tail.indexOf('settleTournamentPlacesAtomically('));
    expect(window).toMatch(/gtd > 0 \? 'critical' : 'warning'/);
  });
});

describe('something finally asks whether the guarantee was kept', () => {
  it('the reconciler exposes the check', () => {
    expect(RECONCILER).toMatch(/export async function auditGuaranteesKept/);
    expect(RECONCILER).toMatch(/fn_tournament_guarantee_check/);
  });

  it('it is wired into the periodic sweep beside the other audits', () => {
    expect(GAMESERVER).toMatch(/auditGuaranteesKept\(24\)/);
    expect(GAMESERVER).toMatch(/auditGuaranteesKept,/);
  });

  it('it detects and never repairs - no credit call in the audit path', () => {
    const fn = RECONCILER.slice(
      RECONCILER.indexOf('export async function auditGuaranteesKept'),
      RECONCILER.indexOf('export async function auditSatelliteConservation')
    );
    expect(fn).not.toMatch(/fn_credit_and_log/);
    expect(fn).not.toMatch(/fn_apply_prize_guarantee/);
  });
});
