import { describe, it, expect } from 'vitest';
import { StateVerifier, type VerificationContext } from './StateVerifier.js';
import type { SeatPlayer } from '../types.js';

/**
 * A7 — chip-conservation invariants.
 *
 * Before this suite the verifier ran ONLY at HAND_COMPLETE and ONLY summed
 * stacks. That made in-street chip creation structurally invisible: the extra
 * chips sat in the pot, and by the time the check ran the pot had been paid
 * out, so the drift was already folded into a winner's stack where it looked
 * like a legitimate win. It also had no `pot === Σ contributions` check at all,
 * and the `chipTotal` it returned (stacks + pot) was a different quantity from
 * the one it had just compared (stacks), so the number next to the verdict
 * could not be reconciled with the verdict.
 */

function player(over: Partial<SeatPlayer> & { user_id: string }): SeatPlayer {
  return {
    seat: 1,
    username: over.user_id,
    stack: 0,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    ...over,
  } as SeatPlayer;
}

function ctx(over: Partial<VerificationContext>): VerificationContext {
  return {
    tableId: 't1',
    handNumber: 1,
    players: [],
    communityCards: [],
    pot: 0,
    stage: 'preflop',
    ...over,
  };
}

/** Two players, 1000 each, who have both put `bet` into the pot this hand. */
function midHand(betA: number, betB: number) {
  return [
    player({ user_id: 'a', seat: 1, stack: 1000 - betA, bet: betA, totalInvested: betA }),
    player({ user_id: 'b', seat: 2, stack: 1000 - betB, bet: betB, totalInvested: betB }),
  ];
}

/**
 * COMMUNITY_CARD_COUNT — direction matters, and only one direction is a fault.
 *
 * Added 2026-08-17 after production showed this check firing on 236 DISTINCT
 * HANDS PER HOUR, every observed instance being a board that had run AHEAD of
 * its stage label ("Stage flop expects 3 community cards, got 5"). That is an
 * all-in runout: the board is dealt to completion while `stage` still reads
 * flop. The cards are correct; the label lags.
 *
 * The genuine fault — a board BEHIND its street, i.e. a river played on four
 * cards — was indistinguishable from that flood, so the whole signal was
 * ignored. These cases pin the asymmetry so it cannot regress back into noise.
 */
function boardOf(n: number) {
  const ranks = ['2', '3', '4', '5', '6', '7'] as const;
  return ranks.slice(0, n).map((rank) => ({ rank, suit: 'hearts' as const }));
}

describe('StateVerifier - COMMUNITY_CARD_COUNT direction', () => {
  const cardCountViolations = (stage: string, n: number) =>
    new StateVerifier()
      .verify(ctx({ stage, communityCards: boardOf(n) }))
      .violations.filter((v) => v.type === 'COMMUNITY_CARD_COUNT');

  it('does NOT flag a board that has run ahead of its stage (all-in runout)', () => {
    // The exact production shape that fired 236x/hour.
    expect(cardCountViolations('flop', 5)).toHaveLength(0);
    expect(cardCountViolations('turn', 5)).toHaveLength(0);
    expect(cardCountViolations('flop', 4)).toHaveLength(0);
  });

  it('DOES flag a board behind its stage - cards are missing', () => {
    const v = cardCountViolations('river', 4);
    expect(v).toHaveLength(1);
    expect(v[0].details).toMatchObject({ reason: 'board_behind_stage', expected: 5, actual: 4 });
  });

  it('DOES flag a board larger than five cards as critical', () => {
    const v = cardCountViolations('river', 6);
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('critical');
    expect(v[0].details).toMatchObject({ reason: 'board_overflow', actual: 6 });
  });

  it('stays silent when the board exactly matches the street', () => {
    expect(cardCountViolations('preflop', 0)).toHaveLength(0);
    expect(cardCountViolations('flop', 3)).toHaveLength(0);
    expect(cardCountViolations('turn', 4)).toHaveLength(0);
    expect(cardCountViolations('river', 5)).toHaveLength(0);
  });
});

