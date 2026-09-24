import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { from, rpc, reportError } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from, rpc },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError,
  reportWarning: vi.fn(),
  describeError: (error: unknown) => String(error),
}));
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
import { tournamentLeaseMonotonicNow } from '../services/tournamentLease.js';
import {
  AbandonedGenerationRefusedError,
  abandonedGenerationReceiptId,
  abandonedPermitGeneration,
  closeAbandonedGeneration,
} from './abandonedGenerationDoor.js';

/**
 * A DEAD GENERATION'S HAND IS DECIDED BY THE GENERATION THAT ADOPTS ITS EVENT
 * (2026-09-22). Before this, an adopting generation that found a reserved
 * permit of a generation that had died refused to deal at that table for the
 * rest of its life: 56 MTT tables in 36 events, 90 Spin and 80 SNG tables on
 * production that day. See tournament/abandonedGenerationDoor.ts.
 */

const EVENT = 'a1000000-0000-4000-8000-000000000001';
const MINE = 'a5000000-0000-4000-8000-000000000005';
const DEAD = 'a6000000-0000-4000-8000-000000000006';
const OTHER_DEAD = 'a7000000-0000-4000-8000-000000000007';
const TABLE_A = 'a2000000-0000-4000-8000-00000000000a';
const TABLE_B = 'a2000000-0000-4000-8000-00000000000b';
const TABLE_C = 'a2000000-0000-4000-8000-00000000000c';

function permit(tableId: string, generation: string) {
  return {
    permit_id: 'a9000000-0000-4000-8000-000000000009',
    tournament_id: EVENT,
    table_id: tableId,
    lifecycle: '1',
    hand_number: '42',
    custody_id: 'a8000000-0000-4000-8000-000000000008',
    generation,
    state: 'reserved',
  };
}

function handState(tableId: string, generation: string | null) {
  return generation
    ? {
        ok: true,
        table_id: tableId,
        lifecycle: '1',
        used_hand_number_max: '42',
        next_hand_number_candidate: null,
        can_reserve: false,
        blocked_reason: 'hand_permit_unresolved',
        unresolved_permit: permit(tableId, generation),
      }
    : {
        ok: true,
        table_id: tableId,
        lifecycle: '1',
        used_hand_number_max: '42',
        next_hand_number_candidate: '43',
        can_reserve: true,
        blocked_reason: null,
        unresolved_permit: null,
      };
}

type DoorAnswer = { data?: unknown; error?: { message: string; code?: string } | null };

/**
 * One event on a small model of the database: which generation holds a
 * reserved permit on each table, and the event's blind level. The door, when
 * it decides, frees that generation's tables and returns the clock to level
 * 3, exactly the two things fn_f06_abort_abandoned_generation writes that an
 * adopting generation must see.
 */
