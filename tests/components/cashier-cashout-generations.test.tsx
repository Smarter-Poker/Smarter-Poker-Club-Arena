import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  userId: '51000000-0000-4000-8000-000000000001', epoch: 0,
  prepare: vi.fn(), recover: vi.fn(), confirm: vi.fn(), balance: 20000 as number | null,
  refreshBalance: () => {}, pendingRead: vi.fn(), capture: vi.fn(), run: vi.fn(), lock: vi.fn(), load: vi.fn(), history: vi.fn(),
  authListeners: new Set<() => void>(),
}));
const CLUB = '51000000-0000-4000-8000-000000000004';
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: state.userId } }) }));
vi.mock('../../src/services/CashoutService', () => ({ captureCashoutAccountGuard: (actor: string) => {
  const epoch = state.epoch; return () => state.userId === actor && state.epoch === epoch;
} }));
// This mounted page test owns capture/preflight/confirmation wiring. The actual
// generation store and canonical parser are exercised in CashoutOperation.test.
vi.mock('../../src/services/CashoutOperation', () => ({
  prepareCashoutOperation: (intent: any) => state.prepare(intent),
  captureCashoutStart: (prepared: any) => {
    if (!prepared.isCurrent()) throw new Error('Cashout Changed');
    state.capture(prepared); return prepared;
  },
  assertCashoutStartCurrent: (start: any) => { if (!start.isCurrent()) throw new Error('Cashout Changed'); },
  captureCashoutReceiptCheck: (original: any, isCurrent: () => boolean) => ({ ...original, isCurrent }),
  recoverCashoutOperation: async (intent: any) => {
    if (!intent.isCurrent()) throw new Error('Cashout Changed');
    const result = await state.recover(intent);
    if (!intent.isCurrent()) throw new Error('Cashout Changed');
    return result;
  },
  confirmCashoutOperation: async (intent: any) => {
    if (!intent.isCurrent()) throw new Error('Cashout Changed');
    const result = await state.confirm(intent);
    if (!intent.isCurrent()) throw new Error('Cashout Changed');
    return result;
  },
  runCashoutOperation: async (start: any) => {
    if (!start.isCurrent()) throw new Error('Cashout Changed');
    const result = await state.run(start);
    if (!start.isCurrent()) throw new Error('Cashout Changed');
    return result;
  },
}));
vi.mock('../../src/utils/settlementLock', () => ({ checkSettlementLock: (...args: unknown[]) => state.lock(...args) }));
vi.mock('../../src/stores/useWalletStore', () => ({ useWalletStore: () => ({ loadBalances: state.load, mintChips: vi.fn() }) }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }));
vi.mock('../../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: () => {} }));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({ useMasterBusSubscription: () => {},
  useMasterBusSubscriptions: (events: string[], handler: () => void) => {
    if (events.includes('TEST_CHIP_BALANCE')) state.refreshBalance = handler;
  },
}));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: () => {} }));
vi.mock('../../src/hooks/useRealtimeFinancials', () => ({ useRealtimeFinancials: () => {} }));
vi.mock('../../src/hooks/useCashierHistory', () => ({ useCashierHistory: () => ({ transactions: [], loading: false, error: null, load: state.history }) }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/retryFetch', () => ({ retryFetch: (read: () => unknown) => read() }));
vi.mock('../../src/utils/clubQuickLink', () => ({
  CHIP_BALANCE_EVENTS: ['TEST_CHIP_BALANCE'], fetchClubChipBalances: async () => state.balance === null ? null : new Map([['51000000-0000-4000-8000-000000000004', state.balance]]),
  clearClubChipBalanceCache: vi.fn(), resolveTargetClub: vi.fn(), readCachedQuickLinkClubs: vi.fn(), fetchQuickLinkClubs: vi.fn(),
}));
vi.mock('../../src/components/club/CashierClubSwitcher', () => ({ default: () => null }));
vi.mock('../../src/components/agent/AgentPromoPanel', () => ({ default: () => null }));
vi.mock('../../src/components/wallet/DynamicWallet', () => ({ default: () => null }));
vi.mock('../../src/components/wallet/WalletCashierModal', () => ({ default: () => null }));
vi.mock('../../src/components/wallet/PlayerWalletModal', () => ({ default: () => null }));
vi.mock('../../src/components/wallet/CashoutRequestModal', () => ({ default: () => null }));
vi.mock('../../src/components/layouts/StandardContentLayout', () => ({ default: ({ children }: any) => <div>{children}</div> }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: {
  subscribe: (name: string, handler: () => void) => {
    if (name === 'AUTH_STATE_CHANGED') state.authListeners.add(handler);
    return () => { state.authListeners.delete(handler); };
  },
  emit: vi.fn(), registerChannelFactory: vi.fn(), removeChannelFactory: vi.fn(), removeRegisteredChannel: vi.fn(),
  getOrCreateChannel: () => { const channel = { on: () => channel, subscribe: () => channel }; return channel; },
} }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import CashierPage from '../../src/pages/CashierPage';
import { supabase } from '../../src/lib/supabase';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function Navigation() { const navigate = useNavigate(); return <button onClick={() => navigate('/cashier?club=51000000-0000-4000-8000-000000000005')}>Switch Club</button>; }
async function mount(amount: string) {
  render(<MemoryRouter initialEntries={[`/cashier?club=${CLUB}`]}><CashierPage /><Navigation /></MemoryRouter>);
  await screen.findByRole('tab', { name: 'Buy-In', selected: true });
  fireEvent.click(screen.getByRole('tab', { name: 'Cash-Out' }));
  fireEvent.change(screen.getByLabelText('AMOUNT:'), { target: { value: amount } });
  const button = screen.getByRole('button', { name: /REQUEST CASHOUT/i });
  await waitFor(() => expect(button).not.toBeDisabled());
  return button;
}
beforeEach(() => {
  state.epoch += 1; state.prepare.mockReset().mockImplementation(async intent => intent);
  state.balance = 20000; state.recover.mockReset().mockResolvedValue({ found: false });
  state.confirm.mockReset().mockResolvedValue({ found: false });
  state.pendingRead.mockReset().mockResolvedValue({ data: [], error: null });
  state.capture.mockReset(); state.run.mockReset().mockResolvedValue({ status: 'pending' });
  state.lock.mockReset().mockResolvedValue({ locked: false }); state.load.mockReset(); state.history.mockReset();
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'or', 'order', 'limit', 'is', 'in']) query[method] = () => query;
    query.maybeSingle = () => Promise.resolve({ data: table === 'club_members' ? { role: 'member' }
      : table === 'clubs' ? { name: 'Test Club', union_id: null } : null, error: null });
    query.then = (done: (value: unknown) => unknown) => (table === 'cashout_requests'
      ? state.pendingRead() : Promise.resolve({ data: [], error: null })).then(done);
    return query as never;
  });
});
afterEach(cleanup);

