import { describe, it, expect } from 'vitest';
import { detectMiniBBJHit, BBJ_QUALIFYING_HANDS } from './RakeConfig.js';

const P = (id: string, ranking: number, kickers: number[]) => ({
  userId: id,
  handRanking: ranking,
  handName: 'x',
  kickers,
  holeCards: [
    { rank: 'A', suit: 's' },
    { rank: 'K', suit: 'h' },
  ],
});
const QUADS = 8; // HAND_RANK.FOUR_OF_A_KIND
const hit = (variant: string, loserQuad: number) =>
  detectMiniBBJHit(
    [P('L', QUADS, [loserQuad, 5]), P('W', QUADS, [14, 5])],
    'W',
    variant,
    10_000,
    1,
    6,
    ['L', 'W']
  );

describe("Dan's mini bars", () => {
  it('plo5 config is Quad Tens', () => {
    expect(BBJ_QUALIFYING_HANDS.plo5.miniMinQuadRank).toBe(10);
    expect(BBJ_QUALIFYING_HANDS.plo5.miniBarLabel).toBe('Quad Tens Or Better');
  });
  it('pineapple config is Quad Deuces', () => {
    expect(BBJ_QUALIFYING_HANDS.pineapple.miniMinQuadRank).toBe(2);
  });
  it('PLO5: quad nines does NOT pay the mini', () => expect(hit('plo5', 9).hit).toBe(false));
  it('PLO5: quad tens DOES pay the mini', () => {
    const r = hit('plo5', 10);
    expect(r.hit).toBe(true);
    expect(r.qualifyingHandLabel).toBe('Quad Tens Or Better');
    expect(r.miniRule).toBe('ranked_quads');
  });
  it('PLO5: quad aces pays', () => expect(hit('plo5', 14).hit).toBe(true));
  it('FLO5 resolves to the same bar as PLO5', () => {
    expect(hit('flo5', 9).hit).toBe(false);
    expect(hit('flo5', 10).hit).toBe(true);
  });
  it('Pineapple: quad deuces pays', () => {
    const r = hit('pineapple', 2);
    expect(r.hit).toBe(true);
    expect(r.qualifyingHandLabel).toBe('Quad Deuces Or Better');
  });
  it('PLO4 is untouched - any quads still pay', () => {
    expect(hit('plo4', 2).hit).toBe(true);
    expect(hit('plo4', 2).miniRule).toBe('plo_quads');
  });
  it("NLH is untouched - still the hold'em bar", () => {
    expect(hit('nlh', 2).miniRule).toBe('holdem_aces_full');
  });
});

/* ── WHAT THE TIGHTENED BAR TURNS AWAY ──────────────────────────────────────
   Dan's PLO5 bar is Quad Tens. The hand it now refuses is quads BELOW that -
   quad nines losing to quad aces - which paid the mini the day before. Without
   a near-miss row the cost of the new bar is unmeasurable, which is the hole
   bbj_near_misses exists to close. */
import { detectMiniBBJNearMiss } from './RakeConfig.js';

const near = (variant: string, loserRank: number, loserQuads = true) =>
  detectMiniBBJNearMiss(
    [
      {
        userId: 'L',
        handRanking: loserQuads ? QUADS : 3,
        handName: 'loser',
        kickers: [loserRank, 5],
        holeCards: [],
      },
      { userId: 'W', handRanking: QUADS, handName: 'winner', kickers: [14, 5], holeCards: [] },
    ],
    'W',
    variant,
    10_000,
    1,
    6
  );

describe('the tightened PLO5 bar is visible, not silent', () => {
  it('quad nines under the Quad Tens bar is a near miss, and names the bar', () => {
    const r = near('plo5', 9);
    expect(r.nearMiss).toBe(true);
    expect(r.reason).toBe('mini_loser_below_bar');
    expect(r.message).toContain('Quad Tens Or Better');
  });

  it('an ORDINARY hand under the bar is still not a near miss', () => {
    expect(near('plo5', 9, false).nearMiss).toBe(false);
  });

  it('a variant with no ranked bar is unchanged - PLO4 stays silent', () => {
    expect(near('plo4', 9).nearMiss).toBe(false);
  });

  it('FLO5 behaves like PLO5 here too', () => {
    expect(near('flo5', 9).reason).toBe('mini_loser_below_bar');
  });
});
