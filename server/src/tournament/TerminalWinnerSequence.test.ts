import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn<(name: string, args?: unknown) => Promise<{ data: any; error: any }>>(() => {
    throw new Error('Unexpected RPC in finish-stage fixture');
  }),
  reportError: vi.fn(),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: fixture.from, rpc: fixture.rpc },
  maintenanceSupabase: { from: fixture.from, rpc: fixture.rpc },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: fixture.reportError }));
vi.stubGlobal(
  'fetch',
  vi.fn(() => {
    throw new Error('Network disabled in fixture');
  })
);

const { TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js');
const { TournamentSweepWorkCursor } = await import('./TournamentSweepWorkCursor.js');
const tournamentId = '00000000-0000-4000-8000-000000000001';
const firstUserId = '00000000-0000-4000-8000-000000000002';
const lastUserId = '00000000-0000-4000-8000-000000000003';

interface Entrant {
  user_id: string;
  status: string;
  position?: number;
  elimination_sequence: number | null;
  eliminated_at: string | null;
}

function finishStage(
  entrants: Entrant[],
  options: {
    countError?: boolean;
    witnessError?: boolean;
    durableWinnerError?: boolean;
    variant?: string;
  } = {}
) {
  // This transport applies the manager's actual filters and ordering to rows.
  // Reversing callback timestamps therefore reproduces the old wrong candidate.
  fixture.from.mockImplementation((table: string) => {
    expect(table).toBe('tournament_players');
    let rows = [...entrants];
    let status: string | undefined;
    const query: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn((column: string, value: unknown) => {
        if (column === 'status') {
          status = String(value);
          rows = rows.filter((row) => row.status === value);
        }
        if (column === 'position') rows = rows.filter((row) => row.position === value);
        return query;
      }),
      not: vi.fn((column: keyof Entrant, operation: string, value: unknown) => {
        expect(operation).toBe('is');
        expect(value).toBeNull();
        rows = rows.filter((row) => row[column] !== null);
        return query;
      }),
      order: vi.fn((column: keyof Entrant, order: { ascending: boolean }) => {
        rows.sort((a, b) => {
          const av = a[column],
            bv = b[column];
          if (av === bv) return 0;
          if (av === null || av === undefined) return -1;
          if (bv === null || bv === undefined) return 1;
          return (av < bv ? -1 : 1) * (order.ascending ? 1 : -1);
        });
        return query;
      }),
      limit: vi.fn((count: number) => {
        rows = rows.slice(0, count);
        return query;
      }),
      maybeSingle: vi.fn(async () => {
        const failed =
          (status === 'eliminated' && options.witnessError) ||
          (status === 'winner' && options.durableWinnerError);
        return {
          data: failed ? null : (rows[0] ?? null),
          error: failed ? { message: 'read failed' } : null,
        };
      }),
      then: (resolve: any, reject: any) =>
        Promise.resolve({
          count: options.countError ? null : rows.length,
          error: options.countError ? { message: 'count failed' } : null,
        }).then(resolve, reject),
    };
    return query;
  });
  const manager = Object.create(TournamentManagerEliminations.prototype) as any;
  Object.assign(manager, {
    pendingManagerWakes: new Map(),
    pendingManagerWakeGenerations: new Map(),
    running: true,
    isProcessingEliminations: false,
    tournamentId,
    tournamentCache: {
      variant: options.variant ?? 'satellite',
      tournament_type: options.variant === 'mtt' ? 'MTT' : 'SATELLITE',
      prize_pool_finalized: true,
    },
    tournamentEntryRepricePending: false,
    eliminationSweepCursor: new TournamentSweepWorkCursor(),
    resumeCommittedTerminalCleanup: vi.fn().mockResolvedValue(false),
    eliminationWorkBudgetExpired: vi.fn().mockReturnValue(true),
    requestEliminationSweep: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
    maybeActivateMysteryBounty: vi.fn().mockResolvedValue(undefined),
    finishTournament: vi.fn().mockResolvedValue(undefined),
    rearmIfTheFinishWasRefused: vi.fn(),
  });
  manager.eliminationSweepCursor.advanceTo(2);
  return manager;
}

const finalField = (lastTimestamp: string | null): Entrant[] => [
  {
    user_id: firstUserId,
    status: 'eliminated',
    elimination_sequence: 100,
    eliminated_at: '2026-09-10T05:10:01.000Z',
  },
  {
    user_id: lastUserId,
    status: 'eliminated',
    elimination_sequence: 101,
    eliminated_at: lastTimestamp,
  },
];

