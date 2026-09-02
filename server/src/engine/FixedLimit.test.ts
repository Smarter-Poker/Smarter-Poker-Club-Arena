/**
 * FIXED LIMIT — betting structure verification (2026-08-23).
 *
 * The LIMIT tab in the lobby has always existed and `cashKind()` has always
 * classified `flh` into it, but FIX 116 removed the variants and the create-
 * table cards, so the tab could never hold a table. Restoring the cards alone
 * would have been worse than the bug: the engine only knew no-limit and
 * pot-limit (nine copies of `gameVariant.startsWith('plo')`), so an `flh` table
 * would have DEALT limit hold'em and PLAYED no-limit — arbitrary bet sizes, no
 * cap, unlimited raises.
 *
 * These tests pin the rules that make it a real limit game:
 *   • wagers are a FIXED size, never a range;
 *   • small bet preflop and flop, big bet (2x) turn and river;
 *   • four wagers per street — one bet and three raises — then the round caps;
 *   • a capped round offers only fold and call;
 *   • a short stack may still go all in for less;
 *   • a deep stack may NOT shove past the fixed bet;
 *   • no-limit and pot-limit tables are untouched by any of it.
 *
 * Cards are crypto-random, so every assertion is on structure and chip math.
 */
import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import { calculateBettingState, validateAction, determineWinners } from './PokerEngine.js';
import { holeCardCount, isOmahaVariant, isHiLoVariant } from './VariantRules.js';

import {
  bettingStructureFor,
  fixedLimitBetSize,
  isFixedLimitCapped,
  fixedLimitWagerCount,
  stakesLabel,
  substituteOnCappedStreet,
  FIXED_LIMIT_MAX_WAGERS,
} from './BettingStructure.js';
import type { HandConfig, SeatPlayer, ActionRecord } from '../types.js';

