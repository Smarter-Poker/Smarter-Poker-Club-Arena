import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  report: vi.fn(),
  listeners: new Map<string, Set<() => void>>(),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.report }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (event: string, callback: () => void) => {
      if (!mocks.listeners.has(event)) mocks.listeners.set(event, new Set());
      mocks.listeners.get(event)!.add(callback);
      return () => mocks.listeners.get(event)!.delete(callback);
    },
  },
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: create(() => ({ user: { id: 'owner' } })),
}));
import { useUserStore } from '../../src/stores/useUserStore';
import {
  resetClubOperationsOverviewCache,
  useClubOperationsOverview,
} from '../../src/hooks/useClubOperationsOverview';
const payload = (bank: number) => ({
  generated_at: '2026-10-11T19:00:00Z',
  club: { id: 'club' },
  kpis: {
    club_bank: bank,
    members: 1,
    members_pending: 0,
    members_new_7d: 0,
    online_now: 0,
    seated_now: 0,
    live_tables: 0,
    running_tables: 0,
    waiting_tables: 0,
    tournaments_registering: 0,
    tournaments_running: 0,
    hands_today: 0,
  },
  viewer: { is_platform_staff: false, can_view_finance: true, can_control_club: true },
  counts: {
    members: 1,
    members_pending: 0,
    reports_open: 0,
    disputes_open: 0,
    disputes_aged: 0,
    blacklist_active: 0,
    blacklist_expired: 0,
    chip_requests_pending: 0,
    cashouts_pending: 0,
    credit_requests_pending: 0,
    tickets_outstanding: 0,
    anti_cheat_flags_open: 0,
    invoices_open: null,
    invoices_overdue: null,
  },
  alerts: [],
});
const emit = (event: string) =>
  act(() => mocks.listeners.get(event)?.forEach((callback) => callback()));

describe('Club Operations Reading Lifecycle', () => {
  beforeEach(() => {
    resetClubOperationsOverviewCache();
    mocks.rpc.mockReset();
    mocks.report.mockReset();
    useUserStore.setState({ user: { id: 'owner' } as never });
  });
  it('shares the original reading timestamp between sibling consumers', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    mocks.rpc.mockResolvedValue({ data: payload(100), error: null });
    const first = renderHook(() => useClubOperationsOverview('club'));
    await waitFor(() => expect(first.result.current.overview).not.toBeNull());
    clock.mockReturnValue(12_000);
    const second = renderHook(() => useClubOperationsOverview('club'));
    await waitFor(() => expect(second.result.current.overview).not.toBeNull());
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(second.result.current.refreshedAt).toBe(first.result.current.refreshedAt);
    first.unmount();
    second.unmount();
    clock.mockRestore();
  });
  it('does not share finance readings across accounts', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: payload(100), error: null })
      .mockResolvedValueOnce({ data: payload(0), error: null });
    const hook = renderHook(() => useClubOperationsOverview('club'));
    await waitFor(() => expect(hook.result.current.overview?.kpis.club_bank).toBe(100));
    act(() => useUserStore.setState({ user: { id: 'agent' } as never }));
    await waitFor(() => expect(hook.result.current.overview?.kpis.club_bank).toBe(0));
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    hook.unmount();
  });
  it('retires pending replies when an auth event returns to the same account', async () => {
    let finish!: (value: unknown) => void;
    mocks.rpc
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      )
      .mockResolvedValueOnce({ data: payload(2), error: null });
    const hook = renderHook(() => useClubOperationsOverview('club'));
    emit('AUTH_STATE_CHANGED');
    await waitFor(() => expect(hook.result.current.overview?.kpis.club_bank).toBe(2));
    await act(async () => finish({ data: payload(999), error: null }));
    expect(hook.result.current.overview?.kpis.club_bank).toBe(2);
    hook.unmount();
  });
  it.each([
    {},
    { ...payload(1), club: { id: 'another-club' } },
    { ...payload(1), kpis: {} },
    { ...payload(1), generated_at: 'invalid' },
    { ...payload(1), viewer: {} },
    { ...payload(1), counts: {} },
    { ...payload(1), counts: { ...payload(1).counts, anti_cheat_flags_open: 'unknown' } },
  ])('refuses malformed or foreign-club success payloads', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    const hook = renderHook(() => useClubOperationsOverview('club'));
    await waitFor(() => expect(hook.result.current.error).not.toBeNull());
    expect(hook.result.current.overview).toBeNull();
    expect(hook.result.current.refreshedAt).toBeNull();
    hook.unmount();
  });
  it('accepts numeric strings but retains restricted finance and unknown invoices', async () => {
    const data = payload(100);
    mocks.rpc.mockResolvedValue({
      data: {
        ...data,
        viewer: { ...data.viewer, can_view_finance: false },
        kpis: { ...data.kpis, members: '12', club_bank: null },
        counts: { ...data.counts, invoices_open: null, invoices_overdue: null },
      },
      error: null,
    });
    const hook = renderHook(() => useClubOperationsOverview('club'));
    await waitFor(() => expect(hook.result.current.overview?.kpis.members).toBe(12));
    expect(hook.result.current.overview?.kpis.club_bank).toBeUndefined();
    expect(hook.result.current.overview?.counts.invoices_open).toBeNull();
    hook.unmount();
  });
  it('does not resurrect an authorized cache after a permission refusal', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: payload(100), error: null })
      .mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Denied' } })
      .mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Denied' } });
    const first = renderHook(() => useClubOperationsOverview('club'));
    await waitFor(() => expect(first.result.current.overview?.kpis.club_bank).toBe(100));
    act(() => first.result.current.refresh());
    await waitFor(() => expect(first.result.current.denied).toBe(true));
    first.unmount();
    const second = renderHook(() => useClubOperationsOverview('club'));
    await waitFor(() => expect(second.result.current.denied).toBe(true));
    expect(second.result.current.overview).toBeNull();
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
    second.unmount();
  });
  it('clears cached permissions and immediately reads again after a role change', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: payload(100), error: null })
      .mockResolvedValueOnce({ data: payload(0), error: null });
    const hook = renderHook(() => useClubOperationsOverview('club'));
    await waitFor(() => expect(hook.result.current.overview?.kpis.club_bank).toBe(100));
    emit('MEMBER_ROLE_CHANGED');
    await waitFor(() => expect(hook.result.current.overview?.kpis.club_bank).toBe(0));
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    hook.unmount();
  });
});

