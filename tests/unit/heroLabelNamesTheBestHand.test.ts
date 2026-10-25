/**
 * THE LABEL UNDER THE HERO'S SEAT NAMES THE BEST HAND THEY HOLD (Dan 2026-10-25).
 *
 * Dan, from a player's screenshot: "IT SAYS HE HAS A STRAIGHT, WHICH HE DOES,
 * BUT THE BETTER HAND HE HAS IS A FLUSH, IT MUST 100% OF THE TIME DISPLAY THE
 * BEST CURRENT HAND THAT THE USER HAS."
 *
 * Cause: the hero's hole cards spell suits as letters ('c', via
 * ENGINE_SUIT_MAP) and the board spells them as words ('clubs', via
 * normalizeCards). The evaluator compared spellings, so a flush made with any
 * hole card was never seen. These cases feed the exact mixed shapes the table
 * feeds it.
 */
import { describe, it, expect } from 'vitest';
import { bestFive } from '../../src/utils/handEvaluator';
import { normalizeCards } from '../../src/utils/tableGeometry';
import { ENGINE_SUIT_MAP } from '../../src/lib/tableCardDisplay';

const WORD: Record<string, string> = { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' };

/** Hole cards the way table_hole_cards delivers them to the hero. */
const heroHole = (codes: string[]) =>
  codes.map((x) => ({ rank: x[0], suit: ENGINE_SUIT_MAP[WORD[x[1]]] })) as any[];
/** Board the way the snapshot delivers it to the felt. */
const board = (codes: string[]) =>
  normalizeCards(codes.map((x) => ({ rank: x[0] === 'T' ? '10' : x[0], suit: WORD[x[1]] }))) as any[];

describe('hero hand label names the best hand', () => {
  it('the reported PLO5 hand: Kc Jc on 8d 9c 8c Tc is a Flush, not a Straight', () => {
    const best = bestFive(heroHole(['Ks', 'Kc', 'Qs', 'Jc', '3d']), board(['8d', '9c', '8c', 'Tc']), 'plo5');
    expect(best?.name).toBe('Flush');
  });

  it("Hold'em flush using both hole cards is seen", () => {
    const best = bestFive(heroHole(['Ah', '2h']), board(['7h', '9h', 'Kh', '9c', '4d']), 'nlh');
    expect(best?.name).toBe('Flush');
  });

  it('straight flush through mixed spellings is seen', () => {
    const best = bestFive(heroHole(['Jc', 'Qc', '2d', '3s']), board(['Tc', '9c', '8c']), 'plo4');
    expect(best?.name).toBe('Straight Flush');
  });

  it('Omaha still refuses a flush from only one suited hole card', () => {
    const best = bestFive(heroHole(['Ac', 'Kd', 'Qs', 'Jh']), board(['2c', '5c', '9c', 'Tc']), 'plo4');
    expect(best?.name).not.toBe('Flush');
  });
});
