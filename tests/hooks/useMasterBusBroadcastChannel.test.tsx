import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setAuth: vi.fn(),
  getOrCreateChannel: vi.fn(),
  registerChannelFactory: vi.fn(),
  removeChannelFactory: vi.fn(),
  removeRegisteredChannel: vi.fn(),
  reportError: vi.fn(),
  on: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: { realtime: { setAuth: mocks.setAuth } },
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
  });

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
});