describe('terminal candidate follows the durable elimination authority', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['satellite', 'mtt'])(
    'uses the final sequence when %s callback timestamps reverse',
    async (variant) => {
      const manager = finishStage(finalField('2026-09-10T05:10:00.000Z'), { variant });
      await manager.runEliminationSweep(new AbortController().signal);
      expect(manager.finishTournament).toHaveBeenCalledOnce();
      expect(manager.finishTournament).toHaveBeenCalledWith(lastUserId);
      expect(manager.rearmIfTheFinishWasRefused).toHaveBeenCalledOnce();
      expect(fixture.reportError).not.toHaveBeenCalled();
    }
  );

  it('uses the final sequence when both eliminations share a timestamp', async () => {
    const manager = finishStage(finalField('2026-09-10T05:10:01.000Z'));
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.finishTournament).toHaveBeenCalledOnce();
    expect(manager.finishTournament).toHaveBeenCalledWith(lastUserId);
  });

  it('does not let an unsequenced legacy row precede the durable witness', async () => {
    const rows = finalField(null);
    rows[0].elimination_sequence = null;
    const manager = finishStage(rows);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.finishTournament).toHaveBeenCalledOnce();
    expect(manager.finishTournament).toHaveBeenCalledWith(lastUserId);
  });

  it('keeps a missing witness pending without inventing a winner', async () => {
    const manager = finishStage(
      finalField(null).map((row) => ({ ...row, elimination_sequence: null }))
    );
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.finishTournament).not.toHaveBeenCalled();
    expect(manager.requestUrgentEliminationSweepAfter).toHaveBeenCalledOnce();
    expect(fixture.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'Tournament.finish_elimination_witness_unavailable'
    );
    expect(manager.eliminationSweepCursor.nextStage).toBe(2);
  });

  it.each(['countError', 'witnessError'] as const)(
    'never finalizes on a %s transport failure',
    async (failure) => {
      const manager = finishStage(finalField(null), { [failure]: true });
      await manager.runEliminationSweep(new AbortController().signal);
      expect(manager.finishTournament).not.toHaveBeenCalled();
      expect(manager.requestUrgentEliminationSweepAfter).toHaveBeenCalledOnce();
    }
  );

  it('adopts the durable first-place winner before consulting the last bust', async () => {
    const rows = finalField(null);
    rows[0] = { ...rows[0], status: 'winner', position: 1 };
    const manager = finishStage(rows);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.finishTournament).toHaveBeenCalledOnce();
    expect(manager.finishTournament).toHaveBeenCalledWith(firstUserId);
    expect(fixture.from).toHaveBeenCalledTimes(3);
    expect(fixture.reportError).not.toHaveBeenCalled();
  });

  it('never falls back to a bust after the durable winner read fails', async () => {
    const manager = finishStage(finalField(null), { durableWinnerError: true });
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.finishTournament).not.toHaveBeenCalled();
    expect(manager.requestUrgentEliminationSweepAfter).toHaveBeenCalledOnce();
    expect(fixture.from).toHaveBeenCalledTimes(3);
    expect(fixture.reportError).toHaveBeenCalledWith(
      { message: 'read failed' },
      'Tournament.finish_durable_winner_unreadable'
    );
  });

  it('preserves the actual live survivor without consulting elimination order', async () => {
    const rows = finalField(null);
    rows[0].status = 'playing';
    const manager = finishStage(rows);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.finishTournament).toHaveBeenCalledOnce();
    expect(manager.finishTournament).toHaveBeenCalledWith(firstUserId);
    expect(fixture.from).toHaveBeenCalledTimes(2);
  });
});

import nativeCohorts from './__fixtures__/satellite-qualifier-native-receipts.json';
import { TournamentManager } from './TournamentManager.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';