function pendingRead() {
  let resolve!: (value: { data: null; error: Error }) => void;
  const promise = new Promise<{ data: null; error: Error }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('club overview outcome belongs to its mounted reader', () => {
  beforeEach(() => {
    resetClubOperationsOverviewCache();
    mocks.rpc.mockReset();
    mocks.report.mockReset();
  });

  it('drops an aborted read after the owning route unmounts', async () => {
    const read = pendingRead();
    mocks.rpc.mockReturnValueOnce(read.promise);
    const hook = renderHook(() => useClubOperationsOverview('disposed-club'));
    expect(mocks.rpc).toHaveBeenCalledOnce();
    hook.unmount();
    await act(async () => {
      read.resolve({ data: null, error: new TypeError('Failed to fetch') });
    });
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('keeps current-reader transport failures visible', async () => {
    const read = pendingRead();
    mocks.rpc.mockReturnValueOnce(read.promise);
    const hook = renderHook(() => useClubOperationsOverview('active-club'));
    const failure = new TypeError('Failed to fetch');
    await act(async () => {
      read.resolve({ data: null, error: failure });
    });
    expect(mocks.report).toHaveBeenCalledWith(failure, 'ClubOperationsOverview.Load_failed');
    expect(hook.result.current.error).toBe('Live club readings are unavailable right now.');
    expect(hook.result.current.loading).toBe(false);
    hook.unmount();
  });

  it('does not report a former club failure after switching clubs', async () => {
    const former = pendingRead();
    const current = pendingRead();
    mocks.rpc.mockReturnValueOnce(former.promise).mockReturnValueOnce(current.promise);
    const hook = renderHook(({ club }) => useClubOperationsOverview(club), {
      initialProps: { club: 'former-club' },
    });
    hook.rerender({ club: 'current-club' });
    await act(async () => {
      former.resolve({ data: null, error: new TypeError('Failed to fetch') });
    });
    expect(mocks.report).not.toHaveBeenCalled();
    expect(hook.result.current.loading).toBe(true);
    hook.unmount();
    await act(async () => {
      current.resolve({ data: null, error: new TypeError('Failed to fetch') });
    });
    expect(mocks.report).not.toHaveBeenCalled();
  });
});
