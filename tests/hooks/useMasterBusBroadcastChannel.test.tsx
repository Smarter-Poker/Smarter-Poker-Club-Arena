import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setAuth: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribeAuth: vi.fn(),
  authListeners: [] as Array<(event: string) => void>,
  getOrCreateChannel: vi.fn(),
  registerChannelFactory: vi.fn(),
  removeChannelFactory: vi.fn(),
  removeRegisteredChannel: vi.fn(),
  reportError: vi.fn(),
  on: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    realtime: { setAuth: mocks.setAuth },
    auth: { onAuthStateChange: mocks.onAuthStateChange },
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    getOrCreateChannel: mocks.getOrCreateChannel,
    registerChannelFactory: mocks.registerChannelFactory,
    removeChannelFactory: mocks.removeChannelFactory,
    removeRegisteredChannel: mocks.removeRegisteredChannel,
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.reportError }));

import { useMasterBusBroadcastChannel } from '../../src/hooks/useMasterBusBroadcastChannel';

describe('useMasterBusBroadcastChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setAuth.mockResolvedValue(undefined);
    mocks.subscribe.mockReturnValue(undefined);
    mocks.on.mockReturnValue({ subscribe: mocks.subscribe });
    mocks.getOrCreateChannel.mockReturnValue({ state: 'closed', on: mocks.on });
    mocks.authListeners = [];
    mocks.onAuthStateChange.mockImplementation((listener: (event: string) => void) => {
      mocks.authListeners.push(listener);
      return { data: { subscription: { unsubscribe: mocks.unsubscribeAuth } } };
    });
  });

  const authEvent = (event: string) => {
    for (const listener of [...mocks.authListeners]) listener(event);
  };

  it('authenticates Realtime before joining a private channel', async () => {
    let releaseAuth: (() => void) | undefined;
    mocks.setAuth.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseAuth = resolve;
      })
    );

    renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName: 'private:user-1',
        event: 'changed',
        onPayload: vi.fn(),
      })
    );

    expect(mocks.setAuth).toHaveBeenCalledOnce();
    expect(mocks.getOrCreateChannel).not.toHaveBeenCalled();

    await act(async () => releaseAuth?.());

    await waitFor(() => expect(mocks.getOrCreateChannel).toHaveBeenCalledOnce());
    expect(mocks.getOrCreateChannel).toHaveBeenCalledWith('private:user-1', { private: true });
    expect(mocks.on).toHaveBeenCalledWith('broadcast', { event: 'changed' }, expect.any(Function));
  });

  it('does not authenticate a public channel', async () => {
    renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName: 'public-room',
        event: 'changed',
        onPayload: vi.fn(),
        private: false,
      })
    );

    await waitFor(() => expect(mocks.getOrCreateChannel).toHaveBeenCalledOnce());
    expect(mocks.setAuth).not.toHaveBeenCalled();
  });

  it('reports authentication failure without attempting an unauthorized join', async () => {
    const authError = new Error('No active Realtime session');
    const onSubscriptionError = vi.fn();
    mocks.setAuth.mockRejectedValue(authError);

    renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName: 'private:user-1',
        event: 'changed',
        onPayload: vi.fn(),
        onSubscriptionError,
      })
    );

    await waitFor(() => expect(onSubscriptionError).toHaveBeenCalledOnce());
    expect(onSubscriptionError).toHaveBeenCalledWith('AUTH_ERROR', authError);
    expect(mocks.reportError).toHaveBeenCalledWith(
      authError,
      'useMasterBusBroadcastChannel.AUTH_ERROR.changed'
    );
    expect(mocks.getOrCreateChannel).not.toHaveBeenCalled();
  });

  it('does not join after unmount while authentication is pending', async () => {
    let releaseAuth: (() => void) | undefined;
    mocks.setAuth.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseAuth = resolve;
      })
    );

    const { unmount } = renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName: 'private:user-1',
        event: 'changed',
        onPayload: vi.fn(),
      })
    );
    unmount();

    await act(async () => releaseAuth?.());

    expect(mocks.getOrCreateChannel).not.toHaveBeenCalled();
    expect(mocks.removeChannelFactory).toHaveBeenCalledWith('private:user-1');
    expect(mocks.removeRegisteredChannel).toHaveBeenCalledWith('private:user-1');
  });

  /* A failed Realtime sign-in leaves no channel for the registry's health
     monitor to recover, so the hook owns one event-driven retry: the browser
     coming back online, or the session token refreshing, starts the
     subscription once more. No timer is involved. */
  it('retries a failed Realtime sign-in once when the browser comes back online', async () => {
    mocks.setAuth.mockRejectedValueOnce(new Error('Network down')).mockResolvedValue(undefined);
    const onSubscriptionError = vi.fn();

    renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName: 'private:user-1',
        event: 'changed',
        onPayload: vi.fn(),
        onSubscriptionError,
      })
    );

    await waitFor(() =>
      expect(onSubscriptionError).toHaveBeenCalledWith('AUTH_ERROR', expect.any(Error))
    );
    expect(mocks.getOrCreateChannel).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(mocks.getOrCreateChannel).toHaveBeenCalledOnce());
    expect(mocks.setAuth).toHaveBeenCalledTimes(2);
    expect(mocks.unsubscribeAuth).toHaveBeenCalledOnce();

    // One retry per failure: a later online event does not sign in again.
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(mocks.setAuth).toHaveBeenCalledTimes(2);
  });

  it('retries a failed Realtime sign-in once when the session token refreshes', async () => {
    mocks.setAuth
      .mockRejectedValueOnce(new Error('Refresh in flight'))
      .mockResolvedValue(undefined);

    renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName: 'private:user-1',
        event: 'changed',
        onPayload: vi.fn(),
      })
    );

    await waitFor(() => expect(mocks.authListeners).toHaveLength(1));
    // The initial session report is not a new token.
    await act(async () => authEvent('INITIAL_SESSION'));
    expect(mocks.setAuth).toHaveBeenCalledTimes(1);

    await act(async () => authEvent('TOKEN_REFRESHED'));

    await waitFor(() => expect(mocks.getOrCreateChannel).toHaveBeenCalledOnce());
    expect(mocks.setAuth).toHaveBeenCalledTimes(2);
    expect(mocks.unsubscribeAuth).toHaveBeenCalledOnce();
  });

  it('a retry that fails again waits for the next event instead of looping', async () => {
    mocks.setAuth.mockRejectedValue(new Error('No active Realtime session'));
    const onSubscriptionError = vi.fn();

    renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName: 'private:user-1',
        event: 'changed',
        onPayload: vi.fn(),
        onSubscriptionError,
      })
    );

    await waitFor(() => expect(onSubscriptionError).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(onSubscriptionError).toHaveBeenCalledTimes(2));

    // Re-armed exactly once, and nothing fires until the next event.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.setAuth).toHaveBeenCalledTimes(2);
    expect(mocks.onAuthStateChange).toHaveBeenCalledTimes(2);
    expect(mocks.getOrCreateChannel).not.toHaveBeenCalled();
  });

  it('unmounting removes a pending sign-in retry', async () => {
    mocks.setAuth.mockRejectedValue(new Error('No active Realtime session'));
    const onSubscriptionError = vi.fn();

    const { unmount } = renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName: 'private:user-1',
        event: 'changed',
        onPayload: vi.fn(),
        onSubscriptionError,
      })
    );

    await waitFor(() => expect(onSubscriptionError).toHaveBeenCalledOnce());
    unmount();
    expect(mocks.unsubscribeAuth).toHaveBeenCalledOnce();

    await act(async () => {
      window.dispatchEvent(new Event('online'));
      authEvent('TOKEN_REFRESHED');
    });
    expect(mocks.setAuth).toHaveBeenCalledTimes(1);
  });
});
