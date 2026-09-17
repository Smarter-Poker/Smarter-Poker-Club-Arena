import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { CASHOUT_IDS as ID, cashoutV2Receipt, cashoutLookupEnvelope } from '../helpers/cashoutV2Receipt';
const identity = vi.hoisted(() => ({ userId: '', auth: new Set<(event: { payload: { userId: string; isAuthenticated: boolean } }) => void>() }));
vi.mock('../../src/core/IdentityDNA', () => ({ getIdentityDNAStatus: () => ({ loaded: !!identity.userId, authenticated: !!identity.userId, userId: identity.userId }) }));
// Exercises the mounted form, real prepared wrapper and strict receipt service.
// The lock shim remains a unit boundary; native browser storage is separate.
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn((name, handler) => {
      if (name === 'AUTH_STATE_CHANGED') identity.auth.add(handler);
      return () => { identity.auth.delete(handler); };
    }),
    getOrCreateChannel: () => ({
      on() {
        return this;
      },
      subscribe: vi.fn(),
    }),
    subscribeDebounced: () => () => {},
    removeRegisteredChannel: vi.fn(),
  },
}));
vi.mock('../../src/utils/retryAsync', () => ({ retryAsync: (fn: any) => fn() }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/strictClubIdResolver', () => ({ resolveClubUUIDStrict: vi.fn(async (id: string) => id) }));
vi.mock('../../src/services/PushNotificationService', () => ({
  pushNotificationService: { sendToUser: vi.fn() },
}));
vi.mock('../../src/utils/settlementLock', () => ({
  checkSettlementLock: vi.fn(async () => ({ locked: false })),
}));
vi.mock('../../src/lib/date', () => ({ formatRelativeShort: () => '' }));
vi.mock('../../src/utils/vibrationGate', () => ({ fireVibration: vi.fn() }));
vi.mock('../../src/utils/safeErrorMessage', () => ({
  safeErrorMessage: (error: Error) => error.message,
}));
import CashoutRequestModal from '../../src/components/wallet/CashoutRequestModal';
import { cashoutService } from '../../src/services/CashoutService';
import { supabase } from '../../src/lib/supabase';
import { checkSettlementLock } from '../../src/utils/settlementLock';
import { resolveClubUUIDStrict } from '../../src/utils/strictClubIdResolver';
const rpc = vi.fn(); // Financial transition transport only; lookup is separately asserted.
const lookup = vi.fn();
const transport = vi.mocked(supabase.rpc);
const complete = vi.fn();
function withOperation(args: any, response: any) {
  return { ...response, data: response.data ? { ...response.data, op_id: args.p_op_id } : response.data };
}
beforeEach(() => {
  vi.clearAllMocks();
  identity.userId = '';
  for (const handler of identity.auth) handler({ payload: { userId: '', isAuthenticated: false } });
  identity.userId = ID.player;
  for (const handler of identity.auth) handler({ payload: { userId: ID.player, isAuthenticated: true } });
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  vi.mocked(resolveClubUUIDStrict).mockReset().mockImplementation(async id => id);
  const locks = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: (key: string, _options: unknown, callback: () => unknown) => {
      const pending = (locks.get(key) ?? Promise.resolve()).then(callback);
      locks.set(key, pending.catch(() => undefined));
      return pending;
    },
  } });
  lookup.mockReset().mockImplementation(async (_name, args) => ({ data: cashoutLookupEnvelope(args), error: null }));
  transport.mockReset().mockImplementation((name, args) =>
    (name === 'fn_cashout_operation_receipt_v2' ? lookup(name, args) : rpc(name, args)) as never);
  rpc.mockReset().mockImplementation(async (name, args) => ({
    data: { ...cashoutV2Receipt(name === 'fn_cashout_release_v2' ? 'cancellation' : 'hold', { amount: Number(args?.p_amount), note: args?.p_note as string | undefined }), op_id: args?.p_op_id },
    error: null,
  }) as never);
  vi.spyOn(cashoutService, 'getPlayerCashouts').mockResolvedValue([]);
  vi.spyOn(cashoutService, 'getCashout').mockResolvedValue(null);
  vi.mocked(checkSettlementLock).mockResolvedValue({ locked: false } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(balance: number | null = 1e9) {
  render(
    <CashoutRequestModal
      isOpen
      onClose={() => {}}
      playerId={ID.player}
      clubId={ID.club}
      currentBalance={balance}
      onComplete={complete}
    />
  );
  return await screen.findByLabelText('Amount');
}
async function submit(ready = true) {
  const button = screen.getByRole('button', { name: 'Check Or Request Cashout' });
  if (ready) await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}
it.each(['0.01', '0.29', '1.25', '308.5', '1000000000'])(
  'mounted modal sends %s through the actual service unchanged',
  async (text) => {
    const input = await mount();
    fireEvent.change(input, { target: { value: text } });
    await submit();
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(rpc.mock.calls[0]).toEqual([
      'fn_cashout_request_v2',
      expect.objectContaining({ p_amount: Number(text).toFixed(2), p_club_id: ID.club, p_expected_actor_id: ID.player, p_op_id: expect.any(String) }),
    ]);
  }
);
it.each([
  '1.001',
  '1.00000000000000001',
  '0.30000000000000004',
  '0.290000000000000001',
  '1000000000.01',
  '9007199254740992',
  '0',
  '-1',
])('mounted modal refuses original invalid spelling %s', async (text) => {
  const input = await mount();
  fireEvent.change(input, { target: { value: text } });
  expect((input as HTMLInputElement).value).toBe(text);
  await submit(false);
  await screen.findByText(/Whole Cents|Greater Than Zero|Single Request Limit/);
  expect(rpc).not.toHaveBeenCalled();
  expect(checkSettlementLock).not.toHaveBeenCalled();
});
it('Max and percentage selection retain cents and display the resulting request', async () => {
  const input = await mount(1.25);
  expect(input.getAttribute('min')).toBe('0.01');
  expect(input.getAttribute('step')).toBe('0.01');
  expect(input.getAttribute('inputmode')).toBe('decimal');
  fireEvent.click(screen.getByRole('button', { name: '25% · 0.31' }));
  expect((input as HTMLInputElement).value).toBe('0.31');
  fireEvent.click(screen.getByRole('button', { name: 'Max · 1.25' }));
  expect((input as HTMLInputElement).value).toBe('1.25');
  await submit();
  await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
  expect(rpc.mock.calls[0][1].p_amount).toBe('1.25');
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
});
it('a fractional percentage request uses the displayed rounded-down cent value', async () => {
  await mount(1.25);
  fireEvent.click(screen.getByRole('button', { name: '50% · 0.62' }));
  await submit();
  await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
  expect(rpc.mock.calls[0][1].p_amount).toBe('0.62');
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
});
it('same mounted intent retries with the same operation id and amount after unknown delivery', async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { message: 'unknown delivery' } } as never);
  const input = await mount();
  fireEvent.change(input, { target: { value: '0.29' } });
  await submit();
  await screen.findByText(/Cashout Could Not Be Confirmed/);
  expect(complete).not.toHaveBeenCalled();
  const first = rpc.mock.calls[0][1];
  await submit();
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
  expect(rpc.mock.calls[1][1]).toEqual(first);
  expect(first.p_amount).toBe('0.29');
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  expect(first.p_op_id).toBeTruthy();
});
it('balance and settlement refusal still prevent submission', async () => {
  const input = await mount(1.25);
  fireEvent.change(input, { target: { value: '1.26' } });
  await submit();
  await screen.findByText('That Is More Than Your Available Balance');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check Or Request Cashout' })).not.toBeDisabled());
  expect(lookup).toHaveBeenCalledOnce();
  expect(rpc).not.toHaveBeenCalled();
  vi.mocked(checkSettlementLock).mockResolvedValue({ locked: true } as never);
  fireEvent.change(input, { target: { value: '1.25' } });
  await submit();
  await screen.findByText('Settlement In Progress. Cashout Requests Are Frozen');
  expect(rpc).not.toHaveBeenCalled();
});
it('two clicks while settlement admission is pending retain the synchronous submit lock', async () => {
  let release!: (value: any) => void;
  vi.mocked(checkSettlementLock).mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }) as never
  );
  const input = await mount();
  fireEvent.change(input, { target: { value: '1.25' } });
  const button = screen.getByRole('button', { name: 'Check Or Request Cashout' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  await waitFor(() => expect(checkSettlementLock).toHaveBeenCalledOnce());
  await act(async () => release({ locked: false }));
  await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
});