describe('StateVerifier - A7 in-hand chip conservation', () => {
  it('passes on an honest mid-hand state', () => {
    const v = new StateVerifier();
    const players = midHand(150, 150);
    v.recordInitialChipTotal('t1', [
      player({ user_id: 'a', stack: 1000 }),
      player({ user_id: 'b', stack: 1000 }),
    ]);

    const res = v.verify(ctx({ players, pot: 300, phase: 'in_hand' }));

    expect(res.violations).toEqual([]);
    expect(res.valid).toBe(true);
    expect(res.chipTotal).toBe(2000);
    expect(res.expectedChipTotal).toBe(2000);
    expect(res.drift).toBe(0);
    expect(res.phase).toBe('in_hand');
  });

  it('THE A7 HOLE: catches chips minted inside a street', () => {
    const v = new StateVerifier();
    v.recordInitialChipTotal('t1', [
      player({ user_id: 'a', stack: 1000 }),
      player({ user_id: 'b', stack: 1000 }),
    ]);

    // 300 was committed, but the pot somehow holds 500 — 200 chips out of thin
    // air, sitting where the old stacks-only HAND_COMPLETE check could not see
    // them. Contributions are bumped too, so this is purely a conservation
    // failure, not a pot-accounting one.
    const players = midHand(150, 150);
    players[0].totalInvested = 250;
    players[1].totalInvested = 250;
    const res = v.verify(ctx({ players, pot: 500, phase: 'in_hand' }));

    const conservation = res.violations.find((x) => x.type === 'CHIP_CONSERVATION');
    expect(conservation).toBeDefined();
    expect(conservation!.severity).toBe('critical');
    expect(res.chipTotal).toBe(2200);
    expect(res.drift).toBe(200);
    expect(v.isHealthy('t1')).toBe(false);
  });

  it('catches chips destroyed inside a street', () => {
    const v = new StateVerifier();
    v.recordInitialChipTotal('t1', [
      player({ user_id: 'a', stack: 1000 }),
      player({ user_id: 'b', stack: 1000 }),
    ]);
    const players = midHand(150, 150);
    players[0].totalInvested = 100;
    players[1].totalInvested = 100;
    const res = v.verify(ctx({ players, pot: 200, phase: 'in_hand' }));

    expect(res.violations.map((x) => x.type)).toContain('CHIP_CONSERVATION');
    expect(res.drift).toBe(-100);
  });

  it('counts rake already pulled from the pot as still-conserved', () => {
    const v = new StateVerifier();
    v.recordInitialChipTotal('t1', [
      player({ user_id: 'a', stack: 1000 }),
      player({ user_id: 'b', stack: 1000 }),
    ]);
    const players = midHand(150, 150);
    // 15 has been raked out of the 300 pot
    const res = v.verify(ctx({ players, pot: 285, phase: 'in_hand', rakeTaken: 15 }));
    expect(res.violations).toEqual([]);
    expect(res.chipTotal).toBe(2000);
  });

  it('tolerates sub-cent IEEE drift but not a real cent', () => {
    const v = new StateVerifier();
    v.recordInitialChipTotal('t1', [player({ user_id: 'a', stack: 1000 })]);

    const ok = v.verify(
      ctx({
        players: [player({ user_id: 'a', stack: 900.005, bet: 100, totalInvested: 100 })],
        pot: 100,
        phase: 'in_hand',
      })
    );
    expect(ok.violations.filter((x) => x.type === 'CHIP_CONSERVATION')).toEqual([]);

    const bad = v.verify(
      ctx({
        players: [player({ user_id: 'a', stack: 900.5, bet: 100, totalInvested: 100 })],
        pot: 100,
        phase: 'in_hand',
      })
    );
    expect(bad.violations.map((x) => x.type)).toContain('CHIP_CONSERVATION');
  });
});

