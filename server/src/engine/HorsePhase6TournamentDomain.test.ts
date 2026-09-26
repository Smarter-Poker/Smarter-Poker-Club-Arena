/**
 * Phase 6B: the tournament preflop atlas states its domain, and the boundary
 * and intersection cases the earlier suite left open are pinned here with
 * expectations written by hand from the documented arithmetic, never by
 * calling the function under test to produce its own oracle.
 *
 * None of this validates numerical strategy, calibration, GTO optimality or
 * natural reachability of a coordinate. Below-2bb and above-100bb depth is
 * an approximation (a clamp to the endpoint) and is tested as exactly that.
 *
 * Exclusions this file cannot cover (named, not hidden):
 * - `ServerTableEngineTurns.ts` is not instantiated here. Its sit-out roster
 *   rule (sit-outs count in `playersAtTable`, are excluded from covering
 *   stacks) is asserted from source text and executed only at the worker
 *   boundary in `horseDecision/workerRuntime.test.ts`.
 * - `HorseLogic.ts` and `HorsePreflop.ts` keep their own `3` / `1.15`
 *   projection-gate literals; they are held to the domain by behaviour, not
 *   by a shared symbol.
 * - The 215,424-coordinate totality loop lives in
 *   `HorsePhase6Tournament.test.ts` and is bound to the domain there; it is
 *   not duplicated here.
 * - No live, natural or controller-accepted evidence is produced here.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import * as TournamentPreflop from './HorseTournamentPreflop.js';
import {
  TOURNAMENT_ANTE_TYPES,
  TOURNAMENT_CONTEXT_INCOMPLETE,
  TOURNAMENT_CONTEXT_STATUSES,
  TOURNAMENT_CORE_DEPTHS,
  TOURNAMENT_FALLBACK_PRECEDENCE,
  TOURNAMENT_GAME_FAMILIES,
  TOURNAMENT_M_HYSTERESIS,
  TOURNAMENT_M_ZONES,
  TOURNAMENT_M_ZONE_BOUNDARIES,
  TOURNAMENT_NEXT_LEVEL_PROJECTION_GATE,
  TOURNAMENT_POSITIONS,
  TOURNAMENT_PREFLOP_ATLAS_DOMAIN,
  TOURNAMENT_PREFLOP_ATLAS_DOMAIN_DIGEST,
  TOURNAMENT_PREFLOP_ATLAS_REVISION,
  TOURNAMENT_PREFLOP_BRANCHES,
  TOURNAMENT_PREFLOP_CELL_PREFIX,
  TOURNAMENT_TABLE_SIZES,
  buildTournamentMState,
  canonicalJson,
  interpolateTournamentDepth,
  tournamentMZone,
  tournamentPositionForSeat,
  tournamentPositionsForTable,
  tournamentPreflopPolicy,
  type TournamentContextStatus,
  type TournamentMZone,
  type TournamentPosition,
  type TournamentPreflopBranch,
  type TournamentPreflopPolicyInput,
} from './HorseTournamentPreflop.js';
import { horsePhase6AttributionIsValid, observePhase6Lookup } from './HorsePhase6Attribution.js';
import { decidePreflopV7, type PreflopCtx } from './HorsePreflop.js';
import { HorseLogic } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import { drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
import {
  fixture,
  request,
  withPhase6Provenance,
} from '../testing/horseRegression/merged/fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const DOMAIN = TOURNAMENT_PREFLOP_ATLAS_DOMAIN;

/** Shift vector with negative zero folded into zero; `-0` adds nothing to a strength bar. */
const shiftsOf = (policy: { shifts: Record<string, number> }) =>
  Object.fromEntries(Object.entries(policy.shifts).map(([key, value]) => [key, value + 0]));

const ZERO = { open: 0, jam: 0, call: 0, threeBet: 0, fourBet: 0 };

function lookup(overrides: Partial<TournamentPreflopPolicyInput> = {}) {
  return tournamentPreflopPolicy({
    gameFamily: 'nlh',
    contextStatus: 'complete',
    tableSize: 9,
    heroPosition: 'BTN',
    raiserPosition: null,
    anteType: 'per_player',
    branch: 'unopened',
    stackBB: 20,
    ...overrides,
  });
}

