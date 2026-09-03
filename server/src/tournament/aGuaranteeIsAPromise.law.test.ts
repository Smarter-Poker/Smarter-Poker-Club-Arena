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

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ELIM = fs.readFileSync(path.join(HERE, 'TournamentManagerEliminations.ts'), 'utf8');
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

  it('re-reads the pool after funding rather than trusting the local snapshot', () => {
    const tail = CODE.slice(CODE.indexOf("applyPrizeGuarantee('finish_fallback')"));
    const window = tail.slice(0, tail.indexOf('let winnerPrize = 0;'));
    expect(window).toMatch(/from\('tournaments'\)/);
    expect(window).toMatch(/select\('prize_pool'\)/);
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

  it('a failure funding the guarantee never strands the finish', () => {
    const tail = CODE.slice(CODE.indexOf("applyPrizeGuarantee('finish_fallback')"));
    const window = tail.slice(0, tail.indexOf('let winnerPrize = 0;'));
    expect(window).toMatch(/catch/);
    expect(window).toMatch(/guarantee_finish_fallback_failed/);
  });
});

describe('a winner paid nothing says so', () => {
  it('alerts when the winner prize is zero', () => {
    expect(CODE).toMatch(/winnerPrize <= 0 && !isSatelliteFinish/);
    expect(CODE).toMatch(/Tournament\.winner_paid_nothing/);
  });

  it('the alert sits OUTSIDE the `winnerPrize > 0` block, which is the whole point', () => {
    const zero = CODE.indexOf('winnerPrize <= 0 && !isSatelliteFinish');
    const positive = CODE.indexOf('if (winnerPrize > 0) {');
    expect(zero).toBeGreaterThan(-1);
    expect(positive).toBeGreaterThan(zero);
  });

  it('an unfunded guarantee is critical; a genuinely poolless event is a warning', () => {
    const tail = CODE.slice(CODE.indexOf('winnerPrize <= 0 && !isSatelliteFinish'));
    const window = tail.slice(0, tail.indexOf('if (winnerPrize > 0) {'));
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
