import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import DiamondWalletTransfer from '../../src/components/wallet/DiamondWalletTransfer';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: mocks }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
const sender = '10000000-0000-0000-0000-000000000001';
const recipient = '10000000-0000-0000-0000-000000000002';
beforeEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.from.mockImplementation((table: string) => {
    const q: any = {
      select: () => q,
      eq: () => q,
      or: () => q,
      maybeSingle: async () => ({
        data: { id: recipient, username: 'VerifiedFriend' },
        error: null,
      }),
      limit: async () => ({ data: table === 'friendships' ? [{ id: 'friend' }] : [], error: null }),
    };
    return q;
  });
});
async function review() {
  fireEvent.click(screen.getByRole('button', { name: 'Send Diamonds' }));
  fireEvent.change(screen.getByLabelText('Friend Player ID'), { target: { value: recipient } });
  fireEvent.change(screen.getByLabelText('Diamond Amount'), { target: { value: '25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review Transfer' }));
  await screen.findByRole('button', { name: 'Confirm Transfer' });
}
it('verifies identity and requires confirmation before invoking the one writer', async () => {
  const done = vi.fn();
  mocks.rpc.mockImplementation(async (_name: string, p: any) => ({
    data: {
      success: true,
      sender_id: sender,
      recipient_id: p.p_recipient_id,
      request_id: p.p_reference_id,
      amount: p.p_amount,
    },
    error: null,
  }));
  render(<DiamondWalletTransfer userId={sender} onComplete={done} />);
  await review();
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(screen.getByText('VerifiedFriend')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Transfer' }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(mocks.rpc).toHaveBeenCalledWith(
    'send_wallet_diamond_transfer',
    expect.objectContaining({ p_amount: 25, p_recipient_id: recipient })
  );
});
it('retains one request across a lost response and remount', async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: 'Connection Lost' } });
  const view = render(<DiamondWalletTransfer userId={sender} onComplete={() => {}} />);
  await review();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Transfer' }));
  await screen.findByRole('button', { name: 'Retry This Transfer' });
  const first = mocks.rpc.mock.calls[0][1];
  view.unmount();
  render(<DiamondWalletTransfer userId={sender} onComplete={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry This Transfer' }));
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
  expect(mocks.rpc.mock.calls[1][1]).toEqual(first);
});
it('does not present a mismatched receipt as success', async () => {
  const done = vi.fn();
  mocks.rpc.mockResolvedValue({
    data: {
      success: true,
      sender_id: sender,
      recipient_id: recipient,
      request_id: 'wrong',
      amount: 25,
    },
    error: null,
  });
  render(<DiamondWalletTransfer userId={sender} onComplete={done} />);
  await review();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Transfer' }));
  await screen.findByText(/Transfer Not Yet Confirmed/);
  expect(done).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('diamond-transfer:' + sender)).toBeTruthy();
});
it('allows editing after a definitive database refusal', async () => {
  mocks.rpc.mockResolvedValue({
    data: null,
    error: { code: '42501', message: 'accepted_friend_required' },
  });
  render(<DiamondWalletTransfer userId={sender} onComplete={() => {}} />);
  await review();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Transfer' }));
  await screen.findByRole('button', { name: 'Review Transfer' });
  expect(sessionStorage.getItem('diamond-transfer:' + sender)).toBeNull();
});
