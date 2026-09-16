/**
 * ca_hand_facts derivations — position, hand class, flow flags, chip transfer.
 *
 * These four pure functions are where the bugs in a stats pipeline actually
 * live. Every one of them replaces something the platform previously got wrong
 * or could not do at all:
 *
 *  - derivePosition replaces fn_process_hand_position_stats' inference from
 *    preflop ACTION ORDER, which silently drops any player who folded without
 *    acting and so biases every positional stat toward players who played back.
 *  - computeTransfers exists because head-to-head chip flow is not recoverable
 *    from hand_history at all: winners[].amount is gross, and in a multiway pot
 *    the JSON does not say whose money it was.
 *  - deriveFlowFlags reads the action log, which contains no blinds or antes.
 *    That is correct for VPIP and wrong for money, which is exactly why the
 *    money in ca_hand_facts comes from the engine's contributions map instead.
 *
 * The conservation tests below are the important ones: they are what catch the
 * class of bug that makes a stats page quietly lie.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

// The module imports a live Supabase client and the error reporting-backed error
// reporter at load. Neither is needed to exercise the pure helpers, and both
// would demand env vars that a clean CI checkout does not have.
vi.mock('../server/src/services/supabase/client.js', () => ({
  supabase: { from: () => ({ upsert: async () => ({ error: null }) }) },
}));
vi.mock('../server/src/services/errorReporter.js', () => ({
  reportError: () => {},
}));

import {
  computeHandClass,
  derivePosition,
  deriveFlowFlags,
  computeTransfers,
  maxWinnable,
  type HandAction,
} from '../server/src/services/supabase/handFacts';

// ───────────────────────────────────────────────────────────────────────────
describe('computeHandClass — the 169-grid key', () => {
  const c = (rank: string, suit: string) => ({ rank, suit });

  it('names pocket pairs without a suitedness suffix', () => {
    expect(computeHandClass([c('A', 'spades'), c('A', 'hearts')])).toBe('AA');
    expect(computeHandClass([c('2', 'clubs'), c('2', 'diamonds')])).toBe('22');
  });

  it('orders by rank strength, not by the order dealt', () => {
    expect(computeHandClass([c('K', 'spades'), c('A', 'spades')])).toBe('AKs');
    expect(computeHandClass([c('A', 'spades'), c('K', 'spades')])).toBe('AKs');
  });

  it('distinguishes suited from offsuit', () => {
    expect(computeHandClass([c('A', 'spades'), c('K', 'hearts')])).toBe('AKo');
    expect(computeHandClass([c('7', 'clubs'), c('2', 'hearts')])).toBe('72o');
    expect(computeHandClass([c('T', 'hearts'), c('9', 'hearts')])).toBe('T9s');
  });

  it('returns null for PLO holdings — a 13x13 grid cannot represent them', () => {
    expect(
      computeHandClass([c('A', 'spades'), c('K', 'hearts'), c('Q', 'clubs'), c('J', 'diamonds')])
    ).toBeNull();
  });

  it('returns null rather than guessing on malformed input', () => {
    expect(computeHandClass([])).toBeNull();
    expect(computeHandClass([c('A', 'spades')])).toBeNull();
    expect(computeHandClass([{ rank: 'X', suit: 'spades' }, c('K', 'hearts')])).toBeNull();
  });

  it('covers all 169 classes with no collisions across a full deck', () => {
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    const seen = new Set<string>();
    for (const a of ranks) {
      for (const b of ranks) {
        seen.add(computeHandClass([c(a, 'spades'), c(b, 'spades')])!); // suited/pair
        seen.add(computeHandClass([c(a, 'spades'), c(b, 'hearts')])!); // offsuit/pair
      }
    }
    seen.delete('' as string);
    expect(seen.size).toBe(169);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('derivePosition — from the button, not from action order', () => {
  it('maps a standard 6-max table', () => {
    const seats = [1, 2, 3, 4, 5, 6];
    const btn = 1;
    expect(derivePosition(1, btn, seats)).toBe('BTN');
    expect(derivePosition(2, btn, seats)).toBe('SB');
    expect(derivePosition(3, btn, seats)).toBe('BB');
    expect(derivePosition(4, btn, seats)).toBe('UTG');
    expect(derivePosition(5, btn, seats)).toBe('HJ');
    expect(derivePosition(6, btn, seats)).toBe('CO');
  });

  it('maps a standard 9-max table', () => {
    const seats = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const btn = 1;
    expect(derivePosition(1, btn, seats)).toBe('BTN');
    expect(derivePosition(2, btn, seats)).toBe('SB');
    expect(derivePosition(3, btn, seats)).toBe('BB');
    expect(derivePosition(4, btn, seats)).toBe('UTG');
    expect(derivePosition(5, btn, seats)).toBe('UTG+1');
    expect(derivePosition(6, btn, seats)).toBe('MP');
    expect(derivePosition(7, btn, seats)).toBe('LJ');
    expect(derivePosition(8, btn, seats)).toBe('HJ');
    expect(derivePosition(9, btn, seats)).toBe('CO');
  });

  it('handles heads-up, where the button posts the small blind', () => {
    expect(derivePosition(4, 4, [4, 7])).toBe('BTN');
    expect(derivePosition(7, 4, [4, 7])).toBe('BB');
  });

  it('works with non-contiguous seat numbers', () => {
    const seats = [2, 5, 9];
    expect(derivePosition(5, 5, seats)).toBe('BTN');
    expect(derivePosition(9, 5, seats)).toBe('SB');
    expect(derivePosition(2, 5, seats)).toBe('BB');
  });

  it('falls back to the next occupied seat when the button seat was not dealt in', () => {
    // Button on seat 3, but seat 3 is empty this hand.
    const pos = derivePosition(4, 3, [1, 4, 6]);
    expect(pos).toBe('BTN');
  });

  it('never returns a duplicate position at any table size from 2 to 9', () => {
    for (let n = 2; n <= 9; n++) {
      const seats = Array.from({ length: n }, (_, i) => i + 1);
      const got = seats.map((s) => derivePosition(s, 1, seats));
      expect(new Set(got).size, `table of ${n} produced duplicates: ${got.join(',')}`).toBe(n);
      expect(got).toContain('BTN');
      expect(got).toContain('BB');
    }
  });

  it('reports UNKNOWN rather than guessing for a seat that was not dealt in', () => {
    expect(derivePosition(8, 1, [1, 2, 3])).toBe('UNKNOWN');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('deriveFlowFlags', () => {
  const A = 'user-a';
  const B = 'user-b';
  const C = 'user-c';

  const act = (userId: string, action: string, stage: string, amount = 0): HandAction => ({
    seat: 1,
    userId,
    action,
    amount,
    stage,
  });

  it('does not count a checked big blind as VPIP', () => {
    // Blinds are not in the action log at all, which is precisely why a big
    // blind who checks has not voluntarily put money in.
    const actions = [act(A, 'check', 'preflop'), act(B, 'fold', 'preflop')];
    const f = deriveFlowFlags(A, actions, { boardLength: 0, returned: 10, nonFoldedCount: 1 });
    expect(f.vpip).toBe(false);
    expect(f.pfr).toBe(false);
  });

  it('counts a call as VPIP but not as PFR', () => {
    const actions = [act(B, 'raise', 'preflop', 30), act(A, 'call', 'preflop', 30)];
    const f = deriveFlowFlags(A, actions, { boardLength: 3, returned: 0, nonFoldedCount: 2 });
    expect(f.vpip).toBe(true);
    expect(f.pfr).toBe(false);
  });

  it('identifies an open raise as PFR but not a 3-bet', () => {
    const actions = [act(A, 'raise', 'preflop', 30), act(B, 'fold', 'preflop')];
    const f = deriveFlowFlags(A, actions, { boardLength: 0, returned: 45, nonFoldedCount: 1 });
    expect(f.pfr).toBe(true);
    expect(f.three_bet).toBe(false);
  });

  it('identifies the second voluntary raise as a 3-bet', () => {
    const actions = [
      act(B, 'raise', 'preflop', 30),
      act(A, 'raise', 'preflop', 90),
      act(B, 'fold', 'preflop'),
    ];
    const f = deriveFlowFlags(A, actions, { boardLength: 0, returned: 120, nonFoldedCount: 1 });
    expect(f.three_bet).toBe(true);
    expect(f.pfr).toBe(true);
  });

  it('records facing and folding to a 3-bet', () => {
    const actions = [
      act(A, 'raise', 'preflop', 30),
      act(B, 'raise', 'preflop', 90),
      act(A, 'fold', 'preflop'),
    ];
    const f = deriveFlowFlags(A, actions, { boardLength: 0, returned: 0, nonFoldedCount: 1 });
    expect(f.faced_three_bet).toBe(true);
    expect(f.folded_to_three_bet).toBe(true);
  });

  it('does not treat a short all-in call as a raise', () => {
    // An all-in that does not exceed the current level is a call, not a 3-bet.
    const actions = [
      act(B, 'raise', 'preflop', 100),
      act(A, 'all_in', 'preflop', 60),
      act(B, 'call', 'preflop', 0),
    ];
    const f = deriveFlowFlags(A, actions, { boardLength: 5, returned: 0, nonFoldedCount: 2 });
    expect(f.three_bet).toBe(false);
    expect(f.pfr).toBe(false);
    expect(f.was_all_in).toBe(true);
    expect(f.all_in_street).toBe('preflop');
  });

  it('detects a continuation bet only for the preflop aggressor', () => {
    const actions = [
      act(A, 'raise', 'preflop', 30),
      act(B, 'call', 'preflop', 30),
      act(B, 'check', 'flop'),
      act(A, 'bet', 'flop', 40),
    ];
    const fa = deriveFlowFlags(A, actions, { boardLength: 3, returned: 100, nonFoldedCount: 2 });
    const fb = deriveFlowFlags(B, actions, { boardLength: 3, returned: 0, nonFoldedCount: 2 });
    expect(fa.had_cbet_flop_opp).toBe(true);
    expect(fa.cbet_flop).toBe(true);
    expect(fb.had_cbet_flop_opp).toBe(false);
    expect(fb.cbet_flop).toBe(false);
  });

  it('counts a showdown whenever two or more players never folded', () => {
    // This is exact, unlike hand_history.hole_cards, which conflates "reached
    // showdown" with "had their cards revealed".
    const actions = [act(A, 'call', 'preflop', 30), act(C, 'fold', 'preflop')];
    const f = deriveFlowFlags(A, actions, { boardLength: 5, returned: 200, nonFoldedCount: 2 });
    expect(f.went_to_showdown).toBe(true);
    expect(f.won_at_showdown).toBe(true);

    const loser = deriveFlowFlags(B, actions, { boardLength: 5, returned: 0, nonFoldedCount: 2 });
    expect(loser.went_to_showdown).toBe(true);
    expect(loser.won_at_showdown).toBe(false);
  });

  it('does not count a hand won without a showdown as won at showdown', () => {
    const actions = [act(A, 'bet', 'river', 50), act(B, 'fold', 'river')];
    const f = deriveFlowFlags(A, actions, { boardLength: 5, returned: 150, nonFoldedCount: 1 });
    expect(f.went_to_showdown).toBe(false);
    expect(f.won_at_showdown).toBe(false);
  });

  it('tallies aggressive and passive actions across every street', () => {
    const actions = [
      act(A, 'raise', 'preflop', 30),
      act(A, 'bet', 'flop', 40),
      act(A, 'check', 'turn'),
      act(A, 'call', 'river', 80),
    ];
    const f = deriveFlowFlags(A, actions, { boardLength: 5, returned: 0, nonFoldedCount: 2 });
    expect(f.aggressive_actions).toBe(2);
    expect(f.passive_actions).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('maxWinnable — side-pot ceiling', () => {
  it('caps a short stack at what it matched from each opponent', () => {
    // A is in for 50, B and C for 100 each. A can win at most 150.
    expect(maxWinnable(50, [50, 100, 100])).toBe(150);
  });

  it('lets a covering stack win the whole pot', () => {
    expect(maxWinnable(100, [50, 100, 100])).toBe(250);
  });

  it('is the full pot when everyone is in for the same', () => {
    expect(maxWinnable(100, [100, 100])).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('computeTransfers — head-to-head chip attribution', () => {
  it('attributes a heads-up pot entirely to the one loser', () => {
    const nets = new Map([
      ['winner', 90],
      ['loser', -100],
    ]);
    const t = computeTransfers(nets);
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ winnerId: 'winner', loserId: 'loser', amount: 90 });
  });

  it('splits a multiway pot in proportion to each loser`s loss', () => {
    const nets = new Map([
      ['w', 150],
      ['l1', -100],
      ['l2', -50],
    ]);
    const t = computeTransfers(nets);
    const from = (id: string) => t.find((x) => x.loserId === id)!.amount;
    expect(from('l1')).toBeCloseTo(100, 2);
    expect(from('l2')).toBeCloseTo(50, 2);
  });

  it('conserves chips: transfers sum to total winnings', () => {
    const nets = new Map([
      ['w1', 120],
      ['w2', 30],
      ['l1', -90],
      ['l2', -60],
    ]);
    const t = computeTransfers(nets);
    const total = t.reduce((s, x) => s + x.amount, 0);
    expect(total).toBeCloseTo(150, 2);
  });

  it('attributes rake to nobody', () => {
    // 100 + 100 in, pot 200, rake 10, winner awarded 190 => net +90 / -100.
    // The loser is charged 90 to the villain; the missing 10 is the house's.
    const nets = new Map([
      ['w', 90],
      ['l', -100],
    ]);
    const t = computeTransfers(nets);
    const outflow = t.reduce((s, x) => s + x.amount, 0);
    expect(outflow).toBeCloseTo(90, 2);
    expect(outflow).toBeLessThan(100);
  });

  it('returns nothing for a chopped pot where everyone is level', () => {
    const nets = new Map([
      ['a', 0],
      ['b', 0],
    ]);
    expect(computeTransfers(nets)).toEqual([]);
  });

  it('never attributes chips to a player from themselves', () => {
    const nets = new Map([
      ['a', 50],
      ['b', -50],
    ]);
    for (const t of computeTransfers(nets)) {
      expect(t.winnerId).not.toBe(t.loserId);
    }
  });

  it('ignores sub-cent dust rather than emitting rows the CHECK would reject', () => {
    // ca_hand_transfers has CHECK (amount > 0); a 0.00 row would be rejected.
    const nets = new Map([
      ['w', 0.004],
      ['l', -0.004],
    ]);
    expect(computeTransfers(nets)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REGRESSION TESTS — 2026-08-21 audit
//
// Every test below pins a bug that was LIVE while the original suite was
// green. That is the point: the first suite never had a player fold after the
// flop, never had an all-in reached by calling, and never checked that the
// pair-wise transfer split actually summed to what the winner won.
// ═══════════════════════════════════════════════════════════════════════════

describe('saw_flop counts the flop you actually saw', () => {
  const A = 'user-a';
  const B = 'user-b';
  const act = (userId: string, action: string, stage: string, amount = 0): HandAction => ({
    seat: 1,
    userId,
    action,
    amount,
    stage,
  });

  it('a player who calls preflop and folds to a flop c-bet still SAW the flop', () => {
    // The bug: `iFolded` scanned every street, so any postflop fold erased the
    // fact that the player reached the flop at all. saw_flop collapsed into
    // went_to_showdown and every continuation metric was wrong.
    const actions = [
      act(B, 'raise', 'preflop', 30),
      act(A, 'call', 'preflop', 30),
      act(B, 'bet', 'flop', 40),
      act(A, 'fold', 'flop'),
    ];
    const f = deriveFlowFlags(A, actions, { boardLength: 3, returned: 0, nonFoldedCount: 1 });
    expect(f.saw_flop).toBe(true);
    expect(f.went_to_showdown).toBe(false);
  });

  it('a player who folds preflop did NOT see the flop', () => {
    const actions = [act(B, 'raise', 'preflop', 30), act(A, 'fold', 'preflop')];
    const f = deriveFlowFlags(A, actions, { boardLength: 5, returned: 0, nonFoldedCount: 1 });
    expect(f.saw_flop).toBe(false);
  });

  it('a preflop raiser who c-bets and then folds still had the c-bet opportunity', () => {
    // This is the spot the bug hid: cbet% was measured only over c-bets that
    // WORKED, because the ones that got raised off were excluded entirely.
    const actions = [
      act(A, 'raise', 'preflop', 30),
      act(B, 'call', 'preflop', 30),
      act(A, 'bet', 'flop', 40),
      act(B, 'raise', 'flop', 140),
      act(A, 'fold', 'flop'),
    ];
    const f = deriveFlowFlags(A, actions, { boardLength: 3, returned: 0, nonFoldedCount: 1 });
    expect(f.had_cbet_flop_opp).toBe(true);
    expect(f.cbet_flop).toBe(true);
  });
});

describe('4-bets are distinguished from 3-bets', () => {
  const A = 'user-a';
  const B = 'user-b';
  const act = (userId: string, action: string, stage: string, amount = 0): HandAction => ({
    seat: 1,
    userId,
    action,
    amount,
    stage,
  });

  it('the third voluntary raise is a 4-bet, not a 3-bet', () => {
    const actions = [
      act(B, 'raise', 'preflop', 30),
      act(A, 'raise', 'preflop', 90),
      act(B, 'raise', 'preflop', 240),
    ];
    const fb = deriveFlowFlags(B, actions, { boardLength: 0, returned: 0, nonFoldedCount: 2 });
    expect(fb.four_bet).toBe(true);
    expect(fb.three_bet).toBe(false);

    const fa = deriveFlowFlags(A, actions, { boardLength: 0, returned: 0, nonFoldedCount: 2 });
    expect(fa.three_bet).toBe(true);
    expect(fa.four_bet).toBe(false);
  });

  it('folding to a 4-bet is NOT recorded as folding to a 3-bet', () => {
    // The bug: faced_three_bet fired on any re-raise after our raise, so a
    // 3-bettor folding to a 4-bet inflated fold-to-3-bet.
    const actions = [
      act(B, 'raise', 'preflop', 30),
      act(A, 'raise', 'preflop', 90), // A 3-bets
      act(B, 'raise', 'preflop', 240), // B 4-bets
      act(A, 'fold', 'preflop'),
    ];
    const fa = deriveFlowFlags(A, actions, { boardLength: 0, returned: 0, nonFoldedCount: 1 });
    expect(fa.faced_three_bet).toBe(false);
    expect(fa.folded_to_three_bet).toBe(false);

    // The OPENER genuinely did face a 3-bet.
    const fb = deriveFlowFlags(B, actions, { boardLength: 0, returned: 0, nonFoldedCount: 1 });
    expect(fb.faced_three_bet).toBe(true);
  });
});

describe('computeTransfers conserves chips exactly', () => {
  it('pair-wise shares sum to exactly what the winner won, with many losers', () => {
    // The bug: each pair was rounded independently, so the split fell short by
    // up to half a cent per loser and drifted monotonically in the aggregate.
    const nets = new Map<string, number>([
      ['w', 100],
      ['l1', -33.33],
      ['l2', -33.33],
      ['l3', -33.34],
    ]);
    const t = computeTransfers(nets);
    const total = t.reduce((s, x) => s + x.amount, 0);
    expect(Math.round(total * 100)).toBe(10000);
  });

  it('conserves across an awkward three-way split that cannot divide evenly', () => {
    const nets = new Map<string, number>([
      ['w', 10],
      ['l1', -3.33],
      ['l2', -3.33],
      ['l3', -3.34],
    ]);
    const total = computeTransfers(nets).reduce((s, x) => s + x.amount, 0);
    expect(Math.round(total * 100)).toBe(1000);
  });

  it('conserves for every winner independently in a multi-winner pot', () => {
    const nets = new Map<string, number>([
      ['w1', 61.11],
      ['w2', 38.89],
      ['l1', -70],
      ['l2', -30.01],
    ]);
    const t = computeTransfers(nets);
    for (const [w, won] of [
      ['w1', 61.11],
      ['w2', 38.89],
    ] as Array<[string, number]>) {
      const sum = t.filter((x) => x.winnerId === w).reduce((s, x) => s + x.amount, 0);
      expect(Math.round(sum * 100)).toBe(Math.round(won * 100));
    }
  });

  it('still never emits a non-positive amount, which the DB CHECK forbids', () => {
    const nets = new Map<string, number>([
      ['w', 0.02],
      ['l1', -0.01],
      ['l2', -1000],
    ]);
    for (const t of computeTransfers(nets)) {
      expect(t.amount).toBeGreaterThan(0);
    }
  });
});

describe('folded_to_three_bet counts only folds that answer the 3-bet', () => {
  const A = 'user-a';
  const B = 'user-b';
  const C = 'user-c';
  const act = (userId: string, action: string, stage: string, amount = 0): HandAction => ({
    seat: 1,
    userId,
    action,
    amount,
    stage,
  });

  it('opener who is 3-bet and folds IS folding to a 3-bet', () => {
    const actions = [
      act(A, 'raise', 'preflop', 30),
      act(B, 'raise', 'preflop', 90),
      act(A, 'fold', 'preflop'),
    ];
    const f = deriveFlowFlags(A, actions, { boardLength: 0, returned: 0, nonFoldedCount: 1 });
    expect(f.faced_three_bet).toBe(true);
    expect(f.folded_to_three_bet).toBe(true);
  });

  it('opener who 4-bets and then folds to a 5-bet is NOT folding to a 3-bet', () => {
    // The bug: once facedThreeBet latched, ANY later preflop fold set
    // folded_to_three_bet - so a fold to a 5-bet counted as a fold to a 3-bet,
    // inflating the stat with traffic that had nothing to do with 3-bets.
    const actions = [
      act(A, 'raise', 'preflop', 30), // open
      act(B, 'raise', 'preflop', 90), // 3-bet
      act(A, 'raise', 'preflop', 240), // hero 4-bets: he ANSWERED the 3-bet
      act(B, 'raise', 'preflop', 600), // 5-bet
      act(A, 'fold', 'preflop'),
    ];
    const f = deriveFlowFlags(A, actions, { boardLength: 0, returned: 0, nonFoldedCount: 1 });
    expect(f.faced_three_bet).toBe(true);
    expect(f.folded_to_three_bet).toBe(false);
  });

  it('opener who folds to a COLD 4-bet is not folding to a 3-bet', () => {
    // Ordinary multiway traffic, not a corner case: hero opens, one villain
    // 3-bets, another cold-4-bets, and only then does hero fold.
    const actions = [
      act(A, 'raise', 'preflop', 30),
      act(B, 'raise', 'preflop', 90),
      act(C, 'raise', 'preflop', 240),
      act(A, 'fold', 'preflop'),
    ];
    const f = deriveFlowFlags(A, actions, { boardLength: 0, returned: 0, nonFoldedCount: 1 });
    expect(f.folded_to_three_bet).toBe(false);
  });

  it('a 5-bet sets neither three_bet nor four_bet', () => {
    const actions = [
      act(A, 'raise', 'preflop', 30),
      act(B, 'raise', 'preflop', 90),
      act(A, 'raise', 'preflop', 240),
      act(B, 'raise', 'preflop', 600),
    ];
    const fb = deriveFlowFlags(B, actions, { boardLength: 0, returned: 0, nonFoldedCount: 2 });
    expect(fb.three_bet).toBe(true); // his FIRST raise was the 3-bet
    expect(fb.four_bet).toBe(false);
  });
});

describe('bomb pots count as VPIP (Dan 2026-09-05)', () => {
  it('the fact writer marks everyone dealt into a bomb hand as having put money in, and the log passes the flag', () => {
    const facts = readFileSync(
      resolve(__dirname, '../server/src/services/supabase/handFacts.ts'),
      'utf8'
    );
    expect(facts).toMatch(/isBombPot\?: boolean;/);
    expect(facts).toMatch(/if \(input\.isBombPot\) flags\.vpip = true;/);
    const history = readFileSync(
      resolve(__dirname, '../server/src/services/supabase/handHistory.ts'),
      'utf8'
    );
    expect(history).toMatch(/isBombPot: Boolean\(params\.bombPot\),/);
    // The rows already on file were corrected the same way.
    const backfill = readFileSync(
      resolve(__dirname, '../supabase/migrations/20260905063000_bomb_pots_count_as_vpip.sql'),
      'utf8'
    );
    expect(backfill).toMatch(/SET vpip = true[\s\S]*h\.bomb_pot IS NOT NULL/);
  });

  it('a bomb hand with no preflop action still reads vpip=false from the log alone (the reason the flag exists)', () => {
    const fb = deriveFlowFlags(
      'u1',
      [{ userId: 'u1', action: 'check', stage: 'flop', amount: 0 } as never],
      { boardLength: 3, returned: 0, nonFoldedCount: 2 }
    );
    expect(fb.vpip).toBe(false);
  });
});
