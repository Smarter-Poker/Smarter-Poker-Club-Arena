/**
 * Union wallets must open and be able to send funds to any union member.
 *
 * Dan 2026-08-22: "WHEN OWNER, CO OWNER OR ADMIN CLICKS ON ANY OF THE WALLETS
 * IT SHOULD OPEN UP, AND THEY BE ABLE TO SEND CHIPS, DIAMONDS OR PROMO FUNDS
 * TO ANY MEMBER OF THE UNION." The tiles used to be static divs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const rpc = vi.fn();
// The modal also loads a recent-sends feed via supabase.from(...); a thenable
// chain stub keeps that path alive without a real client.
const fromChain = () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'contains']) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (v: { data: unknown[] }) => void) => resolve({ data: [] });
  return chain;
};
vi.mock('../src/lib/supabase', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: () => fromChain() },
}));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import UnionWalletModal from '../src/components/union/UnionWalletModal';

const roster = [
  {
    user_id: 'u-1',
    username: 'danny',
    display_name: 'Danny',
    avatar_url: null,
    club_id: 'c-1',
    club_name: 'JAQK',
    member_role: 'owner',
    member_status: 'active',
  },
  {
    user_id: 'u-2',
    username: 'fish',
    display_name: 'Fish',
    avatar_url: null,
    club_id: 'c-2',
    club_name: 'SHARK',
    member_role: 'member',
    member_status: 'active',
  },
];

const base = {
  isOpen: true,
  onClose: vi.fn(),
  unionId: 'un-1',
  walletKey: 'rake' as const,
  walletLabel: 'Weekly Rake Wallet',
  balance: 5000,
};

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation((fn: string) => {
    if (fn === 'fn_union_player_directory') return Promise.resolve({ data: roster, error: null });
    if (fn === 'fn_union_send_to_member')
      return Promise.resolve({ data: { success: true }, error: null });
    return Promise.resolve({ data: null, error: null });
  });
});

describe('UnionWalletModal', () => {
  it('loads the union-wide roster with roles when opened', async () => {
    render(<UnionWalletModal {...base} />);
    await waitFor(() => expect(screen.getByText('Danny')).toBeTruthy());
    expect(rpc).toHaveBeenCalledWith('fn_union_player_directory', { p_union_id: 'un-1' });
    expect(screen.getByText('OWNER')).toBeTruthy();
    expect(screen.getByText('MEMBER')).toBeTruthy();
    expect(screen.getByText('SHARK')).toBeTruthy();
  });

  it('sends chips from the wallet that was clicked', async () => {
    render(<UnionWalletModal {...base} />);
    await waitFor(() => expect(screen.getByText('Fish')).toBeTruthy());

    fireEvent.click(screen.getByText('Fish'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /send to fish/i }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'fn_union_send_to_member',
        expect.objectContaining({
          p_union_id: 'un-1',
          p_target_user_id: 'u-2',
          p_kind: 'chips',
          p_amount: 250,
          p_source_wallet: 'rake', // the wallet the manager opened
        })
      )
    );
    /* FLAKE, fixed 2026-08-26. This was a SYNCHRONOUS `getByRole('status')`
       immediately after the waitFor above — but that waitFor settles the moment
       the RPC has been CALLED, while the banner only renders once the promise
       resolves and the state update flushes. Locally the microtask always won
       that race; under CI load it lost, and the run that caught it took a
       green PR to red with `Unable to find an accessible element with the role
       "status"`. Await the element itself rather than the call that precedes
       it. */
    expect((await screen.findByRole('status')).textContent).toMatch(/sent 250/i);
  });

  it('sends diamonds without a source wallet', async () => {
    render(<UnionWalletModal {...base} />);
    await waitFor(() => expect(screen.getByText('Fish')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Diamonds' }));
    fireEvent.click(screen.getByText('Fish'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /send to fish/i }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'fn_union_send_to_member',
        expect.objectContaining({ p_kind: 'diamonds', p_source_wallet: null })
      )
    );
  });

  it('stays open and shows the refusal when the server says no', async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'fn_union_player_directory') return Promise.resolve({ data: roster, error: null });
      return Promise.resolve({
        data: { success: false, error: 'Insufficient balance in the selected union wallet.' },
        error: null,
      });
    });
    render(<UnionWalletModal {...base} />);
    await waitFor(() => expect(screen.getByText('Fish')).toBeTruthy());

    fireEvent.click(screen.getByText('Fish'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '999999' } });
    fireEvent.click(screen.getByRole('button', { name: /send to fish/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/insufficient/i);
    expect(base.onClose).not.toHaveBeenCalled();
  });

  it('cannot send until a member and a positive amount are chosen', async () => {
    render(<UnionWalletModal {...base} />);
    await waitFor(() => expect(screen.getByText('Fish')).toBeTruthy());
    const btn = screen.getByRole('button', { name: /pick a member/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('defaults the promo wallet to sending promo funds', async () => {
    render(<UnionWalletModal {...base} walletKey="promo" walletLabel="Promo Wallet" />);
    await waitFor(() => expect(screen.getByText('Fish')).toBeTruthy());

    fireEvent.click(screen.getByText('Fish'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /send to fish/i }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'fn_union_send_to_member',
        expect.objectContaining({ p_kind: 'promo' })
      )
    );
  });
});
