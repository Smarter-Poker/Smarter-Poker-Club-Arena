import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ userId: 'cashier-a', read: vi.fn(), prepare: vi.fn(), approve: vi.fn(), reject: vi.fn(), lock: vi.fn(), listeners: [] as Array<() => void> }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: state.userId } }) }));
vi.mock('../../src/services/CashoutService', () => ({ captureCashoutAccountGuard: () => () => true, cashoutService: {
  getAgentPendingCashouts: (...args: unknown[]) => state.read(...args),
  approveCashout: (...args: unknown[]) => state.approve(...args),
  rejectCashout: (...args: unknown[]) => state.reject(...args),
} }));
// This mounted scope unit uses the actual preparation hook; separate wrapper
// tests own UUID storage and strict canonical service receipts.
vi.mock('../../src/services/CashoutOperation', () => ({
  prepareCashoutOperation: (intent: any) => state.prepare(intent),
  captureCashoutStart: (intent: any) => {
    if (!intent.isCurrent()) throw new Error('Cashout Changed');
    return intent;
  },
  assertCashoutStartCurrent: (intent: any) => {
    if (!intent.isCurrent()) throw new Error('Cashout Changed');
  },
  captureCashoutReceiptCheck: (original: any, isCurrent: () => boolean) => ({ ...original, isCurrent }),
  recoverCashoutOperation: async (intent: any) => {
    if (!intent.isCurrent()) throw new Error('Cashout Changed');
    return { found: false };
  },
  runCashoutOperation: async (intent: any) => {
    if (!intent.isCurrent()) throw new Error('Cashout Changed');
    const context = { clubId: intent.clubId, amount: intent.amount, playerId: intent.playerId, isCurrent: intent.isCurrent };
    const result = intent.kind === 'cashout_approve'
      ? await state.approve(intent.targetId, intent.userId, intent.note, 'saved-operation', context)
      : await state.reject(intent.targetId, intent.userId, intent.note, 'saved-operation', context);
    if (!intent.isCurrent()) throw new Error('Cashout Changed');
    return result;
  },
}));
vi.mock('../../src/utils/settlementLock', () => ({ checkSettlementLock: (...args: unknown[]) => state.lock(...args) }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/avatarGenerator', () => ({ generateDefaultAvatar: () => '' }));
vi.mock('../../src/lib/date', () => ({ formatRelativeShort: () => 'Recently' }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: {
  subscribe: () => () => {},
  subscribeDebounced: (_event: string, callback: () => void) => { state.listeners.push(callback); return () => {}; },
  removeRegisteredChannel: vi.fn(),
  getOrCreateChannel: () => { const c = { on: () => c, subscribe: vi.fn() }; return c; },
} }));
import AgentCashoutPanel from '../../src/components/agent/AgentCashoutPanel';
const row = (id = 'request-a', clubId = 'club-a') => ({ id, playerId: 'player-a', agentId: 'cashier-a', clubId,
  amount: 12.34, status: 'pending' as const, playerName: id, createdAt: '2026-09-15T00:00:00Z' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  state.userId = 'cashier-a'; state.listeners.length = 0;
  state.read.mockReset().mockResolvedValue([row()]);
  state.prepare.mockReset().mockImplementation(async intent => intent);
  state.approve.mockReset().mockResolvedValue(true); state.reject.mockReset().mockResolvedValue(true);
  state.lock.mockReset().mockResolvedValue({ locked: false });
});
afterEach(cleanup);
async function readyApprove() {
  const button = await screen.findByRole('button', { name: 'Approve Cashout' });
  await waitFor(() => expect(button).not.toBeDisabled());
  return button;
}

it('binds the actual camelCase request tuple and refuses a same-frame duplicate action', async () => {
  const response = deferred<boolean>(); state.approve.mockReturnValue(response.promise);
  const done = vi.fn(); render(<AgentCashoutPanel clubId="club-a" onCashoutProcessed={done} />);
  const button = await readyApprove();
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  await waitFor(() => expect(state.approve).toHaveBeenCalledTimes(1));
  expect(state.approve).toHaveBeenCalledWith('request-a', 'cashier-a', undefined, 'saved-operation', {
    clubId: 'club-a', amount: 12.34, playerId: 'player-a', isCurrent: expect.any(Function),
  });
  await act(async () => { response.resolve(true); await response.promise; });
  expect(done).toHaveBeenCalledTimes(1);
});

it('retire old rows and callbacks immediately when a reused panel changes club', async () => {
  const response = deferred<boolean>(); state.approve.mockReturnValue(response.promise);
  const nextRows = deferred<ReturnType<typeof row>[]>();
  const done = vi.fn(); const view = render(<AgentCashoutPanel clubId="club-a" onCashoutProcessed={done} />);
  fireEvent.click(await readyApprove());
  await waitFor(() => expect(state.approve).toHaveBeenCalledOnce());
  const oldScope = state.approve.mock.calls[0][4].isCurrent;
  state.read.mockReturnValue(nextRows.promise);
  view.rerender(<AgentCashoutPanel clubId="club-b" onCashoutProcessed={done} />);
  expect(screen.queryByText('request-a')).toBeNull();
  expect(oldScope()).toBe(false);
  await act(async () => { response.resolve(true); await response.promise; });
  expect(done).not.toHaveBeenCalled();
  await act(async () => { nextRows.resolve([row('request-b', 'club-b')]); await nextRows.promise; });
  expect(await readyApprove()).not.toBeDisabled();
});

it('does not dispatch after an account change while the settlement check is pending', async () => {
  const gate = deferred<{ locked: boolean }>(); state.lock.mockReturnValue(gate.promise);
  const view = render(<AgentCashoutPanel clubId="club-a" />);
  fireEvent.click(await readyApprove());
  state.userId = 'cashier-b'; state.read.mockResolvedValue([]);
  view.rerender(<AgentCashoutPanel clubId="club-a" />);
  await act(async () => { gate.resolve({ locked: false }); await gate.promise; });
  expect(state.approve).not.toHaveBeenCalled();
});

it('keeps the newer pending read when an earlier same-club response arrives last', async () => {
  const first = deferred<ReturnType<typeof row>[]>();
  state.read.mockReturnValueOnce(first.promise).mockResolvedValue([row('newer-request')]);
  render(<AgentCashoutPanel clubId="club-a" />);
  await waitFor(() => expect(state.listeners.length).toBeGreaterThan(0));
  act(() => state.listeners[0]());
  await screen.findByText('newer-request');
  await act(async () => { first.resolve([row('older-request')]); await first.promise; });
  expect(screen.queryByText('older-request')).toBeNull();
  expect(screen.getByText('newer-request')).toBeTruthy();
});

it('a refresh started before acceptance retires the prior prepared row immediately', async () => {
  const nextRead = deferred<ReturnType<typeof row>[]>();
  render(<AgentCashoutPanel clubId="club-a" />);
  const oldButton = await readyApprove();
  const oldIntent = state.prepare.mock.calls[0][0];
  state.read.mockReturnValueOnce(nextRead.promise);
  act(() => state.listeners[0]());
  expect(oldIntent.isCurrent()).toBe(false);
  fireEvent.click(oldButton);
  expect(state.lock).not.toHaveBeenCalled();
  expect(state.approve).not.toHaveBeenCalled();
  await act(async () => nextRead.resolve([row()]));
  expect(await readyApprove()).not.toBeDisabled();
  expect(oldIntent.isCurrent()).toBe(false);
});

it('defers ordinary refreshes during the accepted action and drains one after its receipt', async () => {
  const gate = deferred<{ locked: boolean }>();
  state.lock.mockReturnValueOnce(gate.promise);
  const done = vi.fn();
  render(<AgentCashoutPanel clubId="club-a" onCashoutProcessed={done} />);
  fireEvent.click(await readyApprove());
  await waitFor(() => expect(state.lock).toHaveBeenCalledOnce());
  const oldIntent = state.prepare.mock.calls[0][0];
  act(() => { state.listeners[0](); state.listeners[0](); });
  expect(oldIntent.isCurrent()).toBe(true);
  expect(state.read).toHaveBeenCalledOnce();
  await act(async () => gate.resolve({ locked: false }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(state.approve).toHaveBeenCalledOnce();
  expect(state.read).toHaveBeenCalledTimes(2);
});