describe('Phase 6B atlas domain descriptor', () => {
  it('describes the maintained atlas from the arrays the lookup reads, without a second copy', () => {
    expect(DOMAIN.schemaVersion).toBe(1);
    expect(DOMAIN.atlasRevision).toBe('horse-tournament-preflop-v1');
    expect(DOMAIN.atlasRevision).toBe(TOURNAMENT_PREFLOP_ATLAS_REVISION);
    expect(DOMAIN.implementation).toBe('phase6-v1');
    expect(DOMAIN.implementation).toBe(TOURNAMENT_PREFLOP_CELL_PREFIX);
    expect(DOMAIN.gameFamilies).toBe(TOURNAMENT_GAME_FAMILIES);
    expect(DOMAIN.gameFamilies).toEqual({ supported: ['nlh'], labeled: ['omaha', 'other'] });
    expect(DOMAIN.contextStatuses).toEqual({
      baseline: ['complete'],
      fallback: ['incomplete', 'warming', 'stale'],
    });
    expect([...DOMAIN.contextStatuses.baseline, ...DOMAIN.contextStatuses.fallback].sort()).toEqual(
      [...TOURNAMENT_CONTEXT_STATUSES].sort()
    );
    expect(DOMAIN.tableSizes).toBe(TOURNAMENT_TABLE_SIZES);
    expect(DOMAIN.tableSizes).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(DOMAIN.positions).toBe(TOURNAMENT_POSITIONS);
    expect(DOMAIN.branches).toBe(TOURNAMENT_PREFLOP_BRANCHES);
    expect(DOMAIN.branches).toHaveLength(11);
    expect(DOMAIN.anteTypes).toBe(TOURNAMENT_ANTE_TYPES);
    expect(DOMAIN.anteTypes).toEqual(['none', 'per_player', 'big_blind']);
    expect(DOMAIN.depth.anchorsBB).toBe(TOURNAMENT_CORE_DEPTHS);
    expect(DOMAIN.depth).toEqual({
      anchorsBB: [2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 25, 30, 40, 60, 80, 100],
      minBB: 2,
      maxBB: 100,
      belowMin: 'clamp_to_2_approximation',
      aboveMax: 'clamp_to_100_approximation',
      nonFiniteHelperDefaultBB: 20,
      shiftRoundingDecimals: 5,
      velocityUrgencyRoundingDecimals: 3,
    });
    expect(DOMAIN.m.zoneBoundaries).toBe(TOURNAMENT_M_ZONE_BOUNDARIES);
    expect(DOMAIN.m.zones).toBe(TOURNAMENT_M_ZONES);
    expect(DOMAIN.m).toEqual({
      zoneBoundaries: [1, 5, 10, 20, 40],
      zones: ['dead', 'red', 'orange', 'yellow', 'green', 'blue'],
      hysteresisM: 0.5,
      multiZoneJumpBypassesHysteresis: true,
      playersClamp: { min: 2, max: 10 },
      effectiveScaleDenominator: 10,
      velocityUrgencyDivisorMPerMinute: 2,
      projection: { maxMinutes: 3, minMultiplierExclusive: 1.15 },
    });
    expect(DOMAIN.m.hysteresisM).toBe(TOURNAMENT_M_HYSTERESIS);
    expect(DOMAIN.m.projection).toBe(TOURNAMENT_NEXT_LEVEL_PROJECTION_GATE);
    expect(DOMAIN.fallbackPrecedence).toBe(TOURNAMENT_FALLBACK_PRECEDENCE);
    expect(DOMAIN.fallbackPrecedence).toEqual([
      'invalid_coordinate',
      'unsupported_variant',
      'incomplete_context',
    ]);
    // sum of n^2 for n in 2..10 is 384; x 3 antes x 11 branches x 17 anchors.
    expect(384 * 3 * 11 * 17).toBe(215_424);
    expect(DOMAIN.totalValidCoordinates).toBe(215_424);
  });

  it('lists exactly tableSize positions for every size, each drawn from the canonical labels', () => {
    for (const tableSize of DOMAIN.tableSizes) {
      const ring = DOMAIN.positionsBySize[tableSize];
      expect(ring, String(tableSize)).toHaveLength(tableSize);
      expect(new Set(ring).size, String(tableSize)).toBe(tableSize);
      expect(ring.slice(0, 2), String(tableSize)).toEqual(['SB', 'BB']);
      if (tableSize > 2) expect(ring[ring.length - 1], String(tableSize)).toBe('BTN');
      for (const position of ring) expect(DOMAIN.positions).toContain(position);
      expect(tournamentPositionsForTable(tableSize)).toBe(ring);
    }
    expect(
      Object.keys(DOMAIN.positionsBySize)
        .map(Number)
        .sort((a, b) => a - b)
    ).toEqual([...DOMAIN.tableSizes]);
  });

  it('pins the domain digest so any domain edit is a deliberate two-line change', () => {
    const digest = createHash('sha256').update(canonicalJson(DOMAIN)).digest('hex');
    expect(digest).toBe(TOURNAMENT_PREFLOP_ATLAS_DOMAIN_DIGEST);
    expect(TOURNAMENT_PREFLOP_ATLAS_DOMAIN_DIGEST).toMatch(/^[0-9a-f]{64}$/);
  });

  it('serialises canonically: sorted keys at every level, ordered arrays, no undefined', () => {
    expect(canonicalJson({ b: 1, a: [{ z: null, y: 'x' }], c: undefined })).toBe(
      '{"a":[{"y":"x","z":null}],"b":1}'
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson(1.15)).toBe('1.15');
    expect(canonicalJson(DOMAIN)).toBe(canonicalJson(JSON.parse(JSON.stringify(DOMAIN))));
  });

  it('freezes every exported constant and the domain to its leaves', () => {
    const deepFrozen = (value: unknown, path: string): void => {
      if (!value || typeof value !== 'object') return;
      expect(Object.isFrozen(value), path).toBe(true);
      for (const [key, child] of Object.entries(value)) deepFrozen(child, `${path}.${key}`);
    };
    deepFrozen(DOMAIN, 'domain');
    for (const [name, constant] of Object.entries({
      TOURNAMENT_CORE_DEPTHS,
      TOURNAMENT_TABLE_SIZES,
      TOURNAMENT_POSITIONS,
      TOURNAMENT_PREFLOP_BRANCHES,
      TOURNAMENT_ANTE_TYPES,
      TOURNAMENT_CONTEXT_STATUSES,
      TOURNAMENT_M_ZONES,
      TOURNAMENT_M_ZONE_BOUNDARIES,
      TOURNAMENT_GAME_FAMILIES,
      TOURNAMENT_FALLBACK_PRECEDENCE,
      TOURNAMENT_NEXT_LEVEL_PROJECTION_GATE,
    })) {
      deepFrozen(constant, name);
    }
    for (const tableSize of TOURNAMENT_TABLE_SIZES) {
      expect(Object.isFrozen(tournamentPositionsForTable(tableSize)), String(tableSize)).toBe(true);
    }
    expect(Object.isFrozen(tournamentPositionsForTable(Number.NaN))).toBe(true);
  });

  it('keeps the lookup unchanged when a caller tries to mutate a held ring or anchor list', () => {
    const before = lookup({ tableSize: 9, heroPosition: 'UTG2', raiserPosition: 'HJ' });
    const ring = tournamentPositionsForTable(9) as unknown as TournamentPosition[];
    expect(() => ring.push('UTG3')).toThrow(TypeError);
    expect(() => ring.reverse()).toThrow(TypeError);
    expect(() => {
      ring[0] = 'BTN';
    }).toThrow(TypeError);
    const anchors = TOURNAMENT_CORE_DEPTHS as unknown as number[];
    expect(() => anchors.push(150)).toThrow(TypeError);
    expect(() => {
      (DOMAIN as { totalValidCoordinates: number }).totalValidCoordinates = 1;
    }).toThrow(TypeError);
    expect(() => {
      (DOMAIN.depth as { maxBB: number }).maxBB = 500;
    }).toThrow(TypeError);
    // A detached copy is the caller's to break; the atlas never reads it.
    const copy: number[] = [...TOURNAMENT_CORE_DEPTHS];
    copy.push(150);
    copy.reverse();
    const heldRing = [...tournamentPositionsForTable(9)];
    heldRing.length = 0;
    expect(tournamentPositionsForTable(9)).toHaveLength(9);
    expect([...TOURNAMENT_CORE_DEPTHS]).toEqual([
      2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 25, 30, 40, 60, 80, 100,
    ]);
    expect(DOMAIN.totalValidCoordinates).toBe(215_424);
    expect(lookup({ tableSize: 9, heroPosition: 'UTG2', raiserPosition: 'HJ' })).toEqual(before);
    expect(interpolateTournamentDepth(150)).toEqual({ lower: 100, upper: 100, weight: 0 });
  });
});

describe('Phase 6B near-boundary M hysteresis', () => {
  // Zone i sits below TOURNAMENT_M_ZONE_BOUNDARIES[i]; boundary b opens zone i + 1.
  // Improving needs m >= b + 0.5 (inclusive); worsening needs m < b - 0.5 (exclusive).
  const rows: Array<[boundary: number, lower: TournamentMZone, upper: TournamentMZone]> = [
    [1, 'dead', 'red'],
    [5, 'red', 'orange'],
    [10, 'orange', 'yellow'],
    [20, 'yellow', 'green'],
    [40, 'green', 'blue'],
  ];

  it.each(rows)('holds the half-M deadband on both sides of boundary %s', (b, lower, upper) => {
    // From the lower zone: stays until m reaches b + 0.5 exactly.
    expect(tournamentMZone(b, lower)).toBe(lower);
    expect(tournamentMZone(b + 0.49, lower)).toBe(lower);
    expect(tournamentMZone(b + 0.5, lower)).toBe(upper);
    expect(tournamentMZone(b + 0.51, lower)).toBe(upper);
    // From the upper zone: stays at b - 0.5 exactly, drops just below it.
    expect(tournamentMZone(b - 0.01, upper)).toBe(upper);
    expect(tournamentMZone(b - 0.5, upper)).toBe(upper);
    expect(tournamentMZone(b - 0.51, upper)).toBe(lower);
    // No prior zone: the raw boundary decides.
    expect(tournamentMZone(b)).toBe(upper);
    expect(tournamentMZone(b - 0.01)).toBe(lower);
  });

  it('keeps the outer zones sticky and ignores an unknown prior zone', () => {
    expect(tournamentMZone(1.2, 'dead')).toBe('dead');
    expect(tournamentMZone(0, 'red')).toBe('dead');
    expect(tournamentMZone(0.5, 'red')).toBe('red');
    expect(tournamentMZone(39.6, 'blue')).toBe('blue');
    expect(tournamentMZone(1000, 'green')).toBe('blue');
    expect(tournamentMZone(7, 'purple' as TournamentMZone)).toBe('orange');
    expect(tournamentMZone(Number.NaN, 'green')).toBe('dead');
    expect(tournamentMZone(-3)).toBe('dead');
    // A jump of two or more zones bypasses the deadband in both directions.
    expect(tournamentMZone(10.2, 'dead')).toBe('yellow');
    expect(tournamentMZone(9.8, 'blue')).toBe('orange');
    expect(tournamentMZone(4.9, 'yellow')).toBe('red');
  });
});

