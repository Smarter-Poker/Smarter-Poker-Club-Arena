import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  subscribeRealtime: vi.fn(),
  admissions: [] as Array<{ signal: AbortSignal; status: (value: string) => void }>,
  getOrCreateChannel: vi.fn(),
  registerChannelFactory: vi.fn(),
  removeChannelFactory: vi.fn(),
  removeRegisteredChannel: vi.fn(),
  reportError: vi.fn(),
  statuses: [] as Array<(status: string) => void>,
  payloads: [] as Array<(payload: unknown) => void>,
}));
vi.mock('../../src/lib/subscribeRealtime', () => ({ subscribeRealtime: f.subscribeRealtime }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: f }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: f.reportError }));
import { useMasterBusChannel } from '../../src/hooks/useMasterBusChannel';
import { __resetRealtimeTransportLossForTests } from '../../src/lib/realtimeTransportLoss';

beforeEach(() => {
  vi.clearAllMocks();
  __resetRealtimeTransportLossForTests();
  f.admissions = [];
  f.subscribeRealtime.mockImplementation((channel, status, signal) => {
    f.admissions.push({ signal, status });
    channel.subscribe(status);
    return Promise.resolve();
  });
  f.statuses = [];
  f.payloads = [];
  f.getOrCreateChannel.mockImplementation(() => {
    const channel = {
      state: 'closed',
      on: (_kind: string, _filter: unknown, payload: (value: unknown) => void) => {
        f.payloads.push(payload);
        return channel;
      },
      subscribe: (status: (value: string) => void) => f.statuses.push(status),
    };
    return channel;
  });
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
  expect(f.removeRegisteredChannel).toHaveBeenCalledWith(
    expect.stringMatching(/^club-data-tables:test:row:/),
    expect.anything()
  );
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

it('aborts pending admission on unmount and ignores a retired completion', () => {
  f.subscribeRealtime.mockImplementation((_channel, status, signal) => {
    f.admissions.push({ signal, status });
    return Promise.resolve();
  });
  const onSubscriptionStatus = vi.fn(),
    onSubscriptionError = vi.fn();
  const { unmount } = renderHook(() =>
    useMasterBusChannel({
      channelName: 'pending',
      table: 'club_members',
      filter: 'club_id=eq.test',
      event: '*',
      onPayload: vi.fn(),
      onSubscriptionStatus,
      onSubscriptionError,
    })
  );
  expect(f.admissions[0].signal.aborted).toBe(false);
  unmount();
  expect(f.admissions[0].signal.aborted).toBe(true);
  act(() => f.admissions[0].status('CHANNEL_ERROR'));
  expect(onSubscriptionStatus).not.toHaveBeenCalled();
  expect(onSubscriptionError).not.toHaveBeenCalled();
  expect(f.removeRegisteredChannel).toHaveBeenCalledTimes(1);
});

it('a pending recovery admission is cancelled before its replacement owns callbacks', () => {
  f.subscribeRealtime.mockImplementation((_channel, status, signal) => {
    f.admissions.push({ signal, status });
    return Promise.resolve();
  });
  const onSubscriptionStatus = vi.fn();
  const { unmount } = renderHook(() =>
    useMasterBusChannel({
      channelName: 'pending-retry',
      table: 'club_members',
      filter: 'club_id=eq.test',
      event: '*',
      onPayload: vi.fn(),
      onSubscriptionStatus,
    })
  );
  act(() => f.registerChannelFactory.mock.calls[0][1]());
  expect(f.admissions).toHaveLength(2);
  expect(f.admissions[0].signal.aborted).toBe(true);
  expect(f.admissions[1].signal.aborted).toBe(false);
  act(() => {
    f.admissions[1].status('SUBSCRIBED');
    f.admissions[0].status('CLOSED');
  });
  expect(onSubscriptionStatus.mock.calls).toEqual([['SUBSCRIBED']]);
  unmount();
  expect(f.admissions[1].signal.aborted).toBe(true);
});

it('reports a reasonless socket drop once for every row channel it fans out to (2026-10-24)', () => {
  const errors = [vi.fn(), vi.fn()];
  ['club-members-kings-club', 'club-agents-kings-club'].forEach((channelName, i) =>
    renderHook(() =>
      useMasterBusChannel({
        channelName,
        table: i ? 'agents' : 'club_members',
        filter: 'club_id=eq.test',
        event: '*',
        onPayload: vi.fn(),
        onSubscriptionError: errors[i],
      })
    )
  );
  act(() => f.statuses.forEach((status) => status('CHANNEL_ERROR')));
  expect(f.reportError.mock.calls.map(([, source]) => source)).toEqual(['Realtime.transport_lost']);
  for (const error of errors)
    expect(error).toHaveBeenCalledExactlyOnceWith('CHANNEL_ERROR', undefined);

  // The socket comes back; the next drop is a new outage and is counted.
  act(() => f.statuses.forEach((status) => status('SUBSCRIBED')));
  act(() => f.statuses[0]('CHANNEL_ERROR'));
  expect(f.reportError).toHaveBeenCalledTimes(2);
});

it('still files a row channel the server refused with a reason', () => {
  renderHook(() =>
    useMasterBusChannel({
      channelName: 'club-data:test',
      table: 'tables',
      filter: 'club_id=eq.test',
      event: '*',
      onPayload: vi.fn(),
    })
  );
  const mismatch = new Error('mismatch between server and client bindings for postgres changes');
  act(() => f.statuses[0]('CHANNEL_ERROR', mismatch as never));
  expect(f.reportError).toHaveBeenCalledExactlyOnceWith(
    mismatch,
    'useMasterBusChannel.CHANNEL_ERROR.tables'
  );
});
