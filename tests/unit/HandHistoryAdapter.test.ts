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
import {
  adaptServiceHandToPanel,
  panelHandToShareable,
  toShareVariant,
} from '../../src/lib/handHistoryAdapter';

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
    /* 2026-08-23: the fixture had no `winners` at all, while every production
       row carries one. That absence is what let the adapter publish `p.result`
       — the NET — as `winners[].amount`, which the type has always documented
       as the GROSS chips taken from the pot, with the test agreeing about data
       that does not exist. Hero invests 6 + 10 + 60 = 76 and nets 125, so the
       pot paid 201; the row below says so. */
    winners: [{ user_id: HERO, amount: 201, pot_index: 0, hand_name: 'Three of a kind, aces' }],
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
  /* Was `amount: 125`, the hero's NET. It is the GROSS the pot paid, 201.
     HandDetailModal subtracted the action log and then added this figure, so
     publishing the net here cost the winner their investment twice and the two
     history surfaces printed different numbers for one hand. */
  it('lists every winner with the GROSS the pot paid them, and their hand', () => {
    const w = adaptServiceHandToPanel(baseHand(), HERO).winners;
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ playerId: HERO, playerName: 'Hero', amount: 201 });
  });

  it('is not the net — those are different numbers and only one is the pot', () => {
    const out = adaptServiceHandToPanel(baseHand(), HERO);
    expect(out.winners[0].amount).not.toBe(out.heroResult);
    // gross - invested === net, which is the whole relationship in one line.
    expect(out.winners[0].amount - 76).toBe(out.heroResult);
  });

  it('sums the side pots a winner scooped rather than keeping only the last', () => {
    const hand = baseHand({
      winners: [
        { user_id: HERO, amount: 150, pot_index: 0 },
        { user_id: HERO, amount: 51, pot_index: 1 },
      ],
    });
    expect(adaptServiceHandToPanel(hand, HERO).winners[0].amount).toBe(201);
  });

  /* A row written before `winners` was persisted still pins the gross: the
     service defines result as `won - invested`, so `won = result + invested`
     reconstructs it from the same inputs rather than guessing. */
  it('reconstructs the gross on a legacy row that stored no winners: result + invested', () => {
    /* `won = result + invested`, with `invested` from the model's differenced
       walk (raise-TO levels, blinds synthesised, uncalled bets returned) - not
       a naive sum of `actions[].amount`. In this fixture the villain never
       calls the flop or river bets, so those come back and the hero's true
       investment is what was called, not what was bet. */
    const hand = baseHand({ winners: [] });
    const out = adaptServiceHandToPanel(hand, HERO);
    const invested = out.replay.players.find((p) => p.userId === HERO)?.invested ?? 0;
    expect(invested).toBeGreaterThan(0);
    expect(out.winners[0].amount).toBe(Math.round((125 + invested) * 100) / 100);
    expect(out.winners[0].amount).toBeGreaterThan(125);
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

  it('is empty, not broken, when the row records no winner anywhere', () => {
    const hand = baseHand({ winners: [] });
    for (const p of (hand as never as { players: { is_winner: boolean }[] }).players)
      p.is_winner = false;
    expect(adaptServiceHandToPanel(hand, HERO).winners).toEqual([]);
  });

  it("the row's own winners list is read even when the roster flag is missing", () => {
    // `winners` is the settlement's record; `is_winner` is derived from it. A
    // winner the roster does not carry used to be dropped here.
    const hand = baseHand();
    for (const p of (hand as never as { players: { is_winner: boolean }[] }).players)
      p.is_winner = false;
    const w = adaptServiceHandToPanel(hand, HERO).winners;
    expect(w.map((x) => x.playerId)).toEqual([HERO]);
    expect(w[0].amount).toBe(201);
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

  /* Carried rather than re-derived downstream. HandDetailModal used to rebuild
     the net from the action log plus the winner amount, which is where the
     double subtraction lived. */
  it("carries each player's stored net so nothing has to recompute it", () => {
    const out = adaptServiceHandToPanel(baseHand(), HERO);
    expect(out.players.find((p) => p.id === HERO)?.result).toBe(125);
    expect(out.players.find((p) => p.id === VILLAIN)?.result).toBe(-60);
    expect(out.players.find((p) => p.id === HERO)?.result).toBe(out.heroResult);
  });

  it('does not throw on a row with no players', () => {
    expect(() => adaptServiceHandToPanel(baseHand({ players: null }), HERO)).not.toThrow();
  });
});

/**
 * SHARING THE HAND YOU ARE LOOKING AT.
 *
 * Hand Detail's SHARE button used to share `sharedHandData` — a snapshot built
 * once at the end of the last LIVE hand — so paging back to an older hand and
 * pressing SHARE shared the wrong one, and with no completed hand this session
 * it refused outright ("Play a hand to the end, then share it") while the
 * player was looking straight at a finished hand. The record on screen already
 * carries everything a link needs, so it is converted rather than looked up.
 */
describe('turning a recorded hand into a share link', () => {
  const shared = () => panelHandToShareable(adaptServiceHandToPanel(baseHand(), HERO), 'Table 7');

  it('shares the hand it was handed, not some other one', () => {
    expect(shared().id).toBe('h1');
    expect(shared().tableName).toBe('Table 7');
    expect(shared().timestamp).toBe(Date.parse('2026-08-19T01:02:03.000Z'));
  });

  it('carries the real action log rather than an empty preflop', () => {
    // HandHistoryPage's own converter hardcodes `preflop: []`, which is how a
    // shared hand ends up with players and a board but no betting at all.
    const s = shared();
    expect(s.preflop).toEqual([
      { seat: 1, action: 'RAISE', amount: 6 },
      { seat: 2, action: 'CALL', amount: 6 },
    ]);
    expect(s.flop?.actions).toEqual([
      { seat: 2, action: 'CHECK', amount: 0 },
      { seat: 1, action: 'BET', amount: 10 },
    ]);
    // `all_in` is what the engine stores; the share union spells it ALL_IN.
    expect(s.river?.actions).toEqual([{ seat: 1, action: 'ALL_IN', amount: 60 }]);
  });

  it('slices the board back into the streets that revealed it', () => {
    const s = shared();
    expect(s.flop?.cards).toEqual([
      { rank: 'A', suit: 'h' },
      { rank: 'K', suit: 's' },
      { rank: '7', suit: 'c' },
    ]);
    expect(s.turn?.card).toEqual({ rank: '2', suit: 'd' });
    expect(s.river?.card).toEqual({ rank: 'T', suit: 'h' });
  });

  it('derives the button from the stored position instead of defaulting to 0', () => {
    expect(shared().buttonSeat).toBe(1);
  });

  it('shares the GROSS the pot paid, never the net', () => {
    // Sharing the net would understate every pot by the winner's own
    // investment — the same conflation that made Hand Detail and Hand History
    // print two different numbers for one hand.
    expect(shared().winners).toEqual([{ seat: 1, amount: 201 }]);
  });

  it('omits a stack it does not know rather than inventing one', () => {
    // HandHistoryPage once filled a literal 1000 for every seat, presenting a
    // fabricated chip count to whoever opened the link.
    for (const p of shared().players) expect(p.stack).toBeUndefined();
  });

  it('travels only the holdings the table actually saw', () => {
    const s = shared();
    expect(s.players.find((p) => p.seat === 1)?.cards).toEqual([
      { rank: 'A', suit: 'c' },
      { rank: 'A', suit: 's' },
    ]);
    // Villain's hole_cards are [] on this row: nothing to leak, nothing shared.
    expect(s.players.find((p) => p.seat === 2)?.cards).toBeUndefined();
  });

  it('marks hero and the winner', () => {
    const hero = shared().players.find((p) => p.seat === 1);
    expect(hero?.isHero).toBe(true);
    expect(hero?.isWinner).toBe(true);
    expect(shared().players.find((p) => p.seat === 2)?.isWinner).toBe(false);
  });

  it('drops a pineapple discard rather than relabelling it as a real action', () => {
    const hand = adaptServiceHandToPanel(
      baseHand({
        actions: [
          { street: 'preflop', player_id: HERO, action: 'raise', amount: 6 },
          { street: 'pineapple_discard', player_id: HERO, action: 'discard', amount: 0 },
        ],
      }),
      HERO
    );
    const s = panelHandToShareable(hand, 'T');
    expect(s.preflop).toEqual([{ seat: 1, action: 'RAISE', amount: 6 }]);
    expect(JSON.stringify(s)).not.toContain('discard');
  });

  /**
   * PHASE 4 COMPLETION 2026-09-01 — the card you threw reaches the panel that
   * slides out AT THE TABLE, which is the surface a player actually reviews a
   * hand on mid-session. Phase 4 wired the standalone replay and stopped, so
   * this one still printed the word "discard" and nothing else.
   *
   * The privacy is Postgres's: `hand_discards` is read through
   * `hand_discards_read_own`, so the service can only ever fill
   * `discarded_card` for the viewer. These pin the two halves the adapter is
   * responsible for - carry it when it is there, and never invent it when it
   * is not.
   */
  it('carries the discarded card onto the panel row when the service has it', () => {
    const hand = adaptServiceHandToPanel(
      baseHand({
        actions: [
          {
            street: 'pineapple_discard',
            player_id: HERO,
            action: 'discard',
            amount: 0,
            discarded_card: { rank: '9', suit: 'hearts' },
          },
        ],
      }),
      HERO
    );
    const street = hand.streets.find((st) => st.name === 'pineapple_discard');
    expect(street?.actions[0].discardedCard).toBe('9h');
  });

  it('leaves it undefined for a discard the viewer may not see', () => {
    const hand = adaptServiceHandToPanel(
      baseHand({
        actions: [
          { street: 'pineapple_discard', player_id: VILLAIN, action: 'discard', amount: 0 },
        ],
      }),
      HERO
    );
    const street = hand.streets.find((st) => st.name === 'pineapple_discard');
    expect(street?.actions[0].discardedCard).toBeUndefined();
  });

  it('never lets the thrown card into a SHARED hand', () => {
    /* A shared hand is a public link. The discard is dropped from the
       shareable entirely - this pins that the new field did not sneak in
       behind it. */
    const hand = adaptServiceHandToPanel(
      baseHand({
        actions: [
          {
            street: 'pineapple_discard',
            player_id: HERO,
            action: 'discard',
            amount: 0,
            discarded_card: { rank: '9', suit: 'hearts' },
          },
        ],
      }),
      HERO
    );
    const s = panelHandToShareable(hand, 'T');
    expect(JSON.stringify(s)).not.toContain('discardedCard');
    expect(JSON.stringify(s)).not.toContain('9h');
  });

  it('survives a hand that ended before the flop', () => {
    const hand = adaptServiceHandToPanel(baseHand({ community_cards: [] }), HERO);
    const s = panelHandToShareable(hand, 'T');
    expect(s.flop).toBeUndefined();
    expect(s.turn).toBeUndefined();
    expect(s.river).toBeUndefined();
  });
});

describe('the share variant label', () => {
  /* The union named only half the live catalogue, so PLO8 was shared as PLO4
     and short deck and both pineapples were shared as NLH. Order matters:
     PLO8 must be tested before PLO, or "PLO8" reads as "PLO". */
  it.each([
    ['nlh', 'NLH'],
    ['plo4', 'PLO4'],
    ['plo5', 'PLO5'],
    ['plo6', 'PLO6'],
    ['plo8', 'PLO8'],
    ['short_deck', 'Short Deck'],
    // 2026-09-01: the engine deals Crazy Pineapple; the label follows it.
    ['pineapple', 'Crazy Pineapple'],
    ['PLO', 'PLO4'],
    ['omaha8', 'PLO8'],
  ] as const)('reads %s as %s', (input, expected) => {
    expect(toShareVariant(input)).toBe(expected);
  });

  it('falls back to NLH on something it has never seen', () => {
    expect(toShareVariant(undefined)).toBe('NLH');
    expect(toShareVariant('badugi')).toBe('NLH');
  });
});
