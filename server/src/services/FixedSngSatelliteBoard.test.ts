import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentRecurringService } from './TournamentRecurringService.js';
import { supabase } from './supabase.js';
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => false }));
afterEach(() => vi.restoreAllMocks());
describe('the existing SNG tick creates the target-bound boards', () => {
  it('includes NLH and Omaha, excludes small entries, and preserves its finite creation budget', async () => {
    const rows = [
      { id: 'nlh', game_type: 'NLH', buy_in_amount: 36, buy_in_fee: 4 },
      { id: 'plo', game_type: 'PLO6', buy_in_amount: 27, buy_in_fee: 3 },
      { id: 'small', game_type: 'NLH', buy_in_amount: 18, buy_in_fee: 2 },
    ];
    const query: any = { then: (resolve: any) => resolve({ data: rows, error: null }) };
    for (const key of ['select', 'eq', 'in', 'gt', 'lt', 'order', 'limit'])
      query[key] = () => query;
    vi.spyOn(supabase, 'from').mockReturnValue(query);
    const rpc = vi.spyOn(supabase, 'rpc').mockImplementation((async (_name: any, args: any) => ({
      data: {
        ok: true,
        created: args.p_target_id === 'plo',
        tournament_id: 'sat-' + args.p_target_id,
        target_id: args.p_target_id,
      },
      error: null,
    })) as any);
    const service = new TournamentRecurringService() as any;
    await service.ensureSatelliteHeadsUps(
      {
        clubId: 'fade0000-0000-0000-0000-000000000001',
        unionId: 'fade0000-0000-0000-0000-000000000001',
      },
      1
    );
    expect(rpc.mock.calls.map((call) => call[1])).toEqual([
      { p_target_id: 'nlh', p_seats: 9 },
      { p_target_id: 'plo', p_seats: 6 },
    ]);
  });
});
