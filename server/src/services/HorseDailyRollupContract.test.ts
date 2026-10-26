import { beforeEach, expect, it, vi } from 'vitest';

const { rpc, reportError } = vi.hoisted(() => ({ rpc: vi.fn(), reportError: vi.fn() }));
vi.mock('./supabase/client.js', () => ({ supabase: { rpc } }));
vi.mock('./errorReporter.js', () => ({ reportError }));
beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
  reportError.mockReset();
});

it('admits the installed contract and coalesces concurrent first hands', async () => {
  rpc.mockResolvedValue({ data: { horse_daily_rollups_contract: 1 }, error: null });
  const { horseDailyRollupContract } = await import('./HorseDailyRollupContract.js');
  expect(await Promise.all(Array.from({ length: 8 }, () => horseDailyRollupContract()))).toEqual(
    Array(8).fill(true)
  );
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('ca_project_hand_stats_facts', { p_hand_id: null });
});

it.each([
  { data: null, error: { message: 'function is absent' } },
  { data: { horse_daily_rollups_contract: 2 }, error: null },
  { data: { horse_daily_rollups_contract: '1' }, error: null },
  { data: { ok: false, reason: 'stats_facts_unavailable', hand_id: null }, error: null },
])('retains the legacy writer for an unavailable or incompatible database', async (reply) => {
  rpc.mockResolvedValue(reply);
  const { horseDailyRollupContract } = await import('./HorseDailyRollupContract.js');
  expect(await horseDailyRollupContract()).toBe(false);
  expect(await horseDailyRollupContract()).toBe(false);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(reportError).toHaveBeenCalled();
});

it('reports unknown transport without handing ownership to an old projector', async () => {
  rpc.mockRejectedValue(new Error('connection lost'));
  const { horseDailyRollupContract } = await import('./HorseDailyRollupContract.js');
  expect(await horseDailyRollupContract()).toBe(false);
  expect(reportError).toHaveBeenCalled();
});
