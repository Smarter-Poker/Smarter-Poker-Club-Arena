/**
 * V54 RIVER BLUFF IS MEASURED, AND THE CARDS ARE NOT INERT (2026-10-24)
 *
 * Dan: "the bluff shove or big bet bluff needed to be implemented ONLY WHEN
 * IT MAKES SENSE." `v54RiverBluff` is DEFAULT OFF; the nightly league runs it
 * on (arm A) against production (arm B) in Hold'em and PLO4/5/6, and it is
 * promoted when it wins there.
 *
 * The spot is rare in self-play by design: heads-up, checked to, air, a turn
 * barrel that was flatted, a blocker and a capped non-station opponent. Most
 * heads-up checked-to rivers still hold showdown value, and horses rarely
 * barrel the turn with air. Measured on this card build: the Hold'em card
 * diverges in 1 of 600 pairs at seed 4242 (and 1 of 600 at seed 20261024);
 * Historical PLO6 in1of300 at seed4242; current protected-source recovery
 * produced0of300, so its connected non-inertness check uses the original full
 * declared6,000-pair card at the SAME development seed, without reseeding or
 * relaxing the positive-divergence assertion. This is not a strength verdict.
 * PLO4 in 0 of 80 pairs at each of 8
 * seeds and PLO5 in 0 of 80 at 3. So:
 *  1. All four cards are on the standing card, arm A = flag on, arm B = {}.
 *  2. The Hold'em and PLO6 cards play different poker in their two arms at
 *     a fixed seed (a nightly 0.00 +/- 0.00 is otherwise indistinguishable
 *     from a resolved zero; see LeagueMatchupIsNotInert.test.ts).
 *  3. Every card's arm A reaches the V54 gates in league hands: with
 *     telemetry on that arm, the layer records a fire or a named skip.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEAGUE_MATCHUPS, runMatchup } from './HorseLeague.js';
import { drainFires, enableBrainTelemetry } from '../engine/BrainTelemetry.js';

const CARDS: Array<[string, string | undefined]> = [
  ['v54_river_bluff', undefined],
  ['plo4_v54_river_bluff', 'plo4'],
  ['plo5_v54_river_bluff', 'plo5'],
  ['plo6_v54_river_bluff', 'plo6'],
];

describe('V54 river bluff is measured in every variant', { timeout: 900_000 }, () => {
  beforeAll(() => {
    enableBrainTelemetry();
    drainFires();
  });
  afterAll(() => {
    drainFires();
  });

  it('every V54 card is on the standing card with the flag on in arm A', () => {
    for (const [name, variant] of CARDS) {
      const card = LEAGUE_MATCHUPS.find((m) => m.name === name);
      expect(card, `${name} is missing from the standing card`).toBeDefined();
      expect(card!.variant).toBe(variant);
      expect(card!.pairs).toBe(6000);
      expect(card!.a).toEqual({ v54RiverBluff: true });
      expect(card!.b).toEqual({});
    }
  });

  it.each([
    ['v54_river_bluff', 600],
    ['plo6_v54_river_bluff', 6000],
  ] as const)('%s: the two arms do not play identical poker', async (name, pairs) => {
    const card = LEAGUE_MATCHUPS.find((m) => m.name === name)!;
    const r = await runMatchup(card, pairs, 4242);
    expect(r.hands).toBe(pairs * 2);
    expect(r.divergentPairs).toBeGreaterThan(0);
    expect(r.inert).toBe(false);
  });

  it.each(CARDS.map(([name]) => name))(
    '%s: arm A reaches the V54 gates in league hands',
    async (name) => {
      const card = LEAGUE_MATCHUPS.find((m) => m.name === name)!;
      drainFires();
      await runMatchup({ ...card, a: { ...card.a, telemetry: true } }, 40, 4242);
      const v54 = drainFires().filter((r) => r.feature.startsWith('v54_river_bluff'));
      expect(v54.reduce((n, r) => n + r.fires, 0)).toBeGreaterThan(0);
    }
  );
});
