/**
 * SHOWDOWN SYSTEM 2026-08-25 — Dan's complete showdown specification.
 *
 * Pins the engine-authoritative showdown lifecycle rules:
 *
 *   spec section 3  — the FINAL betting round's last aggressor shows first
 *   spec section 4  — a hand that cannot win or tie any eligible pot may muck
 *   spec section 5  — a hand that wins or ties is auto-tabled, never muckable
 *   spec section 6  — checked-through river: first live player in river
 *                     action order shows first (heads-up: the Big Blind)
 *   spec section 8  — all-in with no further betting: every live hand shows
 *   spec section 11 — side pots keep their own eligible players and winners
 *   spec section 12 — ties split and both winners show
 *   spec section 14 — the descriptive hand line is engine-generated
 *
 * Cards are overwritten with fixed holdings immediately before the action
 * that closes the hand, so the assertions are deterministic. Structure-only
 * tests (all-in exposure, fold-around) keep the crypto-random deal.
 */
import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import { describeHand, evaluateHand } from './PokerEngine.js';
import type { Card, HandConfig, HandEvent, SeatPlayer, ShowdownResult } from '../types.js';

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

function mkConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId: 't1',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

const c = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });

interface Harness {
  hc: HandController;
  events: HandEvent[];
  st: () => any;
  cur: () => number;
  seat: (n: number) => SeatPlayer;
  actSeat: (seat: number, action: string, amount?: number) => boolean;
  setHole: (seatNum: number, cards: Card[]) => void;
  setBoard: (cards: Card[]) => void;
  showdown: () => ShowdownResult[];
  winners: () => Array<{ userId: string; amount: number; potIndex?: number }>;
}

function harness(config: HandConfig, players: SeatPlayer[], dealerSeat: number): Harness {
  const events: HandEvent[] = [];
  const hc = new HandController(config, players, dealerSeat);
  hc.onEvent((e) => events.push(e));
  const st = () => (hc as unknown as { state: any }).state;
  return {
    hc,
    events,
    st,
    cur: () => st().currentPlayerSeat,
    seat: (n: number) => st().players.find((p: SeatPlayer) => p.seat === n),
    actSeat: (s: number, action: string, amount = 0) => hc.performAction(s, action as any, amount),
    setHole: (seatNum: number, cards: Card[]) => {
      const p = st().players.find((pp: SeatPlayer) => pp.seat === seatNum);
      p.cards = cards;
    },
    setBoard: (cards: Card[]) => {
      st().communityCards.length = 0;
      st().communityCards.push(...cards);
    },
    showdown: () => {
      const ev = events.find((e) => e.type === 'SHOWDOWN') as
        | { type: 'SHOWDOWN'; results: ShowdownResult[] }
        | undefined;
      return ev?.results ?? [];
    },
    winners: () => {
      const ev = events.find((e) => e.type === 'WINNERS') as
        | { type: 'WINNERS'; winners: Array<{ userId: string; amount: number; potIndex?: number }> }
        | undefined;
      return ev?.winners ?? [];
    },
  };
}

/** Heads-up hand driven to a checked-down river. Dealer = seat 1 (SB). */
function huToRiver(h: Harness) {
  h.hc.start();
  h.actSeat(1, 'call'); // dealer/SB completes
  h.actSeat(2, 'check'); // BB option
  // flop + turn: BB (seat 2) acts first postflop heads-up
  h.actSeat(2, 'check');
  h.actSeat(1, 'check');
  h.actSeat(2, 'check');
  h.actSeat(1, 'check');
  expect(h.st().stage).toBe('river');
}

const DRY_BOARD: Card[] = [
  c('K', 'spades'),
  c('Q', 'diamonds'),
  c('9', 'clubs'),
  c('5', 'hearts'),
  c('3', 'spades'),
];

