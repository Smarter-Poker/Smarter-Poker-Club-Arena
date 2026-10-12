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
  detail: vi.fn(),
  csv: vi.fn(),
  report: vi.fn(),
  memberSignal: null as null | ((payload: unknown) => void),
  walletSignal: null as null | ((payload: unknown) => void),
  balanceSignal: null as null | ((payload: unknown) => void),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => f.actor }));
vi.mock('../../src/hooks/useProfilePresence', () => ({ useOnlineNow: () => false }));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscriptions: (events: string[], callback: (p: unknown) => void) => {
    if (events.includes('BALANCE_UPDATED')) f.balanceSignal = callback;
  },
}));
vi.mock('../../src/hooks/useMasterBusChannel', () => ({
  useMasterBusChannel: (config: { table: string; onPayload: (p: unknown) => void }) => {
    if (config.table === 'club_members') f.memberSignal = config.onPayload;
  },
}));
vi.mock('../../src/hooks/useMasterBusBroadcastChannel', () => ({
  useMasterBusBroadcastChannel: (config: { onPayload: (p: unknown) => void }) => {
    f.walletSignal = config.onPayload;
  },
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => f.toast }));
vi.mock('../../src/utils/strictClubIdResolver', () => ({
  resolveClubUUIDStrict: async (club: string) =>
    club === 'club-a'
      ? '00000000-0000-0000-0000-000000000043'
      : '00000000-0000-0000-0000-000000000044',
  ClubNotFoundError: class extends Error {},
}));
vi.mock('../../src/services/ClubRosterService', () => ({
  default: {
    getRosterPage: f.page,
    getSummary: f.summary,
    exportRoster: f.export,
    getMemberDetail: f.detail,
  },
  mapRosterRow: (row: unknown) => row,
  MemberAccessDeniedError: class MemberAccessDeniedError extends Error {},
}));
vi.mock('../../src/lib/export', () => ({ exportToCSV: f.csv }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: f.report }));
import ClubMembersPage from '../../src/pages/ClubMembersPage';
import { MemberAccessDeniedError } from '../../src/services/ClubRosterService';

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
  capabilities: { can_view_financials: true },
  wallets: { chip_balance: 125, player_wallet: 125, agent_wallet: 350 },
};
const row = {
  user_id: 'member-a',
  alias: 'Alice',
  username: 'alice',
  role: 'player',
  downline_total: null,
  total_fees: null,
  downline_fees: null,
  can_view_financials: true,
  can_view_notes: false,
  chip_balance: 100,
  player_wallet: 100,
  agent_wallet: 200,
};
const club = '00000000-0000-0000-0000-000000000043';
const signal = () => f.walletSignal?.({ payload: { club_id: club, user_id: 'member-a' } });
const playerSignal = (balance: number) =>
  f.memberSignal?.({
    eventType: 'UPDATE',
    new: { club_id: club, user_id: 'member-a', chip_balance: balance, role: 'player' },
    old: { user_id: 'member-a', chip_balance: 100, role: 'player' },
  });
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
  f.memberSignal = null;
  f.walletSignal = null;
  f.balanceSignal = null;
  f.detail.mockReset();
  f.detail.mockResolvedValue(receipt);
  f.page.mockResolvedValue({ items: [row], next_cursor: null, has_more: false, filtered_total: 1 });
  f.summary.mockResolvedValue({
    viewer_role: 'owner',
    capabilities: {
      can_view_financials: false,
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

it('updates an authorized player wallet absolutely without starting another directory read', async () => {
  render(tree());
  await ready();
  const calls = f.page.mock.calls.length;
  act(() => playerSignal(175));
  expect(screen.getByText('175')).toBeInTheDocument();
  expect(f.page).toHaveBeenCalledTimes(calls);
});
it('rereads agent wallets from private signals and coalesces overlapping events', async () => {
  const first = deferred(),
    latest = deferred();
  f.detail.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
  render(tree());
  await ready();
  const calls = f.page.mock.calls.length;
  act(() => {
    signal();
    signal();
    signal();
  });
  expect(f.detail).toHaveBeenCalledTimes(1);
  await act(async () => {
    first.resolve(receipt);
  });
  expect(f.detail).toHaveBeenCalledTimes(2);
  expect(screen.getByText('350')).toBeInTheDocument();
  await act(async () => {
    latest.resolve({ ...receipt, wallets: { ...receipt.wallets, agent_wallet: 450 } });
  });
  expect(screen.getByText('450')).toBeInTheDocument();
  expect(f.page).toHaveBeenCalledTimes(calls);
});
it('keeps a newer wallet event when a previously started directory read answers', async () => {
  const pending = new Promise<any>((resolve) => {
    f.export.mockImplementation(resolve);
  });
  render(tree());
  await ready();
  f.page.mockReturnValueOnce(pending);
  act(() => {
    f.memberSignal?.({ eventType: 'INSERT', new: {} });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
  expect(f.page).toHaveBeenCalledTimes(2);
  act(() => playerSignal(175));
  await act(async () => {
    f.export({ items: [row], next_cursor: null, has_more: false, filtered_total: 1 });
  });
  expect(screen.getByText('175')).toBeInTheDocument();
});
it('rejects wallet answers after a search scope reset', async () => {
  const old = deferred();
  f.detail.mockReturnValue(old.promise);
  render(tree());
  await ready();
  act(() => signal());
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search Club Members' }), {
    target: { value: 'Other' },
  });
  await act(async () => {
    old.resolve(receipt);
  });
  expect(screen.queryByText('350')).not.toBeInTheDocument();
});
it('does not expose wallets for identity-only rows even if signals carry balances', async () => {
  f.page.mockResolvedValue({
    items: [{ ...row, can_view_financials: false }],
    next_cursor: null,
    has_more: false,
    filtered_total: 1,
  });
  render(tree());
  await ready();
  act(() => {
    playerSignal(175);
    signal();
  });
  expect(f.detail).not.toHaveBeenCalled();
  expect(screen.queryByText('175')).not.toBeInTheDocument();
});
it('preserves the last wallet on a failed authoritative read', async () => {
  f.detail.mockRejectedValue(new Error('Wallet Read Failed'));
  render(tree());
  await ready();
  await act(async () => {
    signal();
  });
  expect(screen.getByText('200')).toBeInTheDocument();
  expect(f.report).toHaveBeenCalledWith(expect.any(Error), 'ClubMembersPage.walletRefresh');
});

it('removes financial values when the authoritative read revokes financial access', async () => {
  f.detail.mockResolvedValue({ capabilities: { can_view_financials: false }, wallets: null });
  render(tree());
  await ready();
  await act(async () => {
    signal();
  });
  expect(screen.queryByText('200')).not.toBeInTheDocument();
  expect(screen.queryByText('100')).not.toBeInTheDocument();
});
it('rejects a previous viewer wallet response and its signal is aborted', async () => {
  const old = deferred();
  f.detail.mockReturnValue(old.promise);
  const view = render(tree());
  await ready();
  act(() => signal());
  const abortSignal = f.detail.mock.calls[0][3];
  f.actor.user = { id: 'viewer-b' };
  view.rerender(tree());
  await ready();
  expect(abortSignal.aborted).toBe(true);
  await act(async () => {
    old.resolve(receipt);
  });
  expect(screen.queryByText('350')).not.toBeInTheDocument();
});

it('accepts a numeric WAL string and rejects empty balance data', async () => {
  render(tree());
  await ready();
  act(() => {
    f.memberSignal?.({
      eventType: 'UPDATE',
      new: { club_id: club, user_id: 'member-a', chip_balance: '275' },
    });
  });
  expect(screen.getByText('275')).toBeInTheDocument();
  act(() => {
    f.memberSignal?.({
      eventType: 'UPDATE',
      new: { club_id: club, user_id: 'member-a', chip_balance: '' },
    });
  });
  expect(screen.getByText('275')).toBeInTheDocument();
});

it('clears its request deadline when the wallet owner unmounts', async () => {
  const pending = deferred();
  f.detail.mockReturnValue(pending.promise);
  const view = render(tree());
  await ready();
  act(() => signal());
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(40_000);
    pending.resolve(receipt);
  });
  expect(f.report).not.toHaveBeenCalled();
});

it('redacts the wallet when the service confirms a full null access denial', async () => {
  f.detail.mockRejectedValue(new MemberAccessDeniedError());
  render(tree());
  await ready();
  await act(async () => {
    signal();
  });
  expect(screen.queryByText('200')).not.toBeInTheDocument();
  expect(screen.queryByText('100')).not.toBeInTheDocument();
  expect(f.report).not.toHaveBeenCalled();
});
