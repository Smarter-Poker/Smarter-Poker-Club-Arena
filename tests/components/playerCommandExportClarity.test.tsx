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
  rows: [{ alias: 'Off Page', role: 'player', total_fees: '12.34', downline_fees: '56.78' }],
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

it('explains all matching exports and annotates every returned server row with exact request and receipt context', async () => {
  vi.setSystemTime(new Date('2026-10-11T23:59:50.000Z'));
  f.export.mockResolvedValue(receipt);
  render(tree());
  await ready();
  expect(screen.getByRole('note', { name: 'Export Scope' })).toHaveTextContent(
    'All Matching Players Across Every Page'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.export).toHaveBeenCalledWith(
    '00000000-0000-0000-0000-000000000043',
    { search: '', filter: 'all', sort: 'hierarchy' },
    null,
    expect.any(AbortSignal)
  );
  expect(f.csv.mock.calls[0][0]).toEqual([
    {
      alias: 'Off Page',
      role: 'Player',
      total_fees: '12.34',
      downline_fees: '56.78',
      export_club_id: '00000000-0000-0000-0000-000000000043',
      export_scope: 'all_matching',
      export_filter: 'all',
      export_sort: 'hierarchy',
      export_search: '',
      export_selected_count: 0,
      export_row_count: 1,
      export_requested_at_utc: '2026-10-11T23:59:50.000Z',
      export_completed_at_utc: '2026-10-11T23:59:50.000Z',
      export_audit_id: 'audit-proof',
      export_activity_period: 'All Recorded Activity',
      export_units: 'Club Chips',
    },
  ]);
});
it('uses selected matching scope and the server row count rather than the loaded directory count', async () => {
  f.export.mockResolvedValue(receipt);
  render(tree());
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Select Loaded' }));
  expect(
    screen.getByText('Selected Players Matching The Current Filter And Search')
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Export Selected (1)' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.export.mock.calls[0][2]).toEqual(['loaded-player']);
  expect(f.csv.mock.calls[0][0][0]).toMatchObject({
    export_scope: 'selected_matching',
    export_selected_count: 1,
    export_row_count: 1,
    alias: 'Off Page',
  });
});
it('captures filter/search/sort when requested even if controls change before the receipt', async () => {
  const pending = deferred();
  f.export.mockReturnValue(pending.promise);
  render(tree());
  await ready();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '  Player  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Agents', exact: true }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'name' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  fireEvent.click(screen.getByRole('button', { name: 'All Players', exact: true }));
  await act(async () => {
    pending.resolve(receipt);
  });
  expect(f.csv.mock.calls[0][0][0]).toMatchObject({
    export_filter: 'agents',
    export_sort: 'name',
    export_search: 'Player',
  });
});
it('defines recursive downline fees separately from individual fees and preserves recorded-activity limits', async () => {
  render(tree());
  await ready();
  expect(screen.getByText('Metric Definitions')).toBeInTheDocument();
  expect(
    screen.getByText(/Total Fees: Fees Generated By The Recursive Downline Only/)
  ).toBeInTheDocument();
  expect(screen.getByText(/Individual Fees: Fees Generated By This Player/)).toBeInTheDocument();
  expect(screen.getByText(/Recorded Activity Follows Hand History Retention/)).toBeInTheDocument();
});

it('exports CSV context as data through the existing formula-safe CSV serializer', async () => {
  const { buildCSV } =
    await vi.importActual<typeof import('../../src/lib/export')>('../../src/lib/export');
  f.export.mockResolvedValue({
    ...receipt,
    rows: [{ alias: '=SUM(1,2)', role: 'player', player_wallet: null, total_fees: '12.34' }],
  });
  render(tree());
  await ready();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '=x,"y"' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  await act(async () => {
    await Promise.resolve();
  });
  const csv = buildCSV(f.csv.mock.calls[0][0]);
  expect(csv.split('\r\n')).toHaveLength(2);
  expect(csv).toContain('"\'=SUM(1,2)"');
  expect(csv).toContain('"\'=x,""y"""');
  expect(csv).toContain('Player,,12.34,');
  expect(csv).toContain('export_audit_id,export_activity_period,export_units');
});
it.each(['empty', 'refused'])(
  'never fabricates a file or success for an %s export',
  async (kind) => {
    if (kind === 'empty')
      f.export.mockResolvedValue({ rows: [], row_count: 0, audit_id: 'empty-audit' });
    else f.export.mockRejectedValue(new Error('Roster Export Requires Club Staff Access'));
    render(tree());
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(f.csv).not.toHaveBeenCalled();
    expect(f.toast.success).not.toHaveBeenCalled();
    expect(f.toast.error).toHaveBeenCalledTimes(1);
  }
);
it('does not expose export controls or export scope to a viewer without export permission', async () => {
  f.summary.mockResolvedValue({
    viewer_role: 'player',
    capabilities: {
      can_view_financials: false,
      can_export: false,
      can_manage_members: false,
      can_view_notes: false,
    },
    counts: { total: 1, online: 0, seated: 0, agents: 0, admins: 0 },
    data_version: null,
    page_size: 80,
  });
  render(tree());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Export Scope')).not.toBeInTheDocument();
  expect(f.export).not.toHaveBeenCalled();
});

it.each(['denied', 'revoked'])(
  'retires a pending export after a verified %s summary and allows a new authorized request',
  async (kind) => {
    const pending = deferred();
    f.export.mockReturnValueOnce(pending.promise).mockResolvedValue(receipt);
    render(tree());
    await ready();
    const allowed = await f.summary.mock.results[0].value;
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    const signal = f.export.mock.calls[0][3] as AbortSignal;
    f.summary.mockResolvedValue(
      kind === 'denied'
        ? null
        : {
            ...allowed,
            capabilities: { ...allowed.capabilities, can_export: false },
          }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      pending.resolve(receipt);
    });
    expect(f.csv).not.toHaveBeenCalled();
    expect(f.toast.success).not.toHaveBeenCalled();
    f.summary.mockResolvedValue(allowed);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(f.export).toHaveBeenCalledTimes(2);
    expect(f.csv).toHaveBeenCalledTimes(1);
  }
);

it('keeps an authorized pending export through an unreadable summary rather than inventing a revocation', async () => {
  const pending = deferred();
  f.export.mockReturnValue(pending.promise);
  render(tree());
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  const signal = f.export.mock.calls[0][3] as AbortSignal;
  f.summary.mockRejectedValue(new Error('Summary Connection Interrupted'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(signal.aborted).toBe(false);
  await act(async () => {
    pending.resolve(receipt);
  });
  expect(f.csv).toHaveBeenCalledTimes(1);
  expect(f.toast.success).toHaveBeenCalledTimes(1);
});
