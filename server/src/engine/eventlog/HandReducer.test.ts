import { describe, it, expect } from 'vitest';
import { replay, apply, deriveDeck, buildOrderedDeck } from './HandReducer.js';
import { buildExampleHand, buildSeedOnlyHand } from './testFixtures.js';

describe('HandReducer - replay of a full example hand', () => {
  it('replays blinds -> deal -> bets -> showdown -> payout to the correct stacks', () => {
    const events = buildExampleHand();
    const state = replay(events);

    const stackOf = (seat: number) => state.seats.find((s) => s.seat === seat)!.stack;

    // btn(1) invested 30+40+100 = 170, won 340 -> 1000 - 170 + 340 = 1170
    expect(stackOf(1)).toBe(1170);
    // SB(2) folded after posting the 5 small blind -> 995
    expect(stackOf(2)).toBe(995);
    // BB(3) invested 30+40+100 = 170, lost -> 830
    expect(stackOf(3)).toBe(830);

    expect(state.pot).toBe(0);
    expect(state.rakeTaken).toBe(5);
    expect(state.complete).toBe(true);
    expect(state.phase).toBe('complete');
    expect(state.board).toHaveLength(5);

    // Total chips conserved: stacks (2995) + rake (5) == initial 3000
    const stackSum = state.seats.reduce((s, p) => s + p.stack, 0);
    expect(stackSum + state.rakeTaken).toBe(3000);
  });

  it('tracks per-street bet -> pot sweeps correctly at each StreetAdvanced', () => {
    const events = buildExampleHand();
    // Fold up to just after the flop StreetAdvanced (index 6).
    const state = replay(events.slice(0, 7));
    // Preflop action: btn 30, SB 5 (dead, folded), BB 30 -> swept -> pot 65.
    expect(state.pot).toBe(65);
    expect(state.seats.every((s) => s.bet === 0)).toBe(true);
    expect(state.phase).toBe('flop');
  });
});

describe('HandReducer - determinism', () => {
  it('produces structurally identical state for the same events, twice', () => {
    const a = replay(buildExampleHand());
    const b = replay(buildExampleHand());
    expect(a).toEqual(b);
    // Deep JSON equality too (guards against hidden non-determinism).
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('is deterministic when the deck is derived from the seed (no explicit cards)', () => {
    const a = replay(buildSeedOnlyHand());
    const b = replay(buildSeedOnlyHand());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    // Board fully dealt from the seed; 5 cards, all distinct, none in hole cards.
    expect(a.board).toHaveLength(5);
    const seen = new Set<string>();
    const push = (c: { rank: string; suit: string }) => seen.add(`${c.rank}${c.suit}`);
    a.board.forEach(push);
    a.seats.forEach((s) => s.cards.forEach(push));
    // 2 players x 2 hole + 5 board = 9 distinct cards.
    expect(seen.size).toBe(9);
  });

  it('deriveDeck is a deterministic permutation of a full 52-card deck', () => {
    const d1 = deriveDeck(12345);
    const d2 = deriveDeck(12345);
    expect(d1).toEqual(d2);
    expect(d1).toHaveLength(52);
    const set = new Set(d1.map((c) => `${c.rank}${c.suit}`));
    expect(set.size).toBe(52);
    // Different seed -> different order (overwhelmingly likely).
    expect(JSON.stringify(deriveDeck(1))).not.toBe(JSON.stringify(deriveDeck(2)));
    // Ordered deck is also length 52 and distinct.
    expect(new Set(buildOrderedDeck().map((c) => `${c.rank}${c.suit}`)).size).toBe(52);
  });
});

describe('HandReducer - purity', () => {
  it('does not mutate the input state', () => {
    const events = buildExampleHand();
    const s0 = apply(undefined, events[0]);
    const snapshot = JSON.stringify(s0);
    const s1 = apply(s0, events[1]);
    // s0 unchanged after producing s1.
    expect(JSON.stringify(s0)).toBe(snapshot);
    expect(s1).not.toBe(s0);
  });

  it('throws if the first event is not HandStarted', () => {
    const events = buildExampleHand();
    expect(() => apply(undefined, events[1])).toThrow(/HandStarted/);
  });
});
