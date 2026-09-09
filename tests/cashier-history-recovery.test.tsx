import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CashierPage from '../src/pages/CashierPage';
import { supabase } from '../src/lib/supabase';
import { engineChannelClient } from '../src/services/EngineStateClient';
import { masterBus } from '../src/core/MasterBus';

vi.unmock('../src/core/MasterBus');

const PLAYER = '22222222-2222-4222-8222-222222222222';
const CLUB = '11111111-1111-4111-8111-111111111111';
const mocks = vi.hoisted(() => ({
  loadBalances: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: PLAYER } }) }));
vi.mock('../src/stores/useWalletStore', () => ({
  useWalletStore: () => ({ loadBalances: mocks.loadBalances, mintChips: vi.fn() }),
}));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: () => {} }));
vi.mock('../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: () => {} }));
vi.mock('../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../src/utils/retryFetch', () => ({ retryFetch: (read: () => unknown) => read() }));
vi.mock('../src/utils/clubQuickLink', () => ({
  CHIP_BALANCE_EVENTS: [],
  fetchClubChipBalances: async () => new Map(),
  clearClubChipBalanceCache: vi.fn(),
  resolveTargetClub: vi.fn(),
  readCachedQuickLinkClubs: vi.fn(),
  fetchQuickLinkClubs: vi.fn(),
}));
vi.mock('../src/components/club/CashierClubSwitcher', () => ({ default: () => null }));
vi.mock('../src/components/agent/AgentPromoPanel', () => ({ default: () => null }));
vi.mock('../src/components/wallet/DynamicWallet', () => ({ default: () => null }));
vi.mock('../src/components/wallet/WalletCashierModal', () => ({ default: () => null }));
vi.mock('../src/components/wallet/PlayerWalletModal', () => ({ default: () => null }));
vi.mock('../src/components/wallet/CashoutRequestModal', () => ({ default: () => null }));
vi.mock('../src/components/layouts/StandardContentLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

type Result = { data: unknown[] | null; error: Error | null };
function deferred() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const transaction = (id: string) => ({
  id,
  user_id: PLAYER,
  wallet_type: 'PLAYER',
  amount: 5,
  type: 'credit',
  category: 'transfer',
  description: id,
  created_at: '2026-09-09T07:00:00Z',
});
let walletReads: ReturnType<typeof deferred>[];
let ledgerReads: ReturnType<typeof deferred>[];
let status: Parameters<typeof engineChannelClient.onStatusChange>[0];

function ClubNavigation() {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate('/cashier?club=33333333-3333-4333-8333-333333333333')}>
      Switch Club
    </button>
  );
}
function start() {
  return render(
    <MemoryRouter initialEntries={[`/cashier?club=${CLUB}`]}>
      <CashierPage />
      <ClubNavigation />
    </MemoryRouter>
  );
}
async function showHistory() {
  await screen.findByRole('tab', { name: 'Buy-In', selected: true });
  const history = screen.getByRole('tab', { name: /history/i });
  fireEvent.click(history);
}
async function settle(index: number, rows: unknown[], failed?: 'wallet' | 'ledger') {
  await act(async () => {
    walletReads[index].resolve({
      data: failed === 'wallet' ? null : rows,
      error: failed === 'wallet' ? new Error('wallet read refused') : null,
    });
    ledgerReads[index].resolve({
      data: failed === 'ledger' ? null : [],
      error: failed === 'ledger' ? new Error('ledger read refused') : null,
    });
  });
}