describe('Phase 6B next-level projection gate', () => {
  // Six dealt, 50/100, no ante: orbit 150. Hero 6000 behind: real M 40, effective M 24 (green).
  // Next level 150/300: projected orbit 450, projected M 13.33, projected effective M 8 (orange).
  // Green to orange is a two-zone jump, so the projection bypasses hysteresis when the gate fires.
  const projectedM = buildTournamentMState({
    stackChips: 6000,
    smallBlind: 50,
    bigBlind: 100,
    ante: 0,
    anteType: 'none',
    playersAtTable: 6,
    nextSmallBlind: 150,
    nextBigBlind: 300,
    nextAnte: 0,
    minutesToNextLevel: 3,
  });

  it('carries the fixture arithmetic exactly', () => {
    expect(projectedM.orbitCostChips).toBe(150);
    expect(projectedM.realM).toBe(40);
    expect(projectedM.effectiveM).toBeCloseTo(24, 10);
    expect(projectedM.projectedOrbitCostChips).toBe(450);
    expect(projectedM.projectedEffectiveM).toBeCloseTo(8, 10);
    expect(projectedM.projectedStackBB).toBe(20);
    expect(projectedM.zone).toBe('green');
    expect(tournamentMZone(Math.min(24, 8), 'green')).toBe('orange');
  });

  // The gate fields are varied in isolation so the boundary itself is what moves the branch.
  const rows: Array<
    [minutes: number | null | undefined, mult: number | undefined, fires: boolean]
  > = [
    [3, 1.16, true],
    [3, 1.15, false],
    [3.01, 1.16, false],
    [2, 1.15, false],
    [2, 3, true],
    [null, 3, false],
    [undefined, 3, false],
    [2, undefined, false],
  ];

  function sixHandedFacingCutoffOpen(
    nextBlindInMin: number | null | undefined,
    nextBlindMult?: number
  ) {
    const seat = (n: number, extra: Record<string, unknown>) => ({
      seat: n,
      user_id: `gate-${n}`,
      username: `Gate ${n}`,
      stack: 6000,
      bet: 0,
      totalInvested: 0,
      cards: [] as Array<{ rank: string; suit: string }>,
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      ...extra,
    });
    const hero = seat(6, {
      cards: [
        { rank: 'A', suit: 'spades' },
        { rank: 'Q', suit: 'spades' },
      ],
    });
    const players = [
      seat(1, { bet: 50, totalInvested: 50, stack: 5950 }),
      seat(2, { bet: 100, totalInvested: 100, stack: 5900 }),
      seat(3, { is_folded: true }),
      seat(4, { is_folded: true }),
      seat(5, { bet: 250, totalInvested: 250, stack: 5750 }),
      hero,
    ];
    const spy = vi.spyOn(TournamentPreflop, 'tournamentPreflopPolicy');
    try {
      seedFastRandom(6_020_925);
      HorseLogic.decide(
        hero as never,
        {
          players,
          communityCards: [],
          pot: 400,
          currentBet: 250,
          minRaise: 150,
          stage: 'preflop',
          gameVariant: 'nlh',
          gameMode: 'tournament',
          format: 'mtt',
          bigBlind: 100,
          ante: 0,
          bigBlindAnte: false,
          dealerSeat: 6,
          actionHistory: [
            {
              seat: 3,
              userId: 'gate-3',
              action: 'fold',
              amount: 0,
              stage: 'preflop',
              timestamp: 1,
            },
            {
              seat: 4,
              userId: 'gate-4',
              action: 'fold',
              amount: 0,
              stage: 'preflop',
              timestamp: 2,
            },
            {
              seat: 5,
              userId: 'gate-5',
              action: 'raise',
              amount: 250,
              stage: 'preflop',
              timestamp: 3,
              isFullRaise: true,
            },
          ],
          tournament: {
            schemaVersion: 1,
            contextStatus: 'complete',
            contextIssues: [],
            playersAtTable: 6,
            playersLeft: 30,
            spotsPaid: 5,
            avgStackChips: 6000,
            currentSmallBlind: 50,
            currentBigBlind: 100,
            currentAnte: 0,
            anteType: 'none',
            nextSmallBlind: 150,
            nextBigBlind: 300,
            nextAnte: 0,
            nextBlindInMin,
            nextBlindMult,
            m: projectedM,
            stacks: [6000, 6000, 6000, 6000, 6000, 6000],
            payoutPct: [40, 25, 15, 10, 10],
            satellite: false,
          },
        } as never,
        'balanced',
        {},
        { telemetry: false, mind: false, v27GtoCharts: false }
      );
      expect(spy).toHaveBeenCalledTimes(1);
      return spy.mock.calls[0][0];
    } finally {
      spy.mockRestore();
    }
  }

  it.each(rows)(
    'HorseLogic re-zones the classifier branch only inside the gate: minutes %s, mult %s -> fires %s',
    (minutes, mult, fires) => {
      const input = sixHandedFacingCutoffOpen(minutes, mult);
      expect(input.heroPosition).toBe('BTN');
      expect(input.raiserPosition).toBe('CO');
      expect(input.tableSize).toBe(6);
      expect(input.stackBB).toBe(60);
      // Orange zone plus a late raiser is reshove pressure; green is a plain cold call.
      expect(input.branch).toBe(fires ? 'reshove' : 'cold_call');
    }
  );

  function unopenedButton(nextBlindInMin: number | null | undefined, nextBlindMult?: number) {
    // 2700 behind, 50/100, no ante, eight dealt: orbit 150, real M 18, effective M 14.4 (yellow).
    // Next level 150/300: projected effective M 4.8 (red), projected depth 9bb.
    const m = buildTournamentMState({
      stackChips: 2700,
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      anteType: 'none',
      playersAtTable: 8,
      nextSmallBlind: 150,
      nextBigBlind: 300,
      nextAnte: 0,
      minutesToNextLevel: 2,
    });
    expect(m.zone).toBe('yellow');
    expect(m.projectedEffectiveM).toBeCloseTo(4.8, 10);
    expect(m.projectedStackBB).toBe(9);
    const ctx: PreflopCtx = {
      strength: 0.65,
      position: 'late',
      raiserPosition: null,
      raises: 0,
      limpers: 0,
      callers: 0,
      oppsLeft: 7,
      toCall: 100,
      currentBet: 100,
      contestablePot: 150,
      pot: 150,
      bigBlind: 100,
      stack: 2700,
      stackBB: 27,
      tightness: 1,
      bluffFreq: 0.1,
      aggression: 1,
      slowplayFreq: 0,
      sizingMultiplier: 1,
      isOmaha: false,
      isPotLimit: false,
      riskAdd: 0.04,
      mode: 'tournament',
      anteInPlay: false,
      anteOrbitBB: 0,
      tableSize: 8,
      format: 'mtt',
      v13: true,
      rand: () => 0.5,
      nextBlindInMin: nextBlindInMin ?? undefined,
      nextBlindMult,
      phase6: {
        m,
        policy: tournamentPreflopPolicy({
          gameFamily: 'nlh',
          contextStatus: 'complete',
          tableSize: 8,
          heroPosition: 'BTN',
          raiserPosition: null,
          anteType: 'none',
          branch: 'unopened',
          stackBB: 27,
          m,
        }),
      },
    };
    return decidePreflopV7(ctx).a;
  }

  it.each(rows)(
    'HorsePreflop applies projected M and depth only inside the gate: minutes %s, mult %s -> fires %s',
    (minutes, mult, fires) => {
      const action = unopenedButton(minutes, mult);
      if (fires) expect(action).toBe('jam');
      else expect(action).not.toBe('jam');
    }
  );
});

