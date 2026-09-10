import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(() => {
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
  elimination_sequence: number | null;
  eliminated_at: string | null;
}

function finishStage(
  entrants: Entrant[],
  options: { countError?: boolean; witnessError?: boolean; variant?: string } = {}
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
          if (av === null) return -1;
          if (bv === null) return 1;
          return (av < bv ? -1 : 1) * (order.ascending ? 1 : -1);
        });
        return query;
      }),
      limit: vi.fn((count: number) => {
        rows = rows.slice(0, count);
        return query;
      }),
      maybeSingle: vi.fn(async () => ({
        data: status === 'eliminated' && options.witnessError ? null : (rows[0] ?? null),
        error: status === 'eliminated' && options.witnessError ? { message: 'read failed' } : null,
      })),
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