it('captures before the first settlement await and refuses same-frame duplicate clicks', async () => {
  const gate = deferred<{ locked: boolean }>(); state.lock.mockReturnValueOnce(gate.promise);
  const button = await mount('250');
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(state.capture).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(state.lock).toHaveBeenCalledTimes(1));
  expect(state.run).not.toHaveBeenCalled();
  await act(async () => gate.resolve({ locked: false }));
  await waitFor(() => expect(state.run).toHaveBeenCalledTimes(1));
  expect(state.run.mock.calls[0][0]).toBe(state.capture.mock.calls[0][0]);
});

it('carries one captured start through high-value confirmation and states the hold has not happened yet', async () => {
  fireEvent.click(await mount('10000'));
  const confirm = await screen.findByRole('button', { name: 'CONFIRM SECURE CASHOUT' });
  expect(state.capture).toHaveBeenCalledTimes(1); expect(state.run).not.toHaveBeenCalled();
  expect(screen.getByText('Chips Will Be Held After You Confirm This Request')).toBeTruthy();
  const original = state.capture.mock.calls[0][0];
  fireEvent.click(confirm);
  await waitFor(() => expect(state.run).toHaveBeenCalledExactlyOnceWith(original));
  expect(state.confirm).toHaveBeenCalledExactlyOnceWith(original);
  expect(state.capture).toHaveBeenCalledTimes(1);
});

it('confirmation recovers the same operation completed elsewhere while the dialog was open and its balance is now low', async () => {
  fireEvent.click(await mount('10000'));
  const confirm = await screen.findByRole('button', { name: 'CONFIRM SECURE CASHOUT' });
  const original = state.capture.mock.calls[0][0];
  const priorLockCalls = state.lock.mock.calls.length;
  state.balance = 0;
  await act(async () => state.refreshBalance());
  state.lock.mockResolvedValue({ locked: true });
  state.confirm.mockResolvedValue({ found: true, result: { status: 'approved' } });
  fireEvent.click(confirm);
  await screen.findByText(/cashout is already approved/i);
  expect(state.confirm).toHaveBeenCalledExactlyOnceWith(original);
  expect(state.capture).toHaveBeenCalledOnce(); expect(state.run).not.toHaveBeenCalled();
  expect(state.lock).toHaveBeenCalledTimes(priorLockCalls);
  expect(screen.queryByText(/Insufficient chips in this club/i)).toBeNull();
});

it.each(['unknown', 'absent'] as const)('confirmation %s never pays through a now-low balance', async outcome => {
  fireEvent.click(await mount('10000'));
  const confirm = await screen.findByRole('button', { name: 'CONFIRM SECURE CASHOUT' });
  state.balance = 0; await act(async () => state.refreshBalance());
  if (outcome === 'unknown') state.confirm.mockRejectedValue(new Error('Receipt Lookup Unavailable'));
  fireEvent.click(confirm);
  await screen.findByText(outcome === 'unknown' ? /Receipt Lookup Unavailable/i : /Insufficient chips in this club/i);
  expect(state.confirm).toHaveBeenCalledOnce(); expect(state.run).not.toHaveBeenCalled();
});

