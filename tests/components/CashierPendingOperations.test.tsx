import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import CashierPendingOperations from '../../src/components/wallet/CashierPendingOperations';
import {
  reserveCashierWalletOperation,
  readCashierWalletOperations,
} from '../../src/services/CashierWalletRecovery';
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: mocks }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/clubIdResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/clubIdResolver')>()),
  resolveClubUUIDStrict: async (id: string) => id,
}));
const user = '11111111-1111-4111-8111-111111111111';
const club = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});
async function reserve() {
  return (await reserveCashierWalletOperation(user, club, 'fn_agent_wallet_send', {
    p_amount: 25,
  }))!;
}
it('resolves only the original owned receipt through a read-only door', async () => {
  const row = await reserve();
  await reserveCashierWalletOperation(other, club, 'fn_agent_wallet_send', { p_amount: 25 });
  mocks.rpc.mockResolvedValue({
    data: { operations: [{ operation_id: row.operationId, receipt: { success: true } }] },
    error: null,
  });
  render(<CashierPendingOperations userId={user} clubId={club} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check Original Receipts' }));
  await screen.findByText(/1 Recorded\. 0 Still Need Verification/);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_cashier_recovery_receipts', {
    p_club_id: club,
    p_operation_ids: [row.operationId],
    p_ticket_keys: [],
  });
  expect(readCashierWalletOperations(user, club)).toHaveLength(0);
  expect(readCashierWalletOperations(other, club)).toHaveLength(1);
});
it('keeps a missing receipt unknown instead of claiming no chips moved', async () => {
  await reserve();
  mocks.rpc.mockResolvedValue({ data: { operations: [] }, error: null });
  render(<CashierPendingOperations userId={user} clubId={club} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check Original Receipts' }));
  await screen.findByText(/0 Recorded\. 1 Still Need Verification/);
  expect(readCashierWalletOperations(user, club)).toHaveLength(1);
});
it('retains identities on receipt read failure and does not dispatch a money request', async () => {
  await reserve();
  mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
  render(<CashierPendingOperations userId={user} clubId={club} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check Original Receipts' }));
  await screen.findByText(/Could Not Verify Receipts/);
  expect(readCashierWalletOperations(user, club)).toHaveLength(1);
  expect(mocks.rpc.mock.calls.map((call) => call[0])).toEqual(['fn_cashier_recovery_receipts']);
});
it('does not let one unreadable entry hide valid unresolved operations', async () => {
  await reserve();
  const key = localStorage.key(0)!;
  localStorage.setItem(key + ':corrupted', '{broken');
  render(<CashierPendingOperations userId={user} clubId={club} />);
  await screen.findByRole('alert');
  await waitFor(() =>
    expect(screen.getByText('1 Wallet Operations Need Verification')).toBeTruthy()
  );
  expect(localStorage.getItem(key + ':corrupted')).toBe('{broken');
});
it('ignores a detached account response instead of displaying it in the new account', async () => {
  const row = await reserve();
  let finish!: (value: unknown) => void;
  mocks.rpc.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const view = render(<CashierPendingOperations userId={user} clubId={club} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check Original Receipts' }));
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledOnce());
  view.rerender(<CashierPendingOperations userId={other} clubId={club} />);
  const { act } = await import('@testing-library/react');
  await act(async () =>
    finish({
      data: { operations: [{ operation_id: row.operationId, receipt: { success: true } }] },
      error: null,
    })
  );
  expect(screen.queryByRole('status')).toBeNull();
});
