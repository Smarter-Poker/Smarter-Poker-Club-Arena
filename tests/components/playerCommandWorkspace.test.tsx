import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  actor: { user: { id: 'viewer-a' } },
  toast: { success: vi.fn(), error: vi.fn() },
  page: vi.fn(),
  summary: vi.fn(),
  export: vi.fn(),
  csv: vi.fn(),
  report: vi.fn(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => f.actor }));
vi.mock('../../src/hooks/useProfilePresence', () => ({ useOnlineNow: () => false }));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscriptions: () => {},
}));
vi.mock('../../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: () => {} }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => f.toast }));
vi.mock('../../src/utils/strictClubIdResolver', () => ({
  resolveClubUUIDStrict: async (club: string) =>
    club === 'club-a'
      ? '00000000-0000-0000-0000-000000000043'
      : '00000000-0000-0000-0000-000000000044',
  ClubNotFoundError: class extends Error {},
}));
vi.mock('../../src/services/ClubRosterService', () => ({
  default: { getRosterPage: f.page, getSummary: f.summary, exportRoster: f.export },
  mapRosterRow: (row: unknown) => row,
  MemberAccessDeniedError: class MemberAccessDeniedError extends Error {},
}));
vi.mock('../../src/lib/export', () => ({ exportToCSV: f.csv }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: f.report }));
import ClubMembersPage from '../../src/pages/ClubMembersPage';
import { rosterSearchKey } from '../../src/lib/rosterCache';

