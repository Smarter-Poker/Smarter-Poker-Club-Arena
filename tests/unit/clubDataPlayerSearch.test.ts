import { beforeEach, expect, it, vi } from 'vitest';
const { rpc, abortSignal } = vi.hoisted(() => ({ rpc: vi.fn(), abortSignal: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import { ClubRosterService } from '../../src/services/ClubRosterService';
const identity = {
  user_id: 'kingfish-id',
  management_club_id: 'managed-club',
  alias: 'KingFish',
  username: 'kingfish',
  player_number: '1',
  can_view_financials: true,
};
beforeEach(() => {
  rpc.mockReset();
  abortSignal.mockReset().mockResolvedValue({ data: { items: [identity] }, error: null });
  rpc.mockReturnValue({ abortSignal });
});
it('uses the identity-only RPC with a fixed bound and keeps the record club', async () => {
  const signal = new AbortController().signal;
  const page = await ClubRosterService.getDataPlayerMatches('club', {
    search: ' KingFish ',
    signal,
  });
  expect(rpc).toHaveBeenCalledExactlyOnceWith('ca_club_data_player_search', {
    p_club_id: 'club',
    p_search: 'KingFish',
    p_limit: 20,
  });
  expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(page.items[0]).toMatchObject(identity);
  expect(page.items[0].display_name).toBe('');
});
it.each([
  null,
  {},
  { items: null },
  { items: [{ ...identity, can_view_financials: false }] },
  { items: [{ ...identity, user_id: '' }] },
  { items: Array(21).fill(identity) },
])('rejects incomplete or private search answers: %j', async (data) => {
  abortSignal.mockResolvedValue({ data, error: null });
  await expect(
    ClubRosterService.getDataPlayerMatches('club', { search: 'KingFish' })
  ).rejects.toThrow('Player Search Response Was Incomplete');
});
it('preserves a legitimate empty answer', async () => {
  abortSignal.mockResolvedValue({ data: { items: [] }, error: null });
  expect(await ClubRosterService.getDataPlayerMatches('club', { search: 'absent' })).toEqual({
    items: [],
  });
});
it('surfaces authorization refusal without an unscoped fallback', async () => {
  abortSignal.mockResolvedValue({ data: null, error: new Error('not authorized') });
  await expect(
    ClubRosterService.getDataPlayerMatches('club', { search: 'KingFish' })
  ).rejects.toThrow('not authorized');
  expect(rpc).toHaveBeenCalledTimes(1);
});
it('does not start a superseded search', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    ClubRosterService.getDataPlayerMatches('club', {
      search: 'KingFish',
      signal: controller.signal,
    })
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(rpc).not.toHaveBeenCalled();
});