it('hides already visible pending rows on a same-ID account epoch change until a fresh read returns', async () => {
  state.pendingRead.mockResolvedValue({ data: [{ id: 'old', amount: 876, status: 'pending', created_at: '2026-09-15T00:00:00Z' }], error: null });
  const view = render(<MemoryRouter initialEntries={[`/cashier?club=${CLUB}`]}><CashierPage /></MemoryRouter>);
  await screen.findByRole('tab', { name: 'Buy-In', selected: true });
  fireEvent.click(screen.getByRole('tab', { name: 'Cash-Out' }));
  await screen.findByText('876 Chips');
  const nextRead = deferred<any>(); state.pendingRead.mockReturnValue(nextRead.promise);
  state.epoch += 2;
  view.rerender(<MemoryRouter initialEntries={[`/cashier?club=${CLUB}`]}><CashierPage /></MemoryRouter>);
  expect(screen.queryByText('876 Chips')).toBeNull();
  await act(async () => nextRead.resolve({ data: [], error: null }));
  expect(screen.queryByText('876 Chips')).toBeNull();
  expect(state.run).not.toHaveBeenCalled();
});

it('auth notification remounts the Cashier during an old pending action and its completion cannot unlock a fresh action', async () => {
  const oldResponse = deferred<{ status: string }>(); const newResponse = deferred<{ status: string }>();
  state.run.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
  fireEvent.click(await mount('250'));
  await waitFor(() => expect(state.run).toHaveBeenCalledOnce());
  const oldIntent = state.run.mock.calls[0][0];
  const priorReads = state.pendingRead.mock.calls.length;
  // This wiring fixture controls the service account epoch. The real bus and
  // service generation are exercised by the three other mounted surfaces.
  act(() => { state.epoch += 2; for (const handler of state.authListeners) handler(); });
  await screen.findByRole('tab', { name: 'Buy-In', selected: true });
  await waitFor(() => expect(state.pendingRead.mock.calls.length).toBeGreaterThan(priorReads));
  expect(oldIntent.isCurrent()).toBe(false);
  fireEvent.click(screen.getByRole('tab', { name: 'Cash-Out' }));
  fireEvent.change(screen.getByLabelText('AMOUNT:'), { target: { value: '250' } });
  const freshButton = screen.getByRole('button', { name: /REQUEST CASHOUT/i });
  await waitFor(() => expect(freshButton).not.toBeDisabled()); fireEvent.click(freshButton);
  await waitFor(() => expect(state.run).toHaveBeenCalledTimes(2));
  expect(state.run.mock.calls[1][0]).not.toBe(oldIntent);
  await act(async () => oldResponse.resolve({ status: 'pending' }));
  expect(freshButton).toBeDisabled();
  expect(screen.queryByText(/chips are held for review/i)).toBeNull();
  fireEvent.click(freshButton); expect(state.run).toHaveBeenCalledTimes(2);
  await act(async () => newResponse.resolve({ status: 'pending' }));
  await screen.findByText(/chips are held for review/i);
});

it('a scope change during settlement cannot dispatch or show old success', async () => {
  const gate = deferred<{ locked: boolean }>(); state.lock.mockReturnValueOnce(gate.promise);
  fireEvent.click(await mount('250'));
  expect(state.capture).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(state.lock).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'Switch Club' }));
  await act(async () => gate.resolve({ locked: false }));
  expect(state.run).not.toHaveBeenCalled();
  expect(screen.queryByText(/chips are held for review/i)).toBeNull();
});


it.each([0, null])('shows a recovered original hold with displayed balance %s without new-payment gates', async balance => {
  state.balance = balance;
  state.lock.mockResolvedValue({ locked: true });
  state.recover.mockResolvedValue({ found: true, result: { status: 'approved' } });
  fireEvent.click(await mount('250'));
  await screen.findByText(/cashout is already approved/i);
  expect(state.lock).not.toHaveBeenCalled(); expect(state.run).not.toHaveBeenCalled();
});

it('exact absence retains the insufficient-balance gate', async () => {
  state.balance = 0;
  fireEvent.click(await mount('250'));
  await screen.findByText(/Insufficient chips in this club/i);
  expect(state.recover).toHaveBeenCalledOnce(); expect(state.run).not.toHaveBeenCalled();
});

it('unknown recovery and a changed account during lookup cannot reach payment checks', async () => {
  const gate = deferred<{ found: false }>(); state.recover.mockReturnValueOnce(gate.promise);
  fireEvent.click(await mount('250'));
  await waitFor(() => expect(state.recover).toHaveBeenCalledOnce());
  state.epoch += 2;
  await act(async () => gate.resolve({ found: false }));
  expect(state.lock).not.toHaveBeenCalled(); expect(state.run).not.toHaveBeenCalled();
});
