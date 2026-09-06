/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LAW: THE ABSOLUTE SCORE RUNS FIRST (2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The fleet plays itself. Its aggregate result is zero minus the drop BY
 * CONSTRUCTION - measured 2026-09-06, net -10,797bb against 9,020bb of rake
 * and 1,761bb of jackpot. So the fleet's own bb/100 can never say whether the
 * brain is any good, and the league only ever says whether config A beat
 * config B.
 *
 * The solver-agreement score is the only ABSOLUTE number in the estate: the
 * mean solver frequency of the action the horse chose, against a reference
 * the brain did not author. It is the one measurement that can say the brain
 * got WORSE with nothing to compare it to.
 *
 * It had never been written once. It sat at the END of runLeague, after a
 * matchup card whose own source comment says it is "ALWAYS killed mid-card":
 *
 *   2026-09-04   28 matchups   no score
 *   2026-09-06    3 matchups   no score
 *
 * A budget break falls through to trailing code. A killed process does not.
 * So the estate's only absolute measurement was gated behind ninety minutes
 * of work that does not finish, and cost seconds itself.
 *
 * This law pins three things:
 *
 *   1. the score is taken BEFORE the matchup loop, not after it;
 *   2. a SKIP is written rather than logged - "no score" and "the chart store
 *      was empty" must not look identical from the database, which is the
 *      exact failure this estate keeps finding;
 *   3. a day whose card already ran still gets its score.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');
const league = readFileSync(join(SRC, 'benchmark/HorseLeague.ts'), 'utf8');

describe('LAW: the absolute score runs first', () => {
  it('is taken before the matchup loop, not after it', () => {
    const call = league.indexOf('await writeSolverAgreement(date);');
    const loop = league.indexOf('for (const m of card) {');
    expect(call, 'runLeague must call writeSolverAgreement').toBeGreaterThan(0);
    expect(loop, 'the matchup loop must still exist').toBeGreaterThan(0);
    expect(
      call,
      'the absolute score must be taken BEFORE the matchup card - the card is killed mid-run'
    ).toBeLessThan(loop);
  });

  it('a skip is written to the database, not only logged', () => {
    const fn = league.slice(league.indexOf('export async function writeSolverAgreement'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    // The RPC call must NOT be inside a branch that a null reference skips.
    expect(body.includes("agreement.reference ?? 'none_chart_store_empty'")).toBe(true);
    expect(
      body.includes("supabase.rpc('fn_horse_solver_agreement_add'"),
      'the write must happen on both paths'
    ).toBe(true);
    // The old shape - skip the write when there is no reference - must be gone.
    expect(body.includes('if (agreement.reference) {')).toBe(false);
  });

  it('a day whose card already ran still gets its score', () => {
    const short = league.slice(league.indexOf('if (await alreadyRanToday(today)) {'));
    const head = short.slice(0, short.indexOf('return;'));
    expect(
      head.includes('if (!(await hasSolverAgreement(today))) await writeSolverAgreement(today);'),
      'the alreadyRanToday short-circuit must still take the score when the day has none'
    ).toBe(true);
  });

  it('the score depends on nothing the matchups produce', () => {
    // If it ever starts reading `results`, it can no longer run first - and
    // the reason it must run first is that `results` is usually incomplete.
    const fn = league.slice(league.indexOf('export async function writeSolverAgreement'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body.includes('results')).toBe(false);
  });
});