describe('Phase 6B velocity urgency', () => {
  // Eight dealt, 50/100, no ante: orbit 150. 3000 behind: real M 20, effective M 16.
  // Next level 100/200: orbit 300, projected effective M 8. Velocity = 8 / minutes.
  const mWithMinutes = (minutesToNextLevel: number | null) =>
    buildTournamentMState({
      stackChips: 3000,
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      anteType: 'none',
      playersAtTable: 8,
      nextSmallBlind: 100,
      nextBigBlind: 200,
      nextAnte: 0,
      minutesToNextLevel,
    });

  it('is zero without a clock, with a non-positive clock, or when the next level is cheaper', () => {
    expect(mWithMinutes(null).velocityMPerMinute).toBe(0);
    expect(mWithMinutes(0).velocityMPerMinute).toBe(0);
    expect(mWithMinutes(-2).velocityMPerMinute).toBe(0);
    expect(mWithMinutes(Number.NaN).velocityMPerMinute).toBe(0);
    const cheaper = buildTournamentMState({
      stackChips: 3000,
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      anteType: 'none',
      playersAtTable: 8,
      nextSmallBlind: 25,
      nextBigBlind: 50,
      nextAnte: 0,
      minutesToNextLevel: 2,
    });
    expect(cheaper.projectedEffectiveM).toBeCloseTo(32, 10);
    expect(cheaper.velocityMPerMinute).toBe(0);
  });

  it('saturates at two M per minute, halves at one, rounds urgency to three decimals', () => {
    expect(mWithMinutes(4).velocityMPerMinute).toBe(2);
    expect(mWithMinutes(2).velocityMPerMinute).toBe(4);
    expect(mWithMinutes(8).velocityMPerMinute).toBe(1);
    expect(mWithMinutes(12).velocityMPerMinute).toBeCloseTo(2 / 3, 12);
    // Nine-max, per-player ante, unopened button at 20bb: open -0.036, jam -0.018 before urgency.
    const calm = lookup({ m: mWithMinutes(null) });
    expect(shiftsOf(calm)).toEqual({ ...ZERO, open: -0.036, jam: -0.018 });
    expect(calm.cell.endsWith(':velocity=0')).toBe(true);
    const saturated = lookup({ m: mWithMinutes(4) });
    expect(shiftsOf(saturated)).toEqual({ ...ZERO, open: -0.048, jam: -0.038 });
    expect(saturated.cell.endsWith(':velocity=1')).toBe(true);
    expect(shiftsOf(lookup({ m: mWithMinutes(2) }))).toEqual(shiftsOf(saturated));
    expect(lookup({ m: mWithMinutes(2) }).cell).toBe(saturated.cell);
    const half = lookup({ m: mWithMinutes(8) });
    expect(shiftsOf(half)).toEqual({ ...ZERO, open: -0.042, jam: -0.028 });
    expect(half.cell.endsWith(':velocity=0.5')).toBe(true);
    // Urgency 1/3 rounds to 0.333; open -0.036 - 0.003996 = -0.039996 rounds to -0.04 at 5dp,
    // jam -0.018 - 0.00666 = -0.02466.
    const third = lookup({ m: mWithMinutes(12) });
    expect(shiftsOf(third)).toEqual({ ...ZERO, open: -0.04, jam: -0.02466 });
    expect(third.cell.endsWith(':velocity=0.333')).toBe(true);
  });

  it('touches only open and jam, and is recorded on a fallback cell whose shifts stay zero', () => {
    const coldCall = lookup({ branch: 'cold_call', raiserPosition: 'UTG', m: mWithMinutes(4) });
    // cold_call vs an early raiser at 20bb: call 0.037, threeBet 0.028; urgency adds -0.012 / -0.02.
    expect(shiftsOf(coldCall)).toEqual({
      open: -0.012,
      jam: -0.02,
      call: 0.037,
      threeBet: 0.028,
      fourBet: 0,
    });
    const warming = lookup({ contextStatus: 'warming', m: mWithMinutes(2) });
    expect(warming.fallbackReason).toBe('incomplete_context');
    expect(shiftsOf(warming)).toEqual(ZERO);
    expect(warming.cell.endsWith(':velocity=1')).toBe(true);
  });
});

