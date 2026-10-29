import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useContext, useMemo, type ReactNode } from 'react';
import {
  MemoryRouter,
  Route,
  Routes,
  useNavigate,
  useLocation,
  UNSAFE_NavigationContext,
} from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  actor: { user: { id: 'viewer-a' } },
  toast: { success: vi.fn(), error: vi.fn() },
  page: vi.fn(),
  summary: vi.fn(),
  export: vi.fn(),
  csv: vi.fn(),
  report: vi.fn(),
  holdOwnReplace: false,
  releaseReplaces: [] as Array<() => void>,
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
      <button onClick={() => navigate('/clubs/club-a/members?view=agents&sort=name')}>
        Linked Agents
      </button>
      <button onClick={() => navigate('/clubs/club-a/members?view=agents')}>
        Linked Agents Hierarchy
      </button>
      <button onClick={() => navigate(-1)}>History Back</button>
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
function DelayedOwnReplace({ children }: { children: ReactNode }) {
  const context = useContext(UNSAFE_NavigationContext);
  const navigator = useMemo(
    () => ({
      ...context.navigator,
      replace: (...args: Parameters<typeof context.navigator.replace>) => {
        if (f.holdOwnReplace) f.releaseReplaces.push(() => context.navigator.replace(...args));
        else context.navigator.replace(...args);
      },
    }),
    [context.navigator]
  );
  return (
    <UNSAFE_NavigationContext.Provider value={{ ...context, navigator }}>
      {children}
    </UNSAFE_NavigationContext.Provider>
  );
}
const tree = (entry = '/clubs/club-a/members') => (
  <MemoryRouter initialEntries={[entry]}>
    <DelayedOwnReplace>
      <Harness />
    </DelayedOwnReplace>
  </MemoryRouter>
);
async function settle() {
  const advanced = screen.queryByRole('button', { name: 'Advanced' });
  if (advanced) fireEvent.click(advanced);
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
  fireEvent.change(sort(), { target: { value: 'name' } });
  fireEvent.change(search(), { target: { value: 'Player' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter Players' }), {
    target: { value: 'agents' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Wallets', exact: true }));
  await settle();
}
function expectPreferences() {
  expect(search()).toHaveValue('Player');
  expect(screen.getByRole('combobox', { name: 'Filter Players' })).toHaveValue('agents');
  expect(sort()).toHaveValue('search');
  expect(sort()).toBeDisabled();
  expect(f.page).toHaveBeenLastCalledWith(clubA, expect.objectContaining({ sort: 'name' }));
  expect(screen.getByRole('checkbox', { name: 'Wallets', exact: true })).toBeChecked();
}
beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  localStorage.clear();
  vi.clearAllMocks();
  f.holdOwnReplace = false;
  f.releaseReplaces = [];
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
  expect(sort()).toHaveValue('newest');
  expect(screen.getByRole('checkbox', { name: 'Wallets', exact: true })).not.toBeChecked();
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
  expect(sort()).toHaveValue('newest');
  expect(screen.getByRole('checkbox', { name: 'Wallets', exact: true })).not.toBeChecked();
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
  expect(screen.getByRole('combobox', { name: 'Filter Players' })).toHaveValue('online');
  expect(sort()).toHaveValue('search');
  expect(f.page).toHaveBeenLastCalledWith(clubA, expect.objectContaining({ sort: 'hierarchy' }));
  fireEvent.change(search(), { target: { value: '' } });
  await settle();
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
it('keeps its filter and sort read owned while its own URL replacement is awaiting acknowledgment', async () => {
  let aborts = 0;
  const finish: Array<() => void> = [];
  f.page.mockImplementation((_club, query) => {
    const page = { items: rows, next_cursor: null, has_more: false, filtered_total: 80 };
    if (query.filter === 'all' && query.sort === 'newest') return Promise.resolve(page);
    return new Promise((resolve, reject) => {
      const aborted = () => {
        aborts++;
        reject(new DOMException('Aborted', 'AbortError'));
      };
      query.signal.addEventListener('abort', aborted, { once: true });
      finish.push(() => {
        query.signal.removeEventListener('abort', aborted);
        resolve(page);
      });
    });
  });
  render(tree());
  await settle();
  f.holdOwnReplace = true;
  const agents = screen.getByRole('combobox', { name: 'Filter Players' });
  fireEvent.change(agents, { target: { value: 'agents' } });
  await act(async () => {});
  expect(agents).toHaveValue('agents');
  expect(aborts).toBe(0);
  expect(f.page.mock.calls.map(([, query]) => query.filter)).toEqual(['all', 'agents']);
  await act(async () => {
    f.holdOwnReplace = false;
    f.releaseReplaces.splice(0).forEach((release) => release());
  });
  await act(async () => {
    finish[0]();
  });
  await settle();
  expect(agents).toHaveValue('agents');
  expect(f.page.mock.calls.map(([, query]) => query.filter)).toEqual(['all', 'agents']);
  f.holdOwnReplace = true;
  fireEvent.change(sort(), { target: { value: 'name' } });
  await act(async () => {});
  expect(sort()).toHaveValue('name');
  expect(aborts).toBe(0);
  expect(f.page.mock.calls.map(([, query]) => query.sort)).toEqual(['newest', 'newest', 'name']);
  await act(async () => {
    f.holdOwnReplace = false;
    f.releaseReplaces.splice(0).forEach((release) => release());
  });
  await act(async () => {
    finish[1]();
  });
  await settle();
  expect(sort()).toHaveValue('name');
  expect(f.page).toHaveBeenCalledTimes(3);
  expect(aborts).toBe(0);
});
it('serializes pending URL replacements and writes the latest rapidly changed controls', async () => {
  render(tree());
  await settle();
  f.holdOwnReplace = true;
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter Players' }), {
    target: { value: 'agents' },
  });
  fireEvent.change(sort(), { target: { value: 'name' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter Players' }), {
    target: { value: 'online' },
  });
  await act(async () => {});
  expect(f.releaseReplaces).toHaveLength(1);
  expect(sort()).toHaveValue('name');
  expect(screen.getByRole('combobox', { name: 'Filter Players' })).toHaveValue('online');
  const calls = f.page.mock.calls.length;
  await act(async () => {
    f.releaseReplaces.shift()!();
  });
  expect(f.releaseReplaces).toHaveLength(1);
  expect(sort()).toHaveValue('name');
  expect(screen.getByRole('combobox', { name: 'Filter Players' })).toHaveValue('online');
  await act(async () => {
    f.holdOwnReplace = false;
    f.releaseReplaces.shift()!();
  });
  await settle();
  expect(screen.getByTestId('location').textContent).toContain('?view=online&sort=name');
  expect(f.page).toHaveBeenCalledTimes(calls);
});
it('does not revive an old URL receipt when the account returns on the same history entry', async () => {
  const view = render(tree());
  await settle();
  f.holdOwnReplace = true;
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter Players' }), {
    target: { value: 'agents' },
  });
  await act(async () => {});
  expect(f.releaseReplaces).toHaveLength(1);
  f.actor.user = { id: 'viewer-b' };
  view.rerender(tree());
  await settle();
  expect(screen.getByRole('combobox', { name: 'Filter Players' })).toHaveValue('all');
  f.actor.user = { id: 'viewer-a' };
  view.rerender(tree());
  await settle();
  expect(screen.getByRole('combobox', { name: 'Filter Players' })).toHaveValue('agents');
  expect(f.releaseReplaces).toHaveLength(2);
  await act(async () => {
    f.holdOwnReplace = false;
    f.releaseReplaces.pop()!();
  });
  await settle();
  expect(screen.getByTestId('location').textContent).toContain('?view=agents');
});
it('honors external PUSH and POP while an own URL replacement is pending', async () => {
  render(tree());
  await settle();
  f.holdOwnReplace = true;
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter Players' }), {
    target: { value: 'agents' },
  });
  fireEvent.change(sort(), { target: { value: 'name' } });
  await act(async () => {});
  expect(f.releaseReplaces).toHaveLength(1);
  // This PUSH matches the outstanding replacement's target query, but its
  // own entry is authoritative and explicitly restores the default sort.
  fireEvent.click(screen.getByRole('button', { name: 'Linked Agents Hierarchy' }));
  await settle();
  expect(sort()).toHaveValue('newest');
  expect(screen.getByRole('combobox', { name: 'Filter Players' })).toHaveValue('agents');
  fireEvent.click(screen.getByRole('button', { name: 'History Back' }));
  await settle();
  expect(sort()).toHaveValue('newest');
  expect(screen.getByRole('combobox', { name: 'Filter Players' })).toHaveValue('all');
});
it('honors explicit same-club navigation and restores the prior URL on history Back', async () => {
  render(tree());
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Linked Agents' }));
  await settle();
  expect(sort()).toHaveValue('name');
  expect(screen.getByRole('combobox', { name: 'Filter Players' })).toHaveValue('agents');
  expect(screen.getByTestId('location').textContent).toContain('?view=agents&sort=name');
  fireEvent.click(screen.getByRole('button', { name: 'History Back' }));
  await settle();
  expect(sort()).toHaveValue('newest');
  expect(screen.getByRole('combobox', { name: 'Filter Players' })).toHaveValue('all');
  expect(screen.getByTestId('location').textContent).toBe('/clubs/club-a/members');
});
it('restores a legal near-end position in a shorter roster viewport', async () => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(9841);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(602);
  const view = render(tree());
  await settle();
  const viewport = view.container.querySelector('.members-viewport') as HTMLDivElement;
  fireEvent.scroll(viewport, { target: { scrollTop: 9200 } });
  fireEvent.click(screen.getAllByRole('button', { name: /^Open Player / })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Back To Roster' }));
  await settle();
  expect((view.container.querySelector('.members-viewport') as HTMLDivElement).scrollTop).toBe(
    9200
  );
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
  expect(sort()).toHaveValue('newest');
  expect(screen.getByRole('combobox', { name: 'Filter Players' })).toHaveValue('all');
  expect(screen.getByRole('checkbox', { name: 'Wallets', exact: true })).not.toBeChecked();
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
  const view = render(tree('/clubs/club-a/members?sort=hierarchy'));
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
    expect.objectContaining({ search: 'Legacy Player', filter: 'all', sort: 'newest' })
  );
  expect(screen.getByRole('button', { name: /^Open Player 0,/ })).toBeInTheDocument();
});
it('normalizes inherited object-property names in deep-linked view and sort to safe defaults', async () => {
  render(tree('/clubs/club-a/members?view=toString&sort=constructor'));
  await settle();
  expect(screen.getByRole('combobox', { name: 'Filter Players' })).toHaveValue('all');
  expect(sort()).toHaveValue('newest');
  expect(f.page).toHaveBeenCalledTimes(1);
  expect(f.page).toHaveBeenCalledWith(
    clubA,
    expect.objectContaining({ filter: 'all', sort: 'newest' })
  );
  expect(screen.getByTestId('location').textContent).not.toMatch(/toString|constructor/);
  expect(screen.getByRole('button', { name: /^Open Player 0,/ })).toBeInTheDocument();
});

