/**
 * AN EMPTY PICK LIST IS A CLEAR, NOT A MALFORMED REQUEST (2026-09-05).
 *
 * Dan, from a screen recording: "THE EYE BALL STAYS 'LOCKED' YOU CAN NEVER
 * UNLOCK IT OR 'UNSHOW'."
 *
 * `showHand` takes the player's FULL current selection every time, which is
 * what makes un-clicking a card work - you send the shorter list. But
 * un-clicking the LAST card means sending `[]`, and that fell into
 * `valid.length === 0 -> 'No valid card indexes'`. The client then stopped
 * sending empty lists at all to avoid the error, so the engine kept holding a
 * card the player had taken back and turned it face up at hand end. The badge
 * came off; the card still showed.
 *
 * The two cases are different and are now told apart: an EMPTY list is a
 * deliberate "show nothing"; a NON-EMPTY list with nothing valid in it is a
 * crafted request and stays an error.
 *
 * `showHand` is called on the prototype with the few fields it reads, because
 * the alternative is standing up a whole table to assert one branch.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { ServerTableEngineSeating } from './ServerTableEngineSeating.js';

type ShowHandResult = { success: boolean; error?: string; shownCardIndexes?: number[] };
type Harness = {
  showHand: (userId: string, cardIndexes?: readonly number[]) => ShowHandResult;
  showHandCards: Map<string, Set<number>> | null;
};

const USER = 'hero-1';

function harness(opts: { stage?: string; folded?: boolean; cards?: number } = {}): Harness {
  const engine = Object.create(ServerTableEngineSeating.prototype) as Harness & {
    handController: unknown;
    tableInfo: unknown;
  };
  engine.showHandCards = null;
  engine.tableInfo = { show_hand_enabled: true };
  engine.handController = {
    getState: () => ({
      stage: opts.stage ?? 'flop',
      players: [
        {
          user_id: USER,
          is_folded: opts.folded ?? false,
          cards: Array.from({ length: opts.cards ?? 2 }, (_, i) => `c${i}`),
        },
      ],
    }),
  };
  return engine;
}

describe('taking a pick back', () => {
  let engine: Harness;
  beforeEach(() => {
    engine = harness();
  });

  it('an empty list SUCCEEDS and clears the stored picks', () => {
    expect(engine.showHand(USER, [0, 1]).success).toBe(true);
    expect(engine.showHandCards?.get(USER)).toEqual(new Set([0, 1]));

    const res = engine.showHand(USER, []);
    expect(res.success).toBe(true);
    expect(res.shownCardIndexes).toEqual([]);
    expect(engine.showHandCards?.get(USER)).toBeUndefined();
  });

  it('clearing when nothing was ever picked is still fine', () => {
    // The map is null here - it must not be dereferenced.
    expect(() => engine.showHand(USER, [])).not.toThrow();
    expect(engine.showHand(USER, []).success).toBe(true);
  });

  it('picks can go two, one, none, and back to two', () => {
    engine.showHand(USER, [0, 1]);
    engine.showHand(USER, [1]);
    expect(engine.showHandCards?.get(USER)).toEqual(new Set([1]));
    engine.showHand(USER, []);
    expect(engine.showHandCards?.get(USER)).toBeUndefined();
    engine.showHand(USER, [0, 1]);
    expect(engine.showHandCards?.get(USER)).toEqual(new Set([0, 1]));
  });
});

describe('a malformed list is still refused', () => {
  it('a non-empty list with no valid index is an error, not a clear', () => {
    const engine = harness();
    engine.showHand(USER, [0]);
    const res = engine.showHand(USER, [5, -1, 1.5]);
    expect(res.success).toBe(false);
    expect(res.error).toBe('No valid card indexes');
    // And it did NOT quietly wipe the real selection on its way out.
    expect(engine.showHandCards?.get(USER)).toEqual(new Set([0]));
  });

  it('out-of-range indexes are dropped, the valid ones kept', () => {
    const engine = harness();
    expect(engine.showHand(USER, [0, 9]).shownCardIndexes).toEqual([0]);
  });
});

describe('the gates around it are unchanged', () => {
  it('a folded hand cannot pick or clear', () => {
    const engine = harness({ folded: true });
    expect(engine.showHand(USER, []).error).toBe('Cannot show a folded hand');
  });

  it('picking specific cards is still allowed before showdown', () => {
    // The whole-hand form requires showdown; per-card picks deliberately do
    // not, because nothing is exposed at the moment of the click.
    expect(harness({ stage: 'flop' }).showHand(USER, [0]).success).toBe(true);
    expect(harness({ stage: 'flop' }).showHand(USER).error).toBe(
      'Can only show hand during showdown'
    );
  });

  it('a table with show-hand disabled refuses everything', () => {
    const engine = harness() as Harness & { tableInfo: unknown };
    engine.tableInfo = { show_hand_enabled: false };
    expect(engine.showHand(USER, []).success).toBe(false);
    expect(engine.showHand(USER, [0]).success).toBe(false);
  });

  it('a hand with no cards is refused', () => {
    expect(harness({ cards: 0 }).showHand(USER, []).error).toBe('No cards to show');
  });
});
