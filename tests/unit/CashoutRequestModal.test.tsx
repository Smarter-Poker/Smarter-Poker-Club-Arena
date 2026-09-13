import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
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
const rpc = vi.mocked(supabase.rpc);
beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({
    data: { success: true, replayed: true, cashout_id: 'cent-request' },
    error: null,
  } as never);
  vi.spyOn(cashoutService, 'getPlayerCashouts').mockResolvedValue([]);
  vi.spyOn(cashoutService, 'getCashout').mockResolvedValue(null);
  vi.mocked(checkSettlementLock).mockResolvedValue({ locked: false } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function mount(balance = 1e9) {
  render(
    <CashoutRequestModal
      isOpen
      onClose={() => {}}
      playerId="player"
      clubId="club"
      currentBalance={balance}
    />
  );
  return await screen.findByLabelText('Amount');
}
function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Request Cashout' }));
}
it.each(['0.01', '0.29', '1.25', '308.5', '1000000000'])(
  'mounted modal sends %s through the actual service unchanged',
  async (text) => {
    const input = await mount();
    fireEvent.change(input, { target: { value: text } });
    submit();
    await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    expect(rpc.mock.calls[0]).toEqual([
      'fn_cashout_request',
      expect.objectContaining({ p_amount: Number(text), p_club_id: 'club' }),
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
  submit();
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
  submit();
  await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
  expect(rpc.mock.calls[0][1].p_amount).toBe(1.25);
});
it('a fractional percentage request uses the displayed rounded-down cent value', async () => {
  await mount(1.25);
  fireEvent.click(screen.getByRole('button', { name: '50% · 0.62' }));
  submit();
  await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
  expect(rpc.mock.calls[0][1].p_amount).toBe(0.62);
});
it('same mounted intent retries with the same operation id and amount after unknown delivery', async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { message: 'unknown delivery' } } as never);
  const input = await mount();
  fireEvent.change(input, { target: { value: '0.29' } });
  submit();
  await screen.findByText('unknown delivery');
  const first = rpc.mock.calls[0][1];
  submit();
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
  expect(rpc.mock.calls[1][1]).toEqual(first);
  expect(first.p_amount).toBe(0.29);
  expect(first.p_op_id).toBeTruthy();
});
it('balance and settlement refusal still prevent submission', async () => {
  const input = await mount(1.25);
  fireEvent.change(input, { target: { value: '1.26' } });
  submit();
  await screen.findByText('That Is More Than Your Available Balance');
  expect(rpc).not.toHaveBeenCalled();
  vi.mocked(checkSettlementLock).mockResolvedValue({ locked: true } as never);
  fireEvent.change(input, { target: { value: '1.25' } });
  submit();
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
  const button = screen.getByRole('button', { name: 'Request Cashout' });
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(checkSettlementLock).toHaveBeenCalledOnce();
  await act(async () => release({ locked: false }));
  await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
});
