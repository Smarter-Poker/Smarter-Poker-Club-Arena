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
  broadcasts: new Map<
    string,
    {
      onPayload: (payload: unknown) => void;
      onSubscriptionStatus?: (status: string) => void;
      onSubscriptionError?: (status: string) => void;
    }
  >(),
  winLoss: vi.fn(async () => new Map()),
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
  useMasterBusBroadcastChannel: (config: {
    channelName?: string;
    onPayload: (payload: unknown) => void;
    onSubscriptionStatus?: (status: string) => void;
    onSubscriptionError?: (status: string) => void;
  }) => {
    if (config.channelName) f.broadcasts.set(config.channelName, config);
  },
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => f.toast }));
vi.mock('../../src/utils/strictClubIdResolver', () => ({
  resolveClubUUIDStrict: async () => '00000000-0000-0000-0000-000000000043',
  ClubNotFoundError: class extends Error {},
}));
vi.mock('../../src/services/ClubRosterService', () => ({
  default: { getRosterPage: f.page, getSummary: f.summary, getMembersWinLoss: f.winLoss },
}));
import ClubMembersPage, { LIVE_RECORD_REFRESH_MS } from '../../src/pages/ClubMembersPage';

beforeEach(() => {
  vi.useFakeTimers();
  f.broadcasts.clear();
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

it('lets a healthy current page finish before consuming a coalesced structural invalidation', async () => {
  const finish: Array<() => void> = [];
  f.page.mockImplementation((_club: string, query: { search: string; signal: AbortSignal }) => {
    f.searches.push(query.search);
    return new Promise((resolve, reject) => {
      const aborted = () => {
        f.aborts++;
        reject(new DOMException('Aborted', 'AbortError'));
      };
      query.signal.addEventListener('abort', aborted, { once: true });
      finish.push(() => {
        query.signal.removeEventListener('abort', aborted);
        resolve({ items: [], next_cursor: null, has_more: false, filtered_total: 0 });
      });
    });
  });
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
  act(() => {
    f.channel!.onPayload({ eventType: 'INSERT', new: {} });
    f.channel!.onPayload({ eventType: 'INSERT', new: {} });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
  expect(f.aborts).toBe(0);
  expect(f.searches).toEqual(['']);
  // Reverting an uncommitted search still belongs to the current healthy
  // request; it must not turn the queued event into an immediate replacement.
  const search = screen.getByRole('searchbox', { name: 'Search Club Members' });
  fireEvent.change(search, { target: { value: 'A' } });
  fireEvent.change(search, { target: { value: '' } });
  expect(f.aborts).toBe(0);
  expect(f.searches).toEqual(['']);
  await act(async () => {
    finish[0]();
  });
  expect(f.searches).toEqual(['', '']);
  expect(f.summary).toHaveBeenCalledTimes(2);
  await act(async () => {
    finish[1]();
  });
  expect(f.aborts).toBe(0);
  expect(f.searches).toEqual(['', '']);
});

it('cancels an obsolete query and consumes its queued structural invalidation in the new query', async () => {
  const finish: Array<() => void> = [];
  f.page.mockImplementation((_club: string, query: { search: string; signal: AbortSignal }) => {
    f.searches.push(query.search);
    return new Promise((resolve, reject) => {
      const aborted = () => {
        f.aborts++;
        reject(new DOMException('Aborted', 'AbortError'));
      };
      query.signal.addEventListener('abort', aborted, { once: true });
      finish.push(() => {
        query.signal.removeEventListener('abort', aborted);
        resolve({ items: [], next_cursor: null, has_more: false, filtered_total: 0 });
      });
    });
  });
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
  act(() => {
    f.channel!.onPayload({ eventType: 'INSERT', new: {} });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search Club Members' }), {
    target: { value: 'A' },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(260);
  });
  expect(f.aborts).toBe(1);
  expect(f.searches).toEqual(['', 'A']);
  await act(async () => {
    finish[0]();
    finish[1]();
  });
  expect(f.searches).toEqual(['', 'A']);
  expect(f.summary).toHaveBeenCalledTimes(2);
});

it('does not automatically retry a failed page to consume a queued structural invalidation', async () => {
  let fail!: (error: Error) => void;
  f.page.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      })
  );
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
  act(() => {
    f.channel!.onPayload({ eventType: 'INSERT', new: {} });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
  await act(async () => {
    fail(new Error('Read deadline expired'));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(f.page).toHaveBeenCalledTimes(1);
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

const club = '00000000-0000-0000-0000-000000000043';
const rosterTopic = `club-roster:${club}`;
function mountDirectory() {
  return render(
    <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
      </Routes>
    </MemoryRouter>
  );
}
const row = (id: string, alias: string) => ({
  user_id: id,
  alias,
  username: alias,
  role: 'player',
  role_rank: 1,
  can_view_financials: true,
  can_view_notes: true,
  total_fees: 10,
  downline_total: 0,
  downline_fees: 0,
  player_wallet: 20,
  agent_wallet: 0,
  is_online: false,
  is_seated: false,
  home_club_name: 'Shark',
});

it('reconciles private roster changes before TTL while retaining loaded pages and selection', async () => {
  f.summary.mockResolvedValue({
    viewer_role: 'owner',
    capabilities: { can_export: true, can_view_financials: true },
    counts: { total: 2, online: 0, seated: 0, agents: 0, admins: 0 },
    page_size: 80,
  });
  let changed = false;
  f.page.mockImplementation(async (_club, query) =>
    query.cursor
      ? {
          items: [row('b', changed ? 'Changed Second' : 'Second')],
          next_cursor: null,
          has_more: false,
          filtered_total: 2,
        }
      : {
          items: [row('a', changed ? 'Changed First' : 'First')],
          next_cursor: { next: 'b' },
          has_more: true,
          filtered_total: 2,
        }
  );
  mountDirectory();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Advanced', exact: true }));
  await act(async () => {});
  expect(screen.getByRole('status', { name: 'Roster Operations' })).toHaveTextContent(
    '2 Loaded Of 2'
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select First' }));
  expect(screen.getByRole('status', { name: 'Roster Operations' })).toHaveTextContent(
    '1 Loaded Players Selected'
  );
  const reads = f.page.mock.calls.length;
  const summaries = f.summary.mock.calls.length;
  changed = true;
  act(() => f.broadcasts.get(rosterTopic)!.onPayload({ payload: {} }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LIVE_RECORD_REFRESH_MS);
  });
  expect(f.page.mock.calls.length).toBe(reads + 2);
  expect(f.summary).toHaveBeenCalledTimes(summaries + 1);
  expect(screen.getByRole('button', { name: /Open Changed Second/ })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Select Changed First' })).toBeChecked();
  expect(screen.getByRole('status', { name: 'Roster Operations' })).toHaveTextContent(
    '2 Loaded Of 2'
  );
});

it('coalesces private roster bursts behind one active read without aborting it', async () => {
  const finish: Array<() => void> = [];
  f.page.mockImplementation(
    (_club, query) =>
      new Promise((resolve, reject) => {
        const abort = () => {
          f.aborts++;
          reject(new DOMException('Aborted', 'AbortError'));
        };
        query.signal.addEventListener('abort', abort, { once: true });
        finish.push(() => {
          query.signal.removeEventListener('abort', abort);
          resolve({ items: [], has_more: false, next_cursor: null, filtered_total: 0 });
        });
      })
  );
  mountDirectory();
  await act(async () => {});
  act(() => {
    for (let i = 0; i < 5; i++) f.broadcasts.get(rosterTopic)!.onPayload({ payload: {} });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
  expect(f.page).toHaveBeenCalledTimes(1);
  expect(f.aborts).toBe(0);
  await act(async () => finish[0]());
  // The owed record read waits out the live cadence instead of chaining.
  expect(f.page).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LIVE_RECORD_REFRESH_MS);
  });
  expect(f.page).toHaveBeenCalledTimes(2);
  act(() => {
    for (let i = 0; i < 5; i++) f.broadcasts.get(rosterTopic)!.onPayload({ payload: {} });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
  expect(f.page).toHaveBeenCalledTimes(2);
  expect(f.aborts).toBe(0);
  await act(async () => finish[1]());
  expect(f.page).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LIVE_RECORD_REFRESH_MS);
  });
  expect(f.page).toHaveBeenCalledTimes(3);
  await act(async () => finish[2]());
  expect(f.aborts).toBe(0);
});

it('reconciles roster and summary after focus, private rejoin and an idle UTC boundary', async () => {
  vi.setSystemTime(new Date('2026-10-18T23:59:50.000Z'));
  mountDirectory();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  const initialReads = f.page.mock.calls.length;
  act(() => window.dispatchEvent(new Event('focus')));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1300);
  });
  expect(f.page).toHaveBeenCalledTimes(initialReads + 1);
  // A rejoin after a dropped private feed owes a prompt catch-up read.
  act(() => {
    f.broadcasts.get(rosterTopic)!.onSubscriptionError!('CHANNEL_ERROR');
    f.broadcasts.get(rosterTopic)!.onSubscriptionStatus!('SUBSCRIBED');
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1300);
  });
  expect(f.page).toHaveBeenCalledTimes(initialReads + 2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8600);
  });
  expect(f.page).toHaveBeenCalledTimes(initialReads + 3);
  expect(f.summary).toHaveBeenCalledTimes(initialReads + 3);
});

