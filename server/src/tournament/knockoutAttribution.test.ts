/**
 * DAN SECTION 78 (cases 19-23) — WHO GETS THE KNOCKOUT.
 *
 * These pin the rule the mystery bounty is worth money on: the credit belongs
 * to the winner(s) of the pot that contained the eliminated player's FINAL
 * chips, not to whoever won the most in the hand.
 *
 * Case 22 is the one that used to fail and is the reason `hand_history.pots`
 * exists. Case 23 is the one nothing can express without a caller: a player at
 * zero chips who has not actually been eliminated never reaches this module,
 * so it is asserted where that decision is made.
 */

import { describe, it, expect } from 'vitest';
import { attributeKnockout, lastPotForPlayer } from './knockoutAttribution.js';

const BUSTED = 'aaaaaaaa-0000-0000-0000-000000000001';
const A = 'bbbbbbbb-0000-0000-0000-000000000002';
const B = 'cccccccc-0000-0000-0000-000000000003';
const C = 'dddddddd-0000-0000-0000-000000000004';

describe('section 78/19 - one elimination is attributed to exactly one knockout', () => {
  it('credits the sole winner of the only pot', () => {
    const out = attributeKnockout(
      {
        pots: [{ index: 0, amount: 600, eligible: [BUSTED, A] }],
        winners: [{ userId: A, amount: 600, potIndex: 0 }],
      },
      BUSTED
    );
    expect(out.knockerUserId).toBe(A);
    expect(out.claimants).toEqual([{ userId: A, weight: 1 }]);
    expect(out.basis).toBe('pot');
    expect(out.potIndex).toBe(0);
  });

  it('never credits the busted player with their own knockout', () => {
    // A short stack can win a pot they were eligible for and still lose their
    // stack. They are not their own knocker.
    const out = attributeKnockout(
      {
        pots: [{ index: 0, amount: 900, eligible: [BUSTED, A, B] }],
        winners: [
          { userId: BUSTED, amount: 300, potIndex: 0 },
          { userId: A, amount: 600, potIndex: 0 },
        ],
      },
      BUSTED
    );
    expect(out.claimants.map((c) => c.userId)).toEqual([A]);
  });
});

describe('section 78/21 - a shared knockout is ONE bounty, split', () => {
  it('splits a tied pot equally between every winner of it', () => {
    const out = attributeKnockout(
      {
        pots: [{ index: 0, amount: 900, eligible: [BUSTED, A, B] }],
        winners: [
          { userId: A, amount: 450, potIndex: 0 },
          { userId: B, amount: 450, potIndex: 0 },
        ],
      },
      BUSTED
    );
    expect(out.claimants).toEqual([
      { userId: A, weight: 1 },
      { userId: B, weight: 1 },
    ]);
    // ONE chest, two claims. The engine passes weights; the SQL divides the
    // single chest between them (largest remainder), so a split can never
    // draw a second chest out of the inventory.
    expect(out.claimants).toHaveLength(2);
  });

  it('equal weights even when the chop paid slightly uneven amounts', () => {
    // A 901-chip pot chopped two ways pays 451/450. Neither player knocked the
    // short stack out any harder than the other.
    const out = attributeKnockout(
      {
        pots: [{ index: 0, amount: 901, eligible: [BUSTED, A, B] }],
        winners: [
          { userId: A, amount: 451, potIndex: 0 },
          { userId: B, amount: 450, potIndex: 0 },
        ],
      },
      BUSTED
    );
    expect(out.claimants.every((c) => c.weight === 1)).toBe(true);
  });

  it('counts one player once even if they won two shares of the same pot', () => {
    // A hi-lo hand pays the same player both halves of one pot.
    const out = attributeKnockout(
      {
        pots: [{ index: 0, amount: 800, eligible: [BUSTED, A] }],
        winners: [
          { userId: A, amount: 400, potIndex: 0 },
          { userId: A, amount: 400, potIndex: 0 },
        ],
      },
      BUSTED
    );
    expect(out.claimants).toEqual([{ userId: A, weight: 1 }]);
  });
});

