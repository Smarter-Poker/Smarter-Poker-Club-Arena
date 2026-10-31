import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  release: undefined as undefined | (() => void),
  subscribe: vi.fn(() => vi.fn()),
  identity: undefined as undefined | ((change: any) => void),
  unblock: undefined as undefined | (() => void),
}));
vi.mock('../../src/services/PrivateRecordTransport', async () => {
  await new Promise<void>((resolve) => {
    f.unblock = resolve;
  });
  return {
    privateRecordTransport: { onPrivateRecord: f.subscribe, getStatus: () => 'connecting' },
  };
});
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (_: string, callback: any) => {
      f.identity = callback;
      return () => {};
    },
    getOrCreateChannel: () => ({ on: () => {} }),
    registerChannelFactory: () => {},
    removeChannelFactory: () => {},
    removeRegisteredChannel: () => {},
  },
}));
vi.mock('../../src/lib/subscribeRealtime', () => ({ subscribeRealtime: () => Promise.resolve() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
import { useMasterBusBroadcastChannel } from '../../src/hooks/useMasterBusBroadcastChannel';
it('does not acquire a record subscription after unmount during module loading', async () => {
  const view = renderHook(() =>
    useMasterBusBroadcastChannel({
      channelName: 'club-roster:11111111-1111-1111-1111-111111111111',
      event: 'record_changed',
      onPayload: () => {},
    })
  );
  await waitFor(() => expect(f.unblock).toBeTypeOf('function'));
  view.unmount();
  await act(async () => f.unblock?.());
  expect(f.subscribe).not.toHaveBeenCalled();
});
