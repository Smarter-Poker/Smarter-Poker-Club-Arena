import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ClubRosterService, {
  type RosterMember,
  type WinLossFigure,
  type WinLossPeriod,
} from '../../src/services/ClubRosterService';
import {
  useRosterWinLoss,
  WIN_LOSS_RETRY_BASE_MS,
  WIN_LOSS_RETRY_MAX_MS,
} from '../../src/hooks/useRosterWinLoss';

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
const member = (id = 'a', visible = true) =>
  ({ user_id: id, can_view_financials: visible }) as RosterMember;
const figure = (net: number): WinLossFigure => ({ cash: net, mtt: 0, net });
const members = [member()];
type Props = {
  revision: number;
  viewer: string;
  period: WinLossPeriod;
  rows: RosterMember[];
  enabled: boolean;
};
const initial: Props = {
  revision: 0,
  viewer: 'first',
  period: 'overall',
  rows: members,
  enabled: true,
};
const useFigures = (p: Props) =>
  useRosterWinLoss('club', p.rows, p.period, p.enabled, p.revision, p.viewer);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('invalidates every cached period immediately on a source revision', async () => {
  let value = 10;
  const read = vi
    .spyOn(ClubRosterService, 'getMembersWinLoss')
    .mockImplementation(async () => new Map([['a', figure(value)]]));
  const { result, rerender } = renderHook(useFigures, { initialProps: initial });
  await waitFor(() => expect(result.current.get('a')?.net).toBe(10));
  rerender({ ...initial, period: 'today' });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await act(async () => {});
  value = 20;
  rerender({ ...initial, period: 'today', revision: 1 });
  expect(result.current.get('a')?.net).toBe(10);
  await waitFor(() => expect(result.current.get('a')?.net).toBe(20));
  rerender({ ...initial, revision: 1 });
  await waitFor(() => expect(result.current.get('a')?.net).toBe(20));
  expect(read).toHaveBeenCalledTimes(4);
});

it('retains verified figures on transport failure and removes a successful denied row', async () => {
  const read = vi
    .spyOn(ClubRosterService, 'getMembersWinLoss')
    .mockResolvedValue(new Map([['a', figure(10)]]));
  const { result, rerender } = renderHook(useFigures, { initialProps: initial });
  await waitFor(() => expect(result.current.get('a')?.net).toBe(10));
  read.mockRejectedValueOnce(new Error('temporary outage'));
  rerender({ ...initial, revision: 1 });
  await act(async () => {});
  expect(result.current.get('a')?.net).toBe(10);
  read.mockResolvedValueOnce(new Map());
  rerender({ ...initial, revision: 2 });
  await waitFor(() => expect(result.current.has('a')).toBe(false));
});

it('withdraws cached figures synchronously on viewer, row access and enabled changes', async () => {
  const read = vi
    .spyOn(ClubRosterService, 'getMembersWinLoss')
    .mockResolvedValue(new Map([['a', figure(10)]]));
  const { result, rerender } = renderHook(useFigures, { initialProps: initial });
  await waitFor(() => expect(result.current.get('a')?.net).toBe(10));
  read.mockImplementation(() => new Promise(() => {}));
  rerender({ ...initial, viewer: 'second' });
  expect(result.current.size).toBe(0);
  rerender({ ...initial, viewer: 'first', rows: [member('a', false)] });
  expect(result.current.size).toBe(0);
  rerender({ ...initial, enabled: false });
  expect(result.current.size).toBe(0);
});

it('removes a revoked row from every cached period before the next RPC', async () => {
  const read = vi
    .spyOn(ClubRosterService, 'getMembersWinLoss')
    .mockResolvedValue(new Map([['a', figure(10)]]));
  const { result, rerender } = renderHook(useFigures, { initialProps: initial });
  await waitFor(() => expect(result.current.get('a')?.net).toBe(10));
  rerender({ ...initial, period: 'today' });
  await waitFor(() => expect(result.current.get('a')?.net).toBe(10));
  read.mockImplementation(() => new Promise(() => {}));
  rerender({ ...initial, period: 'today', rows: [member('a', false)] });
  expect(result.current.size).toBe(0);
  rerender({ ...initial });
  expect(result.current.size).toBe(0);
});

