/**
 * Phase 6B arithmetic checks: the ante orbit under each of the three ante
 * modes at every depth anchor, and every M zone boundary with its half-M
 * hysteresis under each ante mode, all driven through `buildTournamentMState`
 * (the M state the worker and HorseLogic consume), never through
 * `tournamentMZone` alone.
 *
 * Expected values are literal. They were derived by hand from the documented
 * conventions in `AnteMath.ts` (per-player ante times the dealt census; a big
 * blind ante authored at or above one big blind is the whole table's total,
 * capped at two big blinds) and `HorseTournamentPreflop.ts` (real M is stack
 * over one orbit; effective M scales by dealt players over ten; zones open at
 * M 1, 5, 10, 20 and 40 with a half-M deadband on the boundary being crossed).
 * The policy under test never produced its own oracle here.
 */
import { describe, expect, it } from 'vitest';

import { anteOrbitCostBB, bigBlindAnteTotal } from './AnteMath.js';
import {
  TOURNAMENT_ANTE_TYPES,
  TOURNAMENT_CORE_DEPTHS,
  TOURNAMENT_M_HYSTERESIS,
  TOURNAMENT_M_ZONES,
  TOURNAMENT_M_ZONE_BOUNDARIES,
  TOURNAMENT_PREFLOP_ATLAS_DOMAIN,
  buildTournamentMState,
  type TournamentAnteType,
  type TournamentMZone,
} from './HorseTournamentPreflop.js';

const BB = 100;
const SB = 50;

/** Nine dealt: blinds 150; per-player ante 10 adds 90; a big blind ante authored as the
 * total (100, at least one BB) adds exactly 100 and is not multiplied by the seats. */
const NINE_HANDED = {
  none: { ante: 0, orbit: 150 },
  per_player: { ante: 10, orbit: 240 },
  big_blind: { ante: 100, orbit: 250 },
} as const satisfies Record<TournamentAnteType, { ante: number; orbit: number }>;

/** Literal (anchor, mode) rows: real M = anchor x 100 / orbit; effective = real x 0.9. */
const ANCHOR_ROWS: ReadonlyArray<
  [
    anchor: number,
    mode: TournamentAnteType,
    realM: number,
    effectiveM: number,
    zone: TournamentMZone,
  ]
> = [
  [2, 'none', 1.333333, 1.2, 'red'],
  [2, 'per_player', 0.833333, 0.75, 'dead'],
  [2, 'big_blind', 0.8, 0.72, 'dead'],
  [3, 'none', 2, 1.8, 'red'],
  [3, 'per_player', 1.25, 1.125, 'red'],
  [3, 'big_blind', 1.2, 1.08, 'red'],
  [4, 'none', 2.666667, 2.4, 'red'],
  [4, 'per_player', 1.666667, 1.5, 'red'],
  [4, 'big_blind', 1.6, 1.44, 'red'],
  [5, 'none', 3.333333, 3, 'red'],
  [5, 'per_player', 2.083333, 1.875, 'red'],
  [5, 'big_blind', 2, 1.8, 'red'],
  [6, 'none', 4, 3.6, 'red'],
  [6, 'per_player', 2.5, 2.25, 'red'],
  [6, 'big_blind', 2.4, 2.16, 'red'],
  [8, 'none', 5.333333, 4.8, 'red'],
  [8, 'per_player', 3.333333, 3, 'red'],
  [8, 'big_blind', 3.2, 2.88, 'red'],
  [10, 'none', 6.666667, 6, 'orange'],
  [10, 'per_player', 4.166667, 3.75, 'red'],
  [10, 'big_blind', 4, 3.6, 'red'],
  [12, 'none', 8, 7.2, 'orange'],
  [12, 'per_player', 5, 4.5, 'red'],
  [12, 'big_blind', 4.8, 4.32, 'red'],
  [15, 'none', 10, 9, 'orange'],
  [15, 'per_player', 6.25, 5.625, 'orange'],
  [15, 'big_blind', 6, 5.4, 'orange'],
  [18, 'none', 12, 10.8, 'yellow'],
  [18, 'per_player', 7.5, 6.75, 'orange'],
  [18, 'big_blind', 7.2, 6.48, 'orange'],
  [20, 'none', 13.333333, 12, 'yellow'],
  [20, 'per_player', 8.333333, 7.5, 'orange'],
  [20, 'big_blind', 8, 7.2, 'orange'],
  [25, 'none', 16.666667, 15, 'yellow'],
  [25, 'per_player', 10.416667, 9.375, 'orange'],
  [25, 'big_blind', 10, 9, 'orange'],
  [30, 'none', 20, 18, 'yellow'],
  [30, 'per_player', 12.5, 11.25, 'yellow'],
  [30, 'big_blind', 12, 10.8, 'yellow'],
  [40, 'none', 26.666667, 24, 'green'],
  [40, 'per_player', 16.666667, 15, 'yellow'],
  [40, 'big_blind', 16, 14.4, 'yellow'],
  [60, 'none', 40, 36, 'green'],
  [60, 'per_player', 25, 22.5, 'green'],
  [60, 'big_blind', 24, 21.6, 'green'],
  [80, 'none', 53.333333, 48, 'blue'],
  [80, 'per_player', 33.333333, 30, 'green'],
  [80, 'big_blind', 32, 28.8, 'green'],
  [100, 'none', 66.666667, 60, 'blue'],
  [100, 'per_player', 41.666667, 37.5, 'green'],
  [100, 'big_blind', 40, 36, 'green'],
];