function cohortManager(
  raw: (typeof nativeCohorts)[keyof typeof nativeCohorts] = nativeCohorts.two_survivors
) {
  const tableId = raw.source_closeout.source_table_ids[0];
  const engine = new ServerTableEngine(tableId);
  const e = engine as any;
  e.running = true;
  e.handController = null;
  e.handForHandResolve = vi.fn();
  const shared = new Map([[tableId, engine]]);
  const server: any = {
    getTableEngine: (id: string) => shared.get(id),
    ownsTournamentTableEngine: (id: string, expected: ServerTableEngine) =>
      shared.get(id) === expected,
    tournamentRetirementCustody: new TournamentRetirementCustody(),
    unregisterTableEngine: vi.fn((id: string, expected: unknown) => {
      if (shared.get(id) !== expected) return false;
      shared.delete(id);
      return true;
    }),
    stopClosedTournamentTableEngine: vi.fn().mockResolvedValue(false),
  };
  const manager = new TournamentManager(
    raw.tournament_id,
    server,
    '00000000-0000-4000-8000-000000000004',
    performance.now() + 60_000
  ) as any;
  manager.lifecycleEpoch.begin();
  Object.assign(manager, {
    running: true,
    tournamentCache: {
      format_contract: 'mtt-v2',
      satellite_target_id: raw.target_id,
      variant: 'satellite',
      prize_pool_finalized: true,
    },
    requestEliminationSweep: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
    // Remain in the real finish stage, and avoid unrelated stages afterward.
    eliminationWorkBudgetExpired: vi.fn().mockReturnValue(true),
    broadcast: vi.fn().mockResolvedValue(true),
    cleanupBroadcastChannel: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockImplementation(async () => {
      manager.running = false;
    }),
  });
  manager.tableEngines.set(tableId, engine);
  manager.wireEliminationWake(engine);
  vi.spyOn(engine, 'stop').mockImplementation(async () => {
    e.running = false;
  });
  const response = {
    ok: true,
    tournament_id: raw.tournament_id,
    state: 'qualifying',
    full_ticket_count: 2,
    qualifier_ids: raw.qualifier_ids,
  };
  fixture.rpc.mockImplementation(async (name: string) => {
    if (name === 'fn_f06_hand_number_state')
      return {
        data: {
          ok: true,
          table_id: tableId,
          lifecycle: '1',
          can_reserve: true,
          blocked_reason: null,
          used_hand_number_max: '0',
          unresolved_permit: null,
          next_hand_number_candidate: '1',
        },
        error: null,
      };
    if (name === 'fn_get_satellite_qualifier_state') return { data: response, error: null };
    if (name === 'fn_settle_satellite_qualifiers') return { data: raw, error: null };
    throw new Error(`Unexpected cohort RPC ${name}`);
  });
  fixture.from.mockImplementation((name: string) => {
    const q: any = {
      select: vi.fn(() => q),
      eq: vi.fn(() => q),
      in: vi.fn().mockResolvedValue({ data: [{ id: tableId }], error: null }),
      // Original-source control has no cohort stage and only sees two live players.
      then: (resolve: any) =>
        Promise.resolve({ count: raw.qualifier_ids.length, data: null, error: null }).then(resolve),
    };
    expect(['tables', 'tournament_players']).toContain(name);
    return q;
  });
  manager.eliminationSweepCursor.advanceTo(2);
  return { manager, engine, e, server, shared, tableId, response, raw };
}

