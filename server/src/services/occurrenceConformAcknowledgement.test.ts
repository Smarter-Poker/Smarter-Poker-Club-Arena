import { afterEach, expect, it, vi } from 'vitest';
import { ScheduledTournamentService } from './ScheduledTournamentService.js';
import { supabase } from './supabase.js';
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => false }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it.each(['lost-move', 'lost-rename', 'success', 'already-moved'] as const)(
  'requires exact write acknowledgements: %s',
  async (mode) => {
    const oldStart = new Date(Date.now() + 3600000).toISOString();
    const newStart = new Date(Date.now() + 7200000);
    const writes: string[] = [];
    vi.spyOn(supabase, 'from').mockImplementation(((table: string) => {
      let writing = false;
      const query: any = {
        select: () => query,
        eq: () => query,
        in: () => query,
        is: () => query,
        update: () => {
          writing = true;
          writes.push(table);
          return query;
        },
        maybeSingle: () => query,
        then: (resolve: any) =>
          Promise.resolve({
            error: null,
            data: writing
              ? table === 'tournaments'
                ? mode === 'lost-move'
                  ? null
                  : { id: 'event', start_time: newStart.toISOString().replace('Z', '+00:00') }
                : mode === 'lost-rename'
                  ? null
                  : { spawn_key: 'new', tournament_id: 'event' }
              : table === 'tournaments'
                ? {
                    id: 'event',
                    status: 'REGISTERING',
                    start_time: mode === 'already-moved' ? newStart.toISOString() : oldStart,
                    prize_pool_finalized: false,
                  }
                : { spawn_key: 'old', tournament_id: 'event' },
          }).then(resolve),
      };
      return query;
    }) as never);
    const claimed = new Set(['old']);
    await (new ScheduledTournamentService() as any).conformClaimedOccurrences(
      { name: 'Schedule' },
      [{ oldKey: 'old', newKey: 'new', newStart }],
      claimed
    );
    expect(writes).toEqual(
      mode === 'lost-move'
        ? ['tournaments']
        : mode === 'already-moved'
          ? ['tournament_schedule_spawns']
          : ['tournaments', 'tournament_schedule_spawns']
    );
    expect([...claimed]).toEqual(
      mode === 'success' || mode === 'already-moved' ? ['new'] : ['old']
    );
  }
);