describe('Phase 6B covering stacks and short-handed transitions', () => {
  it('includes an equal stack, orders tied covers by userId, and drops empty ids and empty stacks', () => {
    // Eight dealt, 50/100, no ante: orbit 150. Hero 3000: real M 20, effective M 16.
    const state = buildTournamentMState({
      stackChips: 3000,
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      anteType: 'none',
      playersAtTable: 8,
      opponentStacks: [
        { userId: 'b-cover', stackChips: 4500 },
        { userId: 'equal', stackChips: 3000 },
        { userId: '', stackChips: 9000 },
        { userId: 'busted', stackChips: 0 },
        { userId: 'a-cover', stackChips: 4500 },
        { userId: 'short', stackChips: 2999 },
      ],
    });
    expect(state.coveringOpponents.map((opponent) => opponent.userId)).toEqual([
      'equal',
      'a-cover',
      'b-cover',
    ]);
    expect(state.coveringOpponents[0]).toEqual({
      userId: 'equal',
      stackChips: 3000,
      realM: 20,
      effectiveM: 16,
    });
    expect(state.coveringOpponents[1].realM).toBe(30);
    expect(state.coveringOpponents[1].effectiveM).toBeCloseTo(24, 10);
    expect(state.coveringOpponentM).toBe(20);
  });

  it('reports no cover when hero is the largest stack, and never lists a smaller stack', () => {
    const state = buildTournamentMState({
      stackChips: 5000,
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      anteType: 'none',
      playersAtTable: 8,
      opponentStacks: [
        { userId: 'x', stackChips: 4999 },
        { userId: 'y', stackChips: 100 },
      ],
    });
    expect(state.coveringOpponents).toEqual([]);
    expect(state.coveringOpponentM).toBeNull();
    const empty = buildTournamentMState({
      stackChips: 0,
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      anteType: 'none',
      playersAtTable: 8,
      opponentStacks: [{ userId: 'z', stackChips: 0 }],
    });
    expect(empty.realM).toBe(0);
    expect(empty.coveringOpponents).toEqual([]);
  });

  it('rescales orbit cost and effective M as the dealt census shrinks, leaving the stack alone', () => {
    // Per-player ante 10 at 50/100: orbit = 150 + 10 x dealt.
    const perPlayer = (playersAtTable: number) =>
      buildTournamentMState({
        stackChips: 4800,
        smallBlind: 50,
        bigBlind: 100,
        ante: 10,
        anteType: 'per_player',
        playersAtTable,
      });
    const nine = perPlayer(9),
      six = perPlayer(6),
      two = perPlayer(2);
    expect([nine.orbitCostChips, six.orbitCostChips, two.orbitCostChips]).toEqual([240, 210, 170]);
    expect(nine.realM).toBe(20);
    expect(six.realM).toBeCloseTo(4800 / 210, 10);
    expect(two.realM).toBeCloseTo(4800 / 170, 10);
    expect(nine.effectiveM).toBeCloseTo(18, 10);
    expect(six.effectiveM).toBeCloseTo((4800 / 210) * 0.6, 10);
    expect(two.effectiveM).toBeCloseTo((4800 / 170) * 0.2, 10);
    // 18 and 13.71 are yellow; 5.65 is orange (the 5 boundary), not red.
    expect([nine.zone, six.zone, two.zone]).toEqual(['yellow', 'yellow', 'orange']);
    expect([nine.projectedStackBB, six.projectedStackBB, two.projectedStackBB]).toEqual([
      48, 48, 48,
    ]);

    // A big blind ante authored as a total (ante >= BB) costs the orbit the same at any census,
    // so only the short-handed scale moves effective M: 5000 / 250 = 20 real M throughout.
    const authoredTotal = (playersAtTable: number) =>
      buildTournamentMState({
        stackChips: 5000,
        smallBlind: 50,
        bigBlind: 100,
        ante: 100,
        anteType: 'big_blind',
        playersAtTable,
      });
    for (const [players, effective, zone] of [
      [9, 18, 'yellow'],
      [6, 12, 'yellow'],
      [2, 4, 'red'],
    ] as const) {
      const state = authoredTotal(players);
      expect(state.orbitCostChips, String(players)).toBe(250);
      expect(state.realM, String(players)).toBe(20);
      expect(state.effectiveM, String(players)).toBeCloseTo(effective, 10);
      expect(state.zone, String(players)).toBe(zone);
    }
    // A per-player big blind ante (ante < BB) scales with the census up to the two-BB ceiling.
    const perSeatBba = (playersAtTable: number) =>
      buildTournamentMState({
        stackChips: 5000,
        smallBlind: 50,
        bigBlind: 100,
        ante: 25,
        anteType: 'big_blind',
        playersAtTable,
      }).orbitCostChips;
    expect([perSeatBba(9), perSeatBba(6), perSeatBba(2)]).toEqual([350, 300, 200]);
  });

  it('clamps the dealt census to the domain and floors a fractional count', () => {
    const orbit = (playersAtTable: number) =>
      buildTournamentMState({
        stackChips: 1000,
        smallBlind: 50,
        bigBlind: 100,
        ante: 10,
        anteType: 'per_player',
        playersAtTable,
      });
    expect(orbit(1).orbitCostChips).toBe(170);
    expect(orbit(0).orbitCostChips).toBe(170);
    expect(orbit(Number.NaN).orbitCostChips).toBe(170);
    expect(orbit(11).orbitCostChips).toBe(250);
    expect(orbit(9.9).orbitCostChips).toBe(240);
    expect(orbit(1).effectiveM).toBeCloseTo((1000 / 170) * 0.2, 10);
    expect(orbit(11).effectiveM).toBe(1000 / 250);
  });

  it('keeps the table-engine sit-out rule on record: dealt for orbit cost, excluded from cover', () => {
    // Source-inspected, not executed here; the worker boundary executes it in workerRuntime.test.ts.
    const turns = readFileSync(join(here, 'ServerTableEngineTurns.ts'), 'utf8');
    expect(turns).toContain('const dealtPlayers = players;');
    expect(turns).toContain(
      'const actionablePlayers = players.filter((candidate) => !candidate.is_sitting_out);'
    );
    expect(turns).toContain('const playersAtTable = Math.max(2, dealtPlayers.length);');
    expect(turns).toContain('opponentStacks: actionablePlayers');
    expect(turns).toContain('const stackBehind = Math.max(0, Number(player.stack) || 0);');
    const worker = readFileSync(join(here, 'horseDecision', 'workerRuntime.ts'), 'utf8');
    expect(worker).toContain('!seat.is_sitting_out');
    expect(worker).toContain('tournament.playersAtTable !== Math.max(2, gs.players.length)');
  });
});

