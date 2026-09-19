import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GameServer as GameServerType } from './GameServer.js';

let GameServer: typeof GameServerType;
let supabase: typeof import('./services/supabase.js').supabase;

beforeAll(async () => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-placeholder-key');
  ({ GameServer } = await import('./GameServer.js'));
  ({ supabase } = await import('./services/supabase.js'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the existing lease cleanup calls its custody-preserving database owner', () => {
  it('uses the maintained RPC with the existing one-hour age boundary', async () => {
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: [{ table_leases_deleted: 0, tournament_leases_deleted: 0 }],
      error: null,
    } as never);
    await (
      GameServer.prototype as unknown as { reapDeadLeases(): Promise<void> }
    ).reapDeadLeases.call({});
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('reap_dead_engine_leases', { p_stale_seconds: 3600 });
  });

  it('routes the existing hourly callback through owned server lifecycle work', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const work = Promise.resolve();
    const owner = {
      leaseReapTimer: null,
      reapDeadLeases: vi.fn(() => work),
      launchServerLifecycleJob: vi.fn(),
    };
    (GameServer.prototype as unknown as { startLeaseReaper(): void }).startLeaseReaper.call(owner);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(owner.reapDeadLeases).toHaveBeenCalledTimes(1);
    expect(owner.launchServerLifecycleJob).toHaveBeenCalledTimes(1);
    expect(owner.launchServerLifecycleJob).toHaveBeenCalledWith(
      work,
      'GameServer.lease_reap_failed'
    );
    vi.clearAllTimers();
  });
});
