import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  getOrCreateChannel: vi.fn(),
  registerChannelFactory: vi.fn(),
  removeChannelFactory: vi.fn(),
  removeRegisteredChannel: vi.fn(),
  reportError: vi.fn(),
  statuses: [] as Array<(status: string) => void>,
  payloads: [] as Array<(payload: unknown) => void>,
}));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: f }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: f.reportError }));
import { useMasterBusChannel } from '../../src/hooks/useMasterBusChannel';

beforeEach(() => {
  vi.clearAllMocks();
  f.statuses = [];
  f.payloads = [];
  f.getOrCreateChannel.mockImplementation(() => ({
    state: 'closed',
    on: (_kind: string, _filter: unknown, payload: (value: unknown) => void) => {
      f.payloads.push(payload);
      return { subscribe: (status: (value: string) => void) => f.statuses.push(status) };
    },
  }));
});

it('explicit retry replaces a failed row subscription and rejects late old callbacks', () => {
  const onPayload = vi.fn(),
    onSubscriptionStatus = vi.fn(),
    onSubscriptionError = vi.fn();
  const { rerender, unmount } = renderHook(
    ({ restartKey }) =>
      useMasterBusChannel({
        channelName: 'club-data-tables:test',
        table: 'tables',
        filter: 'club_id=eq.test',
        event: '*',
        onPayload,
        onSubscriptionStatus,
        onSubscriptionError,
        ...{ restartKey },
      }),
    { initialProps: { restartKey: 0 } }
  );
  act(() => f.statuses[0]('TIMED_OUT'));
  rerender({ restartKey: 1 });
  expect(f.statuses).toHaveLength(2);
  expect(f.removeRegisteredChannel).toHaveBeenCalledWith('club-data-tables:test');
  onSubscriptionStatus.mockClear();
  onSubscriptionError.mockClear();
  act(() => {
    f.statuses[1]('SUBSCRIBED');
    f.statuses[0]('CLOSED');
    f.payloads[0]({ revision: 'old' });
    f.payloads[1]({ revision: 'new' });
  });
  expect(onSubscriptionStatus.mock.calls).toEqual([['SUBSCRIBED']]);
  expect(onSubscriptionError).not.toHaveBeenCalled();
  expect(onPayload.mock.calls).toEqual([[{ revision: 'new' }]]);
  rerender({ restartKey: 1 });
  expect(f.statuses).toHaveLength(2);
  unmount();
  expect(f.removeRegisteredChannel).toHaveBeenCalledTimes(2);
});

it('a registered recovery factory cannot let a retired channel overwrite its replacement', () => {
  const onPayload = vi.fn(),
    onSubscriptionStatus = vi.fn(),
    onSubscriptionError = vi.fn();
  renderHook(() =>
    useMasterBusChannel({
      channelName: 'club-data-tables:test',
      table: 'tables',
      filter: 'club_id=eq.test',
      event: '*',
      onPayload,
      onSubscriptionStatus,
      onSubscriptionError,
    })
  );
  act(() => f.statuses[0]('TIMED_OUT'));
  act(() => f.registerChannelFactory.mock.calls[0][1]());
  expect(f.statuses).toHaveLength(2);
  onSubscriptionStatus.mockClear();
  onSubscriptionError.mockClear();
  act(() => {
    f.statuses[1]('SUBSCRIBED');
    f.statuses[0]('CLOSED');
    f.payloads[0]({ revision: 'old' });
    f.payloads[1]({ revision: 'new' });
  });
  expect(onSubscriptionStatus.mock.calls).toEqual([['SUBSCRIBED']]);
  expect(onSubscriptionError).not.toHaveBeenCalled();
  expect(onPayload.mock.calls).toEqual([[{ revision: 'new' }]]);
});
