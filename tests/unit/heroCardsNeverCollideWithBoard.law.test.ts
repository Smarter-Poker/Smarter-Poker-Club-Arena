/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW: A CARD CANNOT BE IN TWO PLACES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-31, from a live seat: hero holding J9h with a Kd 9h Qd flop.
 * "How the fuck is that even possible?!"
 *
 * It is not. One deck, one of each card. The engine did not deal it — the
 * client held a hand past the end of its own hand and painted it against the
 * next one's board. `heroCardsCollideWithBoard` is the invariant that catches
 * it whichever path produced it, and this file is what stops the invariant
 * being weakened by an edit that looks harmless.
 *
 * The two callers in TablePage are the card-hold merge (a held hand that the
 * incoming board contradicts is dropped) and the recovery poll (a fetched row
 * the board contradicts is rejected). Both rely on the comparison being exact
 * across the two suit spellings the app carries.
 */
import { describe, it, expect } from 'vitest';
import { heroCardsCollideWithBoard } from '../../src/lib/tableCardDisplay';

describe('LAW: a hero hole card is never also on the board', () => {
  it('catches the reported hand — J9h against a Kd 9h Qd flop', () => {
    const hero = [
      { rank: 'J', suit: 'h' },
      { rank: '9', suit: 'h' },
    ];
    const flop = [
      { rank: 'K', suit: 'diamonds' },
      { rank: '9', suit: 'hearts' },
      { rank: 'Q', suit: 'diamonds' },
    ];
    expect(heroCardsCollideWithBoard(hero, flop)).toBe(true);
  });

  it('compares across BOTH suit spellings, in either direction', () => {
    // The snapshot path delivers the engine's words; the realtime and recovery
    // paths deliver single letters. A comparison that only understood one of
    // them would silently never fire — the worst possible failure for a guard.
    expect(
      heroCardsCollideWithBoard([{ rank: '9', suit: 'hearts' }], [{ rank: '9', suit: 'h' }])
    ).toBe(true);
    expect(
      heroCardsCollideWithBoard([{ rank: '9', suit: 'h' }], [{ rank: '9', suit: 'hearts' }])
    ).toBe(true);
  });

  it('folds 10 and T together', () => {
    expect(
      heroCardsCollideWithBoard([{ rank: '10', suit: 's' }], [{ rank: 'T', suit: 'spades' }])
    ).toBe(true);
  });

  it('does not fire on a legitimate hand', () => {
    const hero = [
      { rank: 'A', suit: 'h' },
      { rank: 'K', suit: 'c' },
    ];
    const flop = [
      { rank: 'K', suit: 'diamonds' },
      { rank: '9', suit: 'hearts' },
      { rank: 'Q', suit: 'diamonds' },
    ];
    // Same RANK as a board card is ordinary poker — top pair. Only the same
    // rank AND suit is impossible.
    expect(heroCardsCollideWithBoard(hero, flop)).toBe(false);
  });

  it('checks every board, because the runouts come off one deck', () => {
    const hero = [{ rank: '9', suit: 'h' }];
    const board1 = [{ rank: 'K', suit: 'diamonds' }];
    const board2 = [{ rank: '9', suit: 'hearts' }];
    // Run-it-twice and bomb-pot double boards are dealt from the same deck, so
    // a collision with the SECOND board is exactly as impossible as the first.
    expect(heroCardsCollideWithBoard(hero, board1, board2)).toBe(true);
  });

  it('is quiet when there is nothing to compare', () => {
    // Preflop, an empty seat, an observer: no board and no cards must read as
    // "no collision", never as a reason to throw a hand away.
    expect(heroCardsCollideWithBoard([], [{ rank: '9', suit: 'h' }])).toBe(false);
    expect(heroCardsCollideWithBoard([{ rank: '9', suit: 'h' }], [])).toBe(false);
    expect(heroCardsCollideWithBoard(null, null)).toBe(false);
    expect(heroCardsCollideWithBoard(undefined, undefined)).toBe(false);
  });

  it('survives malformed cards without claiming a collision', () => {
    // A null in a hole-card array is normal (a Pineapple discard leaves one).
    // Garbage must not become a false positive that blanks a real hand.
    expect(
      heroCardsCollideWithBoard(
        [null, { rank: '9', suit: 'h' }],
        [{ rank: 'K', suit: 'diamonds' }, null, undefined]
      )
    ).toBe(false);
    expect(heroCardsCollideWithBoard([{} as never], [{ rank: '9', suit: 'h' }])).toBe(false);
  });
});
