import { describe, expect, it } from 'vitest';
import type { ActionRecord, HandStage, SeatPlayer } from '../types.js';
import {
  classifyGtoDecisionContext,
  gtoV31DealtInSeats,
  gtoV31FlopRootStack,
  gtoV31HasHeadsUpPostflopLine,
  gtoV31Position,
  gtoV31PotType,
  gtoV31SizeBucket,
  gtoV31UtilityContext,
  lastAggressor,
} from './GtoDecisionContext.js';

const rec = (
  seat: number,
  action: ActionRecord['action'],
  amount: number,
  stage: HandStage,
  isFullRaise?: boolean
): ActionRecord => ({
  seat,
  userId: `p${seat}`,
  action,
  amount,
  stage,
  timestamp: 0,
  ...(isFullRaise === undefined ? {} : { isFullRaise }),
});

function seats(count: number, dealerSeat = count): SeatPlayer[] {
  return Array.from({ length: count }, (_, index) => ({
    seat: index + 1,
    user_id: `p${index + 1}`,
    username: `P${index + 1}`,
    stack: 1_000,
    bet: 0,
    totalInvested: index === 0 ? 10 : 0,
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    cards: index === dealerSeat - 1 ? [] : [],
  })) as SeatPlayer[];
}

function context(
  history: ActionRecord[],
  over: Partial<Parameters<typeof classifyGtoDecisionContext>[0]> = {}
) {
  return classifyGtoDecisionContext({
    street: 'turn',
    hero: { seat: 1, bet: 0, stack: 1_000 },
    opponents: [{ seat: 2, bet: 0, stack: 1_000, is_all_in: false }],
    actionHistory: history,
    currentBet: 0,
    pot: 100,
    ...over,
  });
}