// ─────────────────────────────────────────────────────────────────────────
describe('HEADS-UP showdown ordering + muck (spec sections 3, 4, 7)', () => {
  it('HU 1: river bet + call — aggressor shows first, beaten caller mucks', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200]), 1);
    huToRiver(h);
    h.actSeat(2, 'check');
    expect(h.actSeat(1, 'bet', 4)).toBe(true); // seat 1 is the river aggressor
    h.setBoard(DRY_BOARD);
    h.setHole(1, [c('A', 'spades'), c('A', 'diamonds')]); // pair of aces — wins
    h.setHole(2, [c('7', 'diamonds'), c('2', 'clubs')]); // seven high — loses
    h.actSeat(2, 'call'); // closes the hand

    const results = h.showdown();
    expect(results.length).toBe(2);
    expect(results[0].seat).toBe(1); // final-street aggressor first
    expect(results[0].revealOrder).toBe(0);
    expect(results[0].mucked).toBe(false);
    expect(results[1].seat).toBe(2);
    expect(results[1].mucked).toBe(true); // cannot win or tie — may muck
    expect(h.winners().map((w) => w.userId)).toEqual(['u1']);
  });

  it('HU 2: river bet + call — caller has the better hand, both show, caller wins', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200]), 1);
    huToRiver(h);
    h.actSeat(2, 'check');
    h.actSeat(1, 'bet', 4);
    h.setBoard(DRY_BOARD);
    h.setHole(1, [c('K', 'hearts'), c('J', 'diamonds')]); // pair of kings
    h.setHole(2, [c('A', 'spades'), c('A', 'diamonds')]); // pair of aces — wins
    h.actSeat(2, 'call');

    const results = h.showdown();
    expect(results[0].seat).toBe(1); // aggressor still shows first
    expect(results[0].mucked).toBe(false);
    expect(results[1].seat).toBe(2);
    expect(results[1].mucked).toBe(false); // winning hand is auto-tabled
    expect(h.winners().map((w) => w.userId)).toEqual(['u2']);
  });

  it('HU 3: checked-through river — the Big Blind (first postflop actor) shows first', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200]), 1);
    huToRiver(h);
    h.actSeat(2, 'check');
    h.setBoard(DRY_BOARD);
    h.setHole(1, [c('A', 'spades'), c('4', 'diamonds')]);
    h.setHole(2, [c('8', 'hearts'), c('7', 'diamonds')]);
    h.actSeat(1, 'check'); // river checks through

    const results = h.showdown();
    expect(results[0].seat).toBe(2); // BB tables first — NOT preflop order
    expect(results[0].revealOrder).toBe(0);
    // Seat 1 (ace high) beats seat 2 (eight high): seat 2 shown first, seat 1
    // must show to claim, and wins.
    expect(results[1].mucked).toBe(false);
    expect(h.winners().map((w) => w.userId)).toEqual(['u1']);
  });

  it('HU 4: preflop all-in + call — every live hand is exposed, no muck option', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200]), 1);
    h.hc.start();
    h.actSeat(1, 'all_in');
    h.actSeat(2, 'call'); // parks in ALL_IN_RUNOUT
    expect(h.events.some((e) => e.type === 'ALL_IN_RUNOUT')).toBe(true);
    h.hc.continueRunout();

    const results = h.showdown();
    expect(results.length).toBe(2);
    for (const r of results) expect(r.mucked).toBe(false); // spec section 8
    expect(h.winners().length).toBeGreaterThan(0);
  });

  it('AUDIT: river all-in bet + call — an all-in showdown, both hands exposed', () => {
    // Spec section 8 lists "River all-ins": the runout park never fires (no
    // cards to come), but at most one live player could still bet, so this
    // is an all-in showdown all the same — the beaten caller may NOT muck.
    const h = harness(mkConfig(), mkPlayers([200, 200]), 1);
    huToRiver(h);
    h.actSeat(2, 'check');
    expect(h.actSeat(1, 'all_in')).toBe(true); // river all-in wager
    h.setBoard(DRY_BOARD);
    h.setHole(1, [c('A', 'spades'), c('A', 'diamonds')]); // winner
    h.setHole(2, [c('7', 'diamonds'), c('2', 'clubs')]); // beaten caller
    h.actSeat(2, 'call');

    const results = h.showdown();
    expect(results.length).toBe(2);
    for (const r of results) expect(r.mucked).toBe(false);
    expect(h.winners().map((w) => w.userId)).toEqual(['u1']);
  });

  it('AUDIT: four of a kind or better is ALWAYS tabled, even when beaten (BBJ integrity)', () => {
    // The Bad Beat Jackpot pays the LOSER of a quads-or-better hand — a
    // jackpot on a hand the table never saw is a contradiction, so a monster
    // can never be ruled muckable. Plain bet/call river (no all-in), quads
    // beaten by a royal flush.
    const h = harness(mkConfig(), mkPlayers([200, 200]), 1);
    huToRiver(h);
    h.actSeat(2, 'check');
    h.actSeat(1, 'bet', 4);
    h.setBoard([
      c('T', 'spades'),
      c('J', 'spades'),
      c('Q', 'spades'),
      c('8', 'hearts'),
      c('8', 'diamonds'),
    ]);
    h.setHole(1, [c('A', 'spades'), c('K', 'spades')]); // royal flush
    h.setHole(2, [c('8', 'clubs'), c('8', 'spades')]); // quads — beaten
    h.actSeat(2, 'call');

    const results = h.showdown();
    const bySeat = new Map(results.map((r) => [r.seat, r]));
    expect(bySeat.get(1)!.hand.name).toBe('Royal Flush');
    expect(bySeat.get(2)!.hand.name).toBe('Four of a Kind');
    expect(bySeat.get(2)!.mucked).toBe(false); // beaten, but never muckable
    expect(h.winners().map((w) => w.userId)).toEqual(['u1']);
  });

  it('HU 5: river bet, opponent folds — no showdown event at all', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200]), 1);
    huToRiver(h);
    h.actSeat(2, 'check');
    h.actSeat(1, 'bet', 4);
    h.actSeat(2, 'fold');

    expect(h.events.some((e) => e.type === 'SHOWDOWN')).toBe(false); // spec section 2
    expect(h.winners().map((w) => w.userId)).toEqual(['u1']);
  });

  it('street-scoped aggression: a preflop raise does NOT decide showdown order', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200]), 1);
    h.hc.start();
    h.actSeat(1, 'raise', 6); // preflop aggression from the dealer
    h.actSeat(2, 'call');
    for (const street of ['flop', 'turn', 'river'] as const) {
      expect(h.st().stage).toBe(street);
      h.actSeat(2, 'check');
      if (street !== 'river') h.actSeat(1, 'check');
    }
    h.setBoard(DRY_BOARD);
    h.setHole(1, [c('A', 'spades'), c('4', 'diamonds')]);
    h.setHole(2, [c('8', 'hearts'), c('7', 'diamonds')]);
    h.actSeat(1, 'check'); // river checks through

    // TDA: aggression on an EARLIER street does not survive to showdown
    // order. First river actor (the BB) shows first.
    expect(h.showdown()[0].seat).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('MULTIWAY ordering, muck, side pots (spec sections 3, 5, 10, 11)', () => {
  it('Multiway 1+2: A checks, B bets, C calls, A calls — B shows first; losers muck', () => {
    // dealer=1 → SB=2 (A), BB=3 (B), BTN=1 (C). Postflop order: 2, 3, 1.
    const h = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);
    h.hc.start();
    h.actSeat(1, 'call');
    h.actSeat(2, 'call');
    h.actSeat(3, 'check');
    for (const street of ['flop', 'turn'] as const) {
      expect(h.st().stage).toBe(street);
      h.actSeat(2, 'check');
      h.actSeat(3, 'check');
      h.actSeat(1, 'check');
    }
    // river: A (seat 2) checks, B (seat 3) bets, C (seat 1) calls, A calls
    h.actSeat(2, 'check');
    h.actSeat(3, 'bet', 6);
    h.actSeat(1, 'call');
    h.setBoard(DRY_BOARD);
    h.setHole(3, [c('K', 'hearts'), c('J', 'diamonds')]); // B: pair of kings — wins
    h.setHole(1, [c('Q', 'hearts'), c('J', 'clubs')]); // C: pair of queens — mucks
    h.setHole(2, [c('7', 'diamonds'), c('2', 'clubs')]); // A: seven high — mucks
    h.actSeat(2, 'call');

    const results = h.showdown();
    expect(results.map((r) => r.seat)).toEqual([3, 1, 2]); // B first, then clockwise
    expect(results[0].mucked).toBe(false);
    expect(results[1].mucked).toBe(true); // C beaten by B — may muck
    expect(results[2].mucked).toBe(true); // A beaten by B — may muck
    expect(h.winners().map((w) => w.userId)).toEqual(['u3']);
  });

  it('Multiway 5+6+muck protection: short all-in wins main pot and is auto-tabled', () => {
    // A (seat 2) is short and all-in preflop; B (seat 3) and C (seat 1) play on.
    const h = harness(mkConfig(), mkPlayers([200, 20, 200]), 1);
    h.hc.start();
    h.actSeat(1, 'call'); // C calls 2
    h.actSeat(2, 'all_in'); // A all-in for 20
    h.actSeat(3, 'call'); // B calls 20
    h.actSeat(1, 'call'); // C calls 20
    for (const street of ['flop', 'turn'] as const) {
      expect(h.st().stage).toBe(street);
      h.actSeat(3, 'check');
      h.actSeat(1, 'check');
    }
    // river: B bets, C calls — side-pot betting between the two live stacks
    h.actSeat(3, 'bet', 10);
    h.setBoard(DRY_BOARD);
    h.setHole(2, [c('A', 'spades'), c('A', 'diamonds')]); // A: aces — best hand
    h.setHole(3, [c('K', 'hearts'), c('J', 'diamonds')]); // B: kings — side pot
    h.setHole(1, [c('Q', 'hearts'), c('J', 'clubs')]); // C: queens — beaten
    h.actSeat(1, 'call');

    const pots = h.st().pots;
    expect(pots.length).toBe(2); // main + one side pot
    expect(pots[0].eligiblePlayers).toContain('u2'); // A eligible for main
    expect(pots[1].eligiblePlayers).not.toContain('u2'); // A NOT in side pot

    const results = h.showdown();
    const bySeat = new Map(results.map((r) => [r.seat, r]));
    expect(results[0].seat).toBe(3); // river aggressor first
    // Spec section 5: A's hand wins the main pot — the engine auto-tables it
    // even though A would lose the side pot it is not eligible for.
    expect(bySeat.get(2)!.mucked).toBe(false);
    expect(bySeat.get(3)!.mucked).toBe(false); // B wins the side pot
    expect(bySeat.get(1)!.mucked).toBe(true); // C wins nothing — may muck

    const wins = h.winners();
    expect(wins.find((w) => w.userId === 'u2')?.potIndex).toBe(0); // A: main
    expect(wins.find((w) => w.userId === 'u3')?.potIndex).toBe(1); // B: side
    expect(wins.some((w) => w.userId === 'u1')).toBe(false);
  });

  it('Multiway 7 / spec 12: tied hands both show and split the pot evenly', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200]), 1);
    huToRiver(h);
    h.actSeat(2, 'check');
    // Board plays for both: straight 5-6-7-8-9 on the board, irrelevant holes.
    h.setBoard([
      c('5', 'spades'),
      c('6', 'diamonds'),
      c('7', 'clubs'),
      c('8', 'hearts'),
      c('9', 'spades'),
    ]);
    h.setHole(1, [c('A', 'spades'), c('2', 'diamonds')]);
    h.setHole(2, [c('K', 'hearts'), c('2', 'clubs')]);
    h.actSeat(1, 'check');

    const results = h.showdown();
    expect(results[0].mucked).toBe(false);
    expect(results[1].mucked).toBe(false); // a tie may never be mucked
    const wins = h.winners();
    expect(wins.length).toBe(2);
    expect(wins[0].amount).toBeCloseTo(wins[1].amount, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('HAND DESCRIPTIONS (spec section 14) — engine-generated, never hard-coded', () => {
  const evalCards = (hole: Card[], board: Card[]) => evaluateHand(hole, board);

  it('Full House -> "Kings Full Of Nines"', () => {
    const hand = evalCards(
      [c('K', 'spades'), c('K', 'diamonds')],
      [c('K', 'hearts'), c('9', 'clubs'), c('9', 'spades'), c('4', 'diamonds'), c('2', 'hearts')]
    );
    expect(hand.name).toBe('Full House');
    expect(describeHand(hand)).toBe('Kings Full Of Nines');
  });

  it('Flush -> "Ace High"', () => {
    const hand = evalCards(
      [c('A', 'spades'), c('4', 'spades')],
      [c('K', 'spades'), c('9', 'spades'), c('2', 'spades'), c('Q', 'diamonds'), c('3', 'hearts')]
    );
    expect(hand.name).toBe('Flush');
    expect(describeHand(hand)).toBe('Ace High');
  });

  it('Straight (wheel) -> "Five High"', () => {
    const hand = evalCards(
      [c('A', 'spades'), c('2', 'diamonds')],
      [c('3', 'hearts'), c('4', 'clubs'), c('5', 'spades'), c('9', 'diamonds'), c('J', 'hearts')]
    );
    expect(hand.name).toBe('Straight');
    expect(describeHand(hand)).toBe('Five High');
  });

  it('Four of a Kind -> "Queens"', () => {
    const hand = evalCards(
      [c('Q', 'spades'), c('Q', 'diamonds')],
      [c('Q', 'hearts'), c('Q', 'clubs'), c('9', 'spades'), c('4', 'diamonds'), c('2', 'hearts')]
    );
    expect(hand.name).toBe('Four of a Kind');
    expect(describeHand(hand)).toBe('Queens');
  });

  it('Two Pair -> "Aces And Kings"; Pair -> "Queens"; High Card -> "Ace High"', () => {
    const twoPair = evalCards(
      [c('A', 'spades'), c('K', 'diamonds')],
      [c('A', 'hearts'), c('K', 'clubs'), c('9', 'spades'), c('4', 'diamonds'), c('2', 'hearts')]
    );
    expect(describeHand(twoPair)).toBe('Aces And Kings');
    const pair = evalCards(
      [c('Q', 'spades'), c('J', 'diamonds')],
      [c('Q', 'hearts'), c('8', 'clubs'), c('6', 'spades'), c('4', 'diamonds'), c('2', 'hearts')]
    );
    expect(describeHand(pair)).toBe('Queens');
    const high = evalCards(
      [c('A', 'spades'), c('J', 'diamonds')],
      [c('9', 'hearts'), c('8', 'clubs'), c('6', 'spades'), c('4', 'diamonds'), c('2', 'hearts')]
    );
    expect(describeHand(high)).toBe('Ace High');
  });

  it('Royal Flush and Straight Flush describe their high card', () => {
    const royal = evalCards(
      [c('A', 'spades'), c('K', 'spades')],
      [c('Q', 'spades'), c('J', 'spades'), c('T', 'spades'), c('4', 'diamonds'), c('2', 'hearts')]
    );
    expect(royal.name).toBe('Royal Flush');
    expect(describeHand(royal)).toBe('Ace High');
    const sf = evalCards(
      [c('9', 'spades'), c('8', 'spades')],
      [c('7', 'spades'), c('6', 'spades'), c('5', 'spades'), c('A', 'diamonds'), c('2', 'hearts')]
    );
    expect(sf.name).toBe('Straight Flush');
    expect(describeHand(sf)).toBe('Nine High');
  });

  it('every showdown result carries the description of its own hand', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200]), 1);
    huToRiver(h);
    h.actSeat(2, 'check');
    h.setBoard(DRY_BOARD);
    h.setHole(1, [c('A', 'spades'), c('A', 'diamonds')]);
    h.setHole(2, [c('8', 'hearts'), c('7', 'diamonds')]);
    h.actSeat(1, 'check');
    for (const r of h.showdown()) {
      expect(r.handDescription).toBe(describeHand(r.hand));
      expect(r.handDescription!.length).toBeGreaterThan(0);
    }
  });
});
