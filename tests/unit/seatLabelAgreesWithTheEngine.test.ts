/**
 * THE SEAT LABEL AND THE SHOWDOWN NAME ARE THE SAME HAND (Dan 2026-10-25).
 *
 * Two evaluators name a hand on the felt. The engine's (server/src/engine/
 * PokerEngine.ts) decides the pot and names the winner at showdown; the
 * client's (src/utils/handEvaluator.ts) names the hero's live hand under the
 * seat. The client's was ported from the engine's, and the header there says
 * two that disagree "would show a player a hand that lost the money". Nothing
 * ever checked that they agree. This does, on thousands of seeded random deals
 * across every board game the platform runs, with the engine fed its own
 * spelling (word suits) and the client fed the table's (letter suits), so a
 * spelling split like the one behind the Kc Jc "Straight" label fails here too.
 */
import { describe, it, expect } from 'vitest';
import { bestFive, bestLow } from '../../src/utils/handEvaluator';
import {
  evaluateHand,
  evaluateOmahaHand,
  evaluateOmahaLowHand,
} from '../../server/src/engine/PokerEngine';

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SHORT_RANKS = ['6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'] as const;
const LETTER: Record<string, string> = { hearts: 'h', diamonds: 'd', clubs: 'c', spades: 's' };

/** Small seeded generator so a failure names a reproducible deal. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function deal(seed: number, holeCount: number, boardCount: number, ranks: string[]) {
  const deck = ranks.flatMap((rank) => SUITS.map((suit) => ({ rank, suit })));
  const r = rng(seed);
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return { hole: deck.slice(0, holeCount), board: deck.slice(holeCount, holeCount + boardCount) };
}

const asTable = (cards: { rank: string; suit: string }[]) =>
  cards.map((c) => ({ rank: c.rank, suit: LETTER[c.suit] })) as any[];

const GAMES: { variant: string; hole: number; omaha: boolean; ranks: string[] }[] = [
  { variant: 'nlh', hole: 2, omaha: false, ranks: RANKS },
  { variant: 'plo4', hole: 4, omaha: true, ranks: RANKS },
  { variant: 'plo5', hole: 5, omaha: true, ranks: RANKS },
  { variant: 'plo6', hole: 6, omaha: true, ranks: RANKS },
];

describe('the seat label names the same hand the engine pays', () => {
  for (const g of GAMES) {
    for (const boardCount of [3, 4, 5]) {
      it(`${g.variant}, ${boardCount}-card board`, () => {
        const deals = g.hole >= 5 ? 400 : 1500;
        const mismatches: string[] = [];
        for (let seed = 1; seed <= deals; seed += 1) {
          const { hole, board } = deal(seed * 7919 + boardCount, g.hole, boardCount, g.ranks);
          const engine = g.omaha
            ? evaluateOmahaHand(hole as any, board as any)
            : evaluateHand(hole as any, board as any);
          /* Hole cards in the table's letters, the board in the engine's
             words - the exact split that hid the Kc Jc flush. */
          const seat = bestFive(asTable(hole), board as any[], g.variant);
          if (engine.name !== seat?.name && mismatches.length < 5) {
            const show = (cs: typeof hole) => cs.map((c) => c.rank + LETTER[c.suit]).join(' ');
            mismatches.push(
              `seed ${seed}: ${show(hole)} | ${show(board)} engine=${engine.name} seat=${seat?.name}`
            );
          }
        }
        expect(mismatches).toEqual([]);
      });
    }
  }
});

/* The seat label shows the low half in hi-lo games (src/lib/heroHandLabel.ts),
   so the low it names must be the low the engine pays. */
describe('the seat label names the same low the engine pays', () => {
  for (const boardCount of [3, 4, 5]) {
    it(`plo8, ${boardCount}-card board`, () => {
      const mismatches: string[] = [];
      for (let seed = 1; seed <= 1500; seed += 1) {
        const { hole, board } = deal(seed * 104729 + boardCount, 4, boardCount, RANKS);
        const engine = evaluateOmahaLowHand(hole as any, board as any);
        const seat = bestLow(asTable(hole), board as any[]);
        const e = engine ? engine.name : null;
        const t = seat ? seat.name : null;
        if (e !== t && mismatches.length < 5)
          mismatches.push(`seed ${seed}: engine=${e} seat=${t}`);
      }
      expect(mismatches).toEqual([]);
    });
  }
});

/* SHORT DECK (Dan 2026-10-25, item 4). A 36-card deck reorders the hands - a
   flush beats a full house and A-6-7-8-9 is the low straight - so the seat
   label and the engine must agree on Short Deck too, not only on the rank
   swap the dedicated suite pins. The engine takes the shortDeck flag; the seat
   reads it from the variant. ~50k Short Deck hands are dealt a day. */
describe('the seat label names the same Short Deck hand the engine pays', () => {
  for (const boardCount of [3, 4, 5]) {
    it(`short_deck, ${boardCount}-card board`, () => {
      const mismatches: string[] = [];
      for (let seed = 1; seed <= 2000; seed += 1) {
        const { hole, board } = deal(seed * 15485863 + boardCount, 2, boardCount, SHORT_RANKS);
        const engine = evaluateHand(hole as any, board as any, true);
        const seat = bestFive(asTable(hole), board as any[], 'short_deck');
        if (engine.name !== seat?.name && mismatches.length < 5) {
          const show = (cs: typeof hole) => cs.map((c) => c.rank + LETTER[c.suit]).join(' ');
          mismatches.push(
            `seed ${seed}: ${show(hole)} | ${show(board)} engine=${engine.name} seat=${seat?.name}`
          );
        }
      }
      expect(mismatches).toEqual([]);
    });
  }
});