describe('section 78/22 - a side pot assigns the knockout to the correct winner', () => {
  it('THE BUG THIS EXISTS FOR: the side-pot winner took forty times more money and gets nothing', () => {
    // Short stack all in for 300 into a 900 main pot. Two deep stacks then
    // build a 12,000 side pot the short stack is not in.
    const hand = {
      pots: [
        { index: 0, amount: 900, eligible: [BUSTED, A, B] },
        { index: 1, amount: 12000, eligible: [A, B] },
      ],
      winners: [
        { userId: A, amount: 900, potIndex: 0 },
        { userId: B, amount: 12000, potIndex: 1 },
      ],
    };

    const out = attributeKnockout(hand, BUSTED);
    expect(out.knockerUserId).toBe(A);
    expect(out.potIndex).toBe(0);
    expect(out.basis).toBe('pot');

    // And prove the old rule really did the wrong thing, so this test fails
    // loudly rather than quietly if the sort-by-amount heuristic comes back.
    const largestWinner = [...hand.winners].sort((x, y) => y.amount - x.amount)[0];
    expect(largestWinner.userId).toBe(B);
    expect(out.knockerUserId).not.toBe(largestWinner.userId);
  });

  it('uses the LAST pot the busted player was in, not the main pot', () => {
    // Three-way: C is all in preflop for the least, BUSTED is all in on the
    // turn for more. BUSTED's final chips are in pot 1, not pot 0.
    const out = attributeKnockout(
      {
        pots: [
          { index: 0, amount: 300, eligible: [C, BUSTED, A] },
          { index: 1, amount: 1200, eligible: [BUSTED, A] },
          { index: 2, amount: 4000, eligible: [A] },
        ],
        winners: [
          { userId: C, amount: 300, potIndex: 0 },
          { userId: A, amount: 1200, potIndex: 1 },
          { userId: A, amount: 4000, potIndex: 2 },
        ],
      },
      BUSTED
    );
    expect(out.potIndex).toBe(1);
    expect(out.knockerUserId).toBe(A);
    expect(out.claimants).toEqual([{ userId: A, weight: 1 }]);
  });

  it('lastPotForPlayer prefers the declared index over array position', () => {
    expect(
      lastPotForPlayer(
        [
          { index: 2, amount: 10, eligible: [BUSTED] },
          { index: 0, amount: 10, eligible: [BUSTED] },
        ],
        BUSTED
      )
    ).toBe(2);
  });

  it('falls back to array position when no index is stored', () => {
    expect(
      lastPotForPlayer(
        [
          { amount: 10, eligible: [BUSTED, A] },
          { amount: 10, eligible: [BUSTED, A] },
          { amount: 10, eligible: [A] },
        ],
        BUSTED
      )
    ).toBe(1);
  });

  it('accepts the engine-memory alias eligiblePlayers', () => {
    const out = attributeKnockout(
      {
        pots: [{ amount: 900, eligiblePlayers: [BUSTED, A] }],
        winners: [{ userId: A, amount: 900, potIndex: 0 }],
      },
      BUSTED
    );
    expect(out.knockerUserId).toBe(A);
    expect(out.basis).toBe('pot');
  });
});

describe('side-pot edge cases that must not strand a chest', () => {
  it('walks down to a lower pot when the busted player won their own last pot', () => {
    const out = attributeKnockout(
      {
        pots: [
          { index: 0, amount: 900, eligible: [BUSTED, A] },
          { index: 1, amount: 500, eligible: [BUSTED, A] },
        ],
        winners: [
          { userId: A, amount: 900, potIndex: 0 },
          { userId: BUSTED, amount: 500, potIndex: 1 },
        ],
      },
      BUSTED
    );
    expect(out.potIndex).toBe(0);
    expect(out.knockerUserId).toBe(A);
    expect(out.basis).toBe('pot_fallback');
  });

  it('falls back to the legacy heuristic on a row written before the pots column', () => {
    const out = attributeKnockout(
      {
        winners: [
          { userId: B, amount: 12000, potIndex: 1 },
          { userId: A, amount: 900, potIndex: 0 },
        ],
      },
      BUSTED
    );
    expect(out.basis).toBe('largest_winner');
    expect(out.knockerUserId).toBe(B);
    // Legacy weights are amounts, exactly as the pre-2026-08-25 code passed
    // them, so re-sweeping an old tournament splits a chest the same way it
    // would have then.
    expect(out.claimants).toEqual([
      { userId: B, weight: 12000 },
      { userId: A, weight: 900 },
    ]);
  });

  it('falls back when the busted player is in none of the stored pots', () => {
    const out = attributeKnockout(
      {
        pots: [{ index: 0, amount: 900, eligible: [A, B] }],
        winners: [{ userId: A, amount: 900, potIndex: 0 }],
      },
      BUSTED
    );
    expect(out.basis).toBe('largest_winner');
    expect(out.knockerUserId).toBe(A);
  });

  it('attributes nothing when the hand has no winners at all', () => {
    expect(attributeKnockout({ winners: [] }, BUSTED).basis).toBe('none');
    expect(attributeKnockout(null, BUSTED).basis).toBe('none');
    expect(attributeKnockout({ winners: [{ userId: BUSTED, amount: 5 }] }, BUSTED).basis).toBe(
      'none'
    );
  });

  it('attributes nothing without an eliminated player', () => {
    expect(attributeKnockout({ winners: [{ userId: A, amount: 5 }] }, '').basis).toBe('none');
  });
});
