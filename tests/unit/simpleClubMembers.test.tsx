import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  actor: { user: { id: '00000000-0000-0000-0000-000000000042' } },
  toast: vi.fn(),
  page: vi.fn(),
  summary: vi.fn(),
  period: vi.fn(),
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
  record: null as null | {
    onSubscriptionError?: (status: string) => void;
    onSubscriptionStatus?: (status: string) => void;
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
  useMasterBusBroadcastChannel: (
    config: NonNullable<typeof f.wallet> & { channelName?: string }
  ) => {
    if (config.channelName?.startsWith('club-roster:')) f.record = config;
    else f.wallet = config;
  },
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => f.toast }));
vi.mock('../../src/utils/strictClubIdResolver', () => ({
  resolveClubUUIDStrict: async () => '00000000-0000-0000-0000-000000000043',
  ClubNotFoundError: class extends Error {},
}));
vi.mock('../../src/services/ClubRosterService', () => ({
  default: { getRosterPage: f.page, getSummary: f.summary, getMembersWinLoss: f.period },
}));
import ClubMembersPage, {
  MemberRow,
  liveRosterRefreshPolicy,
} from '../../src/pages/ClubMembersPage';

beforeEach(() => {
  vi.useFakeTimers();
  f.aborts = 0;
  f.searches = [];
  f.page.mockReset();
  f.summary.mockReset();
  f.period.mockResolvedValue(new Map());
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
      f.record?.onSubscriptionStatus?.('SUBSCRIBED');
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
    expect(screen.queryByRole('button', { name: 'Refresh', exact: true })).not.toBeInTheDocument();
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
    f.record?.onSubscriptionStatus?.('SUBSCRIBED');
    f.audit?.onSubscriptionError?.('TIMED_OUT');
  });
  expect(screen.getByRole('button', { name: 'Retry Live Sync' })).toBeInTheDocument();
  f.summary.mockResolvedValue(summary('player'));
  fireEvent.click(screen.getByRole('button', { name: 'Retry Live Sync' }));
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
  // No page hero in either mode (Dan 2026-10-17); Advanced adds the live totals to the page bar.
  expect(screen.getByRole('heading', { level: 1, name: 'Player Management' })).toHaveClass(
    'ca-page-bar__title'
  );
  expect(screen.queryByText('Player Command')).not.toBeInTheDocument();
  expect(screen.queryByText('Total Members')).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Filter Players' })).not.toBeInTheDocument();
  expect(screen.queryByText('Metric Definitions')).not.toBeInTheDocument();
  expect(screen.getByRole('searchbox', { name: 'Search Club Members' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'King' } });
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
  expect(screen.queryByText('Player Command')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Player Management Live Summary')).toHaveTextContent(
    'Total Members'
  );
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
  expect(f.page.mock.calls.at(-1)?.[1].sort).toBe('hierarchy');
  fireEvent.click(screen.getByRole('button', { name: 'Group By Role' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(110);
  });
  expect(f.page.mock.calls.at(-1)?.[1].sort).toBe('name');
});