function mkPlayers(stacks: number[]): SeatPlayer[] {
  return stacks.map(
    (stack, i) =>
      ({
        seat: i + 1,
        user_id: `u${i + 1}`,
        username: `P${i + 1}`,
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
}

/** A 2/4 limit game: blinds 1/2, small bet 2, big bet 4. */
function mkConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId: 't-fl',
    handNumber: 1,
    gameVariant: 'flh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

function harness(config: HandConfig, stacks: number[], dealerSeat = 1) {
  const hc = new HandController(config, mkPlayers(stacks), dealerSeat);
  // Post the blinds and deal. With dealerSeat 1: SB seat 2, BB seat 3, and
  // seat 1 is first to act preflop facing the big blind.
  hc.start();
  const st = () => (hc as unknown as { state: any }).state;
  return {
    hc,
    st,
    cur: () => st().currentPlayerSeat,
    seat: (n: number) => st().players.find((p: SeatPlayer) => p.seat === n),
    act: (action: string, amount?: number) =>
      hc.performAction(st().currentPlayerSeat, action as any, amount),
    menu: () =>
      (hc as unknown as { getAvailableActions: (p: SeatPlayer) => string[] }).getAvailableActions(
        st().players.find((p: SeatPlayer) => p.seat === st().currentPlayerSeat)
      ),
    chips: () => st().players.reduce((s: number, p: SeatPlayer) => s + p.stack, 0) + st().pot,
  };
}

const rec = (over: Partial<ActionRecord>): ActionRecord =>
  ({
    seat: 1,
    userId: 'u1',
    action: 'raise',
    amount: 0,
    timestamp: 0,
    stage: 'flop',
    ...over,
  }) as ActionRecord;

// ═══════════════════════════════════════════════════════════════════════════
// The structure lookup itself
// ═══════════════════════════════════════════════════════════════════════════

describe('bettingStructureFor', () => {
  it('routes the limit variants to fixed_limit', () => {
    expect(bettingStructureFor('flh')).toBe('fixed_limit');
    expect(bettingStructureFor('flo8')).toBe('fixed_limit');
  });

  it('leaves every other variant exactly where it was', () => {
    expect(bettingStructureFor('nlh')).toBe('no_limit');
    expect(bettingStructureFor('pineapple')).toBe('no_limit');
    expect(bettingStructureFor('short_deck')).toBe('no_limit');
    for (const v of ['plo4', 'plo5', 'plo6', 'plo8']) {
      expect(bettingStructureFor(v)).toBe('pot_limit');
    }
  });

  it('does not mistake flo8 for a PLO variant', () => {
    // `flo8` contains no "plo" substring — the old `startsWith('plo')` test and
    // the lobby's `includes('plo')` classifier BOTH miss it, which is how Fixed
    // Limit Omaha ended up in the Mixed bucket instead of the LIMIT tab.
    expect('flo8'.includes('plo')).toBe(false);
    expect(bettingStructureFor('flo8')).not.toBe('pot_limit');
  });

  it('treats an unknown or empty variant as no-limit', () => {
    expect(bettingStructureFor(undefined)).toBe('no_limit');
    expect(bettingStructureFor('')).toBe('no_limit');
    expect(bettingStructureFor('some_future_game')).toBe('no_limit');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Small bet / big bet
// ═══════════════════════════════════════════════════════════════════════════

describe('fixedLimitBetSize', () => {
  it('wagers the small bet preflop and on the flop', () => {
    expect(fixedLimitBetSize(2, 'preflop')).toBe(2);
    expect(fixedLimitBetSize(2, 'flop')).toBe(2);
  });

  it('doubles to the big bet on turn and river', () => {
    expect(fixedLimitBetSize(2, 'turn')).toBe(4);
    expect(fixedLimitBetSize(2, 'river')).toBe(4);
  });
});

describe('stakesLabel', () => {
  it('posts a limit game by BET size, not blind size', () => {
    // Blinds 1/2 is a "2/4" limit game — the standard live convention.
    expect(stakesLabel(1, 2, 'flh')).toBe('2/4');
    expect(stakesLabel(5, 10, 'flo8')).toBe('10/20');
  });

  it('posts everything else by blinds, unchanged', () => {
    expect(stakesLabel(1, 2, 'nlh')).toBe('1/2');
    expect(stakesLabel(0.5, 1, 'plo4')).toBe('0.50/1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The cap: one bet and three raises
// ═══════════════════════════════════════════════════════════════════════════

describe('the four-wager cap', () => {
  it('counts the big blind as the first wager preflop', () => {
    expect(fixedLimitWagerCount([], 'preflop')).toBe(1);
    expect(fixedLimitWagerCount([], 'flop')).toBe(0);
  });

  it('caps preflop after three raises on top of the blind', () => {
    const raises = (n: number) =>
      Array.from({ length: n }, () => rec({ action: 'raise', stage: 'preflop' }));
    expect(isFixedLimitCapped(raises(2), 'preflop')).toBe(false);
    expect(isFixedLimitCapped(raises(3), 'preflop')).toBe(true);
    expect(fixedLimitWagerCount(raises(3), 'preflop')).toBe(FIXED_LIMIT_MAX_WAGERS);
  });

  it('caps postflop after a bet and three raises', () => {
    const street: ActionRecord[] = [
      rec({ action: 'bet' }),
      rec({ action: 'raise' }),
      rec({ action: 'raise' }),
    ];
    expect(isFixedLimitCapped(street, 'flop')).toBe(false);
    expect(isFixedLimitCapped([...street, rec({ action: 'raise' })], 'flop')).toBe(true);
  });

  it('ignores calls, checks and folds', () => {
    const noise = [
      rec({ action: 'call' }),
      rec({ action: 'check' }),
      rec({ action: 'fold' }),
      rec({ action: 'call' }),
    ];
    expect(fixedLimitWagerCount(noise, 'flop')).toBe(0);
  });

  it('does not count a SHORT all-in - it is not a full raise', () => {
    const short = [rec({ action: 'bet' }), rec({ action: 'all_in', isFullRaise: false })];
    expect(fixedLimitWagerCount(short, 'flop')).toBe(1);
    const full = [rec({ action: 'bet' }), rec({ action: 'all_in', isFullRaise: true })];
    expect(fixedLimitWagerCount(full, 'flop')).toBe(2);
  });

  it('counts each street separately', () => {
    const mixed = [
      rec({ action: 'bet', stage: 'flop' }),
      rec({ action: 'raise', stage: 'flop' }),
      rec({ action: 'bet', stage: 'turn' }),
    ];
    expect(fixedLimitWagerCount(mixed, 'flop')).toBe(2);
    expect(fixedLimitWagerCount(mixed, 'turn')).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// validateAction under a fixed-limit betting state
// ═══════════════════════════════════════════════════════════════════════════

describe('validateAction, fixed limit', () => {
  const flState = (over: { currentBet?: number; playerBet?: number; capped?: boolean } = {}) =>
    calculateBettingState(
      20, // pot
      over.currentBet ?? 0,
      over.playerBet ?? 0,
      2, // big blind (= small bet)
      0,
      false,
      { betSize: 4, capped: over.capped ?? false }
    );

  it('collapses min and max onto the one legal size', () => {
    const bs = flState();
    expect(bs.minRaise).toBe(4);
    expect(bs.maxRaise).toBe(4);
    expect(bs.structure).toBe('fixed_limit');
  });

  it('accepts exactly the fixed bet and refuses anything else', () => {
    const bs = flState();
    expect(validateAction('bet', 4, 100, bs).valid).toBe(true);
    expect(validateAction('bet', 3, 100, bs).valid).toBe(false);
    expect(validateAction('bet', 8, 100, bs).valid).toBe(false);
    // The rejection must name the structure that produced the bound — it used
    // to say "Pot-limit max bet" on every table.
    expect(validateAction('bet', 8, 100, bs).error).toContain('Fixed-limit');
  });

  it('accepts a raise of exactly one bet and refuses a larger one', () => {
    const bs = flState({ currentBet: 4, playerBet: 0 });
    expect(validateAction('raise', 8, 100, bs).valid).toBe(true);
    expect(validateAction('raise', 12, 100, bs).valid).toBe(false);
    expect(validateAction('raise', 6, 100, bs).valid).toBe(false);
  });

  it('refuses any wager once the round is capped', () => {
    const bs = flState({ currentBet: 16, playerBet: 4, capped: true });
    expect(validateAction('raise', 20, 100, bs).valid).toBe(false);
    expect(validateAction('raise', 20, 100, bs).error).toMatch(/capped/i);
    // Fold and call remain.
    expect(validateAction('fold', undefined, 100, bs).valid).toBe(true);
    expect(validateAction('call', undefined, 100, bs).valid).toBe(true);
  });

  it('lets a short stack go all in for less than a full bet', () => {
    const bs = flState({ currentBet: 4, playerBet: 0 });
    // Stack of 3 cannot even cover the call, let alone raise.
    expect(validateAction('all_in', undefined, 3, bs).valid).toBe(true);
  });

  it('refuses a deep stack shoving past the fixed bet', () => {
    const bs = flState({ currentBet: 4, playerBet: 0 });
    // 500 behind: all-in would be a raise TO 500, far past currentBet + 4.
    const res = validateAction('all_in', undefined, 500, bs);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('Fixed-limit');
  });

  it('refuses an all-in beyond the call on a capped round', () => {
    const bs = flState({ currentBet: 16, playerBet: 4, capped: true });
    expect(validateAction('all_in', undefined, 500, bs).valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// No-limit and pot-limit must be completely unaffected
// ═══════════════════════════════════════════════════════════════════════════

describe('validateAction, other structures unchanged', () => {
  it('no-limit still has no ceiling', () => {
    const bs = calculateBettingState(20, 0, 0, 2, 0, false);
    expect(bs.maxRaise).toBeUndefined();
    expect(bs.structure).toBe('no_limit');
    expect(validateAction('bet', 500, 500, bs).valid).toBe(true);
    expect(validateAction('all_in', undefined, 500, bs).valid).toBe(true);
  });

  it('pot-limit still caps at the pot and still says so', () => {
    const bs = calculateBettingState(20, 0, 0, 2, 0, true);
    expect(bs.maxRaise).toBe(20);
    expect(bs.structure).toBe('pot_limit');
    expect(validateAction('bet', 20, 500, bs).valid).toBe(true);
    const over = validateAction('bet', 21, 500, bs);
    expect(over.valid).toBe(false);
    expect(over.error).toContain('Pot-limit');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A real hand through HandController
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// FLO8 is a real Omaha game, not a Hold'em game wearing a limit label
// ═══════════════════════════════════════════════════════════════════════════

describe('flo8 is dealt and judged as Omaha Hi-Lo', () => {
  it('deals four hole cards, not two', () => {
    // The bug this pins: `flo8` contains no "plo", so every substring test in
    // the engine missed it and the fallback dealt two cards.
    const h = harness(mkConfig({ gameVariant: 'flo8' }), [200, 200, 200]);
    for (const p of h.st().players) {
      expect(p.cards.length).toBe(4);
    }
    expect(holeCardCount('flo8')).toBe(4);
  });

  it('is an Omaha hand and a hi-lo pot', () => {
    expect(isOmahaVariant('flo8')).toBe(true);
    expect(isHiLoVariant('flo8')).toBe(true);
  });

  it('awards the pot by Omaha rules - determineWinners is where money moves', () => {
    // Board gives a Hold'em player a made flush from the board alone; the
    // Omaha rule forbids playing the board, so the winner must be decided from
    // exactly two hole cards. Under the old `startsWith('plo')` test this
    // function evaluated flo8 with any-five-of-seven and paid the wrong seat.
    const board = [
      { rank: 'A', suit: 'h' },
      { rank: 'K', suit: 'h' },
      { rank: 'Q', suit: 'h' },
      { rank: 'J', suit: 'h' },
      { rank: '9', suit: 'h' },
    ] as any[];
    const players = [
      // Two black aces: nothing in Omaha, since the board flush cannot be played.
      {
        seat: 1,
        user_id: 'u1',
        username: 'P1',
        stack: 0,
        bet: 0,
        totalInvested: 10,
        is_folded: false,
        is_all_in: true,
        is_sitting_out: false,
        cards: [
          { rank: 'A', suit: 's' },
          { rank: 'A', suit: 'c' },
          { rank: '7', suit: 'd' },
          { rank: '8', suit: 'd' },
        ],
      },
      // Holds the Ten of hearts: with one more heart this is a straight flush
      // using exactly two cards. Must win under Omaha rules.
      {
        seat: 2,
        user_id: 'u2',
        username: 'P2',
        stack: 0,
        bet: 0,
        totalInvested: 10,
        is_folded: false,
        is_all_in: true,
        is_sitting_out: false,
        cards: [
          { rank: 'T', suit: 'h' },
          { rank: '2', suit: 'h' },
          { rank: '5', suit: 'c' },
          { rank: '6', suit: 'c' },
        ],
      },
    ] as any[];
    const pots = [{ amount: 20, eligiblePlayers: ['u1', 'u2'] }];

    const flo8Winners = determineWinners(players, board, pots, 'flo8', 1);
    const plo8Winners = determineWinners(players, board, pots, 'plo8', 1);

    // The two games differ only in betting, so the SAME cards must produce the
    // same result. Before VariantRules they did not.
    expect(flo8Winners.map((w) => w.userId).sort()).toEqual(
      plo8Winners.map((w) => w.userId).sort()
    );
    // And nobody is awarded more than the pot.
    expect(flo8Winners.reduce((s, w) => s + w.amount, 0)).toBeCloseTo(20, 2);
  });

  it('plays fixed-limit betting despite being an Omaha game', () => {
    // The trap in the other direction: an Omaha variant that must NOT be
    // pot-limit. HorseEval used to infer `isPotLimit` from `isOmaha`.
    expect(bettingStructureFor('flo8')).toBe('fixed_limit');
    const h = harness(mkConfig({ gameVariant: 'flo8' }), [200, 200, 200]);
    // A pot-sized open would be legal in PLO8 and is illegal here.
    expect(h.act('raise', 12)).toBe(false);
    expect(h.act('raise', 4)).toBe(true);
  });
});

describe('HandController on a 2/4 limit table', () => {
  it('accepts the fixed raise size preflop and conserves chips', () => {
    const h = harness(mkConfig(), [200, 200, 200]);
    const before = h.chips();

    // Preflop the blind is the bet, so a raise goes to 2 + 2 = 4.
    expect(h.act('raise', 4)).toBe(true);
    expect(h.st().currentBet).toBe(4);
    expect(h.chips()).toBeCloseTo(before, 2);
  });

  it('refuses a no-limit-shaped raise', () => {
    const h = harness(mkConfig(), [200, 200, 200]);
    // 40 would be a perfectly ordinary open in a 1/2 no-limit game.
    expect(h.act('raise', 40)).toBe(false);
    // The table is not stuck — the legal size still works.
    expect(h.act('raise', 4)).toBe(true);
  });

  it('withdraws raise from the menu once the round is capped', () => {
    const h = harness(mkConfig(), [200, 200, 200]);
    // Blind is wager 1; three raises take it to the cap.
    expect(h.act('raise', 4)).toBe(true);
    expect(h.act('raise', 6)).toBe(true);
    expect(h.act('raise', 8)).toBe(true);
    expect(isFixedLimitCapped(h.st().actionHistory, 'preflop')).toBe(true);

    const menu = h.menu();
    expect(menu).toContain('fold');
    expect(menu).toContain('call');
    expect(menu).not.toContain('raise');
    expect(menu).not.toContain('bet');
  });

  it('never lets a deep stack shove, and never freezes the seat for trying', () => {
    const h = harness(mkConfig(), [500, 500, 500]);
    const before = h.chips();
    // performAction clamps an illegal shove to the legal maximum rather than
    // rejecting it, so an automated path (horse, disconnect, watchdog) cannot
    // stall the table. Whatever it becomes, it must be accepted and must not
    // put the whole stack in.
    expect(h.act('all_in')).toBe(true);
    expect(h.st().currentBet).toBeLessThanOrEqual(4);
    expect(h.chips()).toBeCloseTo(before, 2);
  });

  it('conserves chips across a full capped street', () => {
    const h = harness(mkConfig(), [200, 200, 200]);
    const before = h.chips();
    h.act('raise', 4);
    h.act('raise', 6);
    h.act('raise', 8);
    h.act('call');
    h.act('call');
    expect(h.chips()).toBeCloseTo(before, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A capped street must never turn a horse's raise into a fold
// ═══════════════════════════════════════════════════════════════════════════

describe('substituteOnCappedStreet', () => {
  it('turns a wager into a call when money is owed', () => {
    // The bug it exists for: the horses decide independently of
    // getAvailableActions, and a REJECTED horse action degrades to
    // `check() || fold()`. On a capped street facing a bet, check is illegal
    // too — so a horse that wanted to RAISE folded the hand it had just
    // decided to put money in with.
    expect(substituteOnCappedStreet('raise', 4)).toBe('call');
    expect(substituteOnCappedStreet('bet', 4)).toBe('call');
  });

  it('turns a wager into a check when nothing is owed', () => {
    expect(substituteOnCappedStreet('raise', 0)).toBe('check');
    expect(substituteOnCappedStreet('bet', 0)).toBe('check');
  });

  it('never substitutes anything that was already legal', () => {
    for (const a of ['fold', 'check', 'call', 'all_in', 'discard'] as const) {
      expect(substituteOnCappedStreet(a, 4)).toBe(a);
      expect(substituteOnCappedStreet(a, 0)).toBe(a);
    }
  });

  it('produces an action a capped street actually accepts', () => {
    // Cross-check against validateAction rather than trusting the mapping: on a
    // capped street the only two survivors are fold and call.
    const capped = calculateBettingState(20, 16, 4, 2, 0, false, { betSize: 4, capped: true });
    expect(
      validateAction(substituteOnCappedStreet('raise', 12), undefined, 100, capped).valid
    ).toBe(true);
    // and the thing it replaced would NOT have been accepted
    expect(validateAction('raise', 20, 100, capped).valid).toBe(false);
  });

  it('treats a sub-cent owed amount as nothing owed', () => {
    // toCall arrives as a float; 0.004 is drift, not a debt.
    expect(substituteOnCappedStreet('raise', 0.004)).toBe('check');
  });
});

describe('a capped street ends by calling, not by folding', () => {
  it('leaves every seat with a legal action after the cap is reached', () => {
    const h = harness(mkConfig(), [200, 200, 200]);
    h.act('raise', 4);
    h.act('raise', 6);
    h.act('raise', 8);
    expect(isFixedLimitCapped(h.st().actionHistory, 'preflop')).toBe(true);

    // Whatever a bot wanted to do, the substitute must be accepted by the
    // engine — never rejected into the check/fold path.
    const menu = h.menu();
    expect(menu).toContain('call');
    const toCall = h.st().currentBet - h.seat(h.cur()).bet;
    const sub = substituteOnCappedStreet('raise', toCall);
    expect(h.act(sub as never)).toBe(true);
  });
});