it('defaults to this week and newest club members and retains an oldest choice', async () => {
  const view = render(tree());
  await settle();
  expect(sort()).toHaveValue('newest');
  expect(screen.getByRole('option', { name: 'Newest Players First' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Oldest Players First' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Simple', exact: true }));
  expect(screen.getByRole('combobox', { name: 'Win And Loss Period' })).toHaveValue('week');
  fireEvent.change(sort(), { target: { value: 'oldest' } });
  await settle();
  expect(f.page).toHaveBeenLastCalledWith(clubA, expect.objectContaining({ sort: 'oldest' }));
  view.unmount();
  render(tree());
  await settle();
  expect(sort()).toHaveValue('oldest');
});

it('adopts newest on upgrade while retaining the old workspace search and columns', async () => {
  sessionStorage.setItem(
    `roster_workspace_v1_viewer-a_${clubA}`,
    JSON.stringify({
      version: 1,
      search: 'Player',
      filter: 'agents',
      sort: 'activity',
      columns: ['fees', 'wallets'],
    })
  );
  render(tree());
  await settle();
  expect(sort()).toHaveValue('search');
  expect(f.page).toHaveBeenLastCalledWith(clubA, expect.objectContaining({ sort: 'newest' }));
  expect(search()).toHaveValue('Player');
  expect(screen.getByRole('combobox', { name: 'Filter Players' })).toHaveValue('agents');
  expect(screen.getByRole('checkbox', { name: 'Wallets', exact: true })).toBeChecked();
});