const clubA = '00000000-0000-0000-0000-000000000043';
const rows = Array.from({ length: 80 }, (_, index) => ({
  user_id: `member-${index}`,
  alias: `Player ${index}`,
  username: `player${index}`,
  role: 'player',
  can_view_financials: true,
  can_view_notes: false,
  downline_total: null,
  total_fees: null,
  downline_fees: null,
  chip_balance: 100,
  player_wallet: 100,
  agent_wallet: null,
}));
function Harness() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <output data-testid="location">
        {location.pathname}
        {location.search}
      </output>
      <button onClick={() => navigate('/clubs/club-a/members')}>Club A</button>
      <button onClick={() => navigate('/clubs/club-b/members')}>Club B</button>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
        <Route
          path="/clubs/:clubId/members/:userId"
          element={<button onClick={() => navigate(-1)}>Back To Roster</button>}
        />
      </Routes>
    </>
  );
}
const tree = (entry = '/clubs/club-a/members') => (
  <MemoryRouter initialEntries={[entry]}>
    <Harness />
  </MemoryRouter>
);
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}
const search = () => screen.getByRole('searchbox', { name: 'Search Club Members' });
const sort = () => screen.getByRole('combobox', { name: 'Sort Players' });
async function preferences() {
  fireEvent.change(search(), { target: { value: 'Player' } });
  fireEvent.click(screen.getByRole('button', { name: 'Agents', exact: true }));
  fireEvent.change(sort(), { target: { value: 'name' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Wallets', exact: true }));
  await settle();
}
function expectPreferences() {
  expect(search()).toHaveValue('Player');
  expect(screen.getByRole('button', { name: 'Agents', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(sort()).toHaveValue('name');
  expect(screen.getByRole('checkbox', { name: 'Wallets', exact: true })).not.toBeChecked();
}
beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  localStorage.clear();
  vi.clearAllMocks();
  f.actor.user = { id: 'viewer-a' };
  f.page.mockResolvedValue({ items: rows, next_cursor: null, has_more: false, filtered_total: 80 });
  f.summary.mockResolvedValue({
    viewer_role: 'owner',
    capabilities: {
      can_view_financials: true,
      can_export: true,
      can_manage_members: false,
      can_view_notes: false,
    },
    counts: { total: 80, online: 0, seated: 0, agents: 80, admins: 0 },
    data_version: null,
    page_size: 80,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('restores the same account and club preferences after an actual page remount', async () => {
  const view = render(tree());
  await settle();
  await preferences();
  view.unmount();
  render(tree());
  await settle();
  expectPreferences();
  expect(screen.getByTestId('location').textContent).not.toContain('q=');
});
it('isolates club preferences and restores the original club on return', async () => {
  render(tree());
  await settle();
  await preferences();
  fireEvent.click(screen.getByRole('button', { name: 'Club B' }));
  await settle();
  expect(search()).toHaveValue('');
  expect(sort()).toHaveValue('hierarchy');
  expect(screen.getByRole('checkbox', { name: 'Wallets', exact: true })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Club A' }));
  await settle();
  expectPreferences();
});
it('isolates an account switch on a mounted route without overwriting the original workspace', async () => {
  const view = render(tree());
  await settle();
  await preferences();
  f.actor.user = { id: 'viewer-b' };
  view.rerender(tree());
  await settle();
  expect(search()).toHaveValue('');
  expect(sort()).toHaveValue('hierarchy');
  expect(screen.getByRole('checkbox', { name: 'Wallets', exact: true })).toBeChecked();
  f.actor.user = { id: 'viewer-a' };
  view.rerender(tree());
  await settle();
  expectPreferences();
});
it('gives an explicit deep-linked view and sort precedence over saved preferences', async () => {
  const view = render(tree());
  await settle();
  await preferences();
  view.unmount();
  render(tree('/clubs/club-a/members?view=online&sort=hierarchy'));
  await settle();
  expect(search()).toHaveValue('Player');
  expect(screen.getByRole('button', { name: 'Online', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(sort()).toHaveValue('hierarchy');
});
it('restores the virtual roster position after opening a real roster row and returning', async () => {
  const view = render(tree());
  await settle();
  const viewport = view.container.querySelector('.members-viewport') as HTMLDivElement;
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(9840);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(696);
  fireEvent.scroll(viewport, { target: { scrollTop: 1476 } });
  expect(screen.queryByRole('button', { name: /^Open Player 0,/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: /^Open Player / })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Back To Roster' }));
  await settle();
  expect((view.container.querySelector('.members-viewport') as HTMLDivElement).scrollTop).toBe(
    1476
  );
  expect(screen.queryByRole('button', { name: /^Open Player 0,/ })).not.toBeInTheDocument();
});
it('never restores selected members or export actions after leaving the roster', async () => {
  render(tree());
  await settle();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Player 0' }));
  fireEvent.click(screen.getByRole('button', { name: /^Open Player 0,/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Back To Roster' }));
  await settle();
  expect(screen.getByRole('checkbox', { name: 'Select Player 0' })).not.toBeChecked();
  expect(f.export).not.toHaveBeenCalled();
  expect(f.csv).not.toHaveBeenCalled();
  const values = [localStorage, sessionStorage]
    .flatMap((storage) =>
      Array.from({ length: storage.length }, (_, i) => storage.key(i)!)
        .filter((key) => key.startsWith('roster_workspace_') || key.startsWith('roster_position_'))
        .map((key) => storage.getItem(key))
    )
    .join('');
  expect(values).not.toContain('member-0');
});
it('keeps the roster usable when optional storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Denied');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Quota');
  });
  render(tree());
  await settle();
  await preferences();
  expectPreferences();
  expect(f.page).toHaveBeenCalledWith(
    clubA,
    expect.objectContaining({ search: 'Player', filter: 'agents', sort: 'name' })
  );
});

it.each([
  'not-json',
  JSON.stringify({
    version: 1,
    search: 123,
    filter: 'invented',
    sort: 'unsafe',
    columns: ['private'],
  }),
  JSON.stringify({ version: 99, search: 'wrong' }),
])('ignores malformed or unsupported workspace storage: %s', async (saved) => {
  sessionStorage.setItem(`roster_workspace_v1_viewer-a_${clubA}`, saved);
  localStorage.setItem(`roster_workspace_v1_viewer-a_${clubA}`, saved);
  render(tree());
  await settle();
  expect(search()).toHaveValue('');
  expect(sort()).toHaveValue('hierarchy');
  expect(screen.getByRole('button', { name: 'All Players', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(screen.getByRole('checkbox', { name: 'Wallets', exact: true })).toBeChecked();
  expect(screen.getByRole('button', { name: /^Open Player 0,/ })).toBeInTheDocument();
});

it('keeps private roster search out of durable storage and URLs', async () => {
  render(tree());
  await settle();
  fireEvent.change(search(), { target: { value: 'Private Alias 761' } });
  await settle();
  const durable = Array.from({ length: localStorage.length }, (_, i) =>
    localStorage.getItem(localStorage.key(i)!)
  ).join('');
  expect(durable).not.toContain('Private Alias 761');
  expect(screen.getByTestId('location').textContent).not.toContain('Private');
});

it('resets a restored position after the operator changes the query', async () => {
  const view = render(tree());
  await settle();
  const viewport = view.container.querySelector('.members-viewport') as HTMLDivElement;
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(9840);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(696);
  fireEvent.scroll(viewport, { target: { scrollTop: 1476 } });
  fireEvent.click(screen.getAllByRole('button', { name: /^Open Player / })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Back To Roster' }));
  await settle();
  expect((view.container.querySelector('.members-viewport') as HTMLDivElement).scrollTop).toBe(
    1476
  );
  fireEvent.change(search(), { target: { value: 'Player 2' } });
  await settle();
  expect((view.container.querySelector('.members-viewport') as HTMLDivElement).scrollTop).toBe(0);
});

it('waits for a bounded next page before restoring a deeper record-return position', async () => {
  let resolveMore!: (value: unknown) => void;
  const more = new Promise((resolve) => {
    resolveMore = resolve;
  });
  f.page
    .mockResolvedValueOnce({ items: rows, next_cursor: null, has_more: false, filtered_total: 80 })
    .mockResolvedValueOnce({
      items: rows.slice(0, 20),
      next_cursor: { user_id: 'member-19' },
      has_more: true,
      filtered_total: 80,
    })
    .mockReturnValueOnce(more);
  const view = render(tree());
  await settle();
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(9840);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(696);
  fireEvent.scroll(view.container.querySelector('.members-viewport')!, {
    target: { scrollTop: 7000 },
  });
  fireEvent.click(screen.getAllByRole('button', { name: /^Open Player / })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Back To Roster' }));
  await settle();
  expect(f.page).toHaveBeenCalledTimes(3);
  expect((view.container.querySelector('.members-viewport') as HTMLDivElement).scrollTop).toBe(0);
  await act(async () => {
    resolveMore({ items: rows.slice(20), next_cursor: null, has_more: false, filtered_total: 80 });
  });
  await settle();
  expect((view.container.querySelector('.members-viewport') as HTMLDivElement).scrollTop).toBe(
    7000
  );
  expect(screen.queryByRole('button', { name: /^Open Player 0,/ })).not.toBeInTheDocument();
  expect(f.page).toHaveBeenCalledTimes(3);
});

it('rejects an old return-page answer after the operator changes the query', async () => {
  let resolveMore!: (value: unknown) => void;
  const more = new Promise((resolve) => {
    resolveMore = resolve;
  });
  f.page
    .mockResolvedValueOnce({ items: rows, next_cursor: null, has_more: false, filtered_total: 80 })
    .mockResolvedValueOnce({
      items: rows.slice(0, 20),
      next_cursor: { user_id: 'member-19' },
      has_more: true,
      filtered_total: 80,
    })
    .mockReturnValueOnce(more);
  const view = render(tree());
  await settle();
  fireEvent.scroll(view.container.querySelector('.members-viewport')!, {
    target: { scrollTop: 7000 },
  });
  fireEvent.click(screen.getAllByRole('button', { name: /^Open Player / })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Back To Roster' }));
  await settle();
  expect(f.page).toHaveBeenCalledTimes(3);
  fireEvent.change(search(), { target: { value: 'Player 2' } });
  await settle();
  await act(async () => {
    resolveMore({ items: rows.slice(20), next_cursor: null, has_more: false, filtered_total: 80 });
  });
  await settle();
  expect(search()).toHaveValue('Player 2');
  expect((view.container.querySelector('.members-viewport') as HTMLDivElement).scrollTop).toBe(0);
  expect(f.page).toHaveBeenCalledTimes(4);
});

it('adopts the existing tab-only search on upgrade without an obsolete blank read', async () => {
  sessionStorage.setItem(rosterSearchKey('viewer-a', clubA), JSON.stringify('Legacy Player'));
  render(tree());
  await settle();
  expect(search()).toHaveValue('Legacy Player');
  expect(f.page).toHaveBeenCalledTimes(1);
  expect(f.page).toHaveBeenCalledWith(
    clubA,
    expect.objectContaining({ search: 'Legacy Player', filter: 'all', sort: 'hierarchy' })
  );
  expect(screen.getByRole('button', { name: /^Open Player 0,/ })).toBeInTheDocument();
});
it('normalizes inherited object-property names in deep-linked view and sort to safe defaults', async () => {
  render(tree('/clubs/club-a/members?view=toString&sort=constructor'));
  await settle();
  expect(screen.getByRole('button', { name: 'All Players', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(sort()).toHaveValue('hierarchy');
  expect(f.page).toHaveBeenCalledTimes(1);
  expect(f.page).toHaveBeenCalledWith(
    clubA,
    expect.objectContaining({ filter: 'all', sort: 'hierarchy' })
  );
  expect(screen.getByTestId('location').textContent).not.toMatch(/toString|constructor/);
  expect(screen.getByRole('button', { name: /^Open Player 0,/ })).toBeInTheDocument();
});