describe('Phase 6B ante arithmetic at every depth anchor under each ante mode', () => {
  it('covers every anchor of the domain under every ante type, and nothing else', () => {
    const covered = new Set(ANCHOR_ROWS.map(([anchor, mode]) => `${anchor}:${mode}`));
    expect(covered.size).toBe(ANCHOR_ROWS.length);
    expect(covered.size).toBe(TOURNAMENT_CORE_DEPTHS.length * TOURNAMENT_ANTE_TYPES.length);
    for (const anchor of TOURNAMENT_PREFLOP_ATLAS_DOMAIN.depth.anchorsBB) {
      for (const mode of TOURNAMENT_PREFLOP_ATLAS_DOMAIN.anteTypes) {
        expect(covered.has(`${anchor}:${mode}`)).toBe(true);
      }
    }
  });

  it.each(ANCHOR_ROWS)(
    'a %sbb stack under the %s ante has real M %s, effective M %s and sits in the %s zone',
    (anchor, mode, realM, effectiveM, zone) => {
      const { ante, orbit } = NINE_HANDED[mode];
      const m = buildTournamentMState({
        stackChips: anchor * BB,
        smallBlind: SB,
        bigBlind: BB,
        ante,
        anteType: mode,
        playersAtTable: 9,
      });
      expect(m.orbitCostChips).toBe(orbit);
      expect(m.realM).toBeCloseTo(realM, 5);
      expect(m.effectiveM).toBeCloseTo(effectiveM, 5);
      expect(m.zone).toBe(zone);
      expect(m.previousZone).toBeNull();
      // Without a next level the projection collapses onto the current level and the
      // stack in big blinds is the anchor itself, distinct from orbit M.
      expect(m.projectedOrbitCostChips).toBe(orbit);
      expect(m.projectedM).toBeCloseTo(realM, 5);
      expect(m.projectedStackBB).toBe(anchor);
      expect(m.velocityMPerMinute).toBe(0);
      // The one ante resolver both the engine and the brain call agrees with the orbit.
      const anteBB = anteOrbitCostBB(ante, 9, BB, mode === 'big_blind');
      expect((SB + BB) / BB + anteBB).toBeCloseTo(orbit / BB, 9);
    }
  );

  it('charges a per-seat-authored big blind ante like the per-player ante and caps an authored total at two big blinds', () => {
    // Authored per seat (10 < BB): the big blind fronts 10 x 9 = 90, the same orbit as
    // per-player 10 at nine seats.
    expect(bigBlindAnteTotal(10, 9, BB)).toBe(90);
    const perSeat = buildTournamentMState({
      stackChips: 20 * BB,
      smallBlind: SB,
      bigBlind: BB,
      ante: 10,
      anteType: 'big_blind',
      playersAtTable: 9,
    });
    expect(perSeat.orbitCostChips).toBe(240);
    expect(perSeat.realM).toBeCloseTo(8.333333, 5);
    // Authored as a total above the ceiling (300 at BB 100): capped at 200, orbit 350.
    expect(bigBlindAnteTotal(300, 9, BB)).toBe(200);
    const capped = buildTournamentMState({
      stackChips: 35 * BB,
      smallBlind: SB,
      bigBlind: BB,
      ante: 300,
      anteType: 'big_blind',
      playersAtTable: 9,
    });
    expect(capped.orbitCostChips).toBe(350);
    expect(capped.realM).toBe(10);
    expect(capped.effectiveM).toBe(9);
    expect(capped.zone).toBe('orange');
    // The per-player convention never sees the ceiling: 300 x 9 = 2700 an orbit.
    const perPlayer = buildTournamentMState({
      stackChips: 35 * BB,
      smallBlind: SB,
      bigBlind: BB,
      ante: 300,
      anteType: 'per_player',
      playersAtTable: 9,
    });
    expect(perPlayer.orbitCostChips).toBe(2850);
    expect(perPlayer.zone).toBe('red');
  });
});

