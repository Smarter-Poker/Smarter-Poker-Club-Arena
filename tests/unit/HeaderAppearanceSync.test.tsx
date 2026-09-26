import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const model = vi.hoisted(() => ({
  userId: 'player-a' as string | undefined,
  options: null as any,
  store: {
    _userId: null as string | null,
    loadOnce: vi.fn(),
    teardown: vi.fn(),
    refreshAppearance: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (select: any) => select({ user: model.userId ? { id: model.userId } : null }),
}));
vi.mock('../../src/stores/useHeaderDataStore', () => ({
  useHeaderDataStore: { getState: () => model.store },
}));
vi.mock('../../src/hooks/useMasterBusBroadcastChannel', () => ({
  useMasterBusBroadcastChannel: (options: unknown) => {
    model.options = options;
  },
}));
import { HeaderAppearanceSync } from '../../src/hooks/useHeaderAppearanceSync';
beforeEach(() => {
  model.userId = 'player-a';
  model.store._userId = null;
  vi.clearAllMocks();
  model.store.loadOnce.mockImplementation((id: string) => {
    model.store._userId = id;
  });
  model.store.teardown.mockImplementation(() => {
    model.store._userId = null;
  });
});
describe('the app-level appearance owner', () => {
  it('loads once without a header and receives only its own real signal', () => {
    render(<HeaderAppearanceSync />);
    expect(model.store.loadOnce).toHaveBeenCalledWith('player-a');
    expect(model.options).toMatchObject({
      channelName: 'profile-appearance:player-a',
      private: true,
      event: 'appearance_changed',
    });
    act(() => model.options.onPayload({ payload: { user_id: 'player-b' } }));
    expect(model.store.refreshAppearance).not.toHaveBeenCalled();
    act(() => model.options.onPayload({ payload: { user_id: 'player-a' } }));
    expect(model.store.refreshAppearance).toHaveBeenCalledTimes(1);
    act(() => model.options.onSubscriptionStatus('SUBSCRIBED'));
    expect(model.store.refreshAppearance).toHaveBeenCalledTimes(2);
  });
  it('retires the old store on account changes and has no signed-out channel', () => {
    const { rerender } = render(<HeaderAppearanceSync />);
    const oldSignal = model.options.onPayload;
    model.userId = 'player-b';
    rerender(<HeaderAppearanceSync />);
    expect(model.store.teardown).toHaveBeenCalledTimes(1);
    expect(model.options.channelName).toBe('profile-appearance:player-b');
    act(() => oldSignal({ payload: { user_id: 'player-a' } }));
    expect(model.store.refreshAppearance).not.toHaveBeenCalled();
    model.userId = undefined;
    rerender(<HeaderAppearanceSync />);
    expect(model.store.teardown).toHaveBeenCalledTimes(2);
    expect(model.options.channelName).toBeNull();
  });
});
