import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  actor: { user: { id: '00000000-0000-0000-0000-000000000042' } },
  toast: vi.fn(),
  page: vi.fn(),
  summary: vi.fn(),
  channel: null as null | {
    onPayload: (payload: unknown) => void;
    restartKey?: number;
    onSubscriptionError?: (status: string) => void;
    onSubscriptionStatus?: (status: string) => void;
  },
  audit: null as null | {
    onPayload: (payload: unknown) => void;
    restartKey?: number;
    enabled?: boolean;
    onSubscriptionStatus?: (status: string) => void;
    onSubscriptionError?: (status: string) => void;
  },
  wallet: null as null | {
    restartKey?: number;
    onSubscriptionError?: (status: string) => void;
    onSubscriptionStatus?: (status: string) => void;
  },
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
  useMasterBusBroadcastChannel: (config: NonNullable<typeof f.wallet>) => {
    f.wallet = config;
  },
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

it.each([false, true])(
  'retries failed subscriptions without restarting healthy feeds (Advanced=%s)',
  async (advanced) => {
    render(
      <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
        <Routes>
          <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
        </Routes>
      </MemoryRouter>
    );
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    if (advanced) fireEvent.click(screen.getByRole('button', { name: 'Advanced', exact: true }));
    act(() => {
      f.channel?.onSubscriptionStatus?.('SUBSCRIBED');
      f.wallet?.onSubscriptionStatus?.('SUBSCRIBED');
      f.channel?.onSubscriptionError?.('TIMED_OUT');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry Live Sync' }));
    expect(f.channel?.restartKey).toBe(1);
    expect(f.wallet?.restartKey ?? 0).toBe(0);
    expect(f.audit?.restartKey ?? 0).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    act(() => f.channel?.onSubscriptionStatus?.('SUBSCRIBED'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
    expect(f.channel?.restartKey).toBe(1);
    expect(f.wallet?.restartKey ?? 0).toBe(0);
  }
);

it('retires an audit failure when the viewer no longer has audit access', async () => {
  const summary = (role: string) => ({
    viewer_role: role,
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
  f.summary.mockResolvedValue(summary('owner'));
  render(
    <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(f.audit?.enabled).toBe(true);
  act(() => {
    f.channel?.onSubscriptionStatus?.('SUBSCRIBED');
    f.wallet?.onSubscriptionStatus?.('SUBSCRIBED');
    f.audit?.onSubscriptionError?.('TIMED_OUT');
  });
  expect(screen.getByRole('button', { name: 'Retry Live Sync' })).toBeInTheDocument();
  f.summary.mockResolvedValue(summary('player'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(f.audit?.enabled).toBe(false);
  expect(screen.queryByRole('button', { name: 'Retry Live Sync' })).not.toBeInTheDocument();
});

it('defaults to a compact directory and restores the full workspace in Advanced', async () => {
  render(
    <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(110);
  });
  expect(screen.getByRole('button', { name: 'Simple' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByText('Player Command')).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Filter Players' })).not.toBeInTheDocument();
  expect(screen.queryByText('Metric Definitions')).not.toBeInTheDocument();
  expect(screen.getByRole('searchbox', { name: 'Search Club Members' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'King' } });
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
  expect(screen.getByText('Player Command')).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Filter Players' })).toBeInTheDocument();
  expect(screen.getByText('Metric Definitions')).toBeInTheDocument();
  expect(screen.getByRole('searchbox')).toHaveValue('King');
  fireEvent.click(screen.getByRole('button', { name: 'Simple' }));
  expect(screen.getByRole('searchbox')).toHaveValue('King');
  expect(screen.queryByRole('link', { name: 'Applicants' })).not.toBeInTheDocument();
});

it('routes Simple agent and role grouping controls through the existing server query', async () => {
  render(
    <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(110);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(110);
  });
  expect(f.page.mock.calls.at(-1)?.[1].filter).toBe('agents');
  fireEvent.click(screen.getByRole('button', { name: 'Group By Role' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(110);
  });
  expect(f.page.mock.calls.at(-1)?.[1].sort).toBe('name');
});

it('shows the authorized fees generated, never the wallet, and opens the existing management route', async () => {
  f.page.mockResolvedValue({
    items: [
      {
        user_id: 'player-1',
        alias: 'KingFish45',
        player_number: '3258017',
        role: 'player',
        player_wallet: 98765,
        total_fees: 12345,
        can_view_financials: true,
      },
    ],
    has_more: false,
    next_cursor: null,
    filtered_total: 1,
  });
  f.summary.mockResolvedValue({
    viewer_role: 'owner',
    capabilities: {
      can_view_financials: true,
      can_export: true,
      can_manage_members: true,
      can_view_notes: true,
    },
    counts: { total: 1, online: 0, seated: 0, agents: 0, admins: 0 },
    data_version: null,
    page_size: 80,
  });
  render(
    <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
        <Route path="/clubs/:clubId/members/:userId" element={<p>Player Management Record</p>} />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(110);
  });
  expect(screen.getByText('12.3K')).toBeInTheDocument();
  expect(screen.getByText('Fees This Week')).toBeInTheDocument();
  expect(screen.queryByText('98.7K')).not.toBeInTheDocument();
  expect(screen.queryByText('Player Wallet')).not.toBeInTheDocument();
  expect(screen.getByText(/ID: 3258017/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Applicants' })).toHaveAttribute(
    'href',
    '/clubs/shark-club/applicants'
  );
  fireEvent.click(screen.getByRole('button', { name: /Open KingFish45/ }));
  expect(screen.getByText('Player Management Record')).toBeInTheDocument();
});

for (const mode of ['Simple', 'Advanced']) {
  it(`keeps ${mode} refresh usable after an unsettled search is reverted`, async () => {
    render(
      <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
        <Routes>
          <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
        </Routes>
      </MemoryRouter>
    );
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    if (mode === 'Advanced') fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'pending' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
    fireEvent.change(search, { target: { value: '' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    const refresh = screen.getByRole('button', { name: /^Refresh/ });
    expect(refresh).toBeEnabled();
    expect(refresh).toHaveAttribute('aria-busy', 'false');
    const calls = f.page.mock.calls.length;
    fireEvent.click(refresh);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(110);
    });
    expect(f.page.mock.calls.length).toBe(calls + 1);
    expect(refresh).toBeEnabled();
  });
}

it('requires every enabled roster feed to acknowledge before reporting connected', async () => {
  f.summary.mockResolvedValue({
    viewer_role: 'owner',
    capabilities: {},
    counts: { total: 0, online: 0, seated: 0, agents: 0, admins: 0 },
    page_size: 80,
  });
  render(
    <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  const status = () => document.querySelector('.members-connection-status');
  expect(f.audit?.enabled).toBe(true);
  act(() => f.channel?.onSubscriptionStatus?.('SUBSCRIBED'));
  expect(status()).toHaveAttribute('data-connection-state', 'connecting');
  act(() => f.wallet?.onSubscriptionStatus?.('SUBSCRIBED'));
  expect(status()).toHaveAttribute('data-connection-state', 'connecting');
  act(() => f.audit?.onSubscriptionStatus?.('SUBSCRIBED'));
  expect(status()).toHaveAttribute('data-connection-state', 'live');
  act(() => f.audit?.onSubscriptionError?.('TIMED_OUT'));
  expect(status()).toHaveAttribute('data-connection-state', 'reconnecting');
  fireEvent.click(screen.getByRole('button', { name: 'Retry Live Sync' }));
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(f.audit?.restartKey).toBe(1);
  expect(f.channel?.restartKey ?? 0).toBe(0);
  expect(status()).toHaveAttribute('data-connection-state', 'connecting');
  act(() => f.audit?.onSubscriptionStatus?.('SUBSCRIBED'));
  expect(status()).toHaveAttribute('data-connection-state', 'live');
});

it('requires a newly enabled audit feed even when existing member and wallet feeds are live', async () => {
  render(
    <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  act(() => {
    f.channel?.onSubscriptionStatus?.('SUBSCRIBED');
    f.wallet?.onSubscriptionStatus?.('SUBSCRIBED');
  });
  expect(document.querySelector('.members-connection-status')).toHaveAttribute(
    'data-connection-state',
    'live'
  );
  f.summary.mockResolvedValue({
    viewer_role: 'owner',
    capabilities: {},
    counts: { total: 0, online: 0, seated: 0, agents: 0, admins: 0 },
    page_size: 80,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(f.audit?.enabled).toBe(true);
  expect(document.querySelector('.members-connection-status')).toHaveAttribute(
    'data-connection-state',
    'connecting'
  );
  act(() => f.audit?.onSubscriptionStatus?.('SUBSCRIBED'));
  expect(document.querySelector('.members-connection-status')).toHaveAttribute(
    'data-connection-state',
    'live'
  );
});

it('requires fresh acknowledgments after the roster account changes', async () => {
  const original = f.actor.user.id;
  const element = (
    <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
      </Routes>
    </MemoryRouter>
  );
  const view = render(element);
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  act(() => {
    f.channel?.onSubscriptionStatus?.('SUBSCRIBED');
    f.wallet?.onSubscriptionStatus?.('SUBSCRIBED');
  });
  expect(document.querySelector('.members-connection-status')).toHaveAttribute(
    'data-connection-state',
    'live'
  );
  try {
    f.actor.user.id = '00000000-0000-0000-0000-000000000099';
    view.rerender(
      <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
        <Routes>
          <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
        </Routes>
      </MemoryRouter>
    );
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(document.querySelector('.members-connection-status')).toHaveAttribute(
      'data-connection-state',
      'connecting'
    );
    act(() => f.channel?.onSubscriptionStatus?.('SUBSCRIBED'));
    expect(document.querySelector('.members-connection-status')).toHaveAttribute(
      'data-connection-state',
      'connecting'
    );
    act(() => f.wallet?.onSubscriptionStatus?.('SUBSCRIBED'));
    expect(document.querySelector('.members-connection-status')).toHaveAttribute(
      'data-connection-state',
      'live'
    );
  } finally {
    f.actor.user.id = original;
  }
});
