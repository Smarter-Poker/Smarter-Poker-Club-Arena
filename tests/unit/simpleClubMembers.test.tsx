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

it('shows the authorized balance and opens the existing management route', async () => {
  f.page.mockResolvedValue({
    items: [
      {
        user_id: 'player-1',
        alias: 'KingFish45',
        player_number: '3258017',
        role: 'player',
        player_wallet: 12345,
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
  expect(screen.getByText(/ID: 3258017/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Applicants' })).toHaveAttribute(
    'href',
    '/clubs/shark-club/applicants'
  );
  fireEvent.click(screen.getByRole('button', { name: /Open KingFish45/ }));
  expect(screen.getByText('Player Management Record')).toBeInTheDocument();
});
