import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManagerEliminations } from './TournamentManagerEliminations.js';
import { TournamentSweepWorkCursor } from './TournamentSweepWorkCursor.js';
import { supabase } from '../services/supabase.js';
import { emptyManagerWakeInbox } from './__fixtures__/emptyManagerWakeInbox.js';

afterEach(() => vi.restoreAllMocks());

function fixture(
  options: {
    failLaterPage?: boolean;
    shortPage?: boolean;
    unknownCount?: boolean;
    withdrawAfterFirst?: boolean;
    rows?: number;
  } = {}
) {
  const ids = ['player-a', 'player-b', 'player-c'];
  // window-ok: model a REST response capped at 1000 with a valid later generation beyond it.
  const candidates = Array.from({ length: options.rows ?? 1002 }, (_, i) => ({
    id: String(i + 1).padStart(8, '0'),
    eliminated_user_id: i === 0 ? ids[2] : i % 2 === 0 ? ids[0] : ids[1],
    hand_number: i + 1,
    stack_before: 1500,
    state: 'pending',
  }));
  const reads: Array<string | null> = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(supabase, 'from').mockImplementation(((relation: string) => {
    if (relation === 'tournament_manager_wakes') return emptyManagerWakeInbox();
    let columns = '';
    let head = false;
    let cursor: string | null = null;
    let pageSize = 1000;
    let ordering = 'hand_number';
    let ascending = false;
    const query: any = {
      select: (value: string, options?: { head?: boolean }) => {
        columns = value;
        head = options?.head === true;
        return query;
      },
      eq: () => query,
      lte: () => query,
      in: () => query,
      order: (column: string, options: { ascending: boolean }) => {
        ordering = column;
        ascending = options.ascending;
        return query;
      },
      limit: (limit: number) => {
        pageSize = Math.min(limit, 1000);
        return query;
      },
      gt: (column: string, value: string) => {
        if (column !== 'id') throw new Error('unexpected cursor');
        cursor = value;
        return query;
      },
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
        let response: unknown;
        if (relation === 'tournament_players' && head) response = { count: 4, error: null };
        else if (relation === 'tournament_players' && columns === 'id, user_id, chips')
          response = {
            data: ids.map((user_id) => ({ id: user_id, user_id, chips: 0 })),
            error: null,
          };
        else if (relation === 'tournament_knockout_candidates') {
          reads.push(cursor);
          const matches = candidates.filter((row) => cursor === null || row.id > cursor);
          matches.sort((a, b) => {
            const comparison =
              ordering === 'id' ? a.id.localeCompare(b.id) : a.hand_number - b.hand_number;
            return ascending ? comparison : -comparison;
          });
          if (options.withdrawAfterFirst) manager.running = false;
          response =
            options.failLaterPage && cursor !== null
              ? { data: null, count: null, error: { message: 'later page unavailable' } }
              : {
                  data: matches.slice(0, options.shortPage ? pageSize - 1 : pageSize),
                  count: options.unknownCount ? null : matches.length,
                  error: null,
                };
        } else throw new Error('unexpected relation ' + relation);
        return Promise.resolve(response).then(resolve, reject);
      },
    };
    return query;
  }) as never);
  const manager = Object.assign(Object.create(TournamentManagerEliminations.prototype), {
    tournamentId: 'history-event',
    running: true,
    isProcessingEliminations: false,
    pendingManagerWakes: new Map(),
    pendingManagerWakeGenerations: new Map(),
    tournamentCache: { tournament_type: 'MTT', variant: 'freezeout' },
    eliminationSweepCursor: new TournamentSweepWorkCursor(),
    bustRefusalStreak: new Map(),
    resumeCommittedTerminalCleanup: vi.fn(async () => false),
    requestEliminationSweep: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
    onEliminationSweepSettled: vi.fn(),
    tryTournamentRebuys: vi.fn(async () => {
      manager.running = false;
      return { rebought: new Set(), deferredUntil: new Map() };
    }),
  });
  manager.eliminationSweepCursor.advanceTo(1);
  return { manager, reads, ids };
}

describe('knockout ordering survives more than one REST page of rebuy generations', () => {
  it('reaches the input stage with every latest generation, including the oldest player', async () => {
    const { manager, reads, ids } = fixture();
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.tryTournamentRebuys).toHaveBeenCalledTimes(1);
    expect(manager.tryTournamentRebuys.mock.calls[0][1]).toEqual(
      new Map([
        [ids[2], 1],
        [ids[1], 1002],
        [ids[0], 1001],
      ])
    );
    expect(reads).toEqual([null, '00001000']);
  });

  it.each([{ shortPage: true }, { unknownCount: true }, { withdrawAfterFirst: true }])(
    'does not admit work on invalid or withdrawn page evidence: %j',
    async (options) => {
      const { manager, reads } = fixture(options);
      await manager.runEliminationSweep(new AbortController().signal);
      expect(reads).toEqual([null]);
      expect(manager.tryTournamentRebuys).not.toHaveBeenCalled();
    }
  );

  it('checks the end after an exactly full page', async () => {
    const { manager, reads } = fixture({ rows: 1000 });
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.tryTournamentRebuys).toHaveBeenCalledTimes(1);
    expect(reads).toEqual([null, '00001000']);
  });

  it('does not act on a prefix when the later page fails', async () => {
    const { manager, reads } = fixture({ failLaterPage: true });
    await manager.runEliminationSweep(new AbortController().signal);
    expect(reads).toEqual([null, '00001000']);
    expect(manager.tryTournamentRebuys).not.toHaveBeenCalled();
    expect(manager.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
  });
});