describe('Phase 6B positions on sparse rings and shrinking tables', () => {
  it('labels sparse seat numbers from the dealer and wraps past the highest seat', () => {
    const seats = [1, 4, 7, 9];
    expect(seats.map((seat) => tournamentPositionForSeat(seat, 9, seats))).toEqual([
      'SB',
      'BB',
      'CO',
      'BTN',
    ]);
    expect(seats.map((seat) => tournamentPositionForSeat(seat, 4, seats))).toEqual([
      'CO',
      'BTN',
      'SB',
      'BB',
    ]);
    expect(seats.map((seat) => tournamentPositionForSeat(seat, 1, seats))).toEqual([
      'BTN',
      'SB',
      'BB',
      'CO',
    ]);
  });

  it('moves from three-handed to heads-up on the same seat numbers', () => {
    const three = [2, 5, 8];
    expect(three.map((seat) => tournamentPositionForSeat(seat, 5, three))).toEqual([
      'BB',
      'BTN',
      'SB',
    ]);
    const two = [2, 5];
    expect(tournamentPositionForSeat(5, 5, two)).toBe('SB');
    expect(tournamentPositionForSeat(2, 5, two)).toBe('BB');
    expect(tournamentPositionForSeat(2, 2, two)).toBe('SB');
    expect(tournamentPositionForSeat(5, 2, two)).toBe('BB');
    // Undealt hero, missing dealer or a single seat cannot be placed on the ring.
    expect(tournamentPositionForSeat(8, 5, two)).toBe('MP');
    expect(tournamentPositionForSeat(5, undefined, two)).toBe('MP');
    expect(tournamentPositionForSeat(5, 5, [5])).toBe('MP');
    // Heads-up with a dealer outside the dealt pair labels both seats BB (recon observation,
    // unreachable from a complete table snapshot, recorded rather than repaired here).
    expect(tournamentPositionForSeat(5, 9, two)).toBe('BB');
    expect(tournamentPositionForSeat(2, 9, two)).toBe('BB');
  });

  it('keeps a dealt sit-out on the ring so the aggressor label and table size do not shift', () => {
    // Five dealt [1..5], dealer 5: 1 SB, 2 BB, 3 HJ, 4 CO, 5 BTN. Seat 1 sits out but was dealt.
    // Had the sit-out been dropped, the ring would read 2 SB, 3 BB, 4 CO, 5 BTN, the hijack
    // raiser would be mislabelled a blind, and the branch below would fall to cold_call.
    const seat = (n: number, extra: Record<string, unknown>) => ({
      seat: n,
      user_id: `ring-${n}`,
      username: `Ring ${n}`,
      stack: 4000,
      bet: 0,
      totalInvested: 0,
      cards: [] as Array<{ rank: string; suit: string }>,
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      ...extra,
    });
    const hero = seat(4, {
      cards: [
        { rank: 'K', suit: 'hearts' },
        { rank: 'Q', suit: 'hearts' },
      ],
    });
    const players = [
      seat(1, { bet: 50, totalInvested: 50, stack: 3950, is_sitting_out: true, is_folded: true }),
      seat(2, { bet: 100, totalInvested: 100, stack: 3900 }),
      seat(3, { bet: 250, totalInvested: 250, stack: 3750 }),
      hero,
      seat(5, {}),
    ];
    const m = buildTournamentMState({
      stackChips: 4000,
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      anteType: 'none',
      playersAtTable: 5,
      opponentStacks: players
        .filter((candidate) => candidate.seat !== 4 && !candidate.is_sitting_out)
        .map((candidate) => ({ userId: candidate.user_id, stackChips: candidate.stack })),
    });
    // Sit-out excluded from cover: only seat 5 (4000, equal) covers hero.
    expect(m.coveringOpponents.map((opponent) => opponent.userId)).toEqual(['ring-5']);
    const spy = vi.spyOn(TournamentPreflop, 'tournamentPreflopPolicy');
    try {
      seedFastRandom(6_020_926);
      HorseLogic.decide(
        hero as never,
        {
          players,
          communityCards: [],
          pot: 400,
          currentBet: 250,
          minRaise: 150,
          stage: 'preflop',
          gameVariant: 'nlh',
          gameMode: 'tournament',
          format: 'mtt',
          bigBlind: 100,
          ante: 0,
          bigBlindAnte: false,
          dealerSeat: 5,
          actionHistory: [
            {
              seat: 3,
              userId: 'ring-3',
              action: 'raise',
              amount: 250,
              stage: 'preflop',
              timestamp: 1,
              isFullRaise: true,
            },
          ],
          tournament: {
            schemaVersion: 1,
            contextStatus: 'complete',
            contextIssues: [],
            playersAtTable: 5,
            playersLeft: 20,
            spotsPaid: 3,
            avgStackChips: 4000,
            currentSmallBlind: 50,
            currentBigBlind: 100,
            currentAnte: 0,
            anteType: 'none',
            nextSmallBlind: 75,
            nextBigBlind: 150,
            nextAnte: 0,
            nextBlindInMin: 9,
            nextBlindMult: 1.5,
            m,
            stacks: [4000, 4000, 4000, 4000, 4000],
            payoutPct: [50, 30, 20],
            satellite: false,
          },
        } as never,
        'balanced',
        {},
        { telemetry: false, mind: false, v27GtoCharts: false }
      );
      expect(spy).toHaveBeenCalledTimes(1);
      const input = spy.mock.calls[0][0];
      expect(input.tableSize).toBe(5);
      expect(input.heroPosition).toBe('CO');
      expect(input.raiserPosition).toBe('HJ');
      // 4000 / 150 = 26.67 real M x 0.5 = 13.33 effective M is yellow, which is reshove
      // pressure; a hijack raiser is in the late-raiser list, so the node is a reshove.
      expect(m.zone).toBe('yellow');
      expect(input.branch).toBe('reshove');
      // Effective depth: min(hero 4000, raiser 3750 + 250) / 100 = 40bb.
      expect(input.stackBB).toBe(40);
      expect(tournamentPositionsForTable(input.tableSize)).toHaveLength(input.tableSize);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Phase 6B depth endpoints and interpolation approximation', () => {
  it('clamps finite depth to the grid endpoints and substitutes 20bb only for non-finite input', () => {
    for (const stackBB of [1.99, 0.5, 0, -5]) {
      expect(interpolateTournamentDepth(stackBB), String(stackBB)).toEqual({
        lower: 2,
        upper: 2,
        weight: 0,
      });
    }
    for (const stackBB of [100.01, 1e6, Number.MAX_SAFE_INTEGER]) {
      expect(interpolateTournamentDepth(stackBB), String(stackBB)).toEqual({
        lower: 100,
        upper: 100,
        weight: 0,
      });
    }
    for (const stackBB of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(interpolateTournamentDepth(stackBB), String(stackBB)).toEqual({
        lower: 20,
        upper: 20,
        weight: 0,
      });
    }
    expect(interpolateTournamentDepth(2)).toEqual({ lower: 2, upper: 2, weight: 0 });
    expect(interpolateTournamentDepth(100)).toEqual({ lower: 100, upper: 100, weight: 0 });
  });

  it('reports the raw coordinate beside the clamped bracket and repeats the endpoint shifts', () => {
    // Unopened button, nine-max, per-player ante at 2bb: short = 1, jam = -0.035 - 0.018.
    const atTwo = lookup({ stackBB: 2 });
    expect(shiftsOf(atTwo)).toEqual({ ...ZERO, open: -0.036, jam: -0.053 });
    const below = lookup({ stackBB: 1.99 });
    expect(below.depth).toEqual({ lower: 2, upper: 2, weight: 0 });
    expect(below.source).toBe('deterministic_baseline');
    expect(shiftsOf(below)).toEqual(shiftsOf(atTwo));
    const observed = observePhase6Lookup(
      {
        gameFamily: 'nlh',
        contextStatus: 'complete',
        tableSize: 9,
        heroPosition: 'BTN',
        raiserPosition: null,
        anteType: 'per_player',
        branch: 'unopened',
        stackBB: 1.99,
      },
      below
    );
    expect(observed.coordinate.stackBB).toBe(1.99);
    expect(observed.policy.depth.lower).toBe(2);
    expect(observed.policy.cell).toContain(':2-2@0:');

    // three_bet_facing at 100bb: deep = 1, call 0.035, fourBet 0.035; identical far above the grid.
    const atHundred = lookup({ branch: 'three_bet_facing', raiserPosition: 'UTG', stackBB: 100 });
    expect(shiftsOf(atHundred)).toEqual({ ...ZERO, call: 0.035, fourBet: 0.035 });
    const above = lookup({ branch: 'three_bet_facing', raiserPosition: 'UTG', stackBB: 1e6 });
    expect(above.depth).toEqual({ lower: 100, upper: 100, weight: 0 });
    expect(shiftsOf(above)).toEqual(shiftsOf(atHundred));
    expect(above.cell).toContain(':100-100@0:');
    // Interior: 70bb sits at weight 0.5 between 60 and 80; deep = 0.5 gives call 0.025, fourBet 0.0225.
    const seventy = lookup({ branch: 'three_bet_facing', raiserPosition: 'UTG', stackBB: 70 });
    expect(seventy.depth).toEqual({ lower: 60, upper: 80, weight: 0.5 });
    expect(shiftsOf(seventy)).toEqual({ ...ZERO, call: 0.025, fourBet: 0.0225 });
    // At 40bb deep = 0: the base values alone.
    expect(
      shiftsOf(lookup({ branch: 'three_bet_facing', raiserPosition: 'UTG', stackBB: 40 }))
    ).toEqual({ ...ZERO, call: 0.015, fourBet: 0.01 });
  });

  it('matches a hand-derived shift vector for every branch at the 20bb anchor', () => {
    // Nine-max (tableWiden 0), per-player ante (anteWiden 0.018), 20bb (short 0, deep 0).
    const rows: Array<
      [TournamentPreflopBranch, TournamentPosition, TournamentPosition | null, typeof ZERO]
    > = [
      ['unopened', 'BTN', null, { ...ZERO, open: -0.036, jam: -0.018 }],
      ['unopened', 'UTG', null, { ...ZERO, open: -0.006, jam: -0.018 }],
      ['unopened', 'MP', null, { ...ZERO, open: -0.018, jam: -0.018 }],
      ['limp_facing', 'BTN', null, { ...ZERO, open: -0.043, call: 0.012 }],
      ['limp_facing', 'MP', null, { ...ZERO, open: -0.01, call: 0.012 }],
      [
        'blind_vs_blind',
        'SB',
        null,
        { ...ZERO, open: -0.063, jam: -0.018, call: -0.025, threeBet: -0.025 },
      ],
      ['bb_defense', 'BB', 'BTN', { ...ZERO, call: -0.058, threeBet: -0.018 }],
      ['bb_defense', 'BB', 'UTG', { ...ZERO, call: 0.005, threeBet: 0.012 }],
      ['reshove', 'BTN', 'UTG', { ...ZERO, jam: 0.007, call: 0.02 }],
      ['reshove', 'BTN', 'CO', { ...ZERO, jam: -0.043, call: 0.02 }],
      ['squeeze', 'BTN', 'UTG', { ...ZERO, threeBet: 0.009, call: 0.02 }],
      ['squeeze', 'BTN', 'CO', { ...ZERO, threeBet: -0.029, call: 0.02 }],
      ['overcall', 'MP', 'UTG', { ...ZERO, call: 0.053, threeBet: 0.012 }],
      ['overcall', 'MP', 'CO', { ...ZERO, call: 0.035, threeBet: 0.012 }],
      [
        'multiway_all_in',
        'BTN',
        'UTG',
        { ...ZERO, call: 0.09, jam: 0.07, threeBet: 0.06, fourBet: 0.05 },
      ],
      ['three_bet_facing', 'BTN', 'UTG', { ...ZERO, call: 0.015, fourBet: 0.01 }],
      ['open_facing', 'BTN', 'UTG', { ...ZERO, call: 0.025, threeBet: 0.025 }],
      ['open_facing', 'BTN', 'CO', { ...ZERO, call: -0.012, threeBet: -0.015 }],
      ['open_facing', 'BTN', 'HJ', ZERO],
      ['cold_call', 'BTN', 'UTG', { ...ZERO, call: 0.037, threeBet: 0.028 }],
      ['cold_call', 'BTN', 'CO', { ...ZERO, call: 0.002, threeBet: -0.002 }],
      ['cold_call', 'BTN', 'HJ', { ...ZERO, call: 0.012, threeBet: 0.008 }],
    ];
    for (const [branch, heroPosition, raiserPosition, expected] of rows) {
      const policy = lookup({ branch, heroPosition, raiserPosition });
      expect(policy.source, `${branch} ${heroPosition} ${raiserPosition}`).toBe(
        'deterministic_baseline'
      );
      expect(shiftsOf(policy), `${branch} ${heroPosition} ${raiserPosition}`).toEqual(expected);
    }
    expect(new Set(rows.map(([branch]) => branch)).size).toBe(TOURNAMENT_PREFLOP_BRANCHES.length);
  });

  it('widens with table size and ante type exactly as documented', () => {
    // tableWiden = clamp((9 - size) x 0.004, -0.004, 0.028); anteWiden none 0, big_blind 0.012.
    expect(shiftsOf(lookup({ tableSize: 6 }))).toEqual({ ...ZERO, open: -0.048, jam: -0.03 });
    expect(shiftsOf(lookup({ tableSize: 10 }))).toEqual({ ...ZERO, open: -0.032, jam: -0.014 });
    expect(shiftsOf(lookup({ tableSize: 2, heroPosition: 'SB' }))).toEqual({
      ...ZERO,
      open: -0.064,
      jam: -0.046,
    });
    expect(shiftsOf(lookup({ anteType: 'none' }))).toEqual({ ...ZERO, open: -0.018, jam: 0 });
    expect(shiftsOf(lookup({ anteType: 'big_blind' }))).toEqual({
      ...ZERO,
      open: -0.03,
      jam: -0.012,
    });
    // Short-stack ramp: at 11bb short = 0.5, jam = -0.0175 - 0.018 = -0.0355 at each side of the
    // 10/12 bracket, so the interpolated value is the same figure.
    expect(lookup({ stackBB: 11 }).depth).toEqual({ lower: 10, upper: 12, weight: 0.5 });
    expect(shiftsOf(lookup({ stackBB: 11 }))).toEqual({ ...ZERO, open: -0.036, jam: -0.0355 });
  });
});

describe('Phase 6B context routes and the named unsupported-variant fallback', () => {
  const coordinate = {
    tableSize: 6,
    heroPosition: 'BTN' as const,
    raiserPosition: 'HJ' as const,
    anteType: 'per_player' as const,
    branch: 'cold_call' as const,
    stackBB: 25,
  };

  it.each(['incomplete', 'stale', 'warming'] as TournamentContextStatus[])(
    'labels an NLH %s context incomplete_context with zero shifts on a labeled fallback cell',
    (contextStatus) => {
      const policy = tournamentPreflopPolicy({ ...coordinate, gameFamily: 'nlh', contextStatus });
      expect(policy.source).toBe('labeled_fallback');
      expect(policy.fallbackReason).toBe('incomplete_context');
      expect(shiftsOf(policy)).toEqual(ZERO);
      expect(policy.branch).toBe('cold_call');
      expect(policy.depth).toEqual({ lower: 25, upper: 25, weight: 0 });
      expect(policy.cell).toBe(
        'phase6-v1:nlh:labeled_fallback:6:BTN:HJ:per_player:cold_call:25-25@0:velocity=0'
      );
    }
  );

  it('gives the complete NLH control nonzero shifts on the same coordinate', () => {
    const policy = tournamentPreflopPolicy({
      ...coordinate,
      gameFamily: 'nlh',
      contextStatus: 'complete',
    });
    expect(policy.source).toBe('deterministic_baseline');
    expect(policy.fallbackReason).toBeNull();
    // cold_call vs a hijack (neither early nor late), 6-max, per-player, 25bb: short 0.
    expect(shiftsOf(policy)).toEqual({ ...ZERO, call: 0.012, threeBet: 0.008 });
    expect(policy.cell).toBe(
      'phase6-v1:nlh:deterministic_baseline:6:BTN:HJ:per_player:cold_call:25-25@0:velocity=0'
    );
  });

  it.each(['omaha', 'other'] as const)(
    'never lets NLH evidence qualify the %s family: unsupported_variant even when complete',
    (gameFamily) => {
      const policy = tournamentPreflopPolicy({
        ...coordinate,
        gameFamily,
        contextStatus: 'complete',
      });
      expect(policy.source).toBe('labeled_fallback');
      expect(policy.fallbackReason).toBe('unsupported_variant');
      expect(shiftsOf(policy)).toEqual(ZERO);
      expect(policy.cell.startsWith(`phase6-v1:${gameFamily}:labeled_fallback:`)).toBe(true);
      expect(DOMAIN.gameFamilies.supported).not.toContain(gameFamily);
      expect(DOMAIN.gameFamilies.labeled).toContain(gameFamily);
    }
  );

  it('orders fallback reasons invalid_coordinate > unsupported_variant > incomplete_context', () => {
    expect(
      tournamentPreflopPolicy({ ...coordinate, gameFamily: 'omaha', contextStatus: 'warming' })
        .fallbackReason
    ).toBe('unsupported_variant');
    expect(
      tournamentPreflopPolicy({ ...coordinate, gameFamily: 'other', contextStatus: 'stale' })
        .fallbackReason
    ).toBe('unsupported_variant');
    const invalidOmaha = tournamentPreflopPolicy({
      ...coordinate,
      raiserPosition: 'UTG1',
      gameFamily: 'omaha',
      contextStatus: 'complete',
    });
    expect(invalidOmaha.fallbackReason).toBe('invalid_coordinate');
    expect(invalidOmaha.cell).toContain(':labeled_fallback:invalid-6:');
    const invalidAll = tournamentPreflopPolicy({
      ...coordinate,
      tableSize: 11,
      gameFamily: 'omaha',
      contextStatus: 'stale',
    });
    expect(invalidAll.fallbackReason).toBe('invalid_coordinate');
    expect(invalidAll.cell).toContain(':invalid-11:');
    expect(shiftsOf(invalidAll)).toEqual(ZERO);
    const noAuthority = tournamentPreflopPolicy({
      ...coordinate,
      tableSize: Number.NaN,
      gameFamily: 'nlh',
      contextStatus: 'complete',
    });
    expect(noAuthority.fallbackReason).toBe('invalid_coordinate');
    expect(noAuthority.cell).toContain(':invalid-NaN:');
    // The pure ring helper still answers a nine-ring for a non-finite size; only the lookup
    // labels that coordinate invalid (recon observation, recorded).
    expect(tournamentPositionsForTable(Number.NaN)).toHaveLength(9);
  });

  function decideWith(
    mutate: (state: ReturnType<typeof fixture>['state']) => void,
    variant?: 'plo4' | 'short_deck'
  ) {
    enableBrainTelemetry();
    drainFires();
    const f = fixture(7, 3, variant ?? 'nlh');
    mutate(f.state);
    const spy = vi.spyOn(TournamentPreflop, 'tournamentPreflopPolicy');
    try {
      seedFastRandom(901_791);
      const decision = HorseLogic.decide(f.hero, f.state, 'balanced', {}, f.opts);
      expect(spy).toHaveBeenCalledTimes(1);
      const input = spy.mock.calls[0][0];
      const policy = spy.mock.results[0].value as ReturnType<typeof tournamentPreflopPolicy>;
      const features = new Set(drainFires().map((row) => row.feature));
      return { decision, input, policy, features };
    } finally {
      spy.mockRestore();
    }
  }

  it.each(['incomplete', 'stale', 'warming'] as TournamentContextStatus[])(
    'HorseLogic routes an NLH %s context through the atlas as a labeled fallback with a receipt',
    (contextStatus) => {
      const { decision, input, policy, features } = decideWith((state) => {
        state.tournament!.contextStatus = contextStatus;
        state.tournament!.contextIssues = [
          TOURNAMENT_CONTEXT_INCOMPLETE,
          `tournament_context_${contextStatus}`,
        ];
      });
      expect(input.gameFamily).toBe('nlh');
      expect(input.contextStatus).toBe(contextStatus);
      expect(input.branch).toBe('unopened');
      expect(policy.source).toBe('labeled_fallback');
      expect(policy.fallbackReason).toBe('incomplete_context');
      expect(shiftsOf(policy)).toEqual(ZERO);
      expect(features.has('phase6_tournament_context_incomplete')).toBe(true);
      expect(features.has('phase6_tournament_preflop')).toBe(true);
      expect(features.has('phase6_route_atlas')).toBe(true);
      expect(features.has('phase6_atlas_fallback')).toBe(true);
      expect(features.has('phase6_atlas_baseline')).toBe(false);
      const receipt = decision.tournamentPreflopAttribution!;
      expect(receipt.reason).toBe('incomplete_context');
      expect(receipt.status).toBe('unavailable');
      expect(receipt.route).toBe('intent_engine');
      expect(receipt.lookup!.coordinate.contextStatus).toBe(contextStatus);
      expect(receipt.lookup!.policy.fallbackReason).toBe('incomplete_context');
      expect(horsePhase6AttributionIsValid(receipt)).toBe(true);
    }
  );

  it('HorseLogic gives the complete NLH control a baseline receipt on the same fixture', () => {
    const { decision, policy, features } = decideWith(() => {});
    expect(policy.source).toBe('deterministic_baseline');
    expect(policy.fallbackReason).toBeNull();
    expect(Object.values(policy.shifts).some((shift) => shift !== 0)).toBe(true);
    expect(features.has('phase6_tournament_context_complete')).toBe(true);
    expect(features.has('phase6_atlas_baseline')).toBe(true);
    const receipt = decision.tournamentPreflopAttribution!;
    expect(receipt.reason).toBe('atlas_forwarded');
    expect(receipt.status).toBe('atlas_evaluated');
  });

  it.each([
    ['plo4', 'omaha'],
    ['short_deck', 'other'],
  ] as const)(
    'HorseLogic maps %s to the %s family and takes the named variant fallback, not the atlas',
    (variant, gameFamily) => {
      const { decision, input, policy, features } = decideWith(() => {}, variant);
      expect(input.gameFamily).toBe(gameFamily);
      expect(input.contextStatus).toBe('complete');
      expect(policy.source).toBe('labeled_fallback');
      expect(policy.fallbackReason).toBe('unsupported_variant');
      expect(shiftsOf(policy)).toEqual(ZERO);
      expect(features.has('phase6_route_variant_fallback')).toBe(true);
      expect(features.has('phase6_route_atlas')).toBe(false);
      expect(features.has('phase6_atlas_baseline')).toBe(false);
      const receipt = decision.tournamentPreflopAttribution!;
      expect(receipt.reason).toBe('unsupported_variant');
      expect(receipt.status).toBe('unavailable');
      expect(receipt.lookup!.coordinate.gameFamily).toBe(gameFamily);
    }
  );

  it('refuses a receipt whose atlas revision or coordinate leaves the pinned domain', () => {
    const s = withPhase6Provenance(request());
    seedFastRandom(901_791);
    const decision = HorseLogic.decide(s.player, s.gameState, 'balanced', {}, fixture().opts);
    const receipt = decision.tournamentPreflopAttribution!;
    expect(receipt.version).toBe('horse-phase6-attribution-v2');
    expect(receipt.inputSource.atlasRevision).toBe(DOMAIN.atlasRevision);
    expect(horsePhase6AttributionIsValid(receipt)).toBe(true);

    const revision = structuredClone(receipt) as { inputSource: { atlasRevision: string } };
    revision.inputSource.atlasRevision = 'horse-tournament-preflop-v2';
    expect(horsePhase6AttributionIsValid(revision)).toBe(false);

    const size = structuredClone(receipt);
    size.lookup!.coordinate.tableSize = 11;
    expect(horsePhase6AttributionIsValid(size)).toBe(false);

    const ante = structuredClone(receipt) as { lookup: { coordinate: { anteType: string } } };
    ante.lookup.coordinate.anteType = 'button';
    expect(horsePhase6AttributionIsValid(ante)).toBe(false);

    const branch = structuredClone(receipt) as { lookup: { coordinate: { branch: string } } };
    branch.lookup.coordinate.branch = 'four_bet_facing';
    expect(horsePhase6AttributionIsValid(branch)).toBe(false);

    // A rejected receipt authorises nothing: the lookup itself still answers the valid
    // coordinate identically, and an invalid coordinate still answers zero shifts.
    expect(shiftsOf(lookup({ tableSize: 11 }))).toEqual(ZERO);
    expect(lookup({ tableSize: 11 }).fallbackReason).toBe('invalid_coordinate');
  });
});
