import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  identitySubscribe: vi.fn(),
  identityListener: undefined as undefined | ((event: any) => void),
  privateRecord: vi.fn(),
  engineStatus: vi.fn(),
  privateListener: undefined as undefined | ((message: any) => void),
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
  subscriptionCallbacks: [] as Array<(status: string, err?: Error) => void>,
  payloadCallbacks: [] as Array<(payload: unknown) => void>,
}));

vi.mock('../../src/services/EngineStateClient', () => ({
  engineChannelClient: {
    onPrivateRecord: mocks.privateRecord,
    getStatus: mocks.engineStatus,
  },
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    realtime: { setAuth: mocks.setAuth },
    auth: { onAuthStateChange: mocks.onAuthStateChange },
  },
}));

vi.mock('../../src/lib/subscribeRealtime', () => ({
  subscribeRealtime: async (channel: any, callback: any, signal: AbortSignal) => {
    try {
      await mocks.setAuth();
      if (!signal.aborted) channel.subscribe(callback);
    } catch (error) {
      if (!signal.aborted) callback('CHANNEL_ERROR', error);
    }
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: mocks.identitySubscribe,
    getOrCreateChannel: mocks.getOrCreateChannel,
    registerChannelFactory: mocks.registerChannelFactory,
    removeChannelFactory: mocks.removeChannelFactory,
    removeRegisteredChannel: mocks.removeRegisteredChannel,
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: mocks.reportError,
}));

import { useMasterBusBroadcastChannel } from '../../src/hooks/useMasterBusBroadcastChannel';
import { __resetRealtimeTransportLossForTests } from '../../src/lib/realtimeTransportLoss';

describe('useMasterBusBroadcastChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRealtimeTransportLossForTests();
    mocks.identityListener = undefined;
    mocks.identitySubscribe.mockImplementation((_event, listener) => {
      mocks.identityListener = listener;
      return vi.fn();
    });
    mocks.engineStatus.mockReturnValue('connecting');
    mocks.privateListener = undefined;
    mocks.privateRecord.mockImplementation((_topic, listener) => {
      mocks.privateListener = listener;
      return vi.fn();
    });
    mocks.setAuth.mockResolvedValue(undefined);
    mocks.subscriptionCallbacks.length = 0;
    mocks.payloadCallbacks.length = 0;
    mocks.subscribe.mockImplementation((callback: (status: string, err?: Error) => void) => {
      mocks.subscriptionCallbacks.push(callback);
      return undefined;
    });
    mocks.on.mockImplementation((_type, _filter, callback: (payload: unknown) => void) => {
      mocks.payloadCallbacks.push(callback);
      return { subscribe: mocks.subscribe };
    });
    mocks.getOrCreateChannel.mockReturnValue({
      state: 'closed',
      on: mocks.on,
      subscribe: mocks.subscribe,
    });
    mocks.authListeners = [];
    mocks.onAuthStateChange.mockImplementation((listener: (event: string) => void) => {
      mocks.authListeners.push(listener);
      return {
        data: { subscription: { unsubscribe: mocks.unsubscribeAuth } },
      };
    });
  });

  const authEvent = (event: string) => {
    for (const listener of [...mocks.authListeners]) listener(event);
  };

  it('keeps paid fallback until an authorized ready acknowledgment and restores it on loss', async () => {
    const status = vi.fn();
    const payload = vi.fn();
    const degraded = vi.fn();
    renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName:
          'member-record:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222',
        event: 'record_changed',
        onPayload: payload,
        onSubscriptionError: degraded,
        onSubscriptionStatus: status,
      })
    );
    await waitFor(() => expect(mocks.getOrCreateChannel).toHaveBeenCalledTimes(1));
    act(() => mocks.privateListener?.({ type: 'PRIVATE_RECORD_STATUS', ready: true }));
    await waitFor(() => expect(mocks.removeRegisteredChannel).toHaveBeenCalled());
    expect(status).toHaveBeenCalledWith('SUBSCRIBED');
    act(() => mocks.privateListener?.({ type: 'PRIVATE_RECORD_CHANGED' }));
    expect(payload).toHaveBeenCalledWith({ payload: {} });
    act(() => mocks.privateListener?.({ type: 'PRIVATE_RECORD_STATUS', ready: false }));
    await waitFor(() => expect(mocks.getOrCreateChannel).toHaveBeenCalledTimes(2));
    expect(degraded).toHaveBeenCalledWith('CHANNEL_ERROR');
    status.mockClear();
    act(() => mocks.subscriptionCallbacks.at(-1)?.('SUBSCRIBED'));
    expect(status).not.toHaveBeenCalled();
    act(() => mocks.privateListener?.({ type: 'PRIVATE_RECORD_STATUS', ready: true }));
    expect(status).toHaveBeenCalledWith('SUBSCRIBED');
  });

  it('rebinds rapid A/B/A identities on the same mounted topic and refuses retired callbacks', async () => {
    const payload = vi.fn();
    const status = vi.fn();
    renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName: 'club-roster:11111111-1111-1111-1111-111111111111',
        event: 'record_changed',
        onPayload: payload,
        onSubscriptionStatus: status,
      })
    );
    status.mockClear();
    const retired = mocks.privateListener;
    expect(mocks.privateRecord).toHaveBeenCalledTimes(1);
    await act(async () => {
      mocks.identityListener?.({
        payload: { isAuthenticated: true, userId: 'B' },
      });
      mocks.identityListener?.({
        payload: { isAuthenticated: true, userId: 'A' },
      });
      retired?.({ type: 'PRIVATE_RECORD_CHANGED' });
      retired?.({ type: 'PRIVATE_RECORD_STATUS', ready: true });
      await Promise.resolve();
    });
    expect(payload).not.toHaveBeenCalled();
    expect(status.mock.calls.every(([value]) => value === 'CONNECTING')).toBe(true);
    expect(mocks.privateRecord).toHaveBeenCalledTimes(2);
    act(() => mocks.privateListener?.({ type: 'PRIVATE_RECORD_STATUS', ready: true }));
    expect(status).toHaveBeenCalledWith('SUBSCRIBED');
  });

  it.each([
    'club-roster:11111111-1111-1111-1111-111111111111',
    'member-record:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222',
  ])('never treats a cold paid fallback as engine readiness: %s', async (channelName) => {
    const status = vi.fn();
    const error = vi.fn();
    renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName,
        event: 'record_changed',
        onPayload: vi.fn(),
        onSubscriptionStatus: status,
        onSubscriptionError: error,
      })
    );
    await waitFor(() => expect(mocks.subscriptionCallbacks).toHaveLength(1));
    act(() =>
      mocks.privateListener?.({
        type: 'PRIVATE_RECORD_STATUS',
        ready: false,
      })
    );
    expect(error).not.toHaveBeenCalled(); // Ordinary connecting must not toast.
    act(() => mocks.subscriptionCallbacks[0]('SUBSCRIBED'));
    expect(status).not.toHaveBeenCalledWith('SUBSCRIBED');
    mocks.engineStatus.mockReturnValue('connected');
    act(() =>
      mocks.privateListener?.({
        type: 'PRIVATE_RECORD_STATUS',
        ready: false,
        phase: 'connecting',
      })
    );
    expect(error).not.toHaveBeenCalled();
    act(() =>
      mocks.privateListener?.({
        type: 'PRIVATE_RECORD_STATUS',
        ready: false,
        phase: 'unavailable',
      })
    );
    expect(error).toHaveBeenCalledTimes(1);
    mocks.engineStatus.mockReturnValue('reconnecting');
    act(() => {
      mocks.privateListener?.({
        type: 'PRIVATE_RECORD_STATUS',
        ready: false,
      });
      mocks.privateListener?.({
        type: 'PRIVATE_RECORD_STATUS',
        ready: false,
      });
    });
    expect(error).toHaveBeenCalledTimes(1);
    act(() => mocks.subscriptionCallbacks[0]('SUBSCRIBED'));
    expect(status).not.toHaveBeenCalledWith('SUBSCRIBED');
    mocks.engineStatus.mockReturnValue('connected');
    act(() => mocks.privateListener?.({ type: 'PRIVATE_RECORD_STATUS', ready: true }));
    expect(status).toHaveBeenCalledWith('SUBSCRIBED');
    status.mockClear();
    const retired = mocks.privateListener;
    await act(async () => {
      mocks.identityListener?.({
        payload: { isAuthenticated: true, userId: 'B' },
      });
      await Promise.resolve();
    });
    act(() => retired?.({ type: 'PRIVATE_RECORD_STATUS', ready: true }));
    expect(status).not.toHaveBeenCalledWith('SUBSCRIBED');
    act(() => mocks.subscriptionCallbacks.at(-1)?.('SUBSCRIBED'));
    expect(status).not.toHaveBeenCalledWith('SUBSCRIBED');
    act(() => mocks.privateListener?.({ type: 'PRIVATE_RECORD_STATUS', ready: true }));
    expect(status).toHaveBeenCalledWith('SUBSCRIBED');
  });

  it('marks a previously failed engine unavailable before its first new status event', async () => {
    mocks.engineStatus.mockReturnValue('failed');
    const status = vi.fn();
    const error = vi.fn();
    renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName: 'club-roster:11111111-1111-1111-1111-111111111111',
        event: 'record_changed',
        onPayload: vi.fn(),
        onSubscriptionStatus: status,
        onSubscriptionError: error,
      })
    );
    await waitFor(() => expect(mocks.subscriptionCallbacks).toHaveLength(1));
    expect(error).toHaveBeenCalledTimes(1);
    act(() => mocks.subscriptionCallbacks[0]('SUBSCRIBED'));
    expect(status).not.toHaveBeenCalledWith('SUBSCRIBED');
  });

  it.each([
    {
      channelName: 'club-roster-wallet:11111111-1111-1111-1111-111111111111',
      event: 'wallet_changed',
      private: true,
    },
    {
      channelName: 'club-roster:11111111-1111-1111-1111-111111111111',
      event: 'wallet_changed',
      private: true,
    },
    {
      channelName: 'club-roster:11111111-1111-1111-1111-111111111111',
      event: 'record_changed',
      private: false,
    },
  ])(
    'preserves paid subscribed authority outside the exact two private feeds: %j',
    async (configuration) => {
      const status = vi.fn();
      renderHook(() =>
        useMasterBusBroadcastChannel({
          ...configuration,
          onPayload: vi.fn(),
          onSubscriptionStatus: status,
        })
      );
      await waitFor(() => expect(mocks.subscriptionCallbacks).toHaveLength(1));
      act(() => mocks.subscriptionCallbacks[0]('SUBSCRIBED'));
      expect(status).toHaveBeenCalledWith('SUBSCRIBED');
      expect(mocks.privateRecord).not.toHaveBeenCalled();
    }
  );

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
    expect(mocks.subscribe).not.toHaveBeenCalled();

    await act(async () => releaseAuth?.());

    await waitFor(() => expect(mocks.getOrCreateChannel).toHaveBeenCalledOnce());
    expect(mocks.getOrCreateChannel).toHaveBeenCalledWith('private:user-1', {
      private: true,
    });
    expect(mocks.on).toHaveBeenCalledWith('broadcast', { event: 'changed' }, expect.any(Function));
  });

  it('authenticates before a public channel joins under row authorization', async () => {
    renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName: 'public-room',
        event: 'changed',
        onPayload: vi.fn(),
        private: false,
      })
    );

    await waitFor(() => expect(mocks.getOrCreateChannel).toHaveBeenCalledOnce());
    expect(mocks.setAuth).toHaveBeenCalledOnce();
  });

  it('explicit retry rejoins with fresh auth and ignores the retired callbacks', async () => {
    const onPayload = vi.fn();
    const onSubscriptionStatus = vi.fn();
    const onSubscriptionError = vi.fn();
    const { rerender } = renderHook(
      ({ restartKey }) =>
        useMasterBusBroadcastChannel({
          channelName: 'private:user-1',
          event: 'changed',
          onPayload,
          onSubscriptionStatus,
          onSubscriptionError,
          ...{ restartKey },
        }),
      { initialProps: { restartKey: 0 } }
    );
    await waitFor(() => expect(mocks.subscriptionCallbacks).toHaveLength(1));
    act(() => mocks.subscriptionCallbacks[0]('TIMED_OUT'));
    rerender({ restartKey: 1 });
    await waitFor(() => expect(mocks.subscriptionCallbacks).toHaveLength(2));
    expect(mocks.removeRegisteredChannel).toHaveBeenCalledWith('private:user-1', expect.anything());
    expect(mocks.setAuth).toHaveBeenCalledTimes(2);
    onSubscriptionStatus.mockClear();
    onSubscriptionError.mockClear();
    act(() => {
      mocks.subscriptionCallbacks[1]('SUBSCRIBED');
      mocks.subscriptionCallbacks[0]('CLOSED');
      mocks.payloadCallbacks[0]({ revision: 'old' });
      mocks.payloadCallbacks[1]({ revision: 'new' });
    });
    expect(onSubscriptionStatus.mock.calls).toEqual([['SUBSCRIBED']]);
    expect(onSubscriptionError).not.toHaveBeenCalled();
    expect(onPayload.mock.calls).toEqual([[{ revision: 'new' }]]);
    rerender({ restartKey: 1 });
    expect(mocks.subscriptionCallbacks).toHaveLength(2);
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
    expect(onSubscriptionError).toHaveBeenCalledWith('CHANNEL_ERROR', authError);
    expect(mocks.reportError).toHaveBeenCalledWith(
      authError,
      'useMasterBusBroadcastChannel.CHANNEL_ERROR.changed'
    );
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it('ignores stale status and payload callbacks after a channel replacement', async () => {
    const firstChannel = {
      state: 'closed',
      on: mocks.on,
      subscribe: mocks.subscribe,
    };
    const replacementChannel = {
      state: 'closed',
      on: mocks.on,
      subscribe: mocks.subscribe,
    };
    mocks.getOrCreateChannel
      .mockReturnValueOnce(firstChannel)
      .mockReturnValueOnce(replacementChannel);
    const onPayload = vi.fn();
    const onSubscriptionError = vi.fn();
    const onSubscriptionStatus = vi.fn();

    renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName: 'private:user-1',
        event: 'changed',
        onPayload,
        onSubscriptionError,
        onSubscriptionStatus,
      })
    );

    await waitFor(() => expect(mocks.subscriptionCallbacks).toHaveLength(1));
    const startReplacement = mocks.registerChannelFactory.mock.calls[0]?.[1] as
      | (() => void)
      | undefined;
    expect(startReplacement).toBeTypeOf('function');
    await act(async () => {
      startReplacement?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(mocks.subscriptionCallbacks).toHaveLength(2));

    // The superseded channel may still report its late terminal status or a
    // queued frame after its replacement has become the active owner.
    act(() => {
      mocks.subscriptionCallbacks[0]('CLOSED');
      mocks.payloadCallbacks[0]({ revision: 1 });
    });
    expect(onSubscriptionStatus).not.toHaveBeenCalled();
    expect(onSubscriptionError).not.toHaveBeenCalled();
    expect(onPayload).not.toHaveBeenCalled();

    // The active callback remains live across ordinary disconnect/rejoin
    // statuses and continues delivering current-channel payloads.
    const channelError = new Error('Temporary Realtime Disconnect');
    act(() => {
      mocks.subscriptionCallbacks[1]('CHANNEL_ERROR', channelError);
      mocks.subscriptionCallbacks[1]('SUBSCRIBED');
      mocks.payloadCallbacks[1]({ revision: 2 });
    });
    expect(onSubscriptionStatus.mock.calls.map(([status]) => status)).toEqual([
      'CHANNEL_ERROR',
      'SUBSCRIBED',
    ]);
    expect(onSubscriptionError).toHaveBeenCalledWith('CHANNEL_ERROR', channelError);
    expect(onPayload).toHaveBeenCalledWith({ revision: 2 });
  });

  it('does not let an older auth attempt win when it completes after its replacement', async () => {
    const resolveAuth: Array<() => void> = [];
    mocks.setAuth.mockImplementation(
      () => new Promise<void>((resolve) => resolveAuth.push(resolve))
    );
    const firstChannel = {
      state: 'closed',
      on: mocks.on,
      subscribe: mocks.subscribe,
    };
    const replacementChannel = {
      state: 'closed',
      on: mocks.on,
      subscribe: mocks.subscribe,
    };
    mocks.getOrCreateChannel
      .mockReturnValueOnce(firstChannel)
      .mockReturnValueOnce(replacementChannel);

    renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName: 'private:user-1',
        event: 'changed',
        onPayload: vi.fn(),
      })
    );
    await waitFor(() => expect(resolveAuth).toHaveLength(1));

    const startReplacement = mocks.registerChannelFactory.mock.calls[0]?.[1] as
      | (() => void)
      | undefined;
    startReplacement?.();
    await waitFor(() => expect(resolveAuth).toHaveLength(2));

    await act(async () => resolveAuth[1]?.());
    await waitFor(() => expect(mocks.subscriptionCallbacks).toHaveLength(1));
    await act(async () => resolveAuth[0]?.());

    expect(mocks.getOrCreateChannel).toHaveBeenCalledTimes(2);
    expect(mocks.getOrCreateChannel).toHaveBeenCalledWith('private:user-1', {
      private: true,
    });
    expect(mocks.subscriptionCallbacks).toHaveLength(1);
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

    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(mocks.removeChannelFactory).toHaveBeenCalledWith('private:user-1');
    expect(mocks.removeRegisteredChannel).toHaveBeenCalledWith('private:user-1', expect.anything());
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
      expect(onSubscriptionError).toHaveBeenCalledWith('CHANNEL_ERROR', expect.any(Error))
    );
    expect(mocks.subscribe).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
    expect(mocks.getOrCreateChannel).toHaveBeenCalledTimes(2);
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

    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
    expect(mocks.getOrCreateChannel).toHaveBeenCalledTimes(2);
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
    expect(mocks.subscribe).not.toHaveBeenCalled();
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
  /* 2026-10-24: a dropped shared socket fans CHANNEL_ERROR out to every
     channel with no reason. Production filed ~1,100 of these a day, 3 to 10
     per drop. One report per outage; every consumer still hears its own. */
  it('reports a reasonless socket drop once across every channel, but tells every consumer', async () => {
    const errors = [vi.fn(), vi.fn(), vi.fn()];
    const names = ['profile-account:u', 'profile-appearance:u', 'daily-mission-completion:u'];
    names.forEach((channelName, i) =>
      renderHook(() =>
        useMasterBusBroadcastChannel({
          channelName,
          event: 'changed',
          onPayload: vi.fn(),
          onSubscriptionError: errors[i],
        })
      )
    );
    await waitFor(() => expect(mocks.subscriptionCallbacks).toHaveLength(3));
    act(() => mocks.subscriptionCallbacks.forEach((callback) => callback('CHANNEL_ERROR')));

    const filed = mocks.reportError.mock.calls.map(([, source]) => source);
    expect(filed).toEqual(['Realtime.transport_lost']);
    for (const error of errors)
      expect(error).toHaveBeenCalledExactlyOnceWith('CHANNEL_ERROR', undefined);
  });

  it('files a refused private topic once per mount, not on every recovery attempt', async () => {
    const refused = new Error(
      '"Unauthorized: You do not have permissions to read from this Channel topic: table-appearance:x"'
    );
    const onSubscriptionError = vi.fn();
    renderHook(() =>
      useMasterBusBroadcastChannel({
        channelName: 'table-appearance:x',
        event: 'appearance_changed',
        onPayload: vi.fn(),
        onSubscriptionError,
      })
    );
    await waitFor(() => expect(mocks.subscriptionCallbacks).toHaveLength(1));
    const recover = mocks.registerChannelFactory.mock.calls[0][1] as () => void;
    act(() => mocks.subscriptionCallbacks[0]('CHANNEL_ERROR', refused));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      act(() => recover());
      await waitFor(() => expect(mocks.subscriptionCallbacks).toHaveLength(attempt + 1));
      act(() => mocks.subscriptionCallbacks[attempt]('CHANNEL_ERROR', refused));
    }
    expect(
      mocks.reportError.mock.calls.filter(
        ([, source]) => source === 'useMasterBusBroadcastChannel.CHANNEL_ERROR.appearance_changed'
      )
    ).toHaveLength(1);
    expect(onSubscriptionError).toHaveBeenCalledTimes(4);
  });

  it('still files a channel-specific failure every time', async () => {
    renderHook(() =>
      useMasterBusBroadcastChannel({ channelName: 'one', event: 'changed', onPayload: vi.fn() })
    );
    await waitFor(() => expect(mocks.subscriptionCallbacks).toHaveLength(1));
    act(() => mocks.subscriptionCallbacks[0]('TIMED_OUT'));
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Realtime TIMED_OUT on one' }),
      'useMasterBusBroadcastChannel.TIMED_OUT.changed'
    );
  });
});