it('labels lifetime fee criteria Overall while preserving current-week display and query values', async () => {
  f.summary.mockResolvedValue({
    viewer_role: 'owner',
    capabilities: { can_view_financials: true },
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
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(screen.getByRole('combobox', { name: 'Win And Loss Period' })).toHaveValue('week');
  expect(screen.getByRole('combobox', { name: 'Sort Players' })).toHaveValue('newest');
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
  expect(screen.getByRole('option', { name: 'Overall Fees 100+' })).toHaveValue('high_fees');
  expect(screen.getByRole('option', { name: 'Most Overall Fees' })).toHaveValue('fees');
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter Players' }), {
    target: { value: 'high_fees' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Sort Players' }), {
    target: { value: 'fees' },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(f.page.mock.calls.at(-1)?.[1]).toMatchObject({ filter: 'high_fees', sort: 'fees' });
  expect(screen.getByRole('combobox', { name: 'Win And Loss Period' })).toHaveValue('week');
  expect(
    screen.getByText('No Visible Players Have Recorded At Least 100 In Overall Fees.')
  ).toBeInTheDocument();
});

it('shows the authorized period fees, never the wallet, and opens the existing management route', async () => {
  f.period.mockResolvedValue(
    new Map([['player-1', { cash: 0, mtt: 0, net: 0, fees: 12345, downline_fees: 0 }]])
  );
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
  expect(screen.getByText('12,345.00')).toBeInTheDocument();
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
  it(`keeps ${mode} query reads usable without a refresh control`, async () => {
    render(
      <MemoryRouter initialEntries={['/clubs/shark-club/members']}>
        <Routes>
          <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
        </Routes>
      </MemoryRouter>
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    if (mode === 'Advanced') fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.queryByRole('button', { name: 'Refresh', exact: true })).not.toBeInTheDocument();
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'pending' } });
    fireEvent.change(search, { target: { value: '' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    const calls = f.page.mock.calls.length;
    fireEvent.change(search, { target: { value: 'King' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(f.page.mock.calls.length).toBe(calls + 1);
    expect(f.page.mock.calls.at(-1)?.[1].search).toBe('King');
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
  const status = () => document.querySelector('[data-roster-connection]');
  expect(f.audit?.enabled).toBe(true);
  act(() => f.channel?.onSubscriptionStatus?.('SUBSCRIBED'));
  expect(status()).toHaveAttribute('data-roster-connection', 'connecting');
  act(() => {
    f.wallet?.onSubscriptionStatus?.('SUBSCRIBED');
    f.record?.onSubscriptionStatus?.('SUBSCRIBED');
  });
  expect(status()).toHaveAttribute('data-roster-connection', 'connecting');
  act(() => f.audit?.onSubscriptionStatus?.('SUBSCRIBED'));
  expect(status()).toHaveAttribute('data-roster-connection', 'live');
  act(() => f.audit?.onSubscriptionError?.('TIMED_OUT'));
  expect(status()).toHaveAttribute('data-roster-connection', 'reconnecting');
  fireEvent.click(screen.getByRole('button', { name: 'Retry Live Sync' }));
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(f.audit?.restartKey).toBe(1);
  expect(f.channel?.restartKey ?? 0).toBe(0);
  expect(status()).toHaveAttribute('data-roster-connection', 'connecting');
  act(() => f.audit?.onSubscriptionStatus?.('SUBSCRIBED'));
  expect(status()).toHaveAttribute('data-roster-connection', 'live');
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
    f.record?.onSubscriptionStatus?.('SUBSCRIBED');
  });
  expect(document.querySelector('[data-roster-connection]')).toHaveAttribute(
    'data-roster-connection',
    'live'
  );
  f.summary.mockResolvedValue({
    viewer_role: 'owner',
    capabilities: {},
    counts: { total: 0, online: 0, seated: 0, agents: 0, admins: 0 },
    page_size: 80,
  });
  act(() => window.dispatchEvent(new Event('online')));
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(f.audit?.enabled).toBe(true);
  act(() => {
    f.channel?.onSubscriptionStatus?.('SUBSCRIBED');
    f.wallet?.onSubscriptionStatus?.('SUBSCRIBED');
    f.record?.onSubscriptionStatus?.('SUBSCRIBED');
  });
  expect(document.querySelector('[data-roster-connection]')).toHaveAttribute(
    'data-roster-connection',
    'connecting'
  );
  act(() => f.audit?.onSubscriptionStatus?.('SUBSCRIBED'));
  expect(document.querySelector('[data-roster-connection]')).toHaveAttribute(
    'data-roster-connection',
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
    f.record?.onSubscriptionStatus?.('SUBSCRIBED');
  });
  expect(document.querySelector('[data-roster-connection]')).toHaveAttribute(
    'data-roster-connection',
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
    expect(document.querySelector('[data-roster-connection]')).toHaveAttribute(
      'data-roster-connection',
      'connecting'
    );
    act(() => f.channel?.onSubscriptionStatus?.('SUBSCRIBED'));
    expect(document.querySelector('[data-roster-connection]')).toHaveAttribute(
      'data-roster-connection',
      'connecting'
    );
    act(() => {
      f.wallet?.onSubscriptionStatus?.('SUBSCRIBED');
      f.record?.onSubscriptionStatus?.('SUBSCRIBED');
    });
    expect(document.querySelector('[data-roster-connection]')).toHaveAttribute(
      'data-roster-connection',
      'live'
    );
  } finally {
    f.actor.user.id = original;
  }
});

it('keeps a cold record feed connecting after verified HTTP reads and requires engine readiness', async () => {
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
  // Capture the exact record signal separately from wallet delivery.
  expect(f.record).toMatchObject({
    channelName: 'club-roster:00000000-0000-0000-0000-000000000043',
  });
  act(() => {
    f.channel?.onSubscriptionStatus?.('SUBSCRIBED');
    f.wallet?.onSubscriptionStatus?.('SUBSCRIBED');
    f.record?.onSubscriptionStatus?.('CONNECTING');
  });
  const status = () => document.querySelector('[data-roster-connection]');
  expect(f.page).toHaveBeenCalled();
  expect(status()).toHaveAttribute('data-roster-connection', 'connecting');
  act(() => f.record?.onSubscriptionError?.('CHANNEL_ERROR'));
  expect(status()).not.toHaveAttribute('data-roster-connection', 'live');
  act(() => {
    f.record?.onSubscriptionStatus?.('SUBSCRIBED');
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(liveRosterRefreshPolicy.minIntervalMs + 2000);
  });
  expect(status()).toHaveAttribute('data-roster-connection', 'live');
  expect(f.toast).not.toHaveBeenCalled();
});

it.each([
  [9300, '+9.3K'],
  [-9300, '-9.3K'],
])('prints a signed net without a visible metric label for %s', (net, label) => {
  const { container } = render(
    <MemberRow
      member={
        {
          user_id: 'test-player',
          alias: 'RunnerFox44',
          role: 'player',
          player_number: '695811',
          is_seated: true,
          can_view_financials: true,
          total_fees: 1700,
        } as any
      }
      position={1}
      total={1}
      query=""
      onOpen={() => {}}
      selectable={false}
      selected={false}
      onSelect={() => {}}
      columns={new Set(['fees'])}
      simpleMode
      winLoss={{ net: Number(net), cash: Number(net), mtt: 0 }}
      winLossLabel="Week W/L"
    />
  );
  expect(screen.getByText('PlayerID: 695811')).toBeInTheDocument();
  const amount = container.querySelector('.member-simple-balance__winloss');
  expect(amount?.textContent?.trim()).toBe(label);
  expect(amount).toHaveAttribute('aria-label', `Week W/L ${label}`);
  expect(container.querySelector('.member-subline')?.textContent).not.toMatch(/^Player\s/);
});
