/**
 * Union wallets must open and be able to send funds to any union member.
 *
 * Dan 2026-08-22: "WHEN OWNER, CO OWNER OR ADMIN CLICKS ON ANY OF THE WALLETS
 * IT SHOULD OPEN UP, AND THEY BE ABLE TO SEND CHIPS, DIAMONDS OR PROMO FUNDS
 * TO ANY MEMBER OF THE UNION." The tiles used to be static divs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const UNION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sourceState = vi.hoisted(() => ({ clubError: null as null | { message: string } }));

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
  chain.then = (resolve: (v: { data: unknown[]; error: null | { message: string } }) => void) =>
    resolve({
      data: table === 'union_clubs' && !sourceState.clubError ? unionClubs : [],
      error: table === 'union_clubs' ? sourceState.clubError : null,
    });
  return chain;
};
vi.mock('../src/lib/supabase', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (t: string) => fromChain(t) },
}));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({
    user: { id: '11111111-1111-4111-8111-111111111111' },
    isAuthenticated: true,
    isHydrating: false,
  }),
}));
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
  unionId: UNION_ID,
  walletKey: 'rake' as const,
  walletLabel: 'Weekly Rake Wallet',
  balance: 5000,
};

beforeEach(() => {
  window.localStorage.clear();
  sourceState.clubError = null;
  base.onClose.mockClear();
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
    expect(rpc).toHaveBeenCalledWith('fn_union_player_directory', { p_union_id: UNION_ID });
    expect(screen.getByText('OWNER')).toBeTruthy();
    expect(screen.getByText('MEMBER')).toBeTruthy();
    expect(screen.getByText('SHARK')).toBeTruthy();
  });

  it('fails the wallet directory closed and exposes a retry when club wallets cannot load', async () => {
    sourceState.clubError = { message: 'network unavailable' };
    render(<UnionWalletModal {...base} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load club wallets/i);
    expect(screen.getByRole('button', { name: 'Retry Directory' })).toBeVisible();
    expect(screen.getByRole('button', { name: /pick a member or club/i })).toBeDisabled();
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
          p_union_id: UNION_ID,
          p_target_user_id: 'u-2',
          p_kind: 'chips',
          p_amount: 250,
          p_source_wallet: 'rake', // the wallet the manager opened
          p_op_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
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

  it('retires the key after a definitive business refusal', async () => {
    let sendAttempt = 0;
    rpc.mockImplementation((fn: string) => {
      if (fn === 'fn_union_player_directory') return Promise.resolve({ data: roster, error: null });
      if (fn === 'fn_union_send_to_member') {
        sendAttempt += 1;
        return Promise.resolve({
          data:
            sendAttempt === 1
              ? { success: false, error: 'Insufficient balance.' }
              : { success: true },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    render(<UnionWalletModal {...base} />);
    await waitFor(() => expect(screen.getByText('Fish')).toBeTruthy());
    fireEvent.click(screen.getByText('Fish'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /send to fish/i }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /send to fish/i }));
    await screen.findByRole('status');

    const sends = rpc.mock.calls.filter(([fn]) => fn === 'fn_union_send_to_member');
    expect((sends[1][1] as { p_op_id: string }).p_op_id).not.toBe(
      (sends[0][1] as { p_op_id: string }).p_op_id
    );
  });

  it('reuses the member-send operation id after a lost response and a remount', async () => {
    let sendAttempt = 0;
    rpc.mockImplementation((fn: string) => {
      if (fn === 'fn_union_player_directory') return Promise.resolve({ data: roster, error: null });
      if (fn === 'fn_union_send_to_member') {
        sendAttempt += 1;
        if (sendAttempt === 1) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve({ data: { success: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const firstView = render(<UnionWalletModal {...base} />);
    await waitFor(() => expect(screen.getByText('Fish')).toBeTruthy());
    fireEvent.click(screen.getByText('Fish'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /send to fish/i }));
    await screen.findByRole('alert');

    const firstSend = rpc.mock.calls.find(([fn]) => fn === 'fn_union_send_to_member');
    const firstOpId = (firstSend?.[1] as { p_op_id?: string })?.p_op_id;
    expect(firstOpId).toMatch(/^[0-9a-f-]{36}$/);
    firstView.unmount();

    render(<UnionWalletModal {...base} />);
    await waitFor(() => expect(screen.getByText('Fish')).toBeTruthy());
    fireEvent.click(screen.getByText('Fish'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /send to fish/i }));
    expect((await screen.findByRole('status')).textContent).toMatch(/sent 250/i);

    const sends = rpc.mock.calls.filter(([fn]) => fn === 'fn_union_send_to_member');
    expect(sends).toHaveLength(2);
    expect((sends[1][1] as { p_op_id: string }).p_op_id).toBe(firstOpId);
  });

  it('cannot be dismissed while a money response is unresolved', async () => {
    let settle!: (value: { data: { success: true }; error: null }) => void;
    const pending = new Promise<{ data: { success: true }; error: null }>((resolve) => {
      settle = resolve;
    });
    rpc.mockImplementation((fn: string) => {
      if (fn === 'fn_union_player_directory') return Promise.resolve({ data: roster, error: null });
      if (fn === 'fn_union_send_to_member') return pending;
      return Promise.resolve({ data: null, error: null });
    });

    render(<UnionWalletModal {...base} />);
    await screen.findByText('Fish');
    fireEvent.click(screen.getByText('Fish'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: /send to fish/i }));
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(base.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/wait for the current money move/i);
    settle({ data: { success: true }, error: null });
    await screen.findByRole('status');
  });

  it('fails closed before the member RPC when durable safety storage is unavailable', async () => {
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      render(<UnionWalletModal {...base} />);
      await waitFor(() => expect(screen.getByText('Fish')).toBeTruthy());
      fireEvent.click(screen.getByText('Fish'));
      fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '250' } });
      fireEvent.click(screen.getByRole('button', { name: /send to fish/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/safety storage is unavailable/i);
      expect(rpc).not.toHaveBeenCalledWith('fn_union_send_to_member', expect.anything());
    } finally {
      setItem.mockRestore();
    }
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
      expect(promoSend).toHaveBeenCalledWith(
        UNION_ID,
        5000,
        'club',
        'c-1',
        expect.any(String),
        expect.stringMatching(/^[0-9a-f-]{36}$/)
      )
    );
    expect(sendToClub).not.toHaveBeenCalled();
    expect((await screen.findByRole('status')).textContent).toMatch(/promo wallet/i);
  });

  it('reuses the caller-owned API key when a promo-send response is lost', async () => {
    promoSend
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ success: true, promoAfter: 4500 });
    render(<UnionWalletModal {...base} walletKey="promo" walletLabel="Promo Wallet" />);
    await waitFor(() => expect(screen.getByText('Club JAQK')).toBeTruthy());
    fireEvent.click(screen.getByText('Club JAQK'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: /send to club jaqk/i }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: /send to club jaqk/i }));
    await screen.findByRole('status');

    expect(promoSend).toHaveBeenCalledTimes(2);
    expect(promoSend.mock.calls[0][5]).toMatch(/^[0-9a-f-]{36}$/);
    expect(promoSend.mock.calls[1][5]).toBe(promoSend.mock.calls[0][5]);
  });

  it('sends from the union bank to a club through sendToClub, into the Club Bank', async () => {
    render(<UnionWalletModal {...base} walletKey="chips" walletLabel="Union Bank" />);
    await waitFor(() => expect(screen.getByText('SHARK CLUB')).toBeTruthy());
    expect(screen.getAllByText('CLUB BANK').length).toBe(2);

    fireEvent.click(screen.getByText('SHARK CLUB'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /send to shark club/i }));

    await waitFor(() =>
      expect(sendToClub).toHaveBeenCalledWith(
        UNION_ID,
        'c-2',
        250,
        expect.any(String),
        expect.stringMatching(/^[0-9a-f-]{36}$/)
      )
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
        expect.objectContaining({
          p_scope: 'union',
          p_scope_id: UNION_ID,
          p_wallet: 'promo_wallet',
        })
      )
    );
    expect(await screen.findByText('Promo To Club')).toBeTruthy();
    expect(screen.getByText('To Club JAQK')).toBeTruthy();
    // the row amount, and the Net total beneath the tab, both carry the sign
    expect(screen.getAllByText('-5,000.00').length).toBe(2);
    expect(screen.getByText('Wallet After 32,482.58')).toBeTruthy();
  });

  /* THE PULL TAB, ONE TAB OVER FROM THE SEND BUG. Opened on the promo
     wallet it used to call fn_union_clawback_from_club - club Club Bank to
     union bank - and grew the promo figure on screen. A promo pull now comes
     back from the club PROMO wallet, op-keyed; a bank pull stays on the bank
     RPC and carries an op id too. */
  it('pulls from the club promo wallet when opened on the promo wallet', async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'fn_union_player_directory') return Promise.resolve({ data: roster, error: null });
      if (fn === 'fn_union_clawback_promo_from_club')
        return Promise.resolve({ data: { success: true, promo_after: 33000 }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    render(<UnionWalletModal {...base} walletKey="promo" walletLabel="Promo Wallet" />);
    await waitFor(() => expect(screen.getByText('Club JAQK')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Pull (Clawback)' }));
    expect(screen.getAllByText('Pull From The Club Promo Wallet').length).toBe(2);
    fireEvent.click(screen.getByText('Club JAQK'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '400' } });
    fireEvent.click(screen.getByRole('button', { name: /pull from club jaqk/i }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'fn_union_clawback_promo_from_club',
        expect.objectContaining({
          p_union_id: UNION_ID,
          p_club_id: 'c-1',
          p_amount: 400,
          p_op_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        })
      )
    );
    expect(rpc).not.toHaveBeenCalledWith('fn_union_clawback_from_club', expect.anything());
    expect((await screen.findByRole('status')).textContent).toMatch(/promo wallet/i);
    expect(screen.getByText('33,000.00')).toBeTruthy();
  });

  it('pulls from the club bank when opened on the union bank, with an op id', async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'fn_union_player_directory') return Promise.resolve({ data: roster, error: null });
      if (fn === 'fn_union_clawback_from_club')
        return Promise.resolve({ data: { success: true, union_balance: 70000 }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    render(<UnionWalletModal {...base} walletKey="chips" walletLabel="Union Bank" />);
    await waitFor(() => expect(screen.getByText('SHARK CLUB')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Pull (Clawback)' }));
    fireEvent.click(screen.getByText('SHARK CLUB'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /pull from shark club/i }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'fn_union_clawback_from_club',
        expect.objectContaining({ p_club_id: 'c-2', p_amount: 10, p_op_id: expect.any(String) })
      )
    );
    expect(screen.getByText('70,000.00')).toBeTruthy();
  });

  it('reuses the clawback operation id after an ambiguous transport failure', async () => {
    let clawbackAttempt = 0;
    rpc.mockImplementation((fn: string) => {
      if (fn === 'fn_union_player_directory') return Promise.resolve({ data: roster, error: null });
      if (fn === 'fn_union_clawback_from_club') {
        clawbackAttempt += 1;
        if (clawbackAttempt === 1) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve({ data: { success: true, union_balance: 5010 }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    render(<UnionWalletModal {...base} walletKey="chips" walletLabel="Union Bank" />);
    await waitFor(() => expect(screen.getByText('SHARK CLUB')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Pull (Clawback)' }));
    fireEvent.click(screen.getByText('SHARK CLUB'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /pull from shark club/i }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: /pull from shark club/i }));
    await screen.findByRole('status');

    const calls = rpc.mock.calls.filter(([fn]) => fn === 'fn_union_clawback_from_club');
    expect(calls).toHaveLength(2);
    expect((calls[0][1] as { p_op_id: string }).p_op_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((calls[1][1] as { p_op_id: string }).p_op_id).toBe(
      (calls[0][1] as { p_op_id: string }).p_op_id
    );
  });

  it('treats a duplicate clawback response as the confirmed earlier operation', async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'fn_union_player_directory') return Promise.resolve({ data: roster, error: null });
      if (fn === 'fn_union_clawback_from_club') {
        return Promise.resolve({
          data: { success: false, duplicate: true, error: 'operation already processed' },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const onSent = vi.fn();
    render(
      <UnionWalletModal {...base} walletKey="chips" walletLabel="Union Bank" onSent={onSent} />
    );
    await screen.findByText('SHARK CLUB');
    fireEvent.click(screen.getByRole('tab', { name: 'Pull (Clawback)' }));
    fireEvent.click(screen.getByText('SHARK CLUB'));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /pull from shark club/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/already processed/i);
    expect(onSent).toHaveBeenCalledOnce();
  });

  it('refuses a pull from the rake wallet instead of pulling into the bank in silence', async () => {
    render(<UnionWalletModal {...base} />);
    await waitFor(() => expect(screen.getByText('Club JAQK')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Pull (Clawback)' }));
    const row = screen.getByText('Club JAQK').closest('button') as HTMLButtonElement;
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByText('Not Available From Here').length).toBeGreaterThan(0);
    expect(rpc).not.toHaveBeenCalledWith('fn_union_clawback_from_club', expect.anything());
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