it('does not turn a bare success into a completed callback or a held claim', async () => {
  rpc.mockResolvedValueOnce({ data: { success: true, cashout_id: ID.cashout }, error: null } as never);
  const input = await mount(); fireEvent.change(input, { target: { value: '1.25' } }); await submit();
  await screen.findByText(/Cashout Receipt Was Not Confirmed/);
  expect(complete).not.toHaveBeenCalled();
  expect(screen.queryByText(/Chips Are Held For Review/)).toBeNull();
});
it('renders the actual terminal request on a historical hold replay', async () => {
  rpc.mockImplementationOnce(async (_name, args) => withOperation(args, { data: cashoutV2Receipt('hold', { amount: 1.25, replayed: true, currentStatus: 'approved' }), error: null }) as never);
  const input = await mount(); fireEvent.change(input, { target: { value: '1.25' } }); await submit();
  await screen.findByText('This Cashout Is Already approved. Check Its Invoice For Details.');
  expect(complete).toHaveBeenCalledOnce();
  expect(screen.queryByText(/Chips Are Held For Review/)).toBeNull();
});
it('cancels an exact pending tuple through the real v2 service and receipt', async () => {
  vi.mocked(cashoutService.getPlayerCashouts).mockResolvedValue([{
    id: ID.cashout, clubId: ID.club, playerId: ID.player, agentId: ID.agent,
    amount: 250, status: 'pending', createdAt: '2026-09-15T09:00:00+00:00', updatedAt: '2026-09-15T09:00:00+00:00',
  }]);
  await mount();
  const cancel = await screen.findByRole('button', { name: 'Cancel' });
  await waitFor(() => expect((cancel as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(cancel);
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  expect(rpc).toHaveBeenCalledExactlyOnceWith('fn_cashout_release_v2', {
    p_cashout_id: ID.cashout, p_club_id: ID.club, p_amount: '250.00',
    p_expected_actor_id: ID.player, p_op_id: expect.any(String), p_note: null,
  });
});
it('never completes an old account request after an account change during dispatch', async () => {
  let resolve!: (response: any) => void;
  rpc.mockImplementationOnce((_name, args) => new Promise(yes => { resolve = response => yes(withOperation(args, response)); }) as never);
  const input = await mount(); fireEvent.change(input, { target: { value: '1.25' } }); await submit();
  await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
  identity.userId = ID.other;
  await act(async () => resolve({ data: cashoutV2Receipt('hold', { amount: 1.25 }), error: null }));
  expect(complete).not.toHaveBeenCalled();
  expect(screen.queryByText(/Chips Are Held For Review/)).toBeNull();
});

it('checks an unavailable balance intent but refuses new payment after exact absence', async () => {
  const input = await mount(null);
  expect(await screen.findByText('Unavailable')).toBeTruthy();
  fireEvent.change(input, { target: { value: '1.25' } }); await submit();
  await screen.findByText('Your Club Balance Is Unavailable. Refresh Before Requesting A Cashout.');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check Or Request Cashout' })).not.toBeDisabled());
  expect(lookup).toHaveBeenCalledOnce();
  expect(checkSettlementLock).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});

it('close and reopen removes old rows and fences an old completion from a new in-flight request', async () => {
  let finishOld!: (response: any) => void;
  let finishNew!: (response: any) => void;
  rpc.mockImplementationOnce((_name, args) => new Promise(resolve => { finishOld = response => resolve(withOperation(args, response)); }) as never);
  rpc.mockImplementationOnce((_name, args) => new Promise(resolve => { finishNew = response => resolve(withOperation(args, response)); }) as never);
  const existing = { id: ID.cashout, clubId: ID.club, playerId: ID.player, agentId: ID.agent,
    amount: 250, status: 'pending' as const, createdAt: '2026-09-15T09:00:00+00:00' };
  vi.mocked(cashoutService.getPlayerCashouts).mockResolvedValueOnce([existing]).mockResolvedValue([]);
  const props = { onClose: vi.fn(), playerId: ID.player, clubId: ID.club, currentBalance: 500, onComplete: complete };
  const view = render(<CashoutRequestModal {...props} isOpen />);
  await screen.findByRole('button', { name: 'Cancel' });
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1.25' } }); await submit();
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
  view.rerender(<CashoutRequestModal {...props} isOpen={false} />);
  expect(screen.queryByText('250 Chips')).toBeNull();
  view.rerender(<CashoutRequestModal {...props} isOpen />);
  expect(screen.queryByText('250 Chips')).toBeNull();
  fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '1.25' } }); await submit();
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
  await act(async () => finishOld({ data: cashoutV2Receipt('hold', { amount: 1.25 }), error: null }));
  expect(complete).not.toHaveBeenCalled();
  expect(screen.queryByText(/Chips Are Held For Review/)).toBeNull();
  const stillBusy = screen.getByRole('button', { name: 'Checking...' });
  expect((stillBusy as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(stillBusy); expect(rpc).toHaveBeenCalledTimes(2);
  await act(async () => finishNew({ data: cashoutV2Receipt('hold', { amount: 1.25, replayed: true }), error: null }));
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  expect(await screen.findByText(/Chips Are Held For Review/)).toBeTruthy();
});

it('an account A to B to A change during settlement admission refuses the old action without an intermediate render', async () => {
  let finishAdmission!: (value: any) => void;
  vi.mocked(checkSettlementLock).mockImplementationOnce(() => new Promise(resolve => { finishAdmission = resolve; }) as never);
  const input = await mount(); fireEvent.change(input, { target: { value: '1.25' } }); await submit();
  await waitFor(() => expect(checkSettlementLock).toHaveBeenCalledOnce()); expect(rpc).not.toHaveBeenCalled();
  act(() => {
    identity.userId = ID.other;
    for (const handler of identity.auth) handler({ payload: { userId: ID.other, isAuthenticated: true } });
    identity.userId = ID.player;
    for (const handler of identity.auth) handler({ payload: { userId: ID.player, isAuthenticated: true } });
  });
  await act(async () => finishAdmission({ locked: false }));
  expect(rpc).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  expect(screen.queryByText(/Chips Are Held For Review/)).toBeNull();
});

it('keeps the action unavailable until its exact preparation resolves and discards a late old input', async () => {
  let finishOld!: (club: string) => void;
  let finishNew!: (club: string) => void;
  vi.mocked(resolveClubUUIDStrict)
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
  const input = await mount();
  fireEvent.change(input, { target: { value: '1.25' } });
  await waitFor(() => expect(resolveClubUUIDStrict).toHaveBeenCalledTimes(1));
  const button = screen.getByRole('button', { name: 'Check Or Request Cashout' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button); expect(checkSettlementLock).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '2.50' } });
  await waitFor(() => expect(resolveClubUUIDStrict).toHaveBeenCalledTimes(2));
  await act(async () => finishOld(ID.club));
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(rpc).not.toHaveBeenCalled();
  await act(async () => finishNew(ID.club));
  await submit();
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  expect(rpc.mock.calls[0][1].p_amount).toBe('2.50');
});

