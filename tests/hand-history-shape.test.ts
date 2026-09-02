import { describe, it, expect } from 'vitest';
import {
  normaliseStoredHand,
  cardsVisibleAtStage,
  RIT_PREFIX,
} from '../src/utils/handHistoryShape';
import { toDeckCards } from '../src/utils/deckCards';

/**
 * These fixtures are REAL rows, copied from `hand_history` in production
 * (project kuklfnapbkmacvwxktbh) on 2026-08-23. The field names are the point
 * of this file: HandReplayViewer read every one of them under a different name
 * for months, and because each wrong read degraded to a blank rather than an
 * error, nothing anywhere went red.
 *
 * If a rename lands in the engine, this file fails first and says which name
 * moved. Do not "fix" it by loosening the assertions.
 */

const REAL_ACTIONS = [
  {
    seat: 3,
    stage: 'preflop',
    action: 'all_in',
    amount: 5494,
    userId: '6688345d-e7be-49bd-a318-4ee1e6b10253',
    timestamp: 1787452517546,
  },
  {
    seat: 5,
    stage: 'preflop',
    action: 'fold',
    amount: 0,
    userId: 'e0be3976-bb22-4720-829f-791ff19df459',
    timestamp: 1787452520397,
  },
];

const REAL_PLAYERS = [
  {
    seat: 3,
    cards: [],
    stack: 8900,
    userId: '6688345d-e7be-49bd-a318-4ee1e6b10253',
    username: 'Ronald Calabrese',
  },
  {
    seat: 5,
    cards: [],
    stack: 225.8,
    userId: 'e0be3976-bb22-4720-829f-791ff19df459',
    username: 'Richard Bianchi',
  },
];

const REAL_WINNER = {
  hand: { name: 'Two Pair', ranking: 3 },
  amount: 7.2,
  userId: '6688345d-e7be-49bd-a318-4ee1e6b10253',
  potIndex: 0,
};

describe('normaliseStoredHand — the stored field names', () => {
  it('resolves an action to a player name via userId (actions carry no name)', () => {
    const { actions } = normaliseStoredHand(REAL_PLAYERS, REAL_ACTIONS, []);
    expect(actions).toHaveLength(2);
    expect(actions[0].playerName).toBe('Ronald Calabrese');
    expect(actions[1].playerName).toBe('Richard Bianchi');
  });

  it('reads `stage`, not `street` — the board reveal depended on this', () => {
    /* This assertion has to be made on a NON-preflop action. The first version
       of this test used the preflop fixture, so reading the absent `street`
       fell back to 'preflop' and produced the right answer for the wrong
       reason: sabotaging the mapper to read `street` left all 17 tests green.
       A river action is the only shape where the fallback and the truth
       differ, which is what makes this able to fail at all. */
    const riverAction = {
      seat: 3,
      stage: 'river',
      action: 'bet',
      amount: 40,
      userId: '6688345d-e7be-49bd-a318-4ee1e6b10253',
    };
    const { actions } = normaliseStoredHand(REAL_PLAYERS, [riverAction], []);
    expect(actions[0].stage).toBe('river');
    // The old interface named this `street`; a row has no such key.
    expect((riverAction as Record<string, unknown>).street).toBeUndefined();
  });

  it('reveals the full board for a river action (the end-to-end consequence)', () => {
    const { actions } = normaliseStoredHand(
      REAL_PLAYERS,
      [{ seat: 3, stage: 'river', action: 'check', amount: 0, userId: 'x' }],
      []
    );
    // Reading the wrong key collapses every action to preflop, which is why
    // the board never revealed a single card in production.
    expect(cardsVisibleAtStage(actions[0].stage)).toBe(5);
  });

  it('keeps the underscored `all_in` verb', () => {
    const { actions } = normaliseStoredHand(REAL_PLAYERS, REAL_ACTIONS, []);
    expect(actions[0].verb).toBe('all_in');
    expect(actions[0].verb).not.toBe('all-in');
  });

  it('names the winner by userId, not by a `playerId` that does not exist', () => {
    const { winners } = normaliseStoredHand(REAL_PLAYERS, REAL_ACTIONS, [REAL_WINNER]);
    expect(winners[0].playerName).toBe('Ronald Calabrese');
    expect(winners[0].handName).toBe('Two Pair');
    expect(winners[0].amount).toBe(7.2);
  });

  it('does not name the first player as the winner of every hand', () => {
    // The old lookup compared p.id === w.playerId. Both are undefined on real
    // rows, so `find` matched the first entry and confidently showed the wrong
    // name. A winner who is NOT first must still resolve correctly.
    const { winners } = normaliseStoredHand(REAL_PLAYERS, REAL_ACTIONS, [
      { ...REAL_WINNER, userId: 'e0be3976-bb22-4720-829f-791ff19df459' },
    ]);
    expect(winners[0].playerName).toBe('Richard Bianchi');
    expect(winners[0].playerName).not.toBe(REAL_PLAYERS[0].username);
  });

  it('maps players by userId/username/seat/cards/stack', () => {
    const { players } = normaliseStoredHand(REAL_PLAYERS, [], []);
    expect(players[0]).toMatchObject({
      userId: '6688345d-e7be-49bd-a318-4ee1e6b10253',
      username: 'Ronald Calabrese',
      seat: 3,
      stack: 8900,
    });
  });
});