it('ignores a late previous-viewer answer after an A/B/A switch', async () => {
  let finish!: (rows: Map<string, WinLossFigure>) => void;
  const read = vi
    .spyOn(ClubRosterService, 'getMembersWinLoss')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    )
    .mockResolvedValue(new Map([['a', figure(20)]]));
  const { result, rerender } = renderHook(useFigures, { initialProps: initial });
  await act(async () => {});
  const oldSignal = read.mock.calls[0][3]!;
  rerender({ ...initial, viewer: 'second' });
  rerender({ ...initial });
  await waitFor(() => expect(result.current.get('a')?.net).toBe(20));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => finish(new Map([['a', figure(999)]])));
  expect(result.current.get('a')?.net).toBe(20);
});

it('retries aborted cached-row refreshes when a loaded page changes', async () => {
  let finish!: (rows: Map<string, WinLossFigure>) => void;
  const read = vi
    .spyOn(ClubRosterService, 'getMembersWinLoss')
    .mockResolvedValue(new Map([['a', figure(10)]]));
  const { result, rerender } = renderHook(useFigures, { initialProps: initial });
  await waitFor(() => expect(result.current.get('a')?.net).toBe(10));
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  rerender({ ...initial, revision: 1 });
  await act(async () => {});
  const oldSignal = read.mock.calls[1][3]!;
  read.mockResolvedValueOnce(
    new Map([
      ['a', figure(30)],
      ['b', figure(40)],
    ])
  );
  rerender({ ...initial, revision: 1, rows: [member('a'), member('b')] });
  await waitFor(() => expect(result.current.get('a')?.net).toBe(30));
  expect(read.mock.lastCall![1]).toEqual(['a', 'b']);
  expect(oldSignal.aborted).toBe(true);
  await act(async () => finish(new Map([['a', figure(999)]])));
  expect(result.current.get('a')?.net).toBe(30);
});

it('marks a failed row Unavailable instead of loading for ever, then retries on a backoff', async () => {
  vi.useFakeTimers();
  try {
    const read = vi
      .spyOn(ClubRosterService, 'getMembersWinLoss')
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValue(new Map([['a', figure(15)]]));
    const { result } = renderHook(useFigures, { initialProps: initial });
    await act(async () => {});
    expect(result.current.has('a')).toBe(false);
    expect(result.current.unavailable.has('a')).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WIN_LOSS_RETRY_BASE_MS * 1.3);
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.get('a')?.net).toBe(15);
    expect(result.current.unavailable.has('a')).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps a verified figure on a failed refresh and stops retrying once unmounted', async () => {
  vi.useFakeTimers();
  try {
    const read = vi
      .spyOn(ClubRosterService, 'getMembersWinLoss')
      .mockResolvedValueOnce(new Map([['a', figure(10)]]))
      .mockRejectedValue(new Error('timed out'));
    const { result, rerender, unmount } = renderHook(useFigures, { initialProps: initial });
    await act(async () => {});
    expect(result.current.get('a')?.net).toBe(10);
    rerender({ ...initial, revision: 1 });
    await act(async () => {});
    expect(result.current.get('a')?.net).toBe(10);
    expect(result.current.unavailable.has('a')).toBe(true);
    const calls = read.mock.calls.length;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WIN_LOSS_RETRY_MAX_MS * 2);
    });
    expect(read).toHaveBeenCalledTimes(calls);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps fees and profit/loss together when a previous period resolves late', async () => {
  let finishWeek!: (rows: Map<string, WinLossFigure>) => void;
  const week = { ...initial, period: 'week' as const };
  const read = vi
    .spyOn(ClubRosterService, 'getMembersWinLoss')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWeek = resolve;
        })
    )
    .mockResolvedValue(new Map([['a', { cash: 8, mtt: 2, net: 10, fees: 40, downline_fees: 50 }]]));
  const { result, rerender } = renderHook(useFigures, { initialProps: week as Props });
  await act(async () => {});
  rerender({ ...initial, period: 'overall' });
  expect(result.current.size).toBe(0);
  await waitFor(() => expect(result.current.get('a')?.fees).toBe(40));
  await act(async () =>
    finishWeek(new Map([['a', { cash: -9, mtt: 0, net: -9, fees: 2, downline_fees: 3 }]]))
  );
  expect(result.current.get('a')).toEqual({
    cash: 8,
    mtt: 2,
    net: 10,
    fees: 40,
    downline_fees: 50,
  });
  expect(read.mock.calls.map((call) => call[2])).toEqual(['week', 'overall']);
});
