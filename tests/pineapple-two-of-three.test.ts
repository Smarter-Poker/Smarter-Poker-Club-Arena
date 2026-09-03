/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CRAZY PINEAPPLE: THE HAND YOU CAN KEEP, NOT THE CARDS YOU ARE HOLDING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The hero's hand-strength label under their seat, and every other caller of
 * `bestFive`, took ANY FIVE of hole plus board whenever the variant was not
 * Omaha. In Crazy Pineapple the hero holds THREE cards from the deal until the
 * discard closes, and the discard comes AFTER the flop - so for the whole
 * window in which that label matters most, it was naming hands that cannot
 * survive the throw.
 *
 * 9h 9d 9s on an A-K-2 flop read "Three of a Kind". One of those nines is
 * leaving; the player has a pair. The label was telling them to keep a hand
 * they cannot have, at the exact moment they were choosing what to throw.
 *
 * The rule pinned here is the server's own, from
 * `server/src/engine/pineappleDiscardChoice.ts`: "after the discard the hand
 * plays exactly like holdem" with the two cards you kept. So the honest
 * strength is the best over the three ways to keep two - never more than two
 * hole cards, and no fewer allowed than Hold'em allows.
 *
 * Handoff §4 listed this as found-and-triaged but in no phase. It is the last
 * pineapple item from that list that is a defect rather than a config row.
 */
import { describe, it, expect } from 'vitest';
import { bestFive, isPineappleVariant } from '../src/utils/handEvaluator';

type C = { rank: string; suit: string };
const c = (code: string): C => ({ rank: code[0], suit: code[1] });
const cards = (s: string): C[] => s.split(' ').map(c);

describe('a pineapple holding is scored on the two cards that survive', () => {
  it('never names a hand that needs all three hole cards', () => {
    const hole = cards('9h 9d 9s');
    const board = cards('Ac Kd 2h');

    // What the old code did, and still does for a variant that really is
    // "any five of seven" - this is the control, not the bug.
    expect(bestFive(hole, board, 'nlh')?.name).toBe('Three of a Kind');

    // What Crazy Pineapple can actually hold.
    expect(bestFive(hole, board, 'pineapple')?.name).toBe('Pair');
    expect(bestFive(hole, board, 'Crazy Pineapple')?.name).toBe('Pair');
  });

  it('still finds the best hand the two kept cards CAN make', () => {
    /* Keeping Ah Ad pairs the board's ace into trips; keeping either ace with
       the 2c is one pair. The rule is not a blunt cap on the category - it
       picks the best of the three surviving hands, which is the decision the
       player is being asked to make. */
    const hole = cards('Ah Ad 2c');
    const board = cards('As Kd 7h');
    expect(bestFive(hole, board, 'pineapple')?.name).toBe('Three of a Kind');
  });

  it('lets a flush through when the two kept cards make it', () => {
    const hole = cards('Ah Kh 2c');
    const board = cards('7h 8h 3h');
    expect(bestFive(hole, board, 'pineapple')?.name).toBe('Flush');
  });

  it('is a no-op once the discard is done and two cards remain', () => {
    /* The same call runs at showdown, where a pineapple player holds two like
       everybody else. Nothing about that path may change. */
    const hole = cards('9h 9d');
    const board = cards('9s Kd 2h');
    expect(bestFive(hole, board, 'pineapple')?.name).toBe('Three of a Kind');
    expect(bestFive(hole, board, 'nlh')?.name).toBe('Three of a Kind');
  });

  it('returns null rather than guessing before the flop', () => {
    // Three cards and no board is not five cards. A partial guess drawn as a
    // definite hand is worse than drawing nothing (bestFive's own rule).
    expect(bestFive(cards('9h 9d 9s'), [], 'pineapple')).toBeNull();
  });

  it("does not change Omaha, Hold'em or short deck", () => {
    const hole = cards('Qh Jh 2c 3d');
    const board = cards('Th 9h 8h');
    // Omaha's exactly-two rule still applies and still wins the branch.
    expect(bestFive(hole, board, 'plo4')?.name).toBe('Straight Flush');
    expect(isPineappleVariant('plo4')).toBe(false);
    expect(isPineappleVariant('nlh')).toBe(false);
    expect(isPineappleVariant('short_deck')).toBe(false);
  });

  it('excludes OFC by name, which shares the word and none of the rules', () => {
    expect(isPineappleVariant('ofc_pineapple')).toBe(false);
    expect(isPineappleVariant('ofc')).toBe(false);
    expect(isPineappleVariant('pineapple')).toBe(true);
    expect(isPineappleVariant('Crazy Pineapple')).toBe(true);
  });
});