/** Ten dealt so effective M equals real M and every boundary stack is an integer chip count:
 * blinds 150; per-player ante 10 x 10 = 100; big blind ante authored as the total 200
 * (the ceiling, exactly two big blinds). */
const TEN_HANDED = {
  none: { ante: 0, orbit: 150 },
  per_player: { ante: 10, orbit: 250 },
  big_blind: { ante: 200, orbit: 350 },
} as const satisfies Record<TournamentAnteType, { ante: number; orbit: number }>;

const BOUNDARY_ROWS: ReadonlyArray<
  [boundary: number, lower: TournamentMZone, upper: TournamentMZone]
> = [
  [1, 'dead', 'red'],
  [5, 'red', 'orange'],
  [10, 'orange', 'yellow'],
  [20, 'yellow', 'green'],
  [40, 'green', 'blue'],
];

describe('Phase 6B M zone boundaries with half-M hysteresis under each ante mode', () => {
  it('lists every boundary and adjacent zone pair of the domain', () => {
    expect(BOUNDARY_ROWS.map(([boundary]) => boundary)).toEqual([...TOURNAMENT_M_ZONE_BOUNDARIES]);
    expect(TOURNAMENT_M_HYSTERESIS).toBe(0.5);
    BOUNDARY_ROWS.forEach(([, lower, upper], index) => {
      expect(TOURNAMENT_M_ZONES[index]).toBe(lower);
      expect(TOURNAMENT_M_ZONES[index + 1]).toBe(upper);
    });
  });

  const modes = TOURNAMENT_ANTE_TYPES.flatMap((mode) =>
    BOUNDARY_ROWS.map(([boundary, lower, upper]) => [mode, boundary, lower, upper] as const)
  );

  it.each(modes)(
    'under the %s ante the M %s boundary between %s and %s holds its half-M deadband through buildTournamentMState',
    (mode, boundary, lower, upper) => {
      const { ante, orbit } = TEN_HANDED[mode];
      const at = (effectiveM: number, previousZone: TournamentMZone | null) => {
        const m = buildTournamentMState({
          stackChips: effectiveM * orbit,
          smallBlind: SB,
          bigBlind: BB,
          ante,
          anteType: mode,
          playersAtTable: 10,
          previousZone,
        });
        expect(m.orbitCostChips).toBe(orbit);
        expect(m.effectiveM).toBeCloseTo(effectiveM, 9);
        expect(m.realM).toBeCloseTo(effectiveM, 9);
        expect(m.previousZone).toBe(previousZone);
        return m.zone;
      };
      // No prior: the raw boundary opens the upper zone; a chip under it is the lower zone.
      expect(at(boundary, null)).toBe(upper);
      expect(at(boundary - 0.01, null)).toBe(lower);
      // Improving from the lower zone needs a full half M past the boundary.
      expect(at(boundary, lower)).toBe(lower);
      expect(at(boundary + 0.49, lower)).toBe(lower);
      expect(at(boundary + 0.5, lower)).toBe(upper);
      expect(at(boundary + 0.51, lower)).toBe(upper);
      // Worsening from the upper zone needs to fall strictly more than half an M below it.
      expect(at(boundary, upper)).toBe(upper);
      expect(at(boundary - 0.01, upper)).toBe(upper);
      expect(at(boundary - 0.5, upper)).toBe(upper);
      expect(at(boundary - 0.51, upper)).toBe(lower);
    }
  );

  it('rescales the same chip stack across the three ante modes without moving the stack itself', () => {
    // 3,500 chips ten-handed: M 23.33 with no ante, 14 with a per-player ante, 10 with the
    // two-big-blind total ante. Three different zones from one unchanged stack.
    const stacks = TOURNAMENT_ANTE_TYPES.map((mode) =>
      buildTournamentMState({
        stackChips: 3500,
        smallBlind: SB,
        bigBlind: BB,
        ante: TEN_HANDED[mode].ante,
        anteType: mode,
        playersAtTable: 10,
      })
    );
    expect(stacks.map((m) => m.orbitCostChips)).toEqual([150, 250, 350]);
    expect(stacks.map((m) => Number(m.effectiveM.toFixed(6)))).toEqual([23.333333, 14, 10]);
    expect(stacks.map((m) => m.zone)).toEqual(['green', 'yellow', 'yellow']);
    expect(stacks.map((m) => m.projectedStackBB)).toEqual([35, 35, 35]);
  });
});