describe('canonical V31 node context', () => {
  it('uses the exact shared size boundaries', () => {
    expect(gtoV31SizeBucket(0.59)).toBe('small');
    expect(gtoV31SizeBucket(0.6)).toBe('mid');
    expect(gtoV31SizeBucket(1.09)).toBe('mid');
    expect(gtoV31SizeBucket(1.1)).toBe('big');
    expect(gtoV31SizeBucket(0.1, true)).toBe('all_in');
    expect(gtoV31SizeBucket(null)).toBe('none');
  });

  it('finds the last aggressor on only the requested street', () => {
    const history = [rec(1, 'raise', 8, 'preflop'), rec(2, 'bet', 20, 'flop')];
    expect(lastAggressor(history, 'preflop')).toBe(1);
    expect(lastAggressor(history, 'flop')).toBe(2);
    expect(lastAggressor(history, 'turn')).toBeNull();
  });

  it('reconstructs flop-root depth instead of shrinking the solver stack each street', () => {
    const history = [
      rec(1, 'bet', 50, 'flop'),
      rec(2, 'raise', 150, 'flop'),
      rec(1, 'call', 100, 'flop'),
      rec(1, 'bet', 200, 'turn'),
      rec(2, 'call', 200, 'turn'),
    ];
    expect(
      gtoV31FlopRootStack({
        street: 'turn',
        player: { seat: 1, stack: 650, bet: 200 },
        actionHistory: history,
      })
    ).toBe(1_000);
    expect(
      gtoV31FlopRootStack({
        street: 'river',
        player: { seat: 1, stack: 650, bet: 0 },
        actionHistory: history,
      })
    ).toBe(1_000);
    expect(
      gtoV31FlopRootStack({
        street: 'river',
        player: { seat: 2, stack: 650, bet: 0 },
        actionHistory: history,
      })
    ).toBe(1_000);
    expect(
      gtoV31FlopRootStack({
        street: 'turn',
        player: { seat: 1, stack: Number.NaN, bet: 0 },
        actionHistory: history,
      })
    ).toBeNull();
    expect(
      gtoV31FlopRootStack({
        street: 'turn',
        player: { seat: 1, stack: 800, bet: 0 },
        actionHistory: [],
      })
    ).toBeNull();
    expect(
      gtoV31FlopRootStack({
        street: 'turn',
        player: { seat: 1, stack: 650, bet: 250 },
        actionHistory: history,
      })
    ).toBeNull();
    expect(
      gtoV31FlopRootStack({
        street: 'turn',
        player: { seat: 1, stack: 1_000, bet: 0 },
        actionHistory: [rec(1, 'check', 5, 'flop')],
      })
    ).toBeNull();
    expect(
      gtoV31FlopRootStack({
        street: 'turn',
        player: { seat: 1, stack: 1_000, bet: 0 },
        actionHistory: [rec(1, 'fold', 0, 'flop')],
      })
    ).toBeNull();
  });

  it('keys exact positions and original table size rather than a coarse late bucket', () => {
    const six = seats(6);
    expect(gtoV31Position({ seat: 1, dealerSeat: 6, players: six })).toEqual({
      position: 'SB',
      tableSize: 6,
    });
    expect(gtoV31Position({ seat: 3, dealerSeat: 6, players: six })).toEqual({
      position: 'UTG',
      tableSize: 6,
    });
    expect(gtoV31Position({ seat: 4, dealerSeat: 6, players: six })).toEqual({
      position: 'HJ',
      tableSize: 6,
    });
    expect(gtoV31Position({ seat: 6, dealerSeat: 6, players: six })).toEqual({
      position: 'BTN',
      tableSize: 6,
    });

    const nine = seats(9);
    nine[3].is_folded = true;
    nine[3].totalInvested = 0;
    expect(gtoV31DealtInSeats(nine)).toHaveLength(9);
    expect(gtoV31Position({ seat: 4, dealerSeat: 9, players: nine })).toEqual({
      position: 'UTG1',
      tableSize: 9,
    });

    const headsUp = seats(2, 1);
    expect(gtoV31Position({ seat: 1, dealerSeat: 1, players: headsUp })?.position).toBe('SB');
    expect(gtoV31Position({ seat: 2, dealerSeat: 1, players: headsUp })?.position).toBe('BB');
  });

  it('separates limped, single-raised, three-bet, and four-bet pots', () => {
    const open = rec(1, 'raise', 6, 'preflop');
    const threeBet = rec(2, 'raise', 20, 'preflop');
    const fourBet = rec(1, 'all_in', 100, 'preflop');
    fourBet.isFullRaise = true;
    const allInCall = rec(2, 'all_in', 100, 'preflop');
    expect(gtoV31PotType([])).toBe('limped');
    expect(gtoV31PotType([open])).toBe('srp');
    expect(gtoV31PotType([open, threeBet])).toBe('3bet');
    expect(gtoV31PotType([open, threeBet, fourBet])).toBe('4bet_plus');
    expect(gtoV31PotType([open, allInCall])).toBe('srp');
  });

  it('keeps distinct tournament utility families and refuses ordinary ICM in bounty events', () => {
    expect(gtoV31UtilityContext({ family: 'cash', objective: 'cash_ev' })).toBe('cash_ev');
    expect(gtoV31UtilityContext({ family: 'tourney_ev', objective: 'chip_ev' })).toBe('chip_ev');
    expect(
      gtoV31UtilityContext({
        family: 'tourney_icm',
        objective: 'icm',
        tournament: { nearBubble: true },
      })
    ).toBe('bubble');
    expect(
      gtoV31UtilityContext({
        family: 'tourney_icm',
        objective: 'icm',
        tournament: { finalTable: true },
      })
    ).toBe('final_table');
    expect(
      gtoV31UtilityContext({
        family: 'tourney_icm',
        objective: 'icm',
        tournament: { nearBubble: true, bountyFactor: 0.25 },
      })
    ).toBeNull();
    expect(
      gtoV31UtilityContext({
        family: 'tourney_ev',
        objective: 'chip_ev',
        tournament: { bountyFactor: 0.25 },
      })
    ).toBeNull();
    expect(
      gtoV31UtilityContext({
        family: 'spin',
        objective: 'chip_ev',
        tournament: { mysteryChestsLeft: 4 },
      })
    ).toBeNull();
    expect(
      gtoV31UtilityContext({
        family: 'tourney_ev',
        objective: 'chip_ev',
        tournament: { meanBountyCents: 1_000 },
      })
    ).toBeNull();
    expect(gtoV31UtilityContext({ family: 'tourney_icm', objective: 'chip_ev' })).toBeNull();
    expect(gtoV31UtilityContext({ family: 'tourney_ev', objective: 'icm' })).toBeNull();
  });

  it('refuses a heads-up tree after any third player acted postflop', () => {
    expect(gtoV31HasHeadsUpPostflopLine([rec(1, 'check', 0, 'flop')], 1, 2)).toBe(true);
    expect(gtoV31HasHeadsUpPostflopLine([rec(3, 'check', 0, 'flop')], 1, 2)).toBe(false);
    expect(gtoV31HasHeadsUpPostflopLine([rec(3, 'fold', 0, 'turn')], 1, 2)).toBe(false);
  });

  it('separates c-bets, barrels, probes, delayed c-bets, and truly open nodes', () => {
    expect(context([])).toBeNull();
    expect(context([rec(1, 'check', 0, 'flop'), rec(2, 'check', 0, 'flop')])?.nodeRole).toBe(
      'open'
    );
    expect(context([rec(1, 'raise', 8, 'flop')], { street: 'turn' })?.nodeRole).toBe('barrel');
    expect(context([rec(2, 'bet', 8, 'flop')], { street: 'turn' })).toBeNull();
    expect(
      context(
        [rec(1, 'raise', 8, 'preflop'), rec(1, 'check', 0, 'flop'), rec(2, 'check', 0, 'flop')],
        {
          street: 'turn',
        }
      )?.nodeRole
    ).toBe('delayed_cbet');
    expect(
      context(
        [rec(2, 'raise', 8, 'preflop'), rec(1, 'check', 0, 'flop'), rec(2, 'check', 0, 'flop')],
        {
          street: 'turn',
        }
      )?.nodeRole
    ).toBe('probe');
    expect(
      context([rec(1, 'raise', 8, 'preflop'), rec(2, 'check', 0, 'flop')], {
        street: 'flop',
      })?.nodeRole
    ).toBe('cbet');
  });

  it('classifies a first wager by bet/pot-before', () => {
    const result = context([rec(2, 'bet', 75, 'turn')], {
      currentBet: 75,
      pot: 175,
      opponents: [{ seat: 2, bet: 75, stack: 925, is_all_in: false }],
    });
    expect(result).toEqual({ nodeRole: 'facing_bet', facingKind: 'bet', facingSizeBucket: 'mid' });
  });

  it('distinguishes a check-raise from a plain bet-raise and a generic facing raise', () => {
    const checkRaise = context(
      [rec(2, 'check', 0, 'turn'), rec(1, 'bet', 50, 'turn'), rec(2, 'raise', 250, 'turn')],
      {
        hero: { seat: 1, bet: 50, stack: 950 },
        opponents: [{ seat: 2, bet: 250, stack: 750, is_all_in: false }],
        currentBet: 250,
        pot: 400,
      }
    );
    expect(checkRaise?.nodeRole).toBe('check_raise');
    expect(checkRaise?.facingKind).toBe('raise');
    expect(checkRaise?.facingSizeBucket).toBe('mid');

    const betRaise = context([rec(1, 'bet', 50, 'turn'), rec(2, 'raise', 250, 'turn')], {
      hero: { seat: 1, bet: 50, stack: 950 },
      opponents: [{ seat: 2, bet: 250, stack: 750, is_all_in: false }],
      currentBet: 250,
      pot: 400,
    });
    expect(betRaise?.nodeRole).toBe('bet_raise');
    expect(betRaise?.facingSizeBucket).toBe('mid');

    const facingRaise = context(
      [
        rec(1, 'bet', 50, 'turn'),
        rec(2, 'raise', 150, 'turn'),
        rec(1, 'raise', 300, 'turn'),
        rec(2, 'raise', 900, 'turn'),
      ],
      {
        hero: { seat: 1, bet: 300, stack: 700 },
        currentBet: 900,
        pot: 1_300,
        opponents: [{ seat: 2, bet: 900, stack: 100, is_all_in: false }],
      }
    );
    expect(facingRaise?.nodeRole).toBe('facing_raise');
    expect(facingRaise?.facingSizeBucket).toBe('mid');

    expect(
      context([rec(2, 'bet', 80, 'turn')], {
        hero: { seat: 1, bet: 0, stack: 1_000 },
        currentBet: 90,
        pot: 180,
        opponents: [{ seat: 2, bet: 90, stack: 910, is_all_in: false }],
      })
    ).toBeNull();

    expect(
      context([rec(2, 'bet', 100, 'turn')], {
        hero: { seat: 1, bet: 0, stack: Number.NaN },
        currentBet: 100,
        pot: 200,
        opponents: [{ seat: 2, bet: 100, stack: 900, is_all_in: false }],
      })
    ).toBeNull();

    expect(
      context([rec(2, 'bet', 100, 'turn')], {
        currentBet: 100,
        pot: 100,
        opponents: [{ seat: 2, bet: 100, stack: 900, is_all_in: false }],
      })
    ).toBeNull();

    expect(
      context([rec(2, 'raise', 140, 'turn')], {
        currentBet: 140,
        pot: 240,
        opponents: [{ seat: 2, bet: 140, stack: 860, is_all_in: false }],
      })
    ).toBeNull();
  });

  it('gives an all-in its own node and never disguises it as a large bet', () => {
    const result = context([rec(2, 'all_in', 1_000, 'turn', true)], {
      currentBet: 1_000,
      pot: 1_100,
      opponents: [{ seat: 2, bet: 1_000, stack: 0, is_all_in: true }],
    });
    expect(result).toEqual({
      nodeRole: 'all_in',
      facingKind: 'all_in',
      facingSizeBucket: 'all_in',
    });

    const coveringBet = context([rec(2, 'bet', 500, 'turn')], {
      hero: { seat: 1, bet: 0, stack: 200 },
      currentBet: 500,
      pot: 600,
      opponents: [{ seat: 2, bet: 500, stack: 500, is_all_in: false }],
    });
    expect(coveringBet).toEqual({
      nodeRole: 'all_in',
      facingKind: 'all_in',
      facingSizeBucket: 'all_in',
    });

    const coveringRaise = context([rec(1, 'bet', 100, 'turn'), rec(2, 'raise', 500, 'turn')], {
      hero: { seat: 1, bet: 100, stack: 150 },
      currentBet: 500,
      pot: 700,
      opponents: [{ seat: 2, bet: 500, stack: 500, is_all_in: false }],
    });
    expect(coveringRaise).toEqual({
      nodeRole: 'all_in',
      facingKind: 'all_in',
      facingSizeBucket: 'all_in',
    });
  });

  it('fails closed on an impossible second open decision by the same actor', () => {
    expect(context([rec(1, 'bet', 40, 'turn')])).toBeNull();
    expect(context([rec(1, 'check', 0, 'turn')])).toBeNull();
  });

  it('does not treat an all-in call as a new aggressor', () => {
    const history = [rec(1, 'bet', 80, 'flop'), rec(2, 'all_in', 80, 'flop')];
    expect(lastAggressor(history, 'flop')).toBe(1);
  });
});