describe('StateVerifier - A7 pot accounting (pot === Σ contributions)', () => {
  it('flags a pot larger than the chips players actually put in', () => {
    const v = new StateVerifier();
    const players = midHand(150, 150);
    // pot inflated by 50 with no contributor behind it
    const res = v.verify(ctx({ players, pot: 350, phase: 'in_hand', initialChipTotal: 2050 }));

    const potIssue = res.violations.find((x) => x.type === 'POT_ACCOUNTING');
    expect(potIssue).toBeDefined();
    expect(potIssue!.severity).toBe('critical');
    expect(potIssue!.details!.diff).toBe(50);
  });

  it('flags contributions that never reached the pot', () => {
    const v = new StateVerifier();
    const players = midHand(150, 150);
    players[0].totalInvested = 200; // paid 200, only 150 landed in the pot
    const res = v.verify(ctx({ players, pot: 300, phase: 'in_hand', initialChipTotal: 2000 }));
    const potIssue = res.violations.find((x) => x.type === 'POT_ACCOUNTING');
    expect(potIssue).toBeDefined();
    expect(potIssue!.details!.diff).toBe(-50);
  });

  it('is not applied at hand_complete, where the pot is legitimately empty', () => {
    const v = new StateVerifier();
    const players = [
      player({ user_id: 'a', stack: 1300, bet: 150, totalInvested: 150 }),
      player({ user_id: 'b', stack: 700, bet: 150, totalInvested: 150 }),
    ];
    const res = v.verify(ctx({ players, pot: 0, initialChipTotal: 2000 }));
    expect(res.violations.map((x) => x.type)).not.toContain('POT_ACCOUNTING');
  });
});

describe('StateVerifier - hand_complete behaviour is unchanged (FIX 204)', () => {
  it('defaults to hand_complete and sums stacks only, ignoring stale bets', () => {
    const v = new StateVerifier();
    v.recordInitialChipTotal('t1', [
      player({ user_id: 'a', stack: 1000 }),
      player({ user_id: 'b', stack: 1000 }),
    ]);
    // pot distributed: a won it all. `bet` is a stale artifact of the last street.
    const players = [
      player({ user_id: 'a', stack: 1300, bet: 150, totalInvested: 150 }),
      player({ user_id: 'b', stack: 700, bet: 150, totalInvested: 150 }),
    ];
    const res = v.verify(ctx({ players, pot: 0 }));

    expect(res.phase).toBe('hand_complete');
    expect(res.violations).toEqual([]);
    expect(res.chipTotal).toBe(2000);
  });

  it('accounts for rake via deductRake', () => {
    const v = new StateVerifier();
    v.recordInitialChipTotal('t1', [
      player({ user_id: 'a', stack: 1000 }),
      player({ user_id: 'b', stack: 1000 }),
    ]);
    v.deductRake('t1', 15);
    expect(v.getExpectedChipTotal('t1')).toBe(1985);

    const players = [player({ user_id: 'a', stack: 1285 }), player({ user_id: 'b', stack: 700 })];
    expect(v.verify(ctx({ players, pot: 0 })).violations).toEqual([]);
  });
});

describe('StateVerifier - reported numbers reconcile with the verdict', () => {
  it('chipTotal is the exact quantity the conservation check compared', () => {
    const v = new StateVerifier();
    v.recordInitialChipTotal('t1', [
      player({ user_id: 'a', stack: 1000 }),
      player({ user_id: 'b', stack: 1000 }),
    ]);
    // The old code returned stacks + pot here (2000) while checking stacks
    // alone (1700) — a "valid: true" next to a number that did not match.
    const players = [
      player({ user_id: 'a', stack: 1000, bet: 150, totalInvested: 150 }),
      player({ user_id: 'b', stack: 700, bet: 150, totalInvested: 150 }),
    ];
    const res = v.verify(ctx({ players, pot: 300 }));

    expect(res.chipTotal).toBe(1700);
    expect(res.expectedChipTotal).toBe(2000);
    expect(res.drift).toBe(-300);
    expect(res.valid).toBe(false);
  });

  it('reports no baseline rather than a bogus drift', () => {
    const v = new StateVerifier();
    const res = v.verify(ctx({ players: midHand(150, 150), pot: 300, phase: 'in_hand' }));
    expect(res.expectedChipTotal).toBeUndefined();
    expect(res.drift).toBeUndefined();
    expect(res.violations.map((x) => x.type)).not.toContain('CHIP_CONSERVATION');
  });
});

describe('StateVerifier - negative-value guards', () => {
  it('flags a negative bet and a negative contribution', () => {
    const v = new StateVerifier();
    const res = v.verify(
      ctx({
        players: [player({ user_id: 'a', stack: 100, bet: -5, totalInvested: -5 })],
        pot: -5,
        phase: 'in_hand',
      })
    );
    const types = res.violations.map((x) => x.type);
    expect(types).toContain('NEGATIVE_BET');
    expect(types).toContain('NEGATIVE_CONTRIBUTION');
    expect(types).toContain('NEGATIVE_POT');
  });
});
