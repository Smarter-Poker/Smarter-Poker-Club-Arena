/**
 * A TOURNAMENT SEAT STACK IS A WHOLE CHIP - drift incident 07ebac1d.
 *
 * 56 hand commits were refused across 15 tournament tables between 00:00 and
 * 01:37 UTC on 2026-09-11 with `tournament % hand % did not durably sync every
 * final seat stack`, and 500 more on 2026-09-08/09 under the sentence the
 * 2026-09-10 rewrite replaced. Both are the same fault: a fractional seat
 * stack, which `tournament_players.chips` (integer) cannot store and
 * `table_seats.stack` (numeric(15,2)) can, so the commit's own mirror
 * assertion can never be satisfied and the whole hand is rolled back.
 *
 * The values below are the real ones from those alerts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkTournamentWholeChips, describeFractionalSeats } from './tournamentWholeChips.js';

const SETTLEMENT = readFileSync(resolve(__dirname, 'ServerTableEngineSettlement.ts'), 'utf8');

describe('a fractional tournament stack is named before the database refuses it', () => {
  it('catches the production value that cost 121 hands at one table', () => {
    const verdict = checkTournamentWholeChips([
      { user_id: 'd3f422d8-ccab-4ee9-ba50-7678a17ba776', stack: 691173.5, stack_before: 690954 },
      { user_id: 'whole', stack: 12000, stack_before: 12219.5 - 219.5 },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.offenders).toEqual([
      {
        user_id: 'd3f422d8-ccab-4ee9-ba50-7678a17ba776',
        field: 'stack',
        value: 691173.5,
        fraction: 0.5,
      },
    ]);
    expect(verdict.fractionTotal).toBe(0.5);
  });

  it('names the half-chip pair that a two-way chop of an odd pot creates', () => {
    const verdict = checkTournamentWholeChips([
      { user_id: 'a', stack: 479.5, stack_before: 0 },
      { user_id: 'b', stack: 479.5, stack_before: 0 },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.offenders.map((o) => o.user_id)).toEqual(['a', 'b']);
    // The two halves make a whole chip. The hand is still refused - the pair
    // is a conservation-neutral fraction, not a repairable one, because the
    // integer column rounds each seat on its own.
    expect(verdict.fractionTotal).toBe(1);
  });

  it('reports a fractional stack_before separately, because the delta is built from it', () => {
    const verdict = checkTournamentWholeChips([{ user_id: 'a', stack: 1000, stack_before: 999.5 }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.offenders).toEqual([
      { user_id: 'a', field: 'stack_before', value: 999.5, fraction: 0.5 },
    ]);
  });

  it('passes a whole-chip tournament hand, zero stacks included', () => {
    const verdict = checkTournamentWholeChips([
      { user_id: 'a', stack: 0, stack_before: 1500 },
      { user_id: 'b', stack: 3000, stack_before: 1500 },
      { user_id: 'c', stack: 1500 },
    ]);
    expect(verdict).toEqual({ ok: true, offenders: [], fractionTotal: 0 });
  });

  it('treats a value floating point left just off a whole chip as whole', () => {
    // 0.1 + 0.2 arithmetic reaches settlement as 1500.0000000000002. The
    // database stores numeric(15,2), so a cent of float noise is not a
    // fraction the integer column would round - only a real cent is.
    const verdict = checkTournamentWholeChips([{ user_id: 'a', stack: 1500.0000000000002 }]);
    expect(verdict.ok).toBe(true);
  });

  it('refuses to call a non-finite stack whole', () => {
    const verdict = checkTournamentWholeChips([
      { user_id: 'a', stack: Number.NaN },
      { user_id: 'b', stack: Number.POSITIVE_INFINITY },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.offenders.map((o) => o.user_id)).toEqual(['a', 'b']);
  });

  it('describes offenders as one actionable line', () => {
    expect(
      describeFractionalSeats([
        { user_id: 'a', field: 'stack', value: 479.5, fraction: 0.5 },
        { user_id: 'b', field: 'stack_before', value: 12.25, fraction: 0.25 },
      ])
    ).toBe('a stack=479.5, b stack_before=12.25');
  });
});

describe('the invariant is asserted where the payload is built, not after the fact', () => {
  /* FAILS ON origin/main: the gate did not exist, so the only thing that ever
     noticed a fractional tournament stack was the database - after the hand
     had already been destroyed, in a sentence that names neither the seat nor
     the value. */
  it('settlement checks it on a tournament table before the authoritative commit', () => {
    expect(SETTLEMENT).toMatch(
      /import \{[^}]*checkTournamentWholeChips[^}]*\} from '\.\/tournamentWholeChips\.js';/s
    );
    const call = SETTLEMENT.indexOf('checkTournamentWholeChips(');
    expect(call).toBeGreaterThan(0);
    // The observer returns the original commit promise. Pin the awaited
    // operation and its captured hand identity as well as the gate order.
    const commit = SETTLEMENT.search(
      /result = await this\.observeSettlementAwait\(\s*'hand_history_write',\s*persistenceGeneration,\s*snap\.handNumber,\s*commitAuthoritativeHand\s*\)/
    );
    expect(commit).toBeGreaterThan(0);
    expect(call).toBeLessThan(commit);
    expect(SETTLEMENT).toContain("'Tournament.fractional_seat_stack'");
  });

  it('it reports rather than rounds: a repaired fraction is a conservation refusal', () => {
    const gate = SETTLEMENT.slice(
      SETTLEMENT.indexOf('const whole = checkTournamentWholeChips('),
      SETTLEMENT.indexOf('// A conservation refusal is an authoritative settlement fault.')
    );
    expect(gate).toContain('raiseFinancialAlert');
    // No repair. Rounding a seat mints or destroys the fraction, and
    // tournamentChipConservation refuses the hand for that instead.
    expect(gate).not.toMatch(/Math\.(round|floor|ceil|trunc)\s*\(/);
    expect(gate).not.toContain('p.stack =');
  });
});
