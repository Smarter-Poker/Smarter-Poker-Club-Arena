import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: state.rpc } }));
import ClubRosterService from '../../src/services/ClubRosterService';
beforeEach(() => state.rpc.mockReset());
it('reads the selected period once and keeps fee cents beside its profit/loss', async () => {
  state.rpc.mockReturnValue({
    setHeader() {
      return this;
    },
    abortSignal: () =>
      Promise.resolve({
        data: [{ user_id: 'a', cash: -2, mtt: 1, net: -1, fees: '66.63', downline_fees: '155.09' }],
        error: null,
      }),
  });
  expect(await ClubRosterService.getMembersWinLoss('club', ['a'], 'week')).toEqual(
    new Map([['a', { cash: -2, mtt: 1, net: -1, fees: 66.63, downline_fees: 155.09 }]])
  );
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith('ca_club_members_period_summary', {
    p_club_id: 'club',
    p_user_ids: ['a'],
    p_period: 'week',
  });
});
it('rejects an old or incomplete summary instead of treating missing fees as zero', async () => {
  state.rpc.mockReturnValue({
    setHeader() {
      return this;
    },
    abortSignal: () =>
      Promise.resolve({ data: [{ user_id: 'a', cash: -2, mtt: 1, net: -1 }], error: null }),
  });
  await expect(ClubRosterService.getMembersWinLoss('club', ['a'], 'week')).rejects.toThrow(
    'The Period Fee Response Was Incomplete'
  );
});
