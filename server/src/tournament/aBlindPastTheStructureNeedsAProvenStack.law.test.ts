/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PAST THE END OF THE STRUCTURE, AN ESCALATION NEEDS A PROVEN STACK
 *  (2026-09-27)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every level past the last authored one is INVENTED by resolveBlindLevel, and
 * capLevelToChipsInPlay is the only thing that keeps an invented blind inside
 * what the field can post. That cap has existed since 2026-08-31. It measures
 * against chipsInPlayEstimate(), which returns null - capping NOTHING - unless
 * entrantCountForChipCap has been raised, and until today the only thing that
 * ever raised it was the elimination sweep, whose routine wake is a hand
 * completing with a zero stack.
 *
 * So on the one path where it mattered most - a manager freshly adopting an
 * event whose tables cannot deal, which is exactly what the 2026-09-18/19
 * lease-loss wave produced ~470 of - the cap was inert. 2026-09-22 13:24:
 * `Auto-escalated blinds (level 45, structure has 40): 5000000/10000000 ante
 * 4000000` on a $100 Freeroll whose players held 3,000-15,000 chips. Not one
 * of them could post the ante. Every hand at that level is every stack all-in
 * before a card is read, and the event's result is decided by the order the
 * cards fall.
 *
 * The law has two halves, and both are pinned here:
 *   1. an invented blind is never published against an UNPROVEN chip supply -
 *      the last authored level is held instead, and said once;
 *   2. when the supply IS proven, the escalation still happens and the cap
 *      holds it to a blind the field can post.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';

/**
 * A PostgREST-shaped update: `.eq` filters chain, and the write lands only on
 * a row every non-id filter still matches (the level-clock persist is fenced
 * on status and current_level).
 */
function fencedUpdate(row: Record<string, any>, patch: Record<string, unknown>) {
  const filters: Array<[string, unknown]> = [];
  const builder: any = {
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return builder;
    },
    then(resolve: (value: { error: null }) => unknown, reject?: (reason: unknown) => unknown) {
      const matches = filters.every(
        ([column, value]) => column === 'id' || row[column] === undefined || row[column] === value
      );
      if (matches) Object.assign(row, patch);
      return Promise.resolve({ error: null }).then(resolve, reject);
    },
  };
  return builder;
}

let TournamentManagerBase: (typeof import('./TournamentManagerBase.js'))['TournamentManagerBase'];
let supabase: (typeof import('../services/supabase.js'))['supabase'];
let tableStateHub: (typeof import('../transport/TableStateHub.js'))['tableStateHub'];

beforeAll(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
  ({ TournamentManagerBase } = await import('./TournamentManagerBase.js'));
  ({ supabase } = await import('../services/supabase.js'));
  ({ tableStateHub } = await import('../transport/TableStateHub.js'));
});
beforeEach(() => {
  setMaintenanceFrozen(false);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-22T13:24:00.000Z'));
  vi.spyOn(tableStateHub, 'emitEvent').mockImplementation(() => {});
});
afterEach(() => {
  setMaintenanceFrozen(false);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A three-level authored ladder. Level 3 and beyond are invented. */
const structure = [
  { smallBlind: 25, bigBlind: 50, durationMinutes: 10 },
  { smallBlind: 50, bigBlind: 100, durationMinutes: 10 },
  { smallBlind: 100, bigBlind: 200, durationMinutes: 10 },
];

/**
 * A manager sitting far past the end of its ladder - the 2026-09-22 shape,
 * where `currentLevel` (40) had run away from `blindStructure.length` (3)
 * while nothing dealt.
 */
function fixture(options: { startingChips?: number; entrants?: number; currentLevel?: number }) {
  const currentLevel = options.currentLevel ?? 40;
  const row: Record<string, any> = {
    current_level: currentLevel,
    level_started_at: '2026-09-22T13:14:00.000Z',
    blind_structure: structure,
    prize_pool_finalized: true,
    starting_chips: options.startingChips,
    // Past the end of the ladder resolveBlindLevel asks which ladder this is.
    format_contract: 'mtt-v1',
  };
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  const state: any = Object.assign(Object.create(TournamentManagerBase.prototype), {
    tournamentId: 'past-the-ladder',
    tournamentLeaseGeneration: 'active-generation',
    tournamentCache: structuredClone(row),
    running: true,
    currentLevel,
    onBreak: false,
    addOnBreakActive: false,
    blindTimer: null,
    // The level began ten minutes ago and a hand landed a minute ago, so the
    // 2026-09-23 stalled-level hold is not what is being measured here.
    blindTimerStartedAt: Date.parse(row.level_started_at),
    lastObservedHandCompletedAtMs: Date.parse('2026-09-22T13:23:00.000Z'),
    stalledLevelHoldAnnouncedFor: new Set<number>(),
    unprovenEscalationHoldAnnouncedFor: new Set<number>(),
    blindCapReported: false,
    entrantCountForChipCap: options.entrants ?? 0,
    rebuysGrantedForChipCap: 0,
    addonsGrantedForChipCap: 0,
    tableEngines: new Map<string, unknown>([['table-one', {}]]),
    lifecycleEpoch: { current: () => 1, isCurrent: () => state.running },
    lifecycleIsCurrent: () => state.running,
    assertLifecycleCurrent: () => {
      if (!state.running) throw new Error('stale manager');
    },
    startEliminationChecker: vi.fn(),
    reconcileTournamentEntryWindow: vi.fn().mockResolvedValue(undefined),
    requestUrgentEliminationSweepAfter: vi.fn(),
    broadcast: vi.fn().mockResolvedValue(undefined),
    trackLifecycleJob: (promise: Promise<unknown>) => promise,
    setLifecycleTimeout: (callback: () => unknown, delay: number) => ({ callback, delay }),
    clearLifecycleTimeout: vi.fn(),
  });
  vi.spyOn(supabase, 'from').mockReturnValue({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { id: state.tournamentId, status: 'RUNNING', ...structuredClone(row) },
          error: null,
        }),
      }),
    }),
    update: (patch: Record<string, unknown>) => fencedUpdate(row, patch),
  } as never);
  const published: Array<Record<string, any>> = [];
  const rpc = vi
    .spyOn(supabase as unknown as { rpc: (name: string, args: any) => Promise<any> }, 'rpc')
    .mockImplementation(async (name: string, args: any) => {
      if (name !== 'fn_publish_tournament_blind_level') return { data: null, error: null } as never;
      published.push(args);
      Object.assign(row, {
        current_level: args.p_next_level,
        level_started_at: new Date().toISOString(),
        blind_level_state: {
          index: args.p_next_level,
          small_blind: args.p_small_blind,
          big_blind: args.p_big_blind,
          ante: args.p_ante,
        },
      });
      return {
        data: {
          ok: true,
          tournament_id: state.tournamentId,
          current_level: row.current_level,
          level_started_at: row.level_started_at,
          blind_level_state: structuredClone(row.blind_level_state),
        },
        error: null,
      } as never;
    });
  return { state, published, rpc, logs, row };
}