it('an input A to B to A change cannot revive a captured settlement wait', async () => {
  let finishAdmission!: (result: any) => void;
  vi.mocked(checkSettlementLock).mockImplementationOnce(() => new Promise(resolve => { finishAdmission = resolve; }) as never);
  const input = await mount();
  fireEvent.change(input, { target: { value: '1.25' } });
  await submit();
  await waitFor(() => expect(checkSettlementLock).toHaveBeenCalledOnce());
  act(() => {
    // Programmatic event injection also tests the guard below disabled inputs.
    fireEvent.change(input, { target: { value: '2.50' } });
    fireEvent.change(input, { target: { value: '1.25' } });
  });
  await act(async () => finishAdmission({ locked: false }));
  expect(rpc).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  expect(screen.queryByText(/Chips Are Held For Review/)).toBeNull();
});

it.each([0, null])('recovers a lost successful hold with balance %s and a changed settlement lock', async balance => {
  rpc.mockRejectedValueOnce(new Error('Lost After Commit'));
  const props = { onClose: vi.fn(), playerId: ID.player, clubId: ID.club, onComplete: complete };
  const view = render(<CashoutRequestModal {...props} isOpen currentBalance={500} />);
  fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '250' } });
  await submit(); await screen.findByText(/Response Was Lost/);
  const original = rpc.mock.calls[0][1].p_op_id;
  vi.mocked(checkSettlementLock).mockClear().mockResolvedValue({ locked: true } as never);
  lookup.mockImplementationOnce(async (_name, args) => ({ data: cashoutLookupEnvelope(args,
    { ...cashoutV2Receipt('hold', { replayed: true }), op_id: original }), error: null }));
  view.rerender(<CashoutRequestModal {...props} isOpen currentBalance={balance} />);
  await submit();
  await screen.findByText(/Cashout Requested. Chips Are Held For Review/);
  expect(complete).toHaveBeenCalledOnce();
  expect(checkSettlementLock).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledOnce();
  expect(lookup.mock.calls[1][1].p_op_id).toBe(original);
});

it('an unknown lookup cannot reach settlement preflight or payment from the mounted modal', async () => {
  lookup.mockResolvedValueOnce({ data: null, error: { message: 'Unavailable' } });
  const input = await mount(); fireEvent.change(input, { target: { value: '250' } });
  await submit(); await screen.findByText(/Previous Cashout Outcome Could Not Be Verified/);
  expect(checkSettlementLock).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});
