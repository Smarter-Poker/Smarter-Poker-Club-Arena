/**
 * ONE LEADER, AND NEVER ZERO.
 *
 * Leadership gates whether ANY table deals, so the tests that matter most are
 * the fail-open ones. A database blip must never leave the fleet with nobody
 * running it -- and being wrong in that direction lands on today's behaviour,
 * one instance doing everything, which is survivable. Being wrong the other way
 * stops the platform.
 *
 * The second-most-important case is losing leadership while holding it. That
 * can only happen if our own heartbeat lapsed past the staleness window, i.e.
 * this process was wedged long enough for another instance to take over. Two
 * engines both believing they lead is the one outcome worse than a restart.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rpc = vi.fn();
vi.mock('./supabase/client.js', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('./tableLease.js', () => ({ INSTANCE_ID: 'me', INSTANCE_VERSION: 'v1' }));
vi.mock('./errorReporter.js', () => ({ reportError: () => {} }));

const granted = { data: [{ granted: true, holder: 'me', holder_age_seconds: 0 }], error: null };
const refused = {
  data: [{ granted: false, holder: 'other', holder_age_seconds: 3 }],
  error: null,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exitSpy: any;

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});
afterEach(() => exitSpy.mockRestore());

const load = async () => await import('./leadership.js');

describe('fail open — never leave the fleet unowned', () => {
  it('leads when the RPC errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
    const { renewLeadership, isLeader } = await load();
    await expect(renewLeadership()).resolves.toBe('leader');
    expect(isLeader()).toBe(true);
  });

  it('leads when the RPC throws', async () => {
    rpc.mockRejectedValue(new Error('ETIMEDOUT'));
    const { renewLeadership } = await load();
    await expect(renewLeadership()).resolves.toBe('leader');
  });

  it('leads when the RPC returns nothing usable', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const { renewLeadership } = await load();
    await expect(renewLeadership()).resolves.toBe('leader');
  });
});

describe('election', () => {
  it('leads when granted', async () => {
    rpc.mockResolvedValue(granted);
    const { renewLeadership, leadershipDiagnostics } = await load();
    expect(await renewLeadership()).toBe('leader');
    expect(leadershipDiagnostics().holder).toBe('me');
  });

  it('stands by when another instance holds it', async () => {
    rpc.mockResolvedValue(refused);
    const { renewLeadership, isLeader, leadershipDiagnostics } = await load();
    expect(await renewLeadership()).toBe('standby');
    expect(isLeader()).toBe(false);
    expect(leadershipDiagnostics().holder).toBe('other');
  });

  it('a standby promotes the moment the lease is granted', async () => {
    rpc.mockResolvedValue(refused);
    const { renewLeadership, isLeader } = await load();
    expect(await renewLeadership()).toBe('standby');
    rpc.mockResolvedValue(granted);
    expect(await renewLeadership()).toBe('leader');
    expect(isLeader()).toBe(true);
  });

  it('a standby that never led does NOT exit — it is doing its job', async () => {
    rpc.mockResolvedValue(refused);
    const { renewLeadership } = await load();
    await renewLeadership();
    await renewLeadership();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('losing leadership while holding it', () => {
  it('stands down hard rather than risk two leaders', async () => {
    vi.useFakeTimers();
    rpc.mockResolvedValue(granted);
    const { renewLeadership } = await load();
    expect(await renewLeadership()).toBe('leader');

    // Our heartbeat lapsed past the staleness window and someone took over.
    rpc.mockResolvedValue(refused);
    expect(await renewLeadership()).toBe('standby');

    vi.advanceTimersByTime(500);
    expect(exitSpy).toHaveBeenCalledWith(0);
    vi.useRealTimers();
  });
});
