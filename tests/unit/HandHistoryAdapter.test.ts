/**
 * HAND HISTORY ADAPTER (2026-08-19).
 *
 * This maps the stored hand row onto the view model the Hand History panel
 * renders. It is the only thing between what actually happened at the table and
 * what a player is later told happened — the pot, the winner, the amount, their
 * own result.
 *
 * That makes it a quiet kind of dangerous. If the pot is summed wrong or a
 * winner is dropped, nothing crashes and nothing looks broken; the player is
 * simply shown a number that is not true. So the tests below are mostly about
 * arithmetic and completeness rather than shape.
 *
 * It also has to survive rows that are missing pieces. Older hands predate some
 * columns, and a hand can end before the river, so every collection has to be
 * treated as possibly absent rather than assumed.
 */
import { describe, it, expect } from 'vitest';
import { adaptServiceHandToPanel } from '../../src/lib/handHistoryAdapter';

const HERO = 'hero-1';
const VILLAIN = 'villain-1';

/** A complete, ordinary hand that went to showdown. */
function baseHand(over: Record<string, unknown> = {}) {
  return {
    id: 'h1',
    hand_number: 42,
    played_at: '2026-08-19T01:02:03.000Z',
    game_type: 'nlh',
    stakes: '1/2',
    main_pot: 100,
    side_pots: [20, 5],
    community_cards: [
      { rank: 'A', suit: 'hearts' },
      { rank: 'K', suit: 'spades' },
      { rank: '7', suit: 'clubs' },
      { rank: '2', suit: 'diamonds' },
      { rank: 'T', suit: 'hearts' },
    ],
    players: [
      {
        user_id: HERO,
        username: 'Hero',
        seat: 1,
        position: 'BTN',
        hole_cards: [
          { rank: 'A', suit: 'clubs' },
          { rank: 'A', suit: 'spades' },
        ],
        is_winner: true,
        result: 125,
        final_hand: 'Three of a kind, aces',
      },
      {
        user_id: VILLAIN,
        username: 'Villain',
        seat: 2,
        position: 'BB',
        hole_cards: [],
        is_winner: false,
        result: -60,
        final_hand: 'Two pair',
      },
    ],
    actions: [
      { street: 'preflop', player_id: HERO, action: 'raise', amount: 6 },
      { street: 'preflop', player_id: VILLAIN, action: 'call', amount: 6 },
      { street: 'flop', player_id: VILLAIN, action: 'check', amount: 0 },
      { street: 'flop', player_id: HERO, action: 'bet', amount: 10 },
      // `all_in` is what the engine stores. This fixture said 'all-in', a
      // spelling nothing produces, so the test agreed with the buggy adapter
      // about data that does not exist and the real defect survived both.
      { street: 'river', player_id: HERO, action: 'all_in', amount: 60 },
    ],
    ...over,
  } as never;
}

describe('the money', () => {
  it('adds the side pots to the main pot', () => {
    expect(adaptServiceHandToPanel(baseHand(), HERO).potTotal).toBe(125);
  });

  it('is just the main pot when there are no side pots', () => {
    expect(adaptServiceHandToPanel(baseHand({ side_pots: [] }), HERO).potTotal).toBe(100);
    expect(adaptServiceHandToPanel(baseHand({ side_pots: null }), HERO).potTotal).toBe(100);
  });

  it('survives a null inside the side pots rather than producing NaN', () => {
    const out = adaptServiceHandToPanel(baseHand({ side_pots: [20, null, 5] }), HERO);
    expect(out.potTotal).toBe(125);
    expect(Number.isNaN(out.potTotal)).toBe(false);
  });

  it('reports zero, not NaN, when the pot fields are missing entirely', () => {
    const out = adaptServiceHandToPanel(baseHand({ main_pot: null, side_pots: null }), HERO);
    expect(out.potTotal).toBe(0);
  });

  it("reports the hero's own result", () => {
    expect(adaptServiceHandToPanel(baseHand(), HERO).heroResult).toBe(125);
    expect(adaptServiceHandToPanel(baseHand(), VILLAIN).heroResult).toBe(-60);
  });

  it('reports 0 rather than undefined when the hero was not in the hand', () => {
    expect(adaptServiceHandToPanel(baseHand(), 'someone-else').heroResult).toBe(0);
  });
});

describe('winners', () => {
  it('lists every winner with their amount and hand', () => {
    const w = adaptServiceHandToPanel(baseHand(), HERO).winners;
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ playerId: HERO, playerName: 'Hero', amount: 125 });
  });

  it('keeps both winners of a split pot', () => {
    const hand = baseHand();
    (hand as never as { players: { is_winner: boolean; result: number }[] }).players[1].is_winner =
      true;
    (hand as never as { players: { is_winner: boolean; result: number }[] }).players[1].result =
      125;
    const w = adaptServiceHandToPanel(hand, HERO).winners;
    expect(w).toHaveLength(2);
  });

  it('is empty, not broken, when nobody is flagged as a winner', () => {
    const hand = baseHand();
    for (const p of (hand as never as { players: { is_winner: boolean }[] }).players)
      p.is_winner = false;
    expect(adaptServiceHandToPanel(hand, HERO).winners).toEqual([]);
  });
});