describe('new-format satellite completion at the actual full-ticket boundary', () => {
  beforeEach(() => {
    fixture.rpc.mockReset();
    fixture.from.mockReset();
    fixture.reportError.mockClear();
    setMaintenanceFrozen(false);
  });
  it('the actual pause-ready callback prioritizes a pending qualifier boundary and otherwise advances hand-for-hand', () => {
    const f = cohortManager();
    const advance = vi.spyOn(f.manager, 'advanceHandForHandBarrier').mockImplementation(() => {});
    f.manager.satelliteQualifierBoundaryPending = true;
    f.e.pauseReadyCallback(f.tableId);
    expect(f.manager.requestEliminationSweep).toHaveBeenCalledOnce();
    expect(f.manager.requestEliminationSweep).toHaveBeenCalledWith('satellite_qualifier_boundary');
    expect(advance).not.toHaveBeenCalled();

    f.manager.requestEliminationSweep.mockClear();
    f.manager.satelliteQualifierBoundaryPending = false;
    f.e.pauseReadyCallback(f.tableId);
    expect(advance).toHaveBeenCalledOnce();
    expect(f.manager.requestEliminationSweep).not.toHaveBeenCalled();
  });
  it.each(['two_survivors', 'same_hand_overflow'] as const)(
    'the actual finish caller accepts %s without inventing first place',
    async (key) => {
      const f = cohortManager(nativeCohorts[key]);
      await f.manager.runEliminationSweep(new AbortController().signal);
      expect(fixture.rpc).toHaveBeenCalledWith('fn_settle_satellite_qualifiers', {
        p_tournament_id: f.raw.tournament_id,
        p_observed_qualifier_ids: f.raw.qualifier_ids,
      });
      expect(f.manager.broadcast).toHaveBeenCalledWith(
        'satellite_qualifiers',
        expect.objectContaining({ qualifierIds: f.raw.qualifier_ids, receiptVersion: 3 })
      );
      expect(
        f.manager.broadcast.mock.calls.some(([event]: [string]) => event === 'tournament_winner')
      ).toBe(false);
      expect(f.server.unregisterTableEngine).toHaveBeenCalledWith(f.tableId, f.engine);
    }
  );

  it('the real hand-complete callback holds before hand-for-hand can release, including a pending accepted writer', async () => {
    const f = cohortManager();
    f.manager.handForHandActive = true;
    f.manager.handForHandTableIds.add(f.tableId);
    f.e.terminalBoundaryPendingGenerations.add(1);
    f.e.handCompleteCallback(f.tableId, [{ user_id: f.raw.qualifier_ids[0], stack: 0 }]);
    expect(f.e.terminalCloseoutPaused).toBe(true);
    f.manager.advanceHandForHandBarrier();
    expect(f.e.handForHandResolve).not.toHaveBeenCalled();
    await f.manager.runEliminationSweep(new AbortController().signal);
    expect(fixture.rpc.mock.calls.some(([name]) => name === 'fn_settle_satellite_qualifiers')).toBe(
      false
    );
    expect(f.manager.eliminationSweepCursor.nextStage).toBe(0);
    // The real accepted writer's completion allows the same owning operation.
    f.e.terminalBoundaryPendingGenerations.clear();
    f.manager.eliminationSweepCursor.advanceTo(2);
    await f.manager.runEliminationSweep(new AbortController().signal);
    expect(
      fixture.rpc.mock.calls.filter(([name]) => name === 'fn_settle_satellite_qualifiers')
    ).toHaveLength(1);
  });

  it('adopted and replacement dealers preserve both the booked start and qualifier boundary before dealing', async () => {
    const f = cohortManager();
    f.e.running = false;
    const bookedStart = Date.now() + 60_000;
    f.manager.tournamentCache.started_at = new Date(bookedStart).toISOString();
    const start = vi.spyOn(f.engine, 'start').mockImplementation(async () => {
      expect(f.e.terminalCloseoutPaused).toBe(true);
      expect(f.e.dealHoldUntilMs).toBe(bookedStart);
    });
    Object.defineProperty(f.engine, 'ready', { value: Promise.resolve(true) });
    f.manager.startManagedTableEngine(f.engine, 'test');
    await Promise.all([...f.manager.tableEngineRunJobs]);
    expect(start).toHaveBeenCalledOnce();
    expect(f.manager.satelliteQualifierBoundaryPending).toBe(true);
    expect(fixture.reportError).not.toHaveBeenCalled();
  });

  it.each(['freeze', 'stop', 'abort', 'replacement', 'generation'] as const)(
    'cannot pay through a %s change during the authoritative read',
    async (fault) => {
      const f = cohortManager();
      const controller = new AbortController();
      fixture.rpc.mockImplementationOnce(async () => {
        if (fault === 'freeze') setMaintenanceFrozen(true);
        if (fault === 'stop') f.manager.running = false;
        if (fault === 'abort') controller.abort();
        if (fault === 'replacement') f.shared.set(f.tableId, {} as ServerTableEngine);
        if (fault === 'generation') {
          f.manager.holdSatelliteQualifierBoundary();
          fixture.rpc.mockImplementationOnce(async () => {
            f.manager.holdSatelliteQualifierBoundary();
            return { data: f.response, error: null };
          });
        }
        return { data: f.response, error: null };
      });
      try {
        await f.manager.runEliminationSweep(controller.signal);
        expect(
          fixture.rpc.mock.calls.some(([name]) => name === 'fn_settle_satellite_qualifiers')
        ).toBe(false);
      } finally {
        setMaintenanceFrozen(false);
      }
    }
  );

  it('uses a proven continuation to release only this pause while preserving maintenance ownership', async () => {
    const f = cohortManager();
    f.manager.holdSatelliteQualifierBoundary();
    f.e.maintenancePaused = true;
    f.response.state = 'continuing';
    f.response.qualifier_ids = [...f.raw.qualifier_ids, 'dddddddd-dddd-dddd-dddd-dddddddddddd'];
    await f.manager.runEliminationSweep(new AbortController().signal);
    expect(f.e.terminalCloseoutPaused).toBe(false);
    expect(f.e.maintenancePaused).toBe(true);
    expect(f.e.handForHandResolve).not.toHaveBeenCalled();
    expect(fixture.rpc.mock.calls.some(([name]) => name === 'fn_settle_satellite_qualifiers')).toBe(
      false
    );
  });

  it('an unknown payer result stops this generation with its fence retained', async () => {
    const f = cohortManager();
    fixture.rpc.mockImplementation(async (name: string) =>
      name === 'fn_get_satellite_qualifier_state'
        ? { data: f.response, error: null }
        : { data: null, error: { message: 'transport lost' } }
    );
    await f.manager.runEliminationSweep(new AbortController().signal);
    expect(f.manager.stop).toHaveBeenCalledOnce();
    expect(f.e.terminalCloseoutPaused).toBe(true);
    expect(f.manager.broadcast).not.toHaveBeenCalled();
  });
});