function fixture(reserved: Record<string, string | null>, doorAnswers: DoorAnswer[] = []) {
  from.mockClear();
  rpc.mockClear();
  reportError.mockClear();
  const db = { reserved: { ...reserved }, level: 7 };
  const tableIds = Object.keys(reserved);
  const eventReads: number[] = [];
  const calls: string[] = [];
  const written: any = {
    eq: () => written,
    select: () => written,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (value: unknown) => void) => resolve({ data: null, error: null }),
  };
  from.mockImplementation((name: string) => ({
    update: () => written,
    select: () => ({
      eq: () => ({
        maybeSingle: async () => {
          calls.push('read:tournaments');
          eventReads.push(db.level);
          return {
            data: {
              id: EVENT,
              format_contract: 'mtt-v1',
              club_id: 'club',
              status: 'RUNNING',
              blind_structure: [{ smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 }],
              current_level: db.level,
              level_started_at: new Date(Date.now() - 60_000).toISOString(),
              prize_pool_finalized: true,
              on_break: false,
            },
            error: null,
          };
        },
        in: async () => {
          calls.push(`read:${name}`);
          return name === 'tables'
            ? {
                data: tableIds.map((id) => ({
                  id,
                  small_blind: 25,
                  big_blind: 50,
                  ante: 0,
                  stakes: '25/50',
                })),
                error: null,
              }
            : { count: 1, error: null };
        },
      }),
    }),
  }));
  rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    if (name === 'fn_f06_hand_number_state') {
      const tableId = String(args.p_table_id);
      if (db.reserved[tableId] === undefined) return { data: null, error: { message: 'boom' } };
      return { data: handState(tableId, db.reserved[tableId]), error: null };
    }
    if (name === 'fn_ca_resume_hand_submission') return { data: { found: false }, error: null };
    if (name === 'fn_f06_abort_abandoned_generation') {
      const scripted = doorAnswers.shift();
      if (scripted) return { data: scripted.data ?? null, error: scripted.error ?? null };
      for (const [tableId, generation] of Object.entries(db.reserved))
        if (generation === args.p_generation) db.reserved[tableId] = null;
      db.level = 3;
      return {
        data: {
          ok: true,
          outcome: 'aborted_unsettled',
          receipt_id: args.p_receipt_id,
          tournament_id: args.p_tournament_id,
          generation: args.p_generation,
          hands_aborted: 1,
          never_started: 0,
          credit: 0,
        },
        error: null,
      };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  const lifecycle = { live: true };
  const state: any = Object.assign(Object.create(TournamentManagerBase.prototype), {
    tournamentId: EVENT,
    tournamentLeaseGeneration: MINE,
    tournamentLeaseProofDeadlineMonotonicMs: tournamentLeaseMonotonicNow() + 3_600_000,
    tournamentLeaseAuthorityExpired: false,
    running: true,
    tournamentCache: null,
    lifecycleEpoch: { isCurrent: () => lifecycle.live, assertCurrent: () => {} },
    assertLifecycleCurrent: vi.fn(() => {
      if (!lifecycle.live) throw new Error('lifecycle ended');
    }),
    readTournamentClub: vi.fn(async () => {}),
    tableEngines: new Map(),
    createManagedTableEngine: vi.fn(() => ({ setHub: vi.fn() })),
    createTablesAndSeatPlayers: vi.fn(async () => {}),
    wireEliminationWake: vi.fn(),
    admitManagedTableEngine: vi.fn(),
    startManagedTableEngine: vi.fn(),
    restoreDrawnFirstButtons: vi.fn(async () => {}),
    drainTableEngineStartJobs: vi.fn(async () => {}),
    startBlindTimer: vi.fn(),
    startEliminationChecker: vi.fn(),
    unregisterEliminationScheduler: vi.fn(),
    reconcileTournamentEntryWindow: vi.fn(async () => {}),
    requestEliminationSweep: vi.fn(),
  });
  const doorCalls = () =>
    rpc.mock.calls.filter(([name]) => name === 'fn_f06_abort_abandoned_generation');
  const end = () => {
    lifecycle.live = false;
    state.running = false;
  };
  return { db, state, calls, eventReads, doorCalls, end };
}

beforeEach(() => {
  from.mockReset();
  rpc.mockReset();
  reportError.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  setMaintenanceFrozen(false);
  vi.restoreAllMocks();
});

