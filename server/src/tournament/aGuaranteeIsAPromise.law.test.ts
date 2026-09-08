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
const SETTLEMENT = fs.readFileSync(
  path.resolve(
    HERE,
    '../../../supabase/migrations/20260908065210_tournament_cash_settlement_has_one_atomic_authority.sql'
  ),
  'utf8'
);
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

function sqlFunction(name: string): string {
  const start = SETTLEMENT.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = SETTLEMENT.indexOf(`REVOKE ALL ON FUNCTION public.${name}`, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SETTLEMENT.slice(start, end).replace(/--.*$/gm, '');
}

describe('the finish path funds the guarantee', () => {
  it('funds inside both locked cash settlement authorities before pricing', () => {
    for (const [name, firstPrice] of [
      ['fn_settle_tournament_places', 'fn_ca_tournament_place_amounts'],
      ['fn_settle_tournament_final_table_deal', 'fn_ca_tournament_place_amounts'],
    ] as const) {
      const body = sqlFunction(name);
      const fund = body.indexOf('public.fn_apply_prize_guarantee(');
      const price = body.indexOf(firstPrice, fund + 1);
      expect(fund).toBeGreaterThan(-1);
      expect(price).toBeGreaterThan(fund);
      expect(body).toContain('prize_pool_finalized');
      expect(body).toContain('guaranteed_prize');
      expect(body).toMatch(/prize_pool\s*<\s*COALESCE\(v_t\.guaranteed_prize,\s*0\)/);
    }
  });

  it('has no process-side finish fallback that can catch funding failure and keep paying', () => {
    expect(CODE).not.toMatch(/applyPrizeGuarantee\('finish_fallback'\)/);
    expect(CODE).not.toMatch(/guarantee_finish_fallback_failed/);
  });

  it('turns a refused or unverifiable funding receipt into a database exception', () => {
    for (const name of ['fn_settle_tournament_places', 'fn_settle_tournament_final_table_deal']) {
      const body = sqlFunction(name);
      expect(body).toMatch(
        /COALESCE\(\(v_guarantee_result->>'ok'\)::boolean,\s*false\) IS NOT TRUE/
      );
      expect(body).toMatch(/RAISE EXCEPTION[\s\S]*?guarantee funding/);
      expect(body).not.toMatch(/EXCEPTION\s+WHEN[\s\S]*?guarantee/i);
    }
  });
});

describe('a winner paid nothing says so', () => {
  it('alerts when the winner prize is zero', () => {
    expect(CODE).toMatch(/winnerPrize <= 0 && !isSatelliteFinish/);
    expect(CODE).toMatch(/Tournament\.winner_paid_nothing/);
  });

  it('the alert is driven by the authoritative winner amount, not a local formula', () => {
    const zero = CODE.indexOf('winnerPrize <= 0 && !isSatelliteFinish');
    const authoritative = CODE.indexOf('winnerPrize = receipt.winnerAmount');
    expect(zero).toBeGreaterThan(-1);
    expect(authoritative).toBeGreaterThan(-1);
    expect(authoritative).toBeLessThan(zero);
  });

  it('an unfunded guarantee is critical; a genuinely poolless event is a warning', () => {
    const tail = CODE.slice(CODE.indexOf('winnerPrize <= 0 && !isSatelliteFinish'));
    expect(tail).toMatch(/gtd > 0 \? 'critical' : 'warning'/);
  });
});
