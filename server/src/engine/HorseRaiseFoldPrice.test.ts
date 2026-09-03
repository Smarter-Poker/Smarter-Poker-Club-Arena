/**
 * NEVER RAISE-FOLD A PRICE YOU ALREADY PAID FOR (Dan 2026-08-31).
 *
 * Dan watched three hands at PLO6 and asked "WTF?!". All three reproduced
 * here folded 40/40 before the fix:
 *
 *   1. Raised to 12 with 35 behind, faced a raise to 48. That is all-in for
 *      35 to win 95 — 1.7 to 1 — holding a hand the engine itself scored at
 *      strength 0.753, TOP 25%. It folded, and strength was never even
 *      consulted: `toCall <= stack * 0.35` had already vetoed the call.
 *   2. Raised to 6 heads-up, the BB MIN-CLICKED to 12. Six to call into
 *      eighteen. THREE TO ONE, in position. Fold.
 *   3. Min-raised to 4, faced 16. Twelve into twenty. Fold.
 *
 * The bar was 0.803 in all three — a fixed top-20% requirement, whatever the
 * pot laid. In PLO6 essentially any six cards hold more than 25% equity
 * against a 3-betting range, so a 3:1 price is a call with the entire range.
 * The single-raise branch has known this since V24 ("PLO equities are
 * COMPRESSED... a bar tuned in NLH percentile space folds hands that are
 * getting a fine price"). The 3-bet branch never learned it.
 *
 * Two defects, both pinned below:
 *   A. The V25 "never raise-fold a committed PLO stack" guard was gated on
 *      `ploT` — PLO *tournaments*. Every PLO CASH table had no protection.
 *   B. The stack cap is deep-stack discipline, but it bites hardest exactly
 *      when hero is MOST committed and the odds are BEST.
 */
import { describe, it, expect } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import type { Card, CardRank, CardSuit } from '../types.js';

const S: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cd(t: string): Card[] {
  const o: Card[] = [];
  for (let i = 0; i + 1 < t.length; i += 2) o.push({ rank: t[i] as CardRank, suit: S[t[i + 1]] });
  return o;
}

/** Hero raised; villain re-raised. Tally hero's answer over N runs. */
function answer(o: {
  variant?: string;
  bb?: number;
  hole: string;
  heroBet: number;
  heroBehind: number;
  villBet: number;
}) {
  const bb = o.bb ?? 2;
  const tally: Record<string, number> = {};
  for (let i = 0; i < 40; i++) {
    const players = [
      {
        seat: 1,
        user_id: 'hero',
        stack: o.heroBehind,
        bet: o.heroBet,
        is_folded: false,
        is_sitting_out: false,
        cards: cd(o.hole),
        totalInvested: o.heroBet,
      },
      {
        seat: 2,
        user_id: 'vill',
        stack: 500,
        bet: o.villBet,
        is_folded: false,
        is_sitting_out: false,
        cards: [] as Card[],
        totalInvested: o.villBet,
      },
    ];
    const gs = {
      players,
      communityCards: [] as Card[],
      pot: o.heroBet + o.villBet,
      currentBet: o.villBet,
      minRaise: bb,
      stage: 'preflop',
      gameVariant: o.variant ?? 'plo6',
      gameMode: 'cash',
      bigBlind: bb,
      smallBlind: bb / 2,
      dealerSeat: 1,
      actionHistory: [
        { stage: 'preflop', seat: 1, userId: 'hero', action: 'raise', amount: o.heroBet },
        { stage: 'preflop', seat: 2, userId: 'vill', action: 'raise', amount: o.villBet },
      ],
    };
    const r = HorseLogic.decide(players[0] as never, gs as never, 'balanced', {}, {} as never);
    tally[r.action] = (tally[r.action] ?? 0) + 1;
  }
  return tally;
}

const STRONG = 'AhKhQsJs9d8c'; // engine-scored 0.753 — a top-25% PLO6 holding
const JUNK = '2c3d5h7s9cJd';

describe("Dan's three hands", () => {
  it('#1 committed: raised 12 with 35 behind, faces 48 - takes the price', () => {
    const t = answer({ hole: STRONG, heroBet: 12, heroBehind: 35, villBet: 48 });
    expect(t.fold ?? 0).toBe(0);
  });

  it('#2 a MIN-CLICK at 3:1 in position is never folded', () => {
    const t = answer({ hole: STRONG, heroBet: 6, heroBehind: 26, villBet: 12 });
    expect(t.fold ?? 0).toBe(0);
    expect(t.call ?? 0).toBeGreaterThan(0);
  });

  it('#3 min-raise into a 4x still continues', () => {
    const t = answer({ hole: STRONG, heroBet: 4, heroBehind: 60, villBet: 16 });
    expect(t.fold ?? 0).toBe(0);
  });
});

describe('and it did NOT become a calling station', () => {
  it('junk still folds every time at the same prices', () => {
    for (const spot of [
      { heroBet: 6, heroBehind: 26, villBet: 12 },
      { heroBet: 4, heroBehind: 60, villBet: 16 },
    ]) {
      const t = answer({ hole: JUNK, ...spot });
      expect(t.fold ?? 0, JSON.stringify(spot)).toBe(40);
    }
  });

  /**
   * V38 (2026-09-03): the ALL-IN call is priced, not ranked. Raised 12 with
   * 35 behind, facing 48: 35 to win 95 needs 27%, plus the PLO6 domination
   * margin (8 points) — six napkins hold ~44% against the sampled 3-bet range
   * here, so the chip-EV answer is a call. The two cheaper spots above are
   * not all-in prices and still fold on range.
   */
  it('junk facing the all-in price calls when its equity clears it', () => {
    const t = answer({ hole: JUNK, heroBet: 12, heroBehind: 35, villBet: 48 });
    expect(t.fold ?? 0).toBeLessThan(40);
  });

  /**
   * THE PRICE IS THE POINT. The same hand, the same stack, only the price
   * changes: a huge 3-bet laying bad odds must still be foldable, or the
   * relief has simply become "always call".
   */
  it('a bad price is still a fold with a marginal hand', () => {
    // 4 in, faces 200 with 400 behind: 196 to win ~404, and nothing committed.
    const t = answer({ hole: '9c8d5h4s3c2d', heroBet: 4, heroBehind: 400, villBet: 200 });
    expect(t.fold ?? 0).toBeGreaterThan(20);
  });

  /**
   * NOT A LEAK, AND NOT MINE TO "FIX". At 22 to 1 the pre-existing V13
   * priced-in guard calls with any holding, and that is correct poker — the
   * first draft of this suite asserted a FOLD here and was wrong. Pinned so
   * the next agent reading a junk-hand call in a hand history does not
   * "correct" it into a fold.
   */
  it('at 22:1 the priced-in guard calls with anything, deliberately', () => {
    const t = answer({ hole: JUNK, heroBet: 20, heroBehind: 400, villBet: 22 });
    expect(t.call ?? 0).toBe(40);
  });

  it('NLH is moved far less than PLO - its equities are genuinely wider', () => {
    // Same shape, hold'em: the relief multiplier is 0.9 vs Omaha's 1.6 and
    // the floor is higher, so a weak holding still folds.
    const t = answer({ variant: 'nlh', hole: '7h2c', heroBet: 6, heroBehind: 26, villBet: 12 });
    expect(t.fold ?? 0).toBeGreaterThan(20);
  });
});