// Production, 2026-10-19: Shark Club's private roster topic signals on every
// funded hand, seat, fee and wallet change, so a live club sends it about once
// a second. The first join re-read the roster ~1.2s after the initial read, and
// every burst re-read the whole loaded window ~1.2s later, so the page never
// stopped reading and any navigation aborted a read in flight.
it('does not re-read the roster on its first private join or on every live record burst', async () => {
  const view = mountDirectory();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(f.page).toHaveBeenCalledTimes(1);
  expect(f.summary).toHaveBeenCalledTimes(1);
  // The first join opens alongside the read that just finished.
  act(() => f.broadcasts.get(rosterTopic)!.onSubscriptionStatus!('SUBSCRIBED'));
  // A playing club: one signal every 400ms for four seconds.
  for (let i = 0; i < 10; i++) {
    act(() => f.broadcasts.get(rosterTopic)!.onPayload({ payload: {} }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  }
  expect(f.page).toHaveBeenCalledTimes(1);
  expect(f.summary).toHaveBeenCalledTimes(1);
  // The change is still owed: exactly one bounded re-read of window and totals.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LIVE_RECORD_REFRESH_MS);
  });
  expect(f.page).toHaveBeenCalledTimes(2);
  expect(f.summary).toHaveBeenCalledTimes(2);
  // Leaving the page mid-stream cancels nothing.
  act(() => f.broadcasts.get(rosterTopic)!.onPayload({ payload: {} }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1300);
  });
  view.unmount();
  expect(f.aborts).toBe(0);
  expect(f.page).toHaveBeenCalledTimes(2);
});

it('lets a newer roster read satisfy a pending live record change', async () => {
  mountDirectory();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  act(() => f.broadcasts.get(rosterTopic)!.onPayload({ payload: {} }));
  // A structural change re-reads promptly; that read also carries the record.
  act(() => f.bus?.({ clubId: club }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  expect(f.page).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LIVE_RECORD_REFRESH_MS * 2);
  });
  expect(f.page).toHaveBeenCalledTimes(2);
  expect(f.aborts).toBe(0);
});
