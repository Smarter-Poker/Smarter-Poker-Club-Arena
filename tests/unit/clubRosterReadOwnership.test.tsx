import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  actor: { user: { id: '00000000-0000-0000-0000-000000000042' } },
  toast: vi.fn(),
  page: vi.fn(),
  summary: vi.fn(),
  channel: null as null | { onPayload: (payload: unknown) => void },
  audit: null as null | { onPayload: (payload: unknown) => void },
  bus: null as null | ((payload: { clubId: string }) => void),
  aborts: 0,
  searches: [] as string[],
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => f.actor }));
vi.mock('../../src/hooks/useProfilePresence', () => ({ useOnlineNow: () => new Set() }));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscriptions: (events: string[], callback: typeof f.bus) => {
    if (!events.includes('BALANCE_UPDATED')) f.bus = callback;
  },
}));
vi.mock('../../src/hooks/useMasterBusChannel', () => ({
  useMasterBusChannel: (config: NonNullable<typeof f.channel> & { table: string }) => {
    if (config.table === 'audit_trail') f.audit = config;
    else f.channel = config;
  },
}));
// Private wallet delivery is covered by the dedicated wallet-update cases.
vi.mock('../../src/hooks/useMasterBusBroadcastChannel', () => ({
  useMasterBusBroadcastChannel: vi.fn(),
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => f.toast }));
vi.mock('../../src/utils/strictClubIdResolver', () => ({
  resolveClubUUIDStrict: async () => '00000000-0000-0000-0000-000000000043',
  ClubNotFoundError: class extends Error {},
}));
vi.mock('../../src/services/ClubRosterService', () => ({
  default: { getRosterPage: f.page, getSummary: f.summary },
}));
import ClubMembersPage from '../../src/pages/ClubMembersPage';

beforeEach(() => {
  vi.useFakeTimers();
  f.aborts = 0;
  f.searches = [];
  f.page.mockReset();
  f.summary.mockReset();
  sessionStorage.clear();
  f.summary.mockResolvedValue({
    viewer_role: 'player',
    capabilities: {
      can_view_financials: false,
      can_export: false,
      can_manage_members: false,
      can_view_notes: false,
    },
    counts: { total: 0, online: 0, seated: 0, agents: 0, admins: 0 },
    data_version: null,
    page_size: 80,
  });
  f.page.mockImplementation((_club: string, query: { search: string; signal: AbortSignal }) => {
    f.searches.push(query.search);
    return new Promise((resolve, reject) => {
      const aborted = () => {
        clearTimeout(timer);
        f.aborts++;
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        query.signal.removeEventListener('abort', aborted);
        resolve({ items: [], next_cursor: null, has_more: false, filtered_total: 0 });
      }, 100);
      query.signal.addEventListener('abort', aborted, { once: true });
    });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('does not start an obsolete structural read just before a pending search debounce completes', async () => {
  render(
    <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search Club Members' }), {
    target: { value: 'A' },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(360);
  });
  // A real membership event schedules the original 1200ms structural refresh.
  act(() => {
    f.channel!.onPayload({ eventType: 'INSERT', new: {} });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(950);
  });
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search Club Members' }), {
    target: { value: '' },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(f.aborts).toBe(0);
  expect(f.searches).toEqual(['', 'A', '']);
  expect(f.summary).toHaveBeenCalledTimes(2);
});

it('does not lose a structural invalidation when the pending search is reverted', async () => {
  render(
    <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  const search = screen.getByRole('searchbox', { name: 'Search Club Members' });
  fireEvent.change(search, { target: { value: 'A' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(360);
  });
  act(() => {
    f.channel!.onPayload({ eventType: 'INSERT', new: {} });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(950);
  });
  fireEvent.change(search, { target: { value: '' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  fireEvent.change(search, { target: { value: 'A' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(360);
  });
  expect(f.aborts).toBe(0);
  expect(f.searches).toEqual(['', 'A', 'A']);
  expect(f.summary).toHaveBeenCalledTimes(2);
});

it('still refreshes the unchanged directory and summary for a structural event', async () => {
  render(
    <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  act(() => {
    f.channel!.onPayload({ eventType: 'INSERT', new: {} });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1300);
  });
  expect(f.aborts).toBe(0);
  expect(f.searches).toEqual(['', '']);
  expect(f.summary).toHaveBeenCalledTimes(2);
});

it('refreshes changed membership authority but ignores unrelated club and wallet-only events', async () => {
  render(
    <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  const count = f.page.mock.calls.length;
  act(() => {
    f.channel!.onPayload({
      eventType: 'UPDATE',
      old: { role: 'player', chip_balance: 10 },
      new: { role: 'player', chip_balance: 20 },
    });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1300);
  });
  expect(f.page).toHaveBeenCalledTimes(count);
  act(() => {
    f.bus!({ clubId: 'another-club' });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1300);
  });
  expect(f.page).toHaveBeenCalledTimes(count);
  act(() => {
    f.channel!.onPayload({ eventType: 'UPDATE', old: { role: 'player' }, new: { role: 'agent' } });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1300);
  });
  expect(f.page).toHaveBeenCalledTimes(count + 1);
});

it('refreshes off-page role changes from the authorized audit lane without reacting to wallet audits', async () => {
  render(
    <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  const clubId = '00000000-0000-0000-0000-000000000043';
  act(() => {
    f.audit!.onPayload({
      new: { club_id: clubId, target_type: 'club_member', action: 'wallet_transfer' },
    });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1300);
  });
  expect(f.searches).toEqual(['']);
  act(() => {
    f.audit!.onPayload({
      new: {
        club_id: clubId,
        target_type: 'club_member',
        action: 'set_member_role',
        target_id: 'unloaded-player',
      },
    });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1300);
  });
  expect(f.searches).toEqual(['', '']);
});
