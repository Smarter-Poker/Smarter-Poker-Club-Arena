import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandController } from './HandController.js';
import { Deck } from './PokerEngine.js';
import type { Card, HandConfig, HandEvent, SeatPlayer } from '../types.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function config(overrides: Partial<HandConfig> = {}): HandConfig {
  return {
    asset: 'diamonds',
    tableId: 'diamond-cash-certification',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    ...overrides,
  };
}
function players(stacks = [100, 100, 100]): SeatPlayer[] {
  return stacks.map((stack, i) => ({
    seat: i + 1,
    user_id: `p${i + 1}`,
    username: `P${i + 1}`,
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
}
function royalBoard(): void {
  const cards: Card[] = [
    { rank: '2', suit: 'clubs' },
    { rank: '3', suit: 'clubs' },
    { rank: '4', suit: 'clubs' },
    { rank: '5', suit: 'clubs' },
    { rank: '6', suit: 'clubs' },
    { rank: '7', suit: 'clubs' },
    ...(['T', 'J', 'Q', 'K', 'A'] as const).map((rank) => ({ rank, suit: 'hearts' as const })),
  ];
  vi.spyOn(Deck.prototype, 'deal').mockImplementation((count = 1) => {
    if (cards.length < count) throw new Error('Certification Deck Exhausted');
    return cards.splice(0, count);
  });
}
function finish(hc: HandController): void {
  for (let step = 0; step < 25 && hc.getState().stage !== 'showdown'; step++) {
    const state = hc.getState();
    const player = state.players.find((p) => p.seat === state.currentPlayerSeat);
    if (!player || player.is_all_in) {
      hc.continueRunout();
      continue;
    }
    expect(hc.performAction(player.seat, player.bet < state.currentBet ? 'call' : 'check')).toBe(
      true
    );
  }
  expect(hc.getState().stage).toBe('showdown');
}

describe('Diamond cash uses the shared NLH controller with indivisible units', () => {
  it('rejects fractional betting before any state mutation and still accepts a legal raise', () => {
    const hc = new HandController(config(), players(), 1);
    hc.start();
    const before = hc.getState();
    expect(hc.performAction(before.currentPlayerSeat, 'raise', 4.5)).toBe(false);
    expect(hc.getState()).toEqual(before);
    expect(hc.performAction(before.currentPlayerSeat, 'raise', 4)).toBe(true);
    finish(hc);
    expect(hc.getState().players.reduce((sum, p) => sum + p.stack, 0)).toBe(300);
  });
  it('pays an odd tied pot in whole Diamonds clockwise from the button', () => {
    royalBoard();
    const hc = new HandController(config({ ante: 1 }), players(), 1);
    const events: HandEvent[] = [];
    hc.onEvent((event) => events.push(event));
    hc.start();
    expect(hc.performAction(1, 'fold')).toBe(true);
    finish(hc);
    const awards = events
      .filter((event) => event.type === 'WINNERS')
      .flatMap((event) => event.winners);
    expect(awards.map((w) => w.amount).sort()).toEqual([3, 4]);
    expect(awards.find((w) => w.userId === 'p2')?.amount).toBe(4);
    expect(hc.getState().players.reduce((sum, p) => sum + p.stack, 0)).toBe(300);
    expect(hc.getState().players.every((p) => Number.isInteger(p.stack))).toBe(true);
    expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(1);
  });
  /* A DIAMOND TABLE MAY STRADDLE (2026-09-12, Phase 7 line three). The straddle
     is the one optional cash feature that asks nothing of the chip economy:
     StraddleEngine prices it at exactly two times the current blind, and every
     Diamond guard already refuses a table whose blinds are not whole, so there
     is no division anywhere on the path and no counterparty to owe. */
  it('posts a whole UTG straddle and still conserves the table', () => {
    /* The real deck, not the certification board: that fixture holds exactly
       enough cards for three players and this hand needs four. */
    /* Four handed off the button at seat 1: seat 2 is the small blind, seat 3
       the big blind, and seat 4 is under the gun, which is the only seat a UTG
       straddle is ever posted from. */
    const hc = new HandController(
      config({ straddles: [{ seat: 4, amount: 4 }] }),
      players([100, 100, 100, 100]),
      1
    );
    const events: HandEvent[] = [];
    hc.onEvent((event) => events.push(event));
    hc.start();
    const posted = hc.getState();
    expect(posted.players.find((p) => p.seat === 4)?.bet).toBe(4);
    expect(posted.players.find((p) => p.seat === 4)?.stack).toBe(96);
    /* The straddle is a live blind: the floor for a raise is the straddle
       again, not the big blind. */
    expect(posted.currentBet).toBe(4);
    expect(posted.minRaise).toBe(4);
    finish(hc);
    const after = hc.getState();
    expect(after.players.reduce((sum, p) => sum + p.stack, 0)).toBe(400);
    expect(after.players.every((p) => Number.isInteger(p.stack))).toBe(true);
    expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(1);
  });

  /* A DIAMOND TABLE MAY BOMB (2026-09-12, Phase 7 line three). The ante is a
     forced bet out of a stack and the multi-board settlement has cut its shares
     in the table's own unit since the tournament fix, so a Diamond bomb divides
     in whole Diamonds by the same rule run it twice does. */
  it.each<[string, NonNullable<HandConfig['bombPot']>]>([
    ['one board', { anteMultiplier: 2 }],
    ['two boards', { anteMultiplier: 2, boardCount: 2, doubleBoard: true }],
    ['three boards', { anteMultiplier: 3, boardCount: 3, doubleBoard: true }],
    ['a fixed ante', { anteMultiplier: 2, anteFixed: 7 }],
  ])('deals a Diamond bomb pot over %s and conserves the table', (_name, bombPot) => {
    const hc = new HandController(config({ bombPot }), players(), 1);
    const events: HandEvent[] = [];
    hc.onEvent((event) => events.push(event));
    hc.start();
    const posted = hc.getState();
    /* Every dealt-in player put the SAME whole number in, and it is the ante
       the row asked for: a fixed ante when there is one, two or three times the
       blind otherwise. */
    const expected = bombPot.anteFixed ?? 2 * bombPot.anteMultiplier;
    for (const p of posted.players) {
      expect(p.totalInvested, `${p.user_id} anted ${p.totalInvested}`).toBe(expected);
      expect(Number.isSafeInteger(p.stack)).toBe(true);
    }
    expect(posted.pot).toBe(expected * posted.players.length);
    finish(hc);
    const after = hc.getState();
    expect(after.players.reduce((sum, p) => sum + p.stack, 0)).toBe(300);
    expect(after.players.every((p) => Number.isSafeInteger(p.stack))).toBe(true);
    expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(1);
  });

  it('rounds a bomb ante to the whole Diamond rather than the cent', () => {
    /* The boundary refuses a row whose ante could not be whole. This is the
       second half of the same rule: if one ever reached the engine, the forced
       bet is a whole Diamond rather than a fraction the hand guard would then
       refuse from a table that has already dealt. */
    const hc = new HandController(
      config({ smallBlind: 1, bigBlind: 3, bombPot: { anteMultiplier: 1.5 } }),
      players(),
      1
    );
    hc.start();
    for (const p of hc.getState().players) {
      expect(Number.isSafeInteger(p.totalInvested), `anted ${p.totalInvested}`).toBe(true);
    }
    expect(hc.getState().pot).toBe(hc.getState().players.length * 5);
  });

  it('keeps the chip bomb ante on the cent', () => {
    const hc = new HandController(
      config({ asset: 'chips', smallBlind: 0.5, bigBlind: 1, bombPot: { anteMultiplier: 1.5 } }),
      players([100, 100, 100]),
      1
    );
    hc.start();
    for (const p of hc.getState().players) expect(p.totalInvested).toBe(1.5);
  });

  it('refuses a fractional straddle before dealing anything', () => {
    expect(
      () => new HandController(config({ straddles: [{ seat: 4, amount: 4.5 }] }), players(), 1)
    ).toThrow('Whole Units');
  });

  it('settles multi-user all-ins and side pots once, including uncalled money', () => {
    royalBoard();
    const hc = new HandController(config(), players([5, 8, 11]), 1);
    const events: HandEvent[] = [];
    hc.onEvent((event) => events.push(event));
    hc.start();
    for (let step = 0; step < 3; step++) {
      expect(hc.performAction(hc.getState().currentPlayerSeat, 'all_in')).toBe(true);
    }
    hc.continueRunout();
    expect(hc.getState().stage).toBe('showdown');
    expect(hc.getState().players.map((p) => p.stack)).toEqual([5, 8, 11]);
    expect(hc.getState().pots.length).toBeGreaterThan(1);
    hc.continueRunout();
    expect(hc.getState().players.map((p) => p.stack)).toEqual([5, 8, 11]);
    expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(1);
  });
  it.each([0.5, NaN, Infinity, -1])('refuses invalid funded stack %s before dealing', (stack) => {
    expect(() => new HandController(config(), players([stack, 100, 100]), 1)).toThrow(
      'Whole Units'
    );
  });
  it('refuses fractional blinds and unapproved deductions before dealing', () => {
    expect(() => new HandController(config({ smallBlind: 0.5 }), players(), 1)).toThrow(
      'Whole Units'
    );
    expect(
      () =>
        new HandController(
          config({ rakeConfig: { percent: 5, cap: 3, noFlopNoDrop: true } }),
          players(),
          1
        )
    ).toThrow('No Deductions');
  });
  it('rejects a fractional external delta atomically before applying any entry', () => {
    const hc = new HandController(config(), players(), 1);
    const before = hc.getState();
    expect(() =>
      hc.applyStackDeltas(
        new Map([
          ['p1', 1],
          ['p2', -0.5],
        ])
      )
    ).toThrow('Whole Units');
    expect(hc.getState()).toEqual(before);
  });
  it.each<Partial<HandConfig>>([{ insuranceEnabled: true }])(
    'keeps later financial game features outside the initial certificate: %j',
    (feature) => {
      expect(() => new HandController(config(feature), players(), 1)).toThrow(
        'Requires A Supported Game With No Deductions'
      );
    }
  );

  /* PLO4 LEFT THAT LIST ON 2026-09-12, and for the same kind of reason run it
     twice did below: it was never a POLICY refusal, it was a refusal standing
     in for arithmetic nobody had checked. The only question another game asks
     of an indivisible unit is whether it divides a pot somewhere the
     cent-denominated code did not have to care about, and the answer is the
     hi-lo split - which takes the same `chipUnit` the tie chop takes, so the
     low half of a Diamond pot is a whole number of Diamonds and the odd unit
     goes to high. Pot-limit sizing is pure addition; fixed-limit multiplies
     the blind; short deck derives no ante. The nine games the chip cash screen
     offers are admitted, and the money proof for the Omaha family is in
     Phase9MultiboardUnits.test.ts, which checks plo4, plo8 and flo8 over two
     and three boards against an INDEPENDENT reference allocator. */
  it.each<string>([
    'nlh',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'pineapple',
    'short_deck',
    'flh',
    'flo8',
  ])('deals %s for Diamonds', (gameVariant) => {
    expect(
      () => new HandController(config({ gameVariant } as Partial<HandConfig>), players(), 1)
    ).not.toThrow();
  });

  it('and still refuses a game this estate does not deal', () => {
    expect(
      () =>
        new HandController(
          /* `razz` is deliberately not a GameVariant: the point of the case is
             that the boundary refuses a game this estate has no rules for, and
             a value the type already forbids is the only way to write it. */
          config({ gameVariant: 'razz' } as unknown as Partial<HandConfig>),
          players(),
          1
        )
    ).toThrow('Requires A Supported Game With No Deductions');
  });

  /* RUN IT TWICE LEFT THAT LIST ON 2026-09-12. It was there because the RIT
     runout cut every pot into integer cents, so a five Diamond pot over two
     runs paid two and a half Diamonds a board and this very guard would have
     refused the hand it had just dealt. The runout now cuts in the table's own
     unit; the money proof for that lives in RunItTwice.money.test.ts. */
  it('lets a Diamond hand be dealt with run it twice on', () => {
    expect(() => new HandController(config({ ritEnabled: true }), players(), 1)).not.toThrow();
  });
  it('preserves cent-denominated chip betting', () => {
    const hc = new HandController(
      config({ asset: 'chips', smallBlind: 0.5, bigBlind: 1 }),
      players(),
      1
    );
    hc.start();
    expect(hc.performAction(hc.getState().currentPlayerSeat, 'raise', 2.5)).toBe(true);
    finish(hc);
    expect(hc.getState().players.reduce((sum, p) => sum + p.stack, 0)).toBe(300);
  });
});
