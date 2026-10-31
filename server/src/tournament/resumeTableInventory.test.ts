import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { from, reportError } = vi.hoisted(() => ({ from: vi.fn(), reportError: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from, rpc: vi.fn() },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError,
  reportWarning: vi.fn(),
  describeError: String,
}));
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { POSTGREST_PAGE } from '../services/supabase/pagination.js';

function fixture(count: number, failSecondPage = false) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `a2000000-0000-4000-8000-${100000000000 + index}`,
    small_blind: 25,
    big_blind: 50,
    ante: 0,
    stakes: '25/50',
  }));
  let pages = 0;
  from.mockImplementation((relation: string) => {
    let cursor: string | null = null;
    let limit = POSTGREST_PAGE;
    const query: any = {
      select: () => query,
      eq: () => query,
      in: () => query,
      order: () => query,
      limit: (value: number) => {
        limit = value;
        return query;
      },
      gt: (_key: string, value: string) => {
        cursor = value;
        return query;
      },
      maybeSingle: async () => ({
        data: {
          id: 'event',
          club_id: 'club',
          format_contract: 'mtt-v1',
          status: 'RUNNING',
          blind_structure: [],
          prize_pool_finalized: true,
          on_break: false,
        },
        error: null,
      }),
      then: (resolve: (value: unknown) => unknown) => {
        if (relation !== 'tables') throw new Error('Unexpected inventory relation');
        pages++;
        const filtered = rows.filter((row) => cursor === null || row.id > cursor);
        return Promise.resolve(
          failSecondPage && cursor !== null
            ? { data: null, error: { message: 'Later page unavailable' } }
            : { data: filtered.slice(0, limit), error: null }
        ).then(resolve);
      },
    };
    return query;
  });
  const state: any = Object.assign(Object.create(TournamentManagerBase.prototype), {
    tournamentId: 'event',
    running: true,
    lifecycleEpoch: { isCurrent: () => true },
    assertLifecycleCurrent: vi.fn(),
    readTournamentClub: vi.fn(async () => {}),
    loadMultiDayPlan: vi.fn(async () => {}),
    rearmStageEndPauseFromPlan: vi.fn(),
    decideAbandonedGenerations: vi.fn(async () => false),
    // End this focused admission at the next dependency. No dealer, money
    // authority or scheduler is reached by this inventory test.
    adoptAbandonedRetirementCustody: vi.fn(async () => {
      throw new Error('Inventory captured');
    }),
    unregisterEliminationScheduler: vi.fn(),
  });
  return { state, rows, pages: () => pages };
}
beforeEach(() => {
  from.mockReset();
  reportError.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('restart adoption reads every tournament table before handing off the inventory', () => {
  it('includes the table beyond the REST row cap', async () => {
    const f = fixture(POSTGREST_PAGE + 1);
    await f.state.resumeLifecycle(1);
    expect(f.state.decideAbandonedGenerations).toHaveBeenCalledTimes(1);
    expect(f.state.decideAbandonedGenerations).toHaveBeenCalledWith(
      1,
      f.rows.map((row) => row.id)
    );
    expect(f.pages()).toBe(2);
  });
  it('does not hand off a partial inventory when the later page fails', async () => {
    const f = fixture(POSTGREST_PAGE + 1, true);
    await f.state.resumeLifecycle(1);
    expect(f.state.decideAbandonedGenerations).not.toHaveBeenCalled();
    expect(f.state.adoptAbandonedRetirementCustody).not.toHaveBeenCalled();
    expect(f.state.running).toBe(false);
    expect(reportError).toHaveBeenCalled();
  });
});
