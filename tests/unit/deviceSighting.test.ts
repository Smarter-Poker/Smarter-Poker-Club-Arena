/**
 * The install id the multi-account detector reads (2026-10-22): one id per
 * install, kept across sessions, sent only as the id (the database reads the
 * address itself), at most once per half hour per player.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.hoisted(() => vi.fn());
const authListeners = vi.hoisted(() => [] as Array<(e: string, s: unknown) => void>);

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    auth: {
      onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
        authListeners.push(cb);
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  },
}));

import {
  DEVICE_ID_STORAGE_KEY,
  __resetDeviceSightingForTests,
  getDeviceId,
  reportDeviceSighting,
  startDeviceSighting,
} from '../../src/lib/deviceSighting';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('device sighting', () => {
  beforeEach(() => {
    localStorage.clear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: null, error: null });
    authListeners.length = 0;
    __resetDeviceSightingForTests();
  });

  it('creates one id per install and keeps it', () => {
    const id = getDeviceId();
    expect(id).toMatch(UUID_RE);
    expect(localStorage.getItem(DEVICE_ID_STORAGE_KEY)).toBe(id);
    __resetDeviceSightingForTests();
    expect(getDeviceId()).toBe(id);
  });

  it('replaces a malformed stored id', () => {
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, 'not-an-id');
    expect(getDeviceId()).toMatch(UUID_RE);
  });

  it('sends only the id, once per half hour per player', async () => {
    await reportDeviceSighting('user-1');
    await reportDeviceSighting('user-1');
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('ca_record_device_sighting', { p_device_id: getDeviceId() });
    await reportDeviceSighting('user-2');
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it('does nothing when signed out, and retries next time after a failure', async () => {
    await reportDeviceSighting(null);
    expect(rpcMock).not.toHaveBeenCalled();
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await reportDeviceSighting('user-1');
    await reportDeviceSighting('user-1');
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it('reports on sign-in and session restore', async () => {
    startDeviceSighting();
    startDeviceSighting();
    expect(authListeners).toHaveLength(1);
    authListeners[0]('INITIAL_SESSION', { user: { id: 'user-9' } });
    await Promise.resolve();
    expect(rpcMock).toHaveBeenCalledWith('ca_record_device_sighting', expect.any(Object));
    authListeners[0]('SIGNED_OUT', null);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});
