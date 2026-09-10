import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decidePreflopV7, type PreflopCtx } from './HorsePreflop.js';
import {
  HorseLogic,
  bubblePressure,
  endgameAdjust,
  headBountyScale,
  prizeLandscapeScale,
  satelliteRead,
} from './HorseLogic.js';
import { drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
import {
  TOURNAMENT_CONTEXT_INCOMPLETE,
  TOURNAMENT_CORE_DEPTHS,
  TOURNAMENT_PREFLOP_BRANCHES,
  TOURNAMENT_TABLE_SIZES,
  buildTournamentMState,
  classifyTournamentPreflopBranch,
  interpolateTournamentDepth,
  tournamentMZone,
  tournamentPositionForSeat,
  tournamentPositionsForTable,
  tournamentPreflopPolicy,
  type TournamentMState,
  type TournamentPreflopBranch,
  type TournamentPosition,
} from './HorseTournamentPreflop.js';
import { deriveBlindState, deriveContext } from '../services/TournamentBrainContext.js';
import { spinBlindsForLevel } from '../config/spinSpec.js';

const here = dirname(fileURLToPath(import.meta.url));

function completeTournamentRow(nowMs: number) {
  return {
    tournament_type: 'MTT',
    status: 'RUNNING',
    game_type: 'NLH',
    variant: 'freezeout',
    max_players: 200,
    table_size: 8,
    payout_structure: JSON.stringify([
      { place: 1, percentage: 50 },
      { place: 2, percentage: 30 },
      { place: 3, percentage: 20 },
    ]),
    prize_pool: 10_000,
    bounty_pool: 0,
    buy_in_amount: 90,
    buy_in_fee: 10,
    starting_chips: 5000,
    rebuy_cost: 100,
    rebuy_chips: 5000,
    is_pko: false,
    is_bounty: false,
    is_mystery_bounty: false,
    blind_structure: JSON.stringify([
      { level: 1, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 10 },
      { level: 2, smallBlind: 100, bigBlind: 200, ante: 20, durationMinutes: 10 },
    ]),
    // Production current_level is a zero-based array index.
    current_level: 0,
    level_started_at: new Date(nowMs - 2 * 60_000).toISOString(),
    started_at: new Date(nowMs - 8 * 60_000).toISOString(),
    late_reg_mins: 30,
    late_reg_levels: 2,
    is_reentry: true,
    max_reentries: 1,
    is_rebuy: false,
    rebuy_levels: 0,
    max_rebuys: 0,
    add_on_available: true,
    addon_cost: 100,
    addon_chips: 5000,
    addon_levels: 1,
    addon_period_triggered: true,
    addon_period_started_at: new Date(nowMs - 60_000).toISOString(),
    addon_period_ends_at: new Date(nowMs + 60_000).toISOString(),
    prize_pool_finalized: false,
    on_break: false,
    accelerated_mtt: false,
    big_blind_ante: true,
    authorized_to_register: true,
    satellite_seats: 0,
    satellite_target_id: null,
    satellite_target: null,
  };
}

describe('Phase 6 tournament context', () => {
  it('parses the production text-JSON blind schedule and validates the complete context', () => {
    const nowMs = Date.parse('2026-09-09T18:00:00.000Z');
    const context = deriveContext(
      completeTournamentRow(nowMs),
      4,
      20,
      10_000,
      [1000, 2000, 3000, 4000],
      [],
      [],
      0,
      {},
      nowMs
    );

    expect(context.contextStatus).toBe('complete');
    expect(context.contextIssues).toEqual([]);
    expect(context.gameVariant).toBe('nlh');
    expect(context.currentLevel).toBe(0);
    expect(context.currentSmallBlind).toBe(50);
    expect(context.currentBigBlind).toBe(100);
    expect(context.currentAnte).toBe(10);
    expect(context.anteType).toBe('big_blind');
    expect(context.nextSmallBlind).toBe(100);
    expect(context.nextBigBlind).toBe(200);
    expect(context.nextAnte).toBe(20);
    expect(context.nextBlindInMin).toBe(8);
    expect(context.nextBlindMult).toBe(2);
    expect(context.avgStackChips).toBe(2500);
    expect(context.medianStackChips).toBe(2500);
    expect(context.registrationOpen).toBe(true);
    expect(context.lateRegistrationOpen).toBe(true);
    expect(context.registrationRequiresAuthorization).toBe(true);
    expect(context.isPko).toBe(false);
    expect(context.isMysteryBounty).toBe(false);
    expect(context.reentryAllowed).toBe(true);
    expect(context.reentryOpen).toBe(true);
    expect(context.rebuyOpen).toBe(false);
    expect(context.addOnAvailable).toBe(true);
    expect(context.addOnPeriodOpen).toBe(true);
    expect(context.addOnCost).toBe(100);
    expect(context.addOnChips).toBe(5000);
    expect(context.prizePoolCents).toBe(1_000_000);
    expect(context.bountyPoolCents).toBe(0);
    expect(context.buyInCents).toBe(10_000);
    expect(context.startingStackChips).toBe(5000);
    expect(context.rebuyCostCents).toBe(10_000);
    expect(context.rebuyChips).toBe(5000);
    expect(context.rebuyPrizeContributionCents).toBe(9000);
    expect(context.rebuyBountyContributionCents).toBe(0);
    expect(context.reloadsByUser).toEqual({});
    expect(context.addOnTakenByUser).toEqual({});
    expect(context.rebuyAffordableByUser).toEqual({});
    expect(context.addOnAffordableByUser).toEqual({});
    expect(context.handForHandExpected).toBe(false);
  });

  it('carries personal reload and add-on usage without inferring eligibility from the global window', () => {
    const nowMs = Date.parse('2026-09-09T18:00:00.000Z');
    const context = deriveContext(
      completeTournamentRow(nowMs),
      4,
      20,
      10_000,
      [1000, 2000, 3000, 4000],
      [],
      [],
      0,
      {},
      nowMs,
      undefined,
      {
        reloadsByUser: { hero: 1, villain: 0 },
        addOnTakenByUser: { hero: true, villain: false },
        rebuyAffordableByUser: { hero: false, villain: true },
        addOnAffordableByUser: { hero: true, villain: false },
      }
    );

    expect(context.reloadsByUser).toEqual({ hero: 1, villain: 0 });
    expect(context.addOnTakenByUser).toEqual({ hero: true, villain: false });
    expect(context.rebuyAffordableByUser).toEqual({ hero: false, villain: true });
    expect(context.addOnAffordableByUser).toEqual({ hero: true, villain: false });
  });

  it('preserves every observed field stack and every payout place for Phase 7 ICM', () => {
    const nowMs = Date.parse('2026-09-09T18:00:00.000Z');
    const row = completeTournamentRow(nowMs);
    row.payout_structure = JSON.stringify(
      Array.from({ length: 25 }, (_, index) => ({
        place: index + 1,
        percentage: index < 24 ? 3.9 : 6.4,
      }))
    );
    const liveStacks = Array.from({ length: 250 }, (_, index) => 10_000 - index * 17);
    const context = deriveContext(
      row,
      250,
      250,
      liveStacks.reduce((sum, stack) => sum + stack, 0),
      liveStacks,
      [],
      [],
      0,
      {},
      nowMs
    );

    expect(context.stacks).toHaveLength(250);
    expect(context.stacks).toEqual([...liveStacks].sort((left, right) => right - left));
    expect(context.payoutPct).toHaveLength(25);
    expect(context.payoutPct.reduce((sum, payout) => sum + payout, 0)).toBeCloseTo(100, 10);
  });

  it('keeps registration timing separate from the club-approval requirement', () => {
    const nowMs = Date.parse('2026-09-09T18:00:00.000Z');
    const row = completeTournamentRow(nowMs);
    row.authorized_to_register = false;
    const context = deriveContext(
      row,
      4,
      20,
      10_000,
      [1000, 2000, 3000, 4000],
      [],
      [],
      0,
      {},
      nowMs
    );

    expect(context.registrationOpen).toBe(true);
    expect(context.lateRegistrationOpen).toBe(true);
    expect(context.registrationRequiresAuthorization).toBe(false);
  });

  it('matches the authoritative level boundaries and closes every entry window after finalization', () => {
    const nowMs = Date.parse('2026-09-09T18:00:00.000Z');
    const row = completeTournamentRow(nowMs);
    row.is_rebuy = true;
    row.rebuy_levels = 2;
    row.current_level = 2;
    row.add_on_available = false;
    const boundary = deriveContext(
      row,
      4,
      20,
      10_000,
      [1000, 2000, 3000, 4000],
      [],
      [],
      0,
      {},
      nowMs
    );
    expect(boundary.lateRegistrationOpen).toBe(false);
    expect(boundary.reentryOpen).toBe(false);
    expect(boundary.rebuyOpen).toBe(false);

    row.current_level = 1;
    row.add_on_available = true;
    row.prize_pool_finalized = true;
    const finalized = deriveContext(
      row,
      4,
      20,
      10_000,
      [1000, 2000, 3000, 4000],
      [],
      [],
      0,
      {},
      nowMs
    );
    expect(finalized.registrationOpen).toBe(false);
    expect(finalized.reentryOpen).toBe(false);
    expect(finalized.rebuyOpen).toBe(false);
    expect(finalized.addOnPeriodOpen).toBe(false);
  });

  it('labels missing tournament inputs instead of silently presenting a cash-like object', () => {
    const context = deriveContext(
      {
        tournament_type: null,
        variant: null,
        max_players: null,
        table_size: null,
        payout_structure: null,
        prize_pool: null,
        bounty_pool: null,
        is_pko: null,
        is_bounty: null,
      },
      0,
      0,
      0
    );
    expect(context.contextStatus).toBe('incomplete');
    expect(context.contextIssues[0]).toBe(TOURNAMENT_CONTEXT_INCOMPLETE);
    expect(context.contextIssues).toContain('blind_structure_or_level_invalid');
    expect(context.contextIssues).toContain('player_population_invalid');
    expect(context.contextIssues).toContain('payout_or_ticket_structure_missing');
  });

  it('accepts canonical snake-case levels and treats duration as seconds for Spins', () => {
    const nowMs = Date.parse('2026-09-09T18:00:00.000Z');
    const row = completeTournamentRow(nowMs);
    row.blind_structure = JSON.stringify([
      { level: 1, small_blind: 10, big_blind: 20, ante: 0, duration: 180 },
      { level: 2, small_blind: 15, big_blind: 30, ante: 0, duration_minutes: 4 },
    ]);
    row.level_started_at = new Date(nowMs - 60_000).toISOString();
    const context = deriveContext(
      row,
      4,
      20,
      10_000,
      [1000, 2000, 3000, 4000],
      [],
      [],
      0,
      {},
      nowMs
    );

    expect(context.currentSmallBlind).toBe(10);
    expect(context.currentBigBlind).toBe(20);
    expect(context.levelDurationMin).toBe(3);
    expect(context.nextBlindInMin).toBe(2);
    expect(context.nextSmallBlind).toBe(15);
    expect(context.nextBigBlind).toBe(30);
  });

  it('accepts the original sb/bb/duration_mins aliases at zero-based level zero', () => {
    const nowMs = Date.parse('2026-09-09T18:00:00.000Z');
    const state = deriveBlindState(
      JSON.stringify([
        { level: 1, sb: 25, bb: 50, ante: 5, duration_mins: 8 },
        { level: 2, sb: 50, bb: 100, ante: 10, duration_mins: 8 },
      ]),
      0,
      new Date(nowMs - 90_000).toISOString(),
      nowMs
    );
    expect(state).toMatchObject({
      currentLevel: 0,
      currentSmallBlind: 25,
      currentBigBlind: 50,
      currentAnte: 5,
      nextSmallBlind: 50,
      nextBigBlind: 100,
      nextAnte: 10,
      levelDurationMin: 8,
      levelElapsedMin: 1.5,
      nextBlindInMin: 6.5,
      timingStatus: 'complete',
      levelIndexValid: true,
    });
  });

  it('continues generic and legacy Spin schedules deterministically after their stored rows', () => {
    const nowMs = Date.parse('2026-09-09T18:00:00.000Z');
    const generic = deriveBlindState(
      [{ level: 1, smallBlind: 50, bigBlind: 100, durationMinutes: 10 }],
      1,
      new Date(nowMs - 60_000).toISOString(),
      nowMs
    );
    expect(generic.levelIndexValid).toBe(true);
    expect(generic.currentBigBlind).toBeGreaterThan(100);
    expect(
      deriveBlindState(
        [{ level: 1, smallBlind: 50, bigBlind: 100, durationMinutes: 10 }],
        1,
        new Date(nowMs - 60_000).toISOString(),
        nowMs
      ).currentBigBlind
    ).toBe(generic.currentBigBlind);

    const legacySpin = deriveBlindState(
      [{ level: 10, smallBlind: 105, bigBlind: 210, duration: 180 }],
      10,
      new Date(nowMs - 60_000).toISOString(),
      nowMs,
      { isSpin: true }
    );
    const expected = spinBlindsForLevel(11);
    expect(legacySpin).toMatchObject({
      currentLevel: 10,
      currentSmallBlind: expected.small,
      currentBigBlind: expected.big,
      currentAnte: 0,
      timingStatus: 'complete',
    });

    const corruptFrozenSpin = deriveBlindState(
      [
        {
          level: 12,
          smallBlind: 200,
          bigBlind: 400,
          duration: 180,
          spinContinuation: { version: 1, anchorLevel: 12 },
        },
      ],
      12,
      new Date(nowMs - 60_000).toISOString(),
      nowMs,
      { isSpin: true }
    );
    expect(corruptFrozenSpin.levelIndexValid).toBe(false);
    expect(corruptFrozenSpin.timingStatus).toBe('missing');
  });

  it.each([
    ['missing', null, false],
    ['future', new Date(Date.parse('2026-09-09T18:01:00.000Z')).toISOString(), false],
    ['stale', new Date(Date.parse('2026-09-09T17:20:00.000Z')).toISOString(), false],
    ['paused', new Date(Date.parse('2026-09-09T17:59:00.000Z')).toISOString(), true],
  ] as const)(
    'preserves known blind facts while labeling a %s level clock',
    (expectedStatus, levelStartedAt, onBreak) => {
      const nowMs = Date.parse('2026-09-09T18:00:00.000Z');
      const state = deriveBlindState(
        [
          { level: 1, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 10 },
          { level: 2, smallBlind: 100, bigBlind: 200, ante: 20, durationMinutes: 10 },
        ],
        0,
        levelStartedAt,
        nowMs,
        { onBreak }
      );
      expect(state.currentSmallBlind).toBe(50);
      expect(state.currentBigBlind).toBe(100);
      expect(state.nextBigBlind).toBe(200);
      expect(state.timingStatus).toBe(expectedStatus);
      expect(state.levelIndexValid).toBe(true);
    }
  );

  it('derives finalized satellite depth only from immutable entitlement rows', () => {
    const nowMs = Date.parse('2026-09-09T18:00:00.000Z');
    const row = {
      ...completeTournamentRow(nowMs),
      variant: 'satellite',
      satellite_seats: 9,
      satellite_target_id: 'target-tournament',
      prize_pool_finalized: true,
    };
    const context = deriveContext(
      row,
      10,
      20,
      20_000,
      Array.from({ length: 10 }, (_, index) => 1100 + index * 200),
      [],
      [],
      0,
      {},
      nowMs,
      {
        mysteryInventory: 'known',
        satelliteEntitlements: 'known',
        entitlementRows: [
          { position: 1, award_kind: 'seat_or_cash', ticket_value: 100, remainder_value: 0 },
          { position: 2, award_kind: 'seat_or_cash', ticket_value: 100, remainder_value: 0 },
          { position: 3, award_kind: 'cash', ticket_value: 0, remainder_value: 20 },
        ],
      }
    );
    expect(context.contextStatus).toBe('complete');
    expect(context.satellite).toBe(true);
    expect(context.satelliteSeats).toBe(2);
    expect(context.spotsPaid).toBe(3);
    expect(context.payoutPct).toHaveLength(3);
    expect(context.payoutPct[0]).toBeCloseTo(100 / 2.2, 12);
    expect(context.payoutPct[1]).toBeCloseTo(100 / 2.2, 12);
    expect(context.payoutPct[2]).toBeCloseTo(20 / 2.2, 12);
  });

  it('labels provisional satellite and mystery reads incomplete and keeps them out of strategy', () => {
    const nowMs = Date.parse('2026-09-09T18:00:00.000Z');
    const row = {
      ...completeTournamentRow(nowMs),
      variant: 'satellite',
      satellite_seats: 3,
      satellite_target_id: 'target-tournament',
      prize_pool_finalized: false,
      is_mystery_bounty: true,
      mystery_bounty_stage: 'active',
    };
    const context = deriveContext(
      row,
      6,
      20,
      12_000,
      [1000, 1500, 1800, 2100, 2500, 3100],
      [],
      [],
      0,
      {},
      nowMs,
      {
        mysteryInventory: 'read_failed',
        satelliteEntitlements: 'read_failed',
        entitlementRows: [],
      }
    );
    expect(context.contextStatus).toBe('incomplete');
    expect(context.contextIssues).toEqual(
      expect.arrayContaining([
        TOURNAMENT_CONTEXT_INCOMPLETE,
        'satellite_entitlement_read_failed',
        'satellite_award_depth_unavailable',
        'mystery_bounty_inventory_unavailable',
      ])
    );
    const hero = {
      seat: 1,
      user_id: 'hero',
      username: 'Hero',
      stack: 5000,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    };
    expect(
      satelliteRead(
        {
          gameMode: 'tournament',
          format: 'mtt',
          bigBlind: 100,
          tournament: context,
          players: [
            hero,
            { ...hero, seat: 2, user_id: 'villain', username: 'Villain', stack: 1000 },
          ],
        } as never,
        hero,
        50
      ).active
    ).toBe(false);
  });

  it('keeps every legacy tournament strategy reader off an incomplete schema-v1 snapshot', () => {
    const hero = {
      seat: 1,
      user_id: 'hero',
      username: 'Hero',
      stack: 5000,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    };
    const villains = [
      { ...hero, seat: 2, user_id: 'v-1', username: 'V1', stack: 1000 },
      { ...hero, seat: 3, user_id: 'v-2', username: 'V2', stack: 800 },
    ];
    const gs = {
      gameMode: 'tournament',
      format: 'mtt',
      bigBlind: 100,
      ante: 0,
      players: [hero, ...villains],
      tournament: {
        schemaVersion: 1,
        contextStatus: 'incomplete',
        contextIssues: [TOURNAMENT_CONTEXT_INCOMPLETE, 'payout_or_ticket_structure_missing'],
        playersLeft: 11,
        spotsPaid: 10,
        inMoney: true,
        finalTable: true,
        stacks: [5000, 1000, 800],
        satellite: true,
        satelliteSeats: 10,
        bountyFactor: 0.5,
        meanBountyCents: 1000,
        mysteryMeanCents: 1000,
        mysteryTopCents: 10_000,
        mysteryTopLive: true,
        mysteryChestsLeft: 10,
        bountyByUser: { 'v-1': 3000 },
      },
    } as never;

    expect(satelliteRead(gs, hero, 50).active).toBe(false);
    expect(prizeLandscapeScale(gs)).toBe(1);
    expect(headBountyScale(gs, 'v-1')).toBe(1);
    expect(bubblePressure(gs, hero, 2)).toBe(0);
    expect(endgameAdjust(0.05, gs, 50, true)).toBe(0.05);
  });

  it('expects hand-for-hand only at an actual multi-table MTT stone bubble', () => {
    const nowMs = Date.parse('2026-09-09T18:00:00.000Z');
    const paidNine = Array.from({ length: 9 }, (_, index) => ({
      place: index + 1,
      percentage: 100 / 9,
    }));
    const row = { ...completeTournamentRow(nowMs), payout_structure: JSON.stringify(paidNine) };
    const multiTable = deriveContext(
      row,
      10,
      30,
      20_000,
      Array.from({ length: 10 }, () => 2000),
      [],
      [],
      0,
      {},
      nowMs
    );
    expect(multiTable.handForHandExpected).toBe(true);

    const oneTableRow = { ...row, table_size: 10 };
    const oneTable = deriveContext(
      oneTableRow,
      10,
      30,
      20_000,
      Array.from({ length: 10 }, () => 2000),
      [],
      [],
      0,
      {},
      nowMs
    );
    expect(oneTable.handForHandExpected).toBe(false);
  });
});

describe('Phase 6 M engine', () => {
  it('computes real, short-handed effective, projected, velocity, and covered-opponent M', () => {
    const state = buildTournamentMState({
      stackChips: 2300,
      smallBlind: 50,
      bigBlind: 100,
      ante: 10,
      anteType: 'big_blind',
      playersAtTable: 8,
      nextSmallBlind: 100,
      nextBigBlind: 200,
      nextAnte: 20,
      minutesToNextLevel: 2,
      opponentStacks: [
        { userId: 'short', stackChips: 1000 },
        { userId: 'almost', stackChips: 2000 },
        { userId: 'cover-1', stackChips: 3000 },
        { userId: 'cover-2', stackChips: 5000 },
      ],
    });

    expect(state.orbitCostChips).toBe(230);
    expect(state.realM).toBe(10);
    expect(state.effectiveM).toBe(8);
    expect(state.projectedOrbitCostChips).toBe(460);
    expect(state.projectedM).toBe(5);
    expect(state.projectedEffectiveM).toBe(4);
    expect(state.projectedStackBB).toBe(11.5);
    expect(state.velocityMPerMinute).toBe(2);
    expect(state.coveringOpponentM).toBeCloseTo(3000 / 230, 8);
    expect(state.coveringOpponents).toEqual([
      {
        userId: 'cover-1',
        stackChips: 3000,
        realM: 3000 / 230,
        effectiveM: (3000 / 230) * 0.8,
      },
      {
        userId: 'cover-2',
        stackChips: 5000,
        realM: 5000 / 230,
        effectiveM: (5000 / 230) * 0.8,
      },
    ]);
    expect(state.zone).toBe('orange');
  });

  it('uses the exact big-blind-ante total convention instead of multiplying an authored total', () => {
    const state = buildTournamentMState({
      stackChips: 3900,
      smallBlind: 50,
      bigBlind: 100,
      ante: 100,
      anteType: 'big_blind',
      playersAtTable: 8,
    });
    expect(state.orbitCostChips).toBe(250);
    expect(state.realM).toBeCloseTo(15.6, 8);
  });

  it('holds a half-M hysteresis band so one chip cannot bounce a zone', () => {
    expect(tournamentMZone(4.99, 'orange')).toBe('orange');
    expect(tournamentMZone(4.5, 'orange')).toBe('orange');
    expect(tournamentMZone(4.49, 'orange')).toBe('red');
    expect(tournamentMZone(5.01, 'red')).toBe('red');
    expect(tournamentMZone(5.5, 'red')).toBe('orange');
    expect(tournamentMZone(9.8, 'green')).toBe('orange');
    expect(tournamentMZone(21, 'red')).toBe('green');
  });

  it('covers every Harrington boundary and every ante convention', () => {
    expect([
      [0, tournamentMZone(0)],
      [0.999, tournamentMZone(0.999)],
      [1, tournamentMZone(1)],
      [4.999, tournamentMZone(4.999)],
      [5, tournamentMZone(5)],
      [9.999, tournamentMZone(9.999)],
      [10, tournamentMZone(10)],
      [19.999, tournamentMZone(19.999)],
      [20, tournamentMZone(20)],
      [39.999, tournamentMZone(39.999)],
      [40, tournamentMZone(40)],
    ]).toEqual([
      [0, 'dead'],
      [0.999, 'dead'],
      [1, 'red'],
      [4.999, 'red'],
      [5, 'orange'],
      [9.999, 'orange'],
      [10, 'yellow'],
      [19.999, 'yellow'],
      [20, 'green'],
      [39.999, 'green'],
      [40, 'blue'],
    ]);

    const base = {
      stackChips: 10_000,
      smallBlind: 50,
      bigBlind: 100,
      ante: 10,
      playersAtTable: 8,
    };
    expect(buildTournamentMState({ ...base, anteType: 'none' }).orbitCostChips).toBe(150);
    expect(buildTournamentMState({ ...base, anteType: 'per_player' }).orbitCostChips).toBe(230);
    expect(
      buildTournamentMState({ ...base, ante: 100, anteType: 'big_blind' }).orbitCostChips
    ).toBe(250);
  });
});

describe('Phase 6 exact position and action branches', () => {
  it('labels every seat in ten-handed, nine-handed, and heads-up rings', () => {
    const tenSeats = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(tenSeats.map((seat) => tournamentPositionForSeat(seat, 10, tenSeats))).toEqual([
      'SB',
      'BB',
      'UTG',
      'UTG1',
      'UTG2',
      'UTG3',
      'MP',
      'HJ',
      'CO',
      'BTN',
    ]);
    const seats = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(seats.map((seat) => tournamentPositionForSeat(seat, 9, seats))).toEqual([
      'SB',
      'BB',
      'UTG',
      'UTG1',
      'UTG2',
      'MP',
      'HJ',
      'CO',
      'BTN',
    ]);
    expect(tournamentPositionForSeat(5, 5, [2, 5])).toBe('SB');
    expect(tournamentPositionForSeat(2, 5, [2, 5])).toBe('BB');
  });

  it('uses the independently specified canonical ring for every supported table size', () => {
    const expected: Record<number, TournamentPosition[]> = {
      2: ['SB', 'BB'],
      3: ['SB', 'BB', 'BTN'],
      4: ['SB', 'BB', 'CO', 'BTN'],
      5: ['SB', 'BB', 'HJ', 'CO', 'BTN'],
      6: ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'],
      7: ['SB', 'BB', 'UTG', 'MP', 'HJ', 'CO', 'BTN'],
      8: ['SB', 'BB', 'UTG', 'UTG1', 'MP', 'HJ', 'CO', 'BTN'],
      9: ['SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'MP', 'HJ', 'CO', 'BTN'],
      10: ['SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'UTG3', 'MP', 'HJ', 'CO', 'BTN'],
    };
    for (const tableSize of TOURNAMENT_TABLE_SIZES) {
      expect([...tournamentPositionsForTable(tableSize)]).toEqual(expected[tableSize]);
    }
  });

  it('has a reachable classifier case for every required branch', () => {
    const base = {
      raises: 0,
      limpers: 0,
      callers: 0,
      callersOfPreviousRaise: 0,
      opponentsAllIn: 0,
      opponentsLeft: 5,
      stackBB: 40,
      mZone: 'green' as TournamentMState['zone'],
      heroPosition: 'HJ' as TournamentPosition,
      raiserPosition: null as TournamentPosition | null,
      heroPreviouslyActed: false,
      heroWasInitialRaiser: false,
      squeezed: false,
    };
    const cases: Record<TournamentPreflopBranch, Partial<typeof base>> = {
      unopened: {},
      limp_facing: { limpers: 1 },
      open_facing: {
        raises: 1,
        heroPreviouslyActed: true,
        raiserPosition: 'UTG',
      },
      three_bet_facing: { raises: 2 },
      cold_call: { raises: 1, raiserPosition: 'UTG' },
      overcall: { raises: 1, callers: 1, raiserPosition: 'UTG' },
      squeeze: {
        raises: 1,
        callers: 1,
        heroPosition: 'BTN',
        raiserPosition: 'HJ',
      },
      reshove: {
        raises: 1,
        callers: 1,
        stackBB: 18,
        mZone: 'yellow',
        raiserPosition: 'BTN',
      },
      blind_vs_blind: { heroPosition: 'SB', opponentsLeft: 1 },
      bb_defense: {
        raises: 1,
        heroPosition: 'BB',
        raiserPosition: 'SB',
        opponentsLeft: 1,
      },
      multiway_all_in: { raises: 2, opponentsAllIn: 2 },
    };
    for (const branch of TOURNAMENT_PREFLOP_BRANCHES) {
      expect(classifyTournamentPreflopBranch({ ...base, ...cases[branch] }), branch).toBe(branch);
    }

    expect(
      classifyTournamentPreflopBranch({
        ...base,
        raises: 1,
        opponentsAllIn: 1,
        opponentsLeft: 2,
      })
    ).toBe('multiway_all_in');

    // A short blind that posted all-in is not, by itself, a multiway call-off.
    expect(
      classifyTournamentPreflopBranch({
        ...base,
        opponentsAllIn: 1,
        opponentsLeft: 5,
      })
    ).toBe('unopened');

    for (const stackBB of [24.99, 25.01]) {
      expect(
        classifyTournamentPreflopBranch({
          ...base,
          raises: 1,
          callers: 1,
          stackBB,
          mZone: 'yellow',
          raiserPosition: 'BTN',
        })
      ).toBe('reshove');
    }
  });
});

describe('Phase 6 total preflop atlas', () => {
  it('returns a baseline for every valid coordinate and a labeled fallback for impossible pairs', () => {
    let cells = 0;
    const invalid: string[] = [];
    for (const tableSize of TOURNAMENT_TABLE_SIZES) {
      const positions = tournamentPositionsForTable(tableSize);
      for (const heroPosition of positions) {
        for (const raiserPosition of [
          null,
          ...positions.filter((position) => position !== heroPosition),
        ]) {
          for (const anteType of ['none', 'per_player', 'big_blind'] as const) {
            for (const branch of TOURNAMENT_PREFLOP_BRANCHES) {
              for (const stackBB of TOURNAMENT_CORE_DEPTHS) {
                const policy = tournamentPreflopPolicy({
                  gameFamily: 'nlh',
                  contextStatus: 'complete',
                  tableSize,
                  heroPosition,
                  raiserPosition,
                  anteType,
                  branch,
                  stackBB,
                });
                if (
                  policy.source !== 'deterministic_baseline' ||
                  policy.fallbackReason !== null ||
                  policy.depth.lower !== stackBB ||
                  policy.depth.upper !== stackBB ||
                  policy.depth.weight !== 0 ||
                  !policy.cell.includes(`:${branch}:`) ||
                  Object.values(policy.shifts).some((shift) => !Number.isFinite(shift))
                ) {
                  invalid.push(policy.cell);
                }
                cells++;
              }
            }
          }
        }
      }
    }
    expect(invalid).toEqual([]);
    // sum(2^2..10^2) valid hero/raiser pairs x 3 antes x 11 branches x 17 depths
    expect(cells).toBe(215_424);

    for (const tableSize of TOURNAMENT_TABLE_SIZES) {
      for (const heroPosition of tournamentPositionsForTable(tableSize)) {
        const impossible = tournamentPreflopPolicy({
          gameFamily: 'nlh',
          contextStatus: 'complete',
          tableSize,
          heroPosition,
          raiserPosition: heroPosition,
          anteType: 'none',
          branch: 'open_facing',
          stackBB: 20,
        });
        expect(impossible.source).toBe('labeled_fallback');
        expect(impossible.fallbackReason).toBe('invalid_coordinate');
        expect(Object.values(impossible.shifts)).toEqual([0, 0, 0, 0, 0]);
      }
    }
  });

  it('labels non-NLH and incomplete-context cells without claiming solver coverage', () => {
    const base = {
      tableSize: 6,
      heroPosition: 'BTN' as TournamentPosition,
      raiserPosition: 'HJ' as TournamentPosition,
      anteType: 'per_player' as const,
      branch: 'cold_call' as const,
      stackBB: 25,
    };
    const omaha = tournamentPreflopPolicy({
      ...base,
      gameFamily: 'omaha',
      contextStatus: 'complete',
    });
    expect(omaha.source).toBe('labeled_fallback');
    expect(omaha.fallbackReason).toBe('unsupported_variant');
    expect(Object.values(omaha.shifts)).toEqual([0, 0, 0, 0, 0]);

    const warming = tournamentPreflopPolicy({
      ...base,
      gameFamily: 'nlh',
      contextStatus: 'warming',
    });
    expect(warming.source).toBe('labeled_fallback');
    expect(warming.fallbackReason).toBe('incomplete_context');
  });

  it('labels out-of-domain table sizes and positions as invalid coordinates', () => {
    const invalidInputs = [
      { tableSize: 1, heroPosition: 'SB' as const, raiserPosition: 'BB' as const },
      { tableSize: 11, heroPosition: 'BTN' as const, raiserPosition: 'BB' as const },
      { tableSize: Number.NaN, heroPosition: 'BTN' as const, raiserPosition: null },
      { tableSize: 6, heroPosition: 'UTG1' as const, raiserPosition: 'BB' as const },
      { tableSize: 6, heroPosition: 'BTN' as const, raiserPosition: 'UTG1' as const },
    ];
    for (const input of invalidInputs) {
      const policy = tournamentPreflopPolicy({
        gameFamily: 'nlh',
        contextStatus: 'complete',
        anteType: 'none',
        branch: 'open_facing',
        stackBB: 20,
        ...input,
      });
      expect(policy.source).toBe('labeled_fallback');
      expect(policy.fallbackReason).toBe('invalid_coordinate');
      expect(Object.values(policy.shifts)).toEqual([0, 0, 0, 0, 0]);
    }
  });

  it('preserves the baseline strategic direction of the named branches', () => {
    const read = (branch: TournamentPreflopBranch, heroPosition: TournamentPosition = 'BTN') =>
      tournamentPreflopPolicy({
        gameFamily: 'nlh',
        contextStatus: 'complete',
        tableSize: 8,
        heroPosition,
        raiserPosition: 'HJ',
        anteType: 'big_blind',
        branch,
        stackBB: 18,
      });

    expect(read('blind_vs_blind', 'SB').shifts.open).toBeLessThan(read('unopened').shifts.open);
    expect(read('multiway_all_in').shifts.call).toBeGreaterThan(read('open_facing').shifts.call);
    expect(read('cold_call').shifts.call).toBeGreaterThan(read('open_facing').shifts.call);
    const early = tournamentPreflopPolicy({
      gameFamily: 'nlh',
      contextStatus: 'complete',
      tableSize: 8,
      heroPosition: 'BTN',
      raiserPosition: 'UTG',
      anteType: 'big_blind',
      branch: 'reshove',
      stackBB: 18,
    });
    expect(early.shifts.jam).toBeGreaterThan(read('reshove').shifts.jam);
  });

  it('interpolates continuously across every core-depth boundary', () => {
    for (const boundary of TOURNAMENT_CORE_DEPTHS.slice(1, -1)) {
      const left = tournamentPreflopPolicy({
        gameFamily: 'nlh',
        contextStatus: 'complete',
        tableSize: 8,
        heroPosition: 'BTN',
        raiserPosition: 'HJ',
        anteType: 'big_blind',
        branch: 'reshove',
        stackBB: boundary - 0.01,
      });
      const right = tournamentPreflopPolicy({
        gameFamily: 'nlh',
        contextStatus: 'complete',
        tableSize: 8,
        heroPosition: 'BTN',
        raiserPosition: 'HJ',
        anteType: 'big_blind',
        branch: 'reshove',
        stackBB: boundary + 0.01,
      });
      for (const key of Object.keys(left.shifts) as Array<keyof typeof left.shifts>) {
        expect(Math.abs(left.shifts[key] - right.shifts[key]), `${boundary}bb ${key}`).toBeLessThan(
          0.001
        );
      }
      expect(interpolateTournamentDepth(boundary)).toEqual({
        lower: boundary,
        upper: boundary,
        weight: 0,
      });
    }
  });

  it('returns exact quarter, midpoint, and three-quarter interpolation weights', () => {
    for (let index = 0; index < TOURNAMENT_CORE_DEPTHS.length - 1; index++) {
      const lower = TOURNAMENT_CORE_DEPTHS[index];
      const upper = TOURNAMENT_CORE_DEPTHS[index + 1];
      for (const weight of [0.25, 0.5, 0.75]) {
        expect(interpolateTournamentDepth(lower + (upper - lower) * weight)).toEqual({
          lower,
          upper,
          weight,
        });
      }
    }
  });
});

function mAt(stackBB: number): TournamentMState {
  return buildTournamentMState({
    stackChips: stackBB * 100,
    smallBlind: 50,
    bigBlind: 100,
    ante: 10,
    anteType: 'big_blind',
    playersAtTable: 8,
  });
}

function preflop(branch: TournamentPreflopBranch, overrides: Partial<PreflopCtx> = {}): PreflopCtx {
  const stackBB = overrides.stackBB ?? 20;
  const m = mAt(stackBB);
  return {
    strength: 0.8,
    position: 'late',
    raiserPosition: null,
    raises: 0,
    limpers: 0,
    callers: 0,
    oppsLeft: 7,
    toCall: 100,
    currentBet: 100,
    contestablePot: 250,
    pot: 250,
    bigBlind: 100,
    stack: stackBB * 100,
    stackBB,
    tightness: 1,
    bluffFreq: 0.1,
    aggression: 1,
    slowplayFreq: 0,
    sizingMultiplier: 1,
    isOmaha: false,
    isPotLimit: false,
    riskAdd: 0.04,
    mode: 'tournament',
    anteInPlay: true,
    anteOrbitBB: 0.8,
    tableSize: 8,
    format: 'mtt',
    v13: true,
    rand: () => 0.5,
    phase6: {
      m,
      policy: tournamentPreflopPolicy({
        gameFamily: 'nlh',
        contextStatus: 'complete',
        tableSize: 8,
        heroPosition: 'BTN',
        raiserPosition: null,
        anteType: 'big_blind',
        branch,
        stackBB,
        m,
      }),
    },
    ...overrides,
  };
}

describe('Phase 6 shadow replay safety', () => {
  it('keeps premium short-stack opens aggressive and deep opens sized', () => {
    expect(decidePreflopV7(preflop('unopened', { stackBB: 10, stack: 1000 })).a).toBe('jam');
    expect(decidePreflopV7(preflop('unopened', { stackBB: 40, stack: 4000 })).a).toBe('raiseTo');
  });

  it('does not call off a marginal hand into two all-ins', () => {
    const decision = decidePreflopV7(
      preflop('multiway_all_in', {
        strength: 0.58,
        stackBB: 10,
        stack: 1000,
        raises: 2,
        callers: 2,
        raiserPosition: 'late',
        toCall: 900,
        currentBet: 1000,
        contestablePot: 2400,
        pot: 2400,
      })
    );
    expect(decision.a).toBe('fold');
  });

  it('does not turn the multiway safety gate into universal passivity with a premium hand', () => {
    const decision = decidePreflopV7(
      preflop('multiway_all_in', {
        strength: 0.97,
        stackBB: 10,
        stack: 1000,
        raises: 2,
        callers: 2,
        raiserPosition: 'late',
        toCall: 900,
        currentBet: 1000,
        contestablePot: 2400,
        pot: 2400,
      })
    );
    expect(decision.a).not.toBe('fold');
  });

  it('never lets the legacy any-two price guard rewrite a multiway-all-in fold', () => {
    const decision = decidePreflopV7(
      preflop('multiway_all_in', {
        strength: 0.4,
        stackBB: 10,
        stack: 1000,
        raises: 2,
        callers: 2,
        raiserPosition: 'late',
        toCall: 100,
        currentBet: 200,
        contestablePot: 1000,
        pot: 1000,
      })
    );
    expect(decision.a).toBe('fold');
  });

  it('uses imminent projected M and next-level BB depth in the action gate', () => {
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
    expect(m.projectedEffectiveM).toBeCloseTo(4.8, 8);
    expect(m.projectedStackBB).toBe(9);
    const decision = decidePreflopV7(
      preflop('unopened', {
        strength: 0.65,
        stackBB: 27,
        stack: 2700,
        nextBlindInMin: 2,
        nextBlindMult: 3,
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
      })
    );
    expect(decision.a).toBe('jam');
  });

  it('reshoves a premium 18bb stack after an open plus caller and avoids a deep multiway call-off', () => {
    const reshove = decidePreflopV7(
      preflop('reshove', {
        strength: 0.95,
        stackBB: 18,
        stack: 1800,
        raises: 1,
        callers: 1,
        raiserPosition: 'late',
        toCall: 250,
        currentBet: 250,
        contestablePot: 650,
        pot: 650,
      })
    );
    expect(reshove.a).toBe('jam');

    const deepMultiway = decidePreflopV7(
      preflop('multiway_all_in', {
        strength: 0.55,
        stackBB: 40,
        stack: 4000,
        raises: 2,
        callers: 2,
        raiserPosition: 'late',
        toCall: 3500,
        currentBet: 4000,
        contestablePot: 8000,
        pot: 8000,
      })
    );
    expect(deepMultiway.a).toBe('fold');
  });

  it('keeps the same action one chip either side of every certified depth', () => {
    for (const depth of TOURNAMENT_CORE_DEPTHS) {
      const below = Math.max(2, depth - 0.01);
      const above = Math.min(100, depth + 0.01);
      const left = decidePreflopV7(
        preflop('unopened', { strength: 0.9, stackBB: below, stack: below * 100 })
      );
      const right = decidePreflopV7(
        preflop('unopened', { strength: 0.9, stackBB: above, stack: above * 100 })
      );
      expect(right.a, `${depth}bb boundary`).toBe(left.a);
    }

    const below25 = decidePreflopV7(
      preflop('reshove', {
        strength: 0.8,
        stackBB: 24.99,
        stack: 2499,
        raises: 1,
        callers: 1,
        raiserPosition: 'late',
      })
    );
    const above25 = decidePreflopV7(
      preflop('reshove', {
        strength: 0.8,
        stackBB: 25.01,
        stack: 2501,
        raises: 1,
        callers: 1,
        raiserPosition: 'late',
      })
    );
    expect(above25.a).toBe(below25.a);
  });
});

describe('Phase 6 live wiring', () => {
  it('puts explicit context, M, atlas, fallbacks, and receipts on the live path', () => {
    const turns = readFileSync(join(here, 'ServerTableEngineTurns.ts'), 'utf8');
    const logic = readFileSync(join(here, 'HorseLogic.ts'), 'utf8');
    expect(turns).toContain('getTournamentBrainContextSnapshot');
    expect(turns).toContain('TOURNAMENT_CONTEXT_INCOMPLETE');
    expect(turns).toContain('buildTournamentMState');
    expect(turns).toContain('handForHand: this.handForHandPaused');
    expect(turns).toContain('this.horseTournamentContext(');
    expect(turns).toContain('state.dealerSeat ?? this.currentHandDealerSeat');
    expect(turns).toContain('gameVariant: activeVariant');
    expect(turns).toContain("format: contextStatus === 'complete'");
    expect(turns).toContain("nextSmallBlind: contextStatus === 'complete'");
    expect(logic).toContain('classifyTournamentPreflopBranch');
    expect(logic).toContain('tournamentPreflopPolicy');
    expect(logic).toContain("noteFire('phase6_tournament_context_incomplete')");
    expect(logic).toContain("noteFire('phase6_tournament_preflop')");
  });

  it('emits real complete-context, M, branch, atlas, and route receipts on an actual decision', () => {
    enableBrainTelemetry();
    drainFires();
    const hero = {
      seat: 1,
      user_id: 'phase6-hero',
      username: 'Phase 6 Hero',
      stack: 1900,
      bet: 100,
      totalInvested: 100,
      cards: [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'spades' },
      ],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    };
    const villain = {
      ...hero,
      seat: 2,
      user_id: 'phase6-villain',
      username: 'Phase 6 Villain',
      stack: 1800,
      bet: 200,
      totalInvested: 200,
      cards: [],
    };
    const m = buildTournamentMState({
      stackChips: hero.stack,
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      anteType: 'none',
      playersAtTable: 2,
      nextSmallBlind: 75,
      nextBigBlind: 150,
      nextAnte: 0,
      minutesToNextLevel: 5,
      opponentStacks: [{ userId: villain.user_id, stackChips: villain.stack }],
    });
    HorseLogic.decide(
      hero as never,
      {
        players: [hero, villain],
        communityCards: [],
        pot: 300,
        currentBet: 200,
        minRaise: 200,
        stage: 'preflop',
        gameVariant: 'nlh',
        gameMode: 'tournament',
        format: 'mtt',
        bigBlind: 100,
        ante: 0,
        bigBlindAnte: false,
        dealerSeat: 1,
        actionHistory: [
          {
            seat: 2,
            userId: villain.user_id,
            action: 'raise',
            amount: 200,
            stage: 'preflop',
            timestamp: 1,
          },
        ],
        tournament: {
          schemaVersion: 1,
          contextStatus: 'complete',
          contextIssues: [],
          playersAtTable: 2,
          playersLeft: 10,
          spotsPaid: 3,
          avgStackChips: 2000,
          currentSmallBlind: 50,
          currentBigBlind: 100,
          currentAnte: 0,
          anteType: 'none',
          nextSmallBlind: 75,
          nextBigBlind: 150,
          nextAnte: 0,
          nextBlindInMin: 5,
          nextBlindMult: 1.5,
          m,
          stacks: [2200, 2000, 1800],
          payoutPct: [50, 30, 20],
          satellite: false,
        },
      } as never,
      'balanced',
      {},
      { telemetry: true, mind: false, v27GtoCharts: false }
    );
    const features = new Set(drainFires().map((row) => row.feature));
    for (const feature of [
      'decide_tournament',
      'decide_tournament_preflop',
      'phase6_tournament_context',
      'phase6_tournament_context_complete',
      'phase6_m_engine',
      'phase6_tournament_preflop',
      'phase6_route_atlas',
      'phase6_atlas_baseline',
      'phase6_branch_blind_vs_blind',
    ]) {
      expect(features.has(feature), feature).toBe(true);
    }
  });

  it('does not classify forced blind all-ins as a voluntary multiway all-in branch', () => {
    enableBrainTelemetry();
    drainFires();
    const hero = {
      seat: 1,
      user_id: 'phase6-button',
      username: 'Phase 6 Button',
      stack: 2000,
      bet: 0,
      totalInvested: 0,
      cards: [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'spades' },
      ],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    };
    const smallBlind = {
      ...hero,
      seat: 2,
      user_id: 'phase6-short-sb',
      username: 'Phase 6 Short SB',
      stack: 0,
      bet: 50,
      totalInvested: 50,
      cards: [],
      is_all_in: true,
    };
    const bigBlind = {
      ...hero,
      seat: 3,
      user_id: 'phase6-short-bb',
      username: 'Phase 6 Short BB',
      stack: 0,
      bet: 100,
      totalInvested: 100,
      cards: [],
      is_all_in: true,
    };
    const m = buildTournamentMState({
      stackChips: hero.stack,
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      anteType: 'none',
      playersAtTable: 3,
      nextSmallBlind: 75,
      nextBigBlind: 150,
      nextAnte: 0,
      minutesToNextLevel: 5,
      opponentStacks: [
        { userId: smallBlind.user_id, stackChips: smallBlind.stack },
        { userId: bigBlind.user_id, stackChips: bigBlind.stack },
      ],
    });
    HorseLogic.decide(
      hero as never,
      {
        players: [hero, smallBlind, bigBlind],
        communityCards: [],
        pot: 150,
        currentBet: 100,
        minRaise: 100,
        stage: 'preflop',
        gameVariant: 'nlh',
        gameMode: 'tournament',
        format: 'mtt',
        bigBlind: 100,
        ante: 0,
        bigBlindAnte: false,
        dealerSeat: 1,
        actionHistory: [],
        tournament: {
          schemaVersion: 1,
          contextStatus: 'complete',
          contextIssues: [],
          playersAtTable: 3,
          playersLeft: 10,
          spotsPaid: 3,
          avgStackChips: 2000,
          currentSmallBlind: 50,
          currentBigBlind: 100,
          currentAnte: 0,
          anteType: 'none',
          nextSmallBlind: 75,
          nextBigBlind: 150,
          nextAnte: 0,
          nextBlindInMin: 5,
          nextBlindMult: 1.5,
          m,
          stacks: [2000, 100, 50],
          payoutPct: [50, 30, 20],
          satellite: false,
        },
      } as never,
      'balanced',
      {},
      { telemetry: true, mind: false, v27GtoCharts: false }
    );
    const features = new Set(drainFires().map((row) => row.feature));
    expect(features.has('phase6_branch_unopened')).toBe(true);
    expect(features.has('phase6_branch_multiway_all_in')).toBe(false);
  });
});