describe('an invented blind is never published against an unproven stack', () => {
  it('holds the level when the event has no proven chips in play', async () => {
    // A freshly adopted manager of a frozen event: nothing has raised the
    // entrant count, so chipsInPlayEstimate() is null and the cap is inert.
    const { state, published, logs } = fixture({ startingChips: 3000, entrants: 0 });

    await state.advanceBlindLevel(structure);

    expect(state.chipsInPlayEstimate()).toBeNull();
    // The incident line is never reached: nothing is published at all.
    expect(published).toHaveLength(0);
    expect(state.currentLevel).toBe(40);
    expect(logs.join('\n')).toContain('holding level 40');
  });

  it('holds it just as firmly when the event has no starting stack on file', async () => {
    const { state, published } = fixture({ startingChips: undefined, entrants: 20 });

    await state.advanceBlindLevel(structure);

    expect(state.chipsInPlayEstimate()).toBeNull();
    expect(published).toHaveLength(0);
  });

  it('announces the hold once per level, not once every fifteen seconds', async () => {
    const { state, logs } = fixture({ startingChips: 3000, entrants: 0 });

    await state.advanceBlindLevel(structure);
    await state.advanceBlindLevel(structure);
    await state.advanceBlindLevel(structure);

    const held = logs.filter((line) => line.includes('holding level 40'));
    expect(held).toHaveLength(1);
  });
});

describe('a proven stack escalates, and the blind stays postable', () => {
  it('publishes a level the field can actually post', async () => {
    // 20 entrants x 3,000 = 60,000 chips in play. Uncapped, an escalation 38
    // levels past a 3-row ladder saturates at MAX_BLIND_VALUE (10,000,000) -
    // the shape that printed 5000000/10000000 on 2026-09-22.
    const { state, published } = fixture({ startingChips: 3000, entrants: 20 });

    expect(state.chipsInPlayEstimate()).toBe(60_000);

    await state.advanceBlindLevel(structure);

    expect(published).toHaveLength(1);
    const level = published[0];
    expect(level.p_next_level).toBe(41);
    // The whole event still holds at least twenty big blinds.
    expect(level.p_big_blind).toBeLessThanOrEqual(60_000 / 20);
    expect(level.p_big_blind).toBeGreaterThan(0);
    expect(level.p_small_blind).toBeLessThanOrEqual(level.p_big_blind);
    // And nothing resembling the incident survives the cap.
    expect(level.p_big_blind).toBeLessThan(10_000_000);
    expect(level.p_ante).toBeLessThan(level.p_big_blind);
  });

  it('an event still inside its authored ladder is untouched by this rule', async () => {
    // Level 1 -> 2 is a level a human wrote. It is played as written, and an
    // unproven chip supply is not a reason to hold it.
    const { state, published } = fixture({
      startingChips: undefined,
      entrants: 0,
      currentLevel: 1,
    });

    await state.advanceBlindLevel(structure);

    expect(state.chipsInPlayEstimate()).toBeNull();
    expect(published).toHaveLength(1);
    expect(published[0].p_next_level).toBe(2);
    expect(published[0].p_big_blind).toBe(200);
  });
});