describe('the board is sliced back into the streets that revealed it', () => {
  it('3 / 1 / 1', () => {
    const s = adaptServiceHandToPanel(baseHand(), HERO).streets;
    expect(s.find((x) => x.name === 'flop')?.cards).toEqual(['Ah', 'Ks', '7c']);
    expect(s.find((x) => x.name === 'turn')?.cards).toEqual(['2d']);
    expect(s.find((x) => x.name === 'river')?.cards).toEqual(['Th']);
  });

  it('a hand that ended on the flop has no turn or river cards', () => {
    const hand = baseHand({
      community_cards: [
        { rank: 'A', suit: 'hearts' },
        { rank: 'K', suit: 'spades' },
        { rank: '7', suit: 'clubs' },
      ],
      actions: [{ street: 'flop', player_id: HERO, action: 'bet', amount: 10 }],
    });
    const s = adaptServiceHandToPanel(hand, HERO).streets;
    expect(s.find((x) => x.name === 'flop')?.cards).toHaveLength(3);
    expect(s.find((x) => x.name === 'turn')).toBeUndefined();
    expect(s.find((x) => x.name === 'river')).toBeUndefined();
  });

  it('a preflop-only hand has no board at all', () => {
    const hand = baseHand({
      community_cards: [],
      actions: [{ street: 'preflop', player_id: HERO, action: 'fold', amount: 0 }],
    });
    const s = adaptServiceHandToPanel(hand, HERO).streets;
    expect(s.map((x) => x.name)).toEqual(['preflop']);
  });

  it('drops streets where nothing happened and no card fell', () => {
    const s = adaptServiceHandToPanel(baseHand(), HERO).streets;
    // turn had no actions but did reveal a card, so it stays
    expect(s.map((x) => x.name)).toEqual(['preflop', 'flop', 'turn', 'river']);
  });
});

describe('actions', () => {
  it("renames the engine's 'all_in' to the panel's 'allin'", () => {
    const river = adaptServiceHandToPanel(baseHand(), HERO).streets.find((s) => s.name === 'river');
    expect(river?.actions[0].action).toBe('allin');
  });

  it('keeps actions on their own street, in order', () => {
    const flop = adaptServiceHandToPanel(baseHand(), HERO).streets.find((s) => s.name === 'flop');
    expect(flop?.actions.map((a) => a.action)).toEqual(['check', 'bet']);
  });

  it('names the acting player', () => {
    const flop = adaptServiceHandToPanel(baseHand(), HERO).streets.find((s) => s.name === 'flop');
    expect(flop?.actions.map((a) => a.playerName)).toEqual(['Villain', 'Hero']);
  });

  it('falls back to "Player" for an id no longer in the roster', () => {
    const hand = baseHand({
      actions: [{ street: 'preflop', player_id: 'ghost', action: 'fold', amount: 0 }],
    });
    const pre = adaptServiceHandToPanel(hand, HERO).streets.find((s) => s.name === 'preflop');
    expect(pre?.actions[0].playerName).toBe('Player');
  });

  it('handles a row with no actions at all', () => {
    expect(() => adaptServiceHandToPanel(baseHand({ actions: null }), HERO)).not.toThrow();
  });
});

describe('cards are formatted as rank + first letter of suit', () => {
  it('hole cards come through when present', () => {
    const hero = adaptServiceHandToPanel(baseHand(), HERO).players.find((p) => p.id === HERO);
    expect(hero?.holeCards).toEqual(['Ac', 'As']);
  });

  it('a mucked hand has no hole cards rather than an empty array', () => {
    const v = adaptServiceHandToPanel(baseHand(), HERO).players.find((p) => p.id === VILLAIN);
    expect(v?.holeCards).toBeUndefined();
  });
});

describe('the row is copied across faithfully', () => {
  it('carries the identifying fields', () => {
    const out = adaptServiceHandToPanel(baseHand(), HERO);
    expect(out).toMatchObject({
      id: 'h1',
      handNumber: 42,
      gameType: 'nlh',
      blinds: '1/2',
      heroId: HERO,
    });
    expect(out.timestamp).toBe(Date.parse('2026-08-19T01:02:03.000Z'));
  });

  it('lists every player with seat and position', () => {
    const out = adaptServiceHandToPanel(baseHand(), HERO);
    expect(out.players).toHaveLength(2);
    expect(out.players[0]).toMatchObject({ id: HERO, name: 'Hero', seat: 1, position: 'BTN' });
  });

  it('does not throw on a row with no players', () => {
    expect(() => adaptServiceHandToPanel(baseHand({ players: null }), HERO)).not.toThrow();
  });
});
