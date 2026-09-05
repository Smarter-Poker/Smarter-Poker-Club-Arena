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
const unionClubs = [
  { club_id: 'c-1', clubs: { name: 'Club JAQK' } },
  { club_id: 'c-2', clubs: { name: 'SHARK CLUB' } },
];
const fromChain = (table?: string) => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'contains']) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (v: { data: unknown[] }) => void) =>
    resolve({ data: table === 'union_clubs' ? unionClubs : [] });
  return chain;
};
vi.mock('../src/lib/supabase', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (t: string) => fromChain(t) },
}));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
const promoSend = vi.fn();
const sendToClub = vi.fn();
vi.mock('../src/services/UnionApiService', () => ({
  unionApi: {
    promoSend: (...a: unknown[]) => promoSend(...a),
    sendToClub: (...a: unknown[]) => sendToClub(...a),
  },
}));

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
  promoSend.mockReset();
  sendToClub.mockReset();
  promoSend.mockResolvedValue({ success: true });
  sendToClub.mockResolvedValue({ success: true });
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

  /* THE 2026-09-05 BUG, AS A TEST. Dan opened the Promo Wallet, picked a club,
     sent 5,000, and the modal called sendToClub - union BANK to club BANK.
     The promo wallet must reach the club's PROMO wallet through promoSend,
     and the bank route must never be taken from the promo wallet. */
  it('sends from the promo wallet to a club through promoSend, never sendToClub', async () => {
    render(<UnionWalletModal {...base} walletKey="promo" walletLabel="Promo Wallet" />);
    await waitFor(() => expect(screen.getByText('Club JAQK')).toBeTruthy());
    expect(screen.getAllByText('CLUB PROMO WALLET').length).toBe(2);

    fireEvent.click(screen.getByText('Club JAQK'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: /send to club jaqk/i }));

    await waitFor(() =>
      expect(promoSend).toHaveBeenCalledWith('un-1', 5000, 'club', 'c-1', expect.any(String))
    );
    expect(sendToClub).not.toHaveBeenCalled();
    expect((await screen.findByRole('status')).textContent).toMatch(/promo wallet/i);
  });

  it('sends from the union bank to a club through sendToClub, into the Club Bank', async () => {
    render(<UnionWalletModal {...base} walletKey="chips" walletLabel="Union Bank" />);
    await waitFor(() => expect(screen.getByText('SHARK CLUB')).toBeTruthy());
    expect(screen.getAllByText('CLUB BANK').length).toBe(2);

    fireEvent.click(screen.getByText('SHARK CLUB'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /send to shark club/i }));

    await waitFor(() =>
      expect(sendToClub).toHaveBeenCalledWith('un-1', 'c-2', 250, expect.any(String))
    );
    expect(promoSend).not.toHaveBeenCalled();
  });

  it('refuses a club send from the rake wallet instead of drawing on the bank in silence', async () => {
    render(<UnionWalletModal {...base} />);
    await waitFor(() => expect(screen.getByText('Club JAQK')).toBeTruthy());
    const row = screen.getByText('Club JAQK').closest('button') as HTMLButtonElement;
    expect(row.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(row);
    expect(
      (screen.getByRole('button', { name: /pick a member/i }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(sendToClub).not.toHaveBeenCalled();
    expect(promoSend).not.toHaveBeenCalled();
  });

  it('has a ledger tab that reads fn_promo_wallet_ledger for the open wallet', async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'fn_union_player_directory') return Promise.resolve({ data: roster, error: null });
      if (fn === 'fn_promo_wallet_ledger')
        return Promise.resolve({
          data: {
            authorized: true,
            total: 1,
            totals: { in: 0, out: 5000, net: -5000 },
            rows: [
              {
                id: 'l-1',
                created_at: '2026-09-05T03:07:38Z',
                amount: 5000,
                direction: 'out',
                category: 'promo_to_club',
                notes: 'Promo Wallet To Club Promo Wallet',
                balance_after: 32482.58,
                counterparty_type: 'club',
                counterparty_name: 'Club JAQK',
                actor_name: 'KingFish',
              },
            ],
          },
          error: null,
        });
      return Promise.resolve({ data: null, error: null });
    });
    render(<UnionWalletModal {...base} walletKey="promo" walletLabel="Promo Wallet" />);
    await waitFor(() => expect(screen.getByText('Fish')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Ledger' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'fn_promo_wallet_ledger',
        expect.objectContaining({ p_scope: 'union', p_scope_id: 'un-1', p_wallet: 'promo_wallet' })
      )
    );
    expect(await screen.findByText('Promo To Club')).toBeTruthy();
    expect(screen.getByText('To Club JAQK')).toBeTruthy();
    // the row amount, and the Net total beneath the tab, both carry the sign
    expect(screen.getAllByText('-5,000.00').length).toBe(2);
    expect(screen.getByText('Wallet After 32,482.58')).toBeTruthy();
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
