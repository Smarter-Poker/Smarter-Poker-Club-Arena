import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
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

function Harness() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/clubs/club-a/members')}>Club A</button>
      <button onClick={() => navigate('/clubs/club-b/members')}>Club B</button>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
      </Routes>
    </>
  );
}
const tree = () => (
  <MemoryRouter initialEntries={['/clubs/club-a/members']}>
    <Harness />
  </MemoryRouter>
);
const receipt = {
  rows: [
    {
      user_id: 'loaded-player',
      alias: 'Off Page',
      role: 'player',
      total_fees: '12.34',
      downline_fees: '56.78',
    },
  ],
  row_count: 1,
  audit_id: 'audit-proof',
};
function deferred() {
  let resolve!: (value: typeof receipt) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<typeof receipt>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function ready() {
  const advanced = screen.queryByRole('button', { name: 'Advanced' });
  if (advanced) fireEvent.click(advanced);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
}
beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  vi.clearAllMocks();
  f.actor.user = { id: 'viewer-a' };
  f.page.mockResolvedValue({
    items: [
      {
        user_id: 'loaded-player',
        alias: 'Loaded Player',
        role: 'player',
        player_wallet: 1,
        agent_wallet: 2,
        total_fees: 12,
        downline_fees: 56,
        downline_total: 3,
        can_view_financials: true,
      },
    ],
    next_cursor: null,
    has_more: false,
    filtered_total: 100,
  });
  f.summary.mockResolvedValue({
    viewer_role: 'owner',
    capabilities: {
      can_view_financials: true,
      can_export: true,
      can_manage_members: false,
      can_view_notes: false,
    },
    counts: { total: 0, online: 0, seated: 0, agents: 0, admins: 0 },
    data_version: null,
    page_size: 80,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const operation = () => screen.getByRole('status', { name: 'Export Operation' });
const rosterOperations = () => screen.getByRole('status', { name: 'Roster Operations' });
const row = (id: string) => ({
  user_id: id,
  alias: id,
  role: 'player',
  player_wallet: 1,
  agent_wallet: 0,
  total_fees: 0,
  downline_fees: 0,
  downline_total: 0,
  can_view_financials: true,
});
async function refreshRows(ids: string[]) {
  f.page.mockResolvedValue({
    items: ids.map(row),
    next_cursor: null,
    has_more: false,
    filtered_total: ids.length,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

it('retires removed row identities and selects the current loaded set rather than comparing counts', async () => {
  render(tree());
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Select Loaded', exact: true }));
  await refreshRows(['replacement-player']);
  expect(screen.queryByRole('button', { name: 'Export Selected (1)' })).not.toBeInTheDocument();
  const select = screen.getByRole('button', { name: 'Select Loaded', exact: true });
  expect(select).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(select);
  f.export.mockResolvedValue(receipt);
  fireEvent.click(screen.getByRole('button', { name: 'Export Selected (1)' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.export.mock.calls[0][2]).toEqual(['replacement-player']);
});

it('allows only one active export and preserves its captured selection while current selection changes', async () => {
  const pending = deferred();
  f.export.mockReturnValue(pending.promise);
  render(tree());
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Select Loaded', exact: true }));
  const button = screen.getByRole('button', { name: 'Export Selected (1)' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(f.export).toHaveBeenCalledTimes(1);
  expect(f.export.mock.calls[0][2]).toEqual(['loaded-player']);
  expect(operation()).toHaveAttribute('data-operation-state', 'preparing');
  expect(operation()).toHaveTextContent(/1/);
  fireEvent.click(screen.getByRole('button', { name: 'Clear', exact: true }));
  await act(async () => {
    pending.resolve(receipt);
  });
  expect(f.csv).toHaveBeenCalledTimes(1);
  expect(f.csv.mock.calls[0][0][0]).toMatchObject({
    export_selected_count: 1,
    export_scope: 'selected_matching',
  });
  expect(operation()).toHaveAttribute('data-operation-state', 'success');
  expect(operation()).toHaveTextContent('audit-proof');
});

it('keeps returned count and audit reference visible after a completed all-matching export', async () => {
  f.export.mockResolvedValue({
    ...receipt,
    rows: [receipt.rows[0], { ...receipt.rows[0], user_id: 'off-page' }],
    row_count: 2,
  });
  render(tree());
  await ready();
  expect(rosterOperations()).toHaveTextContent(/1/);
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(operation()).toHaveAttribute('data-operation-state', 'success');
  expect(operation()).toHaveTextContent(/2/);
  expect(operation()).toHaveTextContent('audit-proof');
  expect(f.csv.mock.calls[0][0]).toHaveLength(2);
});

it('reports a verified empty export without downloading or claiming players were exported', async () => {
  f.export.mockResolvedValue({ rows: [], row_count: 0, audit_id: 'empty-audit' });
  render(tree());
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.csv).not.toHaveBeenCalled();
  expect(f.toast.success).not.toHaveBeenCalled();
  expect(operation()).toHaveAttribute('data-operation-state', 'empty');
  expect(operation()).toHaveTextContent('empty-audit');
});

it('keeps an export failure visible and never automatically submits it again', async () => {
  f.export.mockRejectedValue(new Error('Export Connection Interrupted'));
  render(tree());
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(f.export).toHaveBeenCalledTimes(1);
  expect(f.csv).not.toHaveBeenCalled();
  expect(operation()).toHaveAttribute('data-operation-state', 'error');
  expect(operation()).toHaveTextContent('Export Connection Interrupted');
});

it.each(['viewer', 'club'])(
  'retires the visible pending operation and late receipt after a %s ownership change',
  async (kind) => {
    const pending = deferred();
    f.export.mockReturnValue(pending.promise);
    const rendered = render(tree());
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    const signal = f.export.mock.calls[0][3] as AbortSignal;
    expect(operation()).toHaveAttribute('data-operation-state', 'preparing');
    if (kind === 'viewer') {
      f.actor.user = { id: 'viewer-b' };
      rendered.rerender(tree());
    } else fireEvent.click(screen.getByRole('button', { name: 'Club B' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole('status', { name: 'Export Operation' })).not.toBeInTheDocument();
    await act(async () => {
      pending.resolve(receipt);
    });
    expect(f.csv).not.toHaveBeenCalled();
    expect(screen.queryByText('audit-proof')).not.toBeInTheDocument();
  }
);

it('clears selection and pending operation on confirmed export permission revocation', async () => {
  const pending = deferred();
  f.export.mockReturnValue(pending.promise);
  render(tree());
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Select Loaded', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Export Selected (1)' }));
  const allowed = await f.summary.mock.results[0].value;
  f.summary.mockResolvedValue({
    ...allowed,
    capabilities: { ...allowed.capabilities, can_export: false },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.queryByRole('status', { name: 'Export Operation' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Selected Players' })).not.toBeInTheDocument();
  await act(async () => {
    pending.resolve(receipt);
  });
  expect(f.csv).not.toHaveBeenCalled();
});

it.each(['search', 'filter', 'sort'])(
  'retires selected identities when the user changes the %s query before its new read',
  async (kind) => {
    render(tree());
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Select Loaded', exact: true }));
    if (kind === 'search') {
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search Club Members' }), {
        target: { value: 'Private Search Text' },
      });
    } else {
      fireEvent.change(
        screen.getByRole('combobox', {
          name: kind === 'filter' ? 'Filter Players' : 'Sort Players',
        }),
        {
          target: { value: kind === 'filter' ? 'online' : 'name' },
        }
      );
    }
    expect(screen.queryByRole('region', { name: 'Selected Players' })).not.toBeInTheDocument();
    expect(f.export).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
    f.export.mockResolvedValue(receipt);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(f.export.mock.calls[0][2]).toBeNull();
    expect(operation()).not.toHaveTextContent('Private Search Text');
  }
);

it.each(['search', 'filter', 'sort'])(
  'does not label retained rows as the current query while a changed %s is pending or failed',
  async (kind) => {
    let rejectRead!: (error: Error) => void;
    const pendingRead = new Promise((_, reject) => {
      rejectRead = reject;
    });
    render(tree());
    await ready();
    expect(rosterOperations()).toHaveTextContent('1 Loaded Of 100 Matching Players.');
    f.page.mockReturnValue(pendingRead);
    if (kind === 'search') {
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search Club Members' }), {
        target: { value: 'New Query' },
      });
    } else {
      fireEvent.change(
        screen.getByRole('combobox', {
          name: kind === 'filter' ? 'Filter Players' : 'Sort Players',
        }),
        {
          target: { value: kind === 'filter' ? 'online' : 'name' },
        }
      );
    }
    expect(rosterOperations()).not.toHaveTextContent('1 Loaded Of 100 Matching Players.');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(rosterOperations()).not.toHaveTextContent('1 Loaded Of 100 Matching Players.');
    expect(rosterOperations()).toHaveTextContent(/Previously Verified|Not Yet Verified/);
    await act(async () => {
      rejectRead(new Error('Current Filter Read Failed'));
    });
    expect(rosterOperations()).not.toHaveTextContent('1 Loaded Of 100 Matching Players.');
    expect(rosterOperations()).toHaveTextContent(/Previously Verified|Not Yet Verified/);
    expect(f.export).not.toHaveBeenCalled();
  }
);
