/**
 * The signed-in player's presence heartbeat (src/lib/presenceHeartbeat.ts,
 * src/hooks/usePresenceHeartbeat.ts). The law that it is the only presence
 * writer and is mounted once is tests/presence-has-one-definition.law.test.ts.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { reportError } from '../../src/utils/errorReporter';
import { PRESENCE_HEARTBEAT_MS, signalOffline } from '../../src/lib/presenceHeartbeat';
import { usePresenceHeartbeat } from '../../src/hooks/usePresenceHeartbeat';

let visibility: DocumentVisibilityState = 'visible';
const beats = () => rpc.mock.calls.filter((c) => c[0] === 'fn_update_presence');
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
  vi.mocked(reportError).mockReset();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePresenceHeartbeat', () => {
  it('beats on load with the player id and online true', () => {
    renderHook(() => usePresenceHeartbeat('u1'));
    expect(beats()).toEqual([['fn_update_presence', { p_user_id: 'u1', p_is_online: true }]]);
  });

  it('beats every interval while visible', async () => {
    renderHook(() => usePresenceHeartbeat('u1'));
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS * 2);
    expect(beats()).toHaveLength(3);
  });

  it('does not beat while hidden, and beats at once on becoming visible', async () => {
    renderHook(() => usePresenceHeartbeat('u1'));
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS * 3);
    expect(beats()).toHaveLength(1);

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(beats()).toHaveLength(2);
  });

  it('a hidden tab that loads does not beat until it is shown', () => {
    visibility = 'hidden';
    renderHook(() => usePresenceHeartbeat('u1'));
    expect(beats()).toHaveLength(0);
  });

  it('beats for nobody when signed out, and stops when unmounted', async () => {
    renderHook(() => usePresenceHeartbeat(null));
    expect(beats()).toHaveLength(0);

    const { unmount } = renderHook(() => usePresenceHeartbeat('u1'));
    unmount();
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS * 3);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(beats()).toHaveLength(1);
  });

  it('reports a failing beat once per run of failures, not every interval', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'offline' } });
    renderHook(() => usePresenceHeartbeat('u1'));
    await flush();
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS * 3);
    await flush();
    expect(beats()).toHaveLength(4);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe('signalOffline', () => {
  it('sends online false for the player', async () => {
    await signalOffline('u1');
    expect(beats()).toEqual([['fn_update_presence', { p_user_id: 'u1', p_is_online: false }]]);
  });

  it('never throws, and never waits past its bound', async () => {
    rpc.mockReturnValueOnce(new Promise(() => {}));
    const done = signalOffline('u1', 2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toBeUndefined();

    rpc.mockRejectedValueOnce(new Error('network'));
    await expect(signalOffline('u1')).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