describe('an adopting generation decides the reserved hand a dead generation left', () => {
  it('asks the door once, before any dealer, and adopts the clock the door left', async () => {
    const f = fixture({ [TABLE_A]: DEAD, [TABLE_B]: null });
    await f.state.resumeLifecycle(1);

    expect(f.doorCalls()).toHaveLength(1);
    expect(f.doorCalls()[0][1]).toEqual({
      p_tournament_id: EVENT,
      p_generation: DEAD,
      p_receipt_id: abandonedGenerationReceiptId(EVENT, DEAD),
      p_reason: expect.stringContaining(`generation ${MINE} adopted tournament ${EVENT};`),
      p_release_current_lease: false,
    });
    expect(String(f.doorCalls()[0][1].p_reason).length).toBeGreaterThanOrEqual(40);
    // The door moved the clock back to level 3; the event row was read again
    // after it, and that is the level this generation adopted.
    expect(f.eventReads).toEqual([7, 3]);
    expect(f.state.currentLevel).toBe(3);
    // Every table held by the dead generation is free, and the door came
    // before the event was read again and before any dealer was admitted.
    expect(f.db.reserved).toEqual({ [TABLE_A]: null, [TABLE_B]: null });
    const door = f.calls.indexOf('fn_f06_abort_abandoned_generation');
    expect(f.calls.lastIndexOf('fn_f06_hand_number_state')).toBeLessThan(door);
    expect(f.calls.lastIndexOf('read:tournaments')).toBeGreaterThan(door);
    expect(f.state.startManagedTableEngine).toHaveBeenCalledTimes(2);
    expect(f.state.running).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('asks once for a dead generation that holds several tables, and once per dead generation', async () => {
    const f = fixture({ [TABLE_A]: DEAD, [TABLE_B]: DEAD, [TABLE_C]: OTHER_DEAD });
    await f.state.resumeLifecycle(1);
    expect(f.doorCalls().map(([, args]) => args.p_generation)).toEqual([DEAD, OTHER_DEAD]);
    expect(f.db.reserved).toEqual({ [TABLE_A]: null, [TABLE_B]: null, [TABLE_C]: null });
    expect(f.state.startManagedTableEngine).toHaveBeenCalledTimes(3);
  });

  it('never hands the door a hand this generation reserved', async () => {
    const f = fixture({ [TABLE_A]: MINE });
    await f.state.resumeLifecycle(1);
    expect(f.doorCalls()).toHaveLength(0);
    expect(f.eventReads).toEqual([7]);
    expect(f.state.currentLevel).toBe(7);
  });

  it('adopts an event with nothing reserved exactly as before', async () => {
    const f = fixture({ [TABLE_A]: null, [TABLE_B]: null });
    await f.state.resumeLifecycle(1);
    expect(f.doorCalls()).toHaveLength(0);
    expect(f.eventReads).toEqual([7]);
    expect(f.calls.filter((name) => name === 'fn_f06_hand_number_state')).toHaveLength(2);
    expect(f.state.startManagedTableEngine).toHaveBeenCalledTimes(2);
  });

  it('does not decide a table it could not read', async () => {
    const f = fixture({ [TABLE_A]: DEAD });
    delete f.db.reserved[TABLE_A];
    await f.state.resumeLifecycle(1);
    expect(f.doorCalls()).toHaveLength(0);
    expect(f.state.startManagedTableEngine).toHaveBeenCalledTimes(1);
  });

  it('leaves a table the door refuses by rule exactly as blocked as before, and reports it', async () => {
    const f = fixture({ [TABLE_A]: DEAD }, [
      { error: { message: 'F06_ABANDONED_ROSTER_CHANGED', code: '55000' } },
    ]);
    await f.state.resumeLifecycle(1);
    expect(f.doorCalls()).toHaveLength(1);
    expect(f.db.reserved[TABLE_A]).toBe(DEAD);
    expect(f.eventReads).toEqual([7]);
    expect(f.state.startManagedTableEngine).toHaveBeenCalledTimes(1);
    expect(f.state.running).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][1]).toBe('Tournament.abandoned_generation_refused');
    expect(reportError.mock.calls[0][2]).toMatchObject({
      generation: DEAD,
      code: 'F06_ABANDONED_ROSTER_CHANGED',
      refusal: 'definite',
    });
  });

  it('asks again, a bounded number of times, when the answer says nothing about the hand', async () => {
    const retry = TournamentManagerBase.ABANDONED_GENERATION_RETRY_MS;
    (TournamentManagerBase as any).ABANDONED_GENERATION_RETRY_MS = 1;
    try {
      const busy = { error: { message: 'could not serialize access', code: '40001' } };
      const f = fixture({ [TABLE_A]: DEAD }, [busy, busy, busy, busy]);
      await f.state.resumeLifecycle(1);
      expect(f.doorCalls()).toHaveLength(TournamentManagerBase.ABANDONED_GENERATION_ATTEMPTS);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0][2]).toMatchObject({ refusal: 'transient', code: '40001' });
      expect(f.state.startManagedTableEngine).toHaveBeenCalledTimes(1);

      const g = fixture({ [TABLE_A]: DEAD }, [busy]);
      await g.state.resumeLifecycle(1);
      expect(g.doorCalls()).toHaveLength(2);
      expect(g.db.reserved[TABLE_A]).toBeNull();
      expect(g.state.currentLevel).toBe(3);
    } finally {
      (TournamentManagerBase as any).ABANDONED_GENERATION_RETRY_MS = retry;
    }
  });

  it('never holds an adoption on the maintenance freeze: it adopts every table and asks next time', async () => {
    const f = fixture({ [TABLE_A]: DEAD, [TABLE_B]: null });
    setMaintenanceFrozen(true);
    await f.state.resumeLifecycle(1);
    expect(f.doorCalls()).toHaveLength(0);
    expect(f.db.reserved[TABLE_A]).toBe(DEAD);
    expect(f.eventReads).toEqual([7]);
    expect(f.state.startManagedTableEngine).toHaveBeenCalledTimes(2);
    expect(f.state.running).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
    setMaintenanceFrozen(false);
    await f.state.resumeLifecycle(2);
    expect(f.doorCalls()).toHaveLength(1);
    expect(f.db.reserved[TABLE_A]).toBeNull();
  });

  it('asks again in a later adoption after a refusal, and only once per adoption', async () => {
    const roster = { error: { message: 'F06_ABANDONED_ROSTER_CHANGED', code: '55000' } };
    const f = fixture({ [TABLE_A]: DEAD }, [roster, roster]);
    await f.state.resumeLifecycle(1);
    expect(f.doorCalls()).toHaveLength(1);
    await f.state.resumeLifecycle(2);
    expect(f.doorCalls()).toHaveLength(2);
    expect(f.db.reserved[TABLE_A]).toBe(DEAD);
  });

  it('stops asking, and starts no dealer, once its lifecycle ends', async () => {
    const retry = TournamentManagerBase.ABANDONED_GENERATION_RETRY_MS;
    (TournamentManagerBase as any).ABANDONED_GENERATION_RETRY_MS = 400;
    try {
      const busy = { error: { message: 'could not serialize access', code: '40001' } };
      const f = fixture({ [TABLE_A]: DEAD, [TABLE_B]: null }, [busy, busy, busy]);
      const adoption = f.state.resumeLifecycle(1);
      await vi.waitFor(() => expect(f.doorCalls()).toHaveLength(1));
      f.end();
      await adoption;
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(f.doorCalls()).toHaveLength(1);
      expect(f.state.startManagedTableEngine).not.toHaveBeenCalled();
      expect(f.eventReads).toEqual([7]);
      expect(reportError).not.toHaveBeenCalled();
    } finally {
      (TournamentManagerBase as any).ABANDONED_GENERATION_RETRY_MS = retry;
    }
  });

  it('finishes a retained original the way admission does, then asks once more', async () => {
    const f = fixture({ [TABLE_A]: DEAD, [TABLE_B]: DEAD }, [
      { error: { message: 'F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION', code: '55000' } },
    ]);
    await f.state.resumeLifecycle(1);
    const resumed = rpc.mock.calls
      .filter(([name]) => name === 'fn_ca_resume_hand_submission')
      .map(([, args]) => args.p_table_id);
    expect(resumed).toEqual([TABLE_A, TABLE_B]);
    expect(f.doorCalls()).toHaveLength(2);
    expect(f.calls.indexOf('fn_ca_resume_hand_submission')).toBeGreaterThan(
      f.calls.indexOf('fn_f06_abort_abandoned_generation')
    );
    expect(f.db.reserved).toEqual({ [TABLE_A]: null, [TABLE_B]: null });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('reads the event again when another receipt already decided the generation', async () => {
    const f = fixture({ [TABLE_A]: DEAD }, [
      { error: { message: 'F06_GENERATION_ALREADY_ABORTED', code: '55000' } },
    ]);
    await f.state.resumeLifecycle(1);
    expect(f.doorCalls()).toHaveLength(1);
    expect(f.eventReads).toHaveLength(2);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("the door's answer", () => {
  const reply = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    data: {
      ok: true,
      outcome: 'aborted_unsettled',
      receipt_id: args.p_receipt_id,
      tournament_id: args.p_tournament_id,
      generation: args.p_generation,
      credit: 0,
      ...extra,
    },
    error: null,
  });

  it('is asked with one receipt per event and dead generation, never releasing the caller', async () => {
    const door = vi.fn(async (_name: string, args: any) => reply(args));
    await expect(closeAbandonedGeneration(door as never, EVENT, DEAD, MINE)).resolves.toBe(
      'aborted'
    );
    await expect(
      closeAbandonedGeneration(door as never, EVENT.toUpperCase(), DEAD.toUpperCase(), MINE)
    ).resolves.toBe('aborted');
    expect(door.mock.calls[0][1].p_receipt_id).toBe(door.mock.calls[1][1].p_receipt_id);
    expect(door.mock.calls[0][1].p_release_current_lease).toBe(false);
    expect(abandonedGenerationReceiptId(EVENT, DEAD)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(abandonedGenerationReceiptId(EVENT, DEAD)).not.toBe(
      abandonedGenerationReceiptId(EVENT, OTHER_DEAD)
    );
  });

  it('reports a replay as a replay', async () => {
    const door = vi.fn(async (_name: string, args: any) => reply(args, { replayed: true }));
    await expect(closeAbandonedGeneration(door as never, EVENT, DEAD, MINE)).resolves.toBe(
      'replayed'
    );
  });

  it.each(['F06_GENERATION_ALREADY_ABORTED', 'F06_ABANDONED_NOTHING_RESERVED'])(
    'treats %s as already decided',
    async (code) => {
      const door = vi.fn(async () => ({ data: null, error: { message: code, code: '55000' } }));
      await expect(closeAbandonedGeneration(door as never, EVENT, DEAD, MINE)).resolves.toBe(
        'already_closed'
      );
    }
  );

  it.each([
    [
      'PLATFORM_FROZEN: abandoned-generation abort refused',
      '55000',
      'PLATFORM_FROZEN',
      'transient',
    ],
    ['F06_HAND_DISPATCH_BUSY', '40001', 'F06_HAND_DISPATCH_BUSY', 'transient'],
    ['F06_ABORT_RETRY_PLAYER_LANE', '40001', 'F06_ABORT_RETRY_PLAYER_LANE', 'transient'],
    ['canceling statement due to statement timeout', '57014', '57014', 'transient'],
    ['F06_ABANDONED_ROSTER_CHANGED', '55000', 'F06_ABANDONED_ROSTER_CHANGED', 'definite'],
    ['F06_ABORT_SAVED_STACKS_CHANGED', '55000', 'F06_ABORT_SAVED_STACKS_CHANGED', 'definite'],
    [
      'F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION',
      '55000',
      'F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION',
      'retained_submission',
    ],
  ])('classifies %s', async (message, sqlstate, code, refusal) => {
    const door = vi.fn(async () => ({ data: null, error: { message, code: sqlstate } }));
    const error = await closeAbandonedGeneration(door as never, EVENT, DEAD, MINE).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(AbandonedGenerationRefusedError);
    expect(error).toMatchObject({ code, refusal });
  });

  it.each([
    ['a missing ok', { ok: false }],
    ['another receipt', { receipt_id: 'a0000000-0000-4000-8000-000000000000' }],
    ['another event', { tournament_id: 'a0000000-0000-4000-8000-000000000000' }],
    ['another generation', { generation: OTHER_DEAD }],
    ['a credit', { credit: 1 }],
  ])('does not accept a reply with %s', async (_label, extra) => {
    const door = vi.fn(async (_name: string, args: any) => reply(args, extra));
    await expect(closeAbandonedGeneration(door as never, EVENT, DEAD, MINE)).rejects.toMatchObject({
      code: 'F06_ABANDONED_REPLY_UNPROVEN',
      refusal: 'transient',
    });
  });

  it('treats no answer as transient', async () => {
    const door = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    await expect(closeAbandonedGeneration(door as never, EVENT, DEAD, MINE)).rejects.toMatchObject({
      code: 'no_answer',
      refusal: 'transient',
    });
  });
});

describe('which permit belongs to a dead generation', () => {
  it('names the dead generation of an exact foreign reserved permit on this table', () => {
    expect(abandonedPermitGeneration(handState(TABLE_A, DEAD), EVENT, TABLE_A, MINE)).toBe(DEAD);
    expect(
      abandonedPermitGeneration(handState(TABLE_A, DEAD.toUpperCase()), EVENT, TABLE_A, MINE)
    ).toBe(DEAD);
  });

  it.each([
    ['this generation', handState(TABLE_A, MINE)],
    ['nothing reserved', handState(TABLE_A, null)],
    ['another table', handState(TABLE_B, DEAD)],
    ['a parked table', { ...handState(TABLE_A, DEAD), blocked_reason: 'source_excluded' }],
    ['a table that could reserve', { ...handState(TABLE_A, DEAD), can_reserve: true }],
    ['a refused read', { ...handState(TABLE_A, DEAD), ok: false }],
    [
      'another event',
      {
        ...handState(TABLE_A, DEAD),
        unresolved_permit: { ...permit(TABLE_A, DEAD), tournament_id: OTHER_DEAD },
      },
    ],
    [
      'a decided permit',
      {
        ...handState(TABLE_A, DEAD),
        unresolved_permit: { ...permit(TABLE_A, DEAD), state: 'aborted_unsettled' },
      },
    ],
    [
      'a malformed generation',
      {
        ...handState(TABLE_A, DEAD),
        unresolved_permit: { ...permit(TABLE_A, DEAD), generation: 'not-a-uuid' },
      },
    ],
    ['no permit', { ...handState(TABLE_A, DEAD), unresolved_permit: null }],
    ['nothing at all', null],
    ['a list', [handState(TABLE_A, DEAD)]],
  ])('is not the adopter to decide: %s', (_label, state) => {
    expect(abandonedPermitGeneration(state, EVENT, TABLE_A, MINE)).toBeNull();
  });
});