describe('Cashier history recovery through the rendered page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    walletReads = [];
    ledgerReads = [];
    vi.spyOn(engineChannelClient, 'onStatusChange').mockImplementation((callback) => {
      status = callback;
      return () => {};
    });
    vi.spyOn(engineChannelClient, 'onFinancialUpdate').mockReturnValue(() => {});
    const channel = { on: vi.fn(), subscribe: vi.fn() };
    channel.on.mockReturnValue(channel);
    channel.subscribe.mockReturnValue(channel);
    vi.spyOn(masterBus, 'getOrCreateChannel').mockReturnValue(channel as never);
    vi.spyOn(masterBus, 'registerChannelFactory').mockImplementation(() => {});
    vi.spyOn(masterBus, 'removeChannelFactory').mockImplementation(() => {});
    vi.spyOn(masterBus, 'removeRegisteredChannel').mockImplementation(() => {});
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'or', 'order', 'limit', 'is', 'in'])
        query[method] = () => query;
      query.maybeSingle = () =>
        Promise.resolve({
          data:
            table === 'club_members'
              ? { role: 'member' }
              : table === 'clubs'
                ? { name: 'Test Club', union_id: null }
                : null,
          error: null,
        });
      query.then = (done: (result: unknown) => unknown) => {
        if (table === 'wallet_transactions' || table === 'chip_ledger') {
          const gate = deferred();
          (table === 'wallet_transactions' ? walletReads : ledgerReads).push(gate);
          return gate.promise.then(done);
        }
        return Promise.resolve({ data: [], error: null }).then(done);
      };
      return query as never;
    });
  });

  it('refreshes history after the financial channel reconnects without a ledger event', async () => {
    start();
    await showHistory();
    await waitFor(() => expect(walletReads).toHaveLength(1));
    await settle(0, [transaction('Before Reconnect')]);
    expect(await screen.findByText('Before Reconnect')).toBeInTheDocument();
    act(() => {
      status('connecting');
      status('connected');
    });
    await waitFor(() => expect(walletReads).toHaveLength(2), { timeout: 2500 });
    await settle(1, [transaction('After Reconnect')]);
    expect(await screen.findByText('After Reconnect')).toBeInTheDocument();
    expect(screen.queryByText('Before Reconnect')).toBeNull();
  });

  it('retains a ledger refresh delivered while the first read is pending', async () => {
    start();
    await showHistory();
    await waitFor(() => expect(walletReads).toHaveLength(1));
    act(() => {
      masterBus.emit('TRANSACTION_LOGGED', { entry: {}, direction: 'in' });
    });
    await act(async () => {
      await new Promise((done) => setTimeout(done, 1100));
    });
    await settle(0, [transaction('Obsolete Snapshot')]);
    await waitFor(() => expect(walletReads).toHaveLength(2));
    expect(screen.queryByText('Obsolete Snapshot')).toBeNull();
    await settle(1, [transaction('Current Snapshot')]);
    expect(await screen.findByText('Current Snapshot')).toBeInTheDocument();
  });

  it.each(['wallet', 'ledger'] as const)(
    'preserves loaded history if the %s source fails and supports retry',
    async (failed) => {
      start();
      await showHistory();
      await waitFor(() => expect(walletReads).toHaveLength(1));
      await settle(0, [transaction('Confirmed History')]);
      expect(await screen.findByText('Confirmed History')).toBeInTheDocument();
      act(() => {
        masterBus.emit('TRANSACTION_LOGGED', { entry: {}, direction: 'in' });
      });
      await waitFor(() => expect(walletReads).toHaveLength(2), { timeout: 2500 });
      await settle(1, [], failed);
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Transaction History Could Not Be Refreshed'
      );
      expect(screen.getByText('Confirmed History')).toBeInTheDocument();
      expect(screen.queryByText('No Transactions Recorded Yet')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Retry History' }));
      await waitFor(() => expect(walletReads).toHaveLength(3));
      await settle(2, []);
      expect(await screen.findByText('No Transactions Recorded Yet')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    }
  );
  it('shows a failed initial read instead of an empty ledger', async () => {
    start();
    await showHistory();
    await waitFor(() => expect(walletReads).toHaveLength(1));
    await settle(0, [], 'wallet');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Transaction History Could Not Be Refreshed'
    );
    expect(screen.queryByText('No Transactions Recorded Yet')).toBeNull();
  });

  it.each(['wallet', 'ledger'] as const)(
    'rejects a missing %s result even without an explicit error',
    async (missing) => {
      start();
      await showHistory();
      await waitFor(() => expect(walletReads).toHaveLength(1));
      await act(async () => {
        walletReads[0].resolve({ data: missing === 'wallet' ? null : [], error: null });
        ledgerReads[0].resolve({ data: missing === 'ledger' ? null : [], error: null });
      });
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Transaction History Could Not Be Refreshed'
      );
      expect(screen.queryByText('No Transactions Recorded Yet')).toBeNull();
    }
  );
  it('coalesces one financial notification burst into one history read', async () => {
    start();
    await showHistory();
    await waitFor(() => expect(walletReads).toHaveLength(1));
    await settle(0, [transaction('Known History')]);
    act(() => {
      masterBus.emit('BALANCE_UPDATED', { source: 'history-test' });
      masterBus.emit('WALLET_REFRESHED', { walletType: 'PLAYER', available: 5, total: 5 });
      masterBus.emit('CASHIER_BALANCE_CHANGED', { source: 'history-test' } as never);
    });
    await waitFor(() => expect(walletReads).toHaveLength(2), { timeout: 2500 });
    await settle(1, [transaction('Updated History')]);
    expect(await screen.findByText('Updated History')).toBeInTheDocument();
    expect(walletReads).toHaveLength(2);
  });

  it('hides the previous club history and ignores its late response after navigation', async () => {
    start();
    await showHistory();
    await waitFor(() => expect(walletReads).toHaveLength(1));
    await settle(0, [transaction('Club A History')]);
    expect(await screen.findByText('Club A History')).toBeInTheDocument();
    act(() => {
      status('connected');
    });
    await waitFor(() => expect(walletReads).toHaveLength(2), { timeout: 2500 });
    fireEvent.click(screen.getByRole('button', { name: 'Switch Club' }));
    await showHistory();
    await waitFor(() => expect(walletReads).toHaveLength(3));
    expect(screen.queryByText('Club A History')).toBeNull();
    await settle(1, [transaction('Late Club A History')]);
    expect(screen.queryByText('Late Club A History')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    await settle(2, [transaction('Club B History')]);
    expect(await screen.findByText('Club B History')).toBeInTheDocument();
    expect(screen.queryByText('Late Club A History')).toBeNull();
  });
});