describe('normaliseStoredHand — run it twice', () => {
  const ritAction = {
    seat: null,
    stage: 'river',
    action: `${RIT_PREFIX}2clubs,2diamonds,3diamonds,4diamonds,6clubs`,
    amount: 0,
    userId: null,
  };

  it('lifts the second board out of the action stream', () => {
    const { secondBoard } = normaliseStoredHand(REAL_PLAYERS, [...REAL_ACTIONS, ritAction], []);
    expect(secondBoard).toEqual(['2clubs', '2diamonds', '3diamonds', '4diamonds', '6clubs']);
  });

  it('does not leave the raw rit_board_2 token in the player actions', () => {
    const { actions } = normaliseStoredHand(REAL_PLAYERS, [...REAL_ACTIONS, ritAction], []);
    expect(actions).toHaveLength(2);
    expect(actions.some((a) => a.verb.startsWith(RIT_PREFIX))).toBe(false);
  });

  it('produces a second board CardImage can actually render', () => {
    const { secondBoard } = normaliseStoredHand(REAL_PLAYERS, [ritAction], []);
    const cards = toDeckCards(secondBoard);
    expect(cards).toHaveLength(5);
    expect(cards[0]).toEqual({ rank: '2', suit: 'c' });
  });

  it('lifts BOTH extra boards of a 3-run hand, in run order (2026-08-26)', () => {
    // The old parser read only rit_board_2 — a run-it-three-times hand lost
    // its third board in replay.
    const board3Action = {
      seat: null,
      stage: 'river',
      action: 'rit_board_3:Ahearts,Kdiamonds,Qspades,Jclubs,10hearts',
      amount: 0,
      userId: null,
    };
    const { secondBoard, extraBoards, actions } = normaliseStoredHand(
      REAL_PLAYERS,
      [...REAL_ACTIONS, board3Action, ritAction],
      []
    );
    expect(extraBoards).toHaveLength(2);
    expect(extraBoards[0]).toEqual(['2clubs', '2diamonds', '3diamonds', '4diamonds', '6clubs']);
    expect(extraBoards[1]).toEqual(['Ahearts', 'Kdiamonds', 'Qspades', 'Jclubs', '10hearts']);
    // secondBoard stays the first extra board for existing consumers.
    expect(secondBoard).toEqual(extraBoards[0]);
    // Neither pseudo-action leaks into the player action stream.
    expect(actions.some((a) => a.verb.startsWith('rit_board_'))).toBe(false);
  });
});

describe('cardsVisibleAtStage', () => {
  it('reveals the board by stage', () => {
    expect(cardsVisibleAtStage('preflop')).toBe(0);
    expect(cardsVisibleAtStage('flop')).toBe(3);
    expect(cardsVisibleAtStage('turn')).toBe(4);
    expect(cardsVisibleAtStage('river')).toBe(5);
  });

  it('treats pineapple_discard as pre-board, not as an unknown stage', () => {
    expect(cardsVisibleAtStage('pineapple_discard')).toBe(0);
  });

  it('is safe on a stage it has never seen', () => {
    expect(cardsVisibleAtStage(undefined)).toBe(0);
    expect(cardsVisibleAtStage('some_future_street')).toBe(0);
  });
});

describe('stored community cards render', () => {
  it('parses the long suit names hand_history actually stores', () => {
    // The hand-rolled parser did slice(-1)/slice(0,-1) and produced
    // { rank: 'Kheart', suit: 's' } for 'Khearts'.
    const cards = toDeckCards(['Khearts', '8spades', 'Tspades', '9diamonds', '2hearts']);
    expect(cards).toEqual([
      { rank: 'K', suit: 'h' },
      { rank: '8', suit: 's' },
      { rank: 'T', suit: 's' },
      { rank: '9', suit: 'd' },
      { rank: '2', suit: 'h' },
    ]);
  });
});

describe('normaliseStoredHand — degrades instead of throwing', () => {
  it('survives null columns', () => {
    const r = normaliseStoredHand(null, null, null);
    expect(r).toEqual({ players: [], actions: [], winners: [], extraBoards: [], secondBoard: [] });
  });

  it('falls back to the seat when a player list is missing the actor', () => {
    const { actions } = normaliseStoredHand([], REAL_ACTIONS, []);
    expect(actions[0].playerName).toBe('Seat 3');
  });

  it('drops an action with no verb rather than rendering an empty row', () => {
    const { actions } = normaliseStoredHand(REAL_PLAYERS, [{ seat: 1, stage: 'flop' }], []);
    expect(actions).toHaveLength(0);
  });

  it('coerces a non-numeric amount to 0 rather than NaN', () => {
    const { actions } = normaliseStoredHand(
      REAL_PLAYERS,
      [{ action: 'bet', amount: 'not-a-number', seat: 3, stage: 'flop' }],
      []
    );
    expect(actions[0].amount).toBe(0);
  });
});
