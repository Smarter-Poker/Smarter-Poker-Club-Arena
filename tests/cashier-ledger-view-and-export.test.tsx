import { cashierRecoveryRpc } from './helpers/cashierRecoveryRpc';
/**
 * Club Bank and Promo Wallet follow-up audit, 2026-10-16.
 * Delayed ledger/file/command responses exercise the real modal's ownership
 * boundaries without issuing a production financial command.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Answer = { data: unknown; error: unknown };

const fx = vi.hoisted(() => ({
  club: {
    name: 'Test Club',
    union_id: null as string | null,
    chip_treasury: 1000,
    promo_balance: 0,
  },
  agentRow: null as Record<string, unknown> | null,
  members: [] as Array<{ data: unknown; error: unknown }>,
  sends: [] as Array<
    Promise<{ data: unknown; error: unknown }> | { data: unknown; error: unknown }
  >,
  ledgers: [] as Array<Answer | Promise<Answer>>,
  promoLedgers: [] as Array<Answer | Promise<Answer>>,
  reversible: [] as Array<Record<string, unknown>>,
  handoff: true as boolean | Promise<boolean>,
  exportGuard: null as null | (() => boolean),
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  blobs: [] as Blob[],
}));

const recoveries = cashierRecoveryRpc();

vi.mock('../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: '11111111-1111-4111-8111-111111111111' } }),
}));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => fx.toast }));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn() } }));
vi.mock('../src/components/wallet/ChipMintModal', () => ({
  default: (props: { isOpen: boolean; onClose: () => void }) =>
    props.isOpen ? (
      <div data-testid="chip-mint">
        <button type="button">Mint Amount</button>
        <button type="button" onClick={props.onClose}>
          Close The Mint
        </button>
      </div>
    ) : null,
}));
vi.mock('../src/utils/downloadCsv', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/downloadCsv')>()),
  downloadBlob: (_name: string, blob: Blob, isCurrent?: () => boolean) => {
    fx.exportGuard = isCurrent || null;
    fx.blobs.push(blob);
    return fx.handoff;
  },
}));
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'abortSignal']) builder[method] = () => builder;
      builder.maybeSingle = async () => ({
        error: null,
        data:
          table === 'clubs'
            ? { id: '22222222-2222-4222-8222-222222222222', ...fx.club }
            : table === 'agents'
              ? fx.agentRow
              : null,
      });
      return builder;
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      fx.calls.push({ fn, args });
      const recovery = recoveries.answer(fn, args);
      if (recovery) return Promise.resolve(recovery);
      /* UPDATED 2026-10-09 (launch audit S-07): the cashier reads the Club Bank
         and the promo pot through the role-checked fn_club_money_panel (with
         an abort signal), never through a direct clubs select. The fixture
         club is served through it, unchanged. */
      if (fn === 'fn_club_money_panel') {
        const answer = Promise.resolve({
          data: {
            authorized: true,
            scope: 'club',
            club_id: args.p_club_id,
            club_name: fx.club.name,
            in_union: fx.club.union_id !== null,
            union_id: fx.club.union_id,
            club_treasury: fx.club.chip_treasury,
            club_promo_wallet: fx.club.promo_balance,
          },
          error: null,
        });
        return Object.assign(answer, { abortSignal: () => answer });
      }
      if (fn === 'fn_club_cashier_members') {
        return Promise.resolve(fx.members.length > 1 ? fx.members.shift() : fx.members[0]);
      }
      if (fn === 'fn_agent_wallet_reversible') {
        return Promise.resolve({ data: fx.reversible, error: null });
      }
      if (fn === 'fn_promo_wallet_ledger') {
        return Promise.resolve(
          fx.promoLedgers.length > 1 ? fx.promoLedgers.shift() : fx.promoLedgers[0]
        );
      }
      if (fn === 'fn_club_bank_ledger') {
        return Promise.resolve(fx.ledgers.length > 1 ? fx.ledgers.shift() : fx.ledgers[0]);
      }
      if (
        fn === 'fn_agent_wallet_send' ||
        fn === 'fn_club_bank_send' ||
        fn === 'fn_promo_wallet_send' ||
        fn === 'fn_club_promo_wallet_send'
      ) {
        const next = fx.sends.shift();
        return Promise.resolve(next ?? { data: { success: true }, error: null });
      }
      return Promise.resolve({ data: [], error: null });
    },
    channel: () => {
      const channel = { on: () => channel, subscribe: () => channel };
      return channel;
    },
    removeChannel: vi.fn(),
  },
}));

import WalletCashierModal from '../src/components/wallet/WalletCashierModal';

const CLUB = '22222222-2222-4222-8222-222222222222';
const props = {
  isOpen: true,
  onClose: () => {},
  clubId: CLUB,
  role: 'owner',
  walletType: 'club_bank' as const,
};
const row = (id: string, kind: string) => ({
  id,
  amount: 10,
  transaction_type: kind,
  notes: id,
  created_at: '2026-10-16T12:00:00Z',
  balance_after: 990,
  from_name: 'Sender',
  to_name: 'Recipient',
  metadata: {},
  is_reversed: false,
  reversible: true,
});
const answer = (id: string, kind: string) => ({
  data: {
    authorized: true,
    total: 1,
    types: ['mint', 'club_bank_send'],
    totals: { into_bank: 10, out_of_bank: 0, net: 10 },
    rows: [row(id, kind)],
  },
  error: null,
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function openLedger() {
  const view = render(<WalletCashierModal {...props} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Transaction Ledger' }));
  await screen.findByText('Old Receipt');
  return view;
}
beforeEach(() => {
  recoveries.clear();
  fx.agentRow = null;
  fx.reversible = [];
  fx.club.chip_treasury = 1000;
  fx.promoLedgers = [];
  fx.club.promo_balance = 50;
  fx.members = [{ data: [], error: null }];
  fx.ledgers = [answer('Old Receipt', 'mint')];
  fx.calls = [];
  fx.sends = [];
  fx.blobs = [];
  fx.handoff = true;
  fx.exportGuard = null;
  fx.toast.success.mockReset();
  fx.toast.error.mockReset();
});
afterEach(cleanup);
describe('ledger owns the rows and export currently on screen', () => {
  it('removes the previous filter rows and export while the replacement page is pending', async () => {
    const pending = deferred<Answer>();
    fx.ledgers = [answer('Old Receipt', 'mint'), pending.promise];
    await openLedger();
    fireEvent.click(screen.getByRole('button', { name: 'Club Bank Send', exact: true }));
    await screen.findByText('Loading Ledger...');
    expect(screen.queryByText('Old Receipt')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reverse This Send' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    await act(async () => pending.resolve(answer('New Receipt', 'club_bank_send')));
    expect(await screen.findByText('New Receipt')).toBeInTheDocument();
  });
  it('reports an unavailable export rather than claiming a file was exported', async () => {
    fx.handoff = false;
    await openLedger();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(fx.toast.error).toHaveBeenCalled());
    expect(fx.toast.success).not.toHaveBeenCalled();
  });
  it('waits for the native handoff and invalidates it when the view changes', async () => {
    const pending = deferred<boolean>();
    fx.handoff = pending.promise;
    const view = await openLedger();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(fx.toast.success).not.toHaveBeenCalled();
    expect(fx.exportGuard?.()).toBe(true);
    view.rerender(<WalletCashierModal {...props} isOpen={false} />);
    expect(fx.exportGuard?.()).toBe(false);
    await act(async () => pending.resolve(true));
    expect(fx.toast.success).not.toHaveBeenCalled();
  });
  it('confirms a completed handoff exactly once and blocks a double export', async () => {
    const pending = deferred<boolean>();
    fx.handoff = pending.promise;
    await openLedger();
    const button = screen.getByRole('button', { name: 'Export CSV' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fx.blobs).toHaveLength(1);
    expect(fx.toast.success).not.toHaveBeenCalled();
    await act(async () => pending.resolve(true));
    await waitFor(() => expect(fx.toast.success).toHaveBeenCalledTimes(1));
  });
});

describe('a pending money command retains the confirmed form', () => {
  it('locks the amount, reason, wallet, tabs and mint until the send answers', async () => {
    const pending = deferred<Answer>();
    fx.sends = [pending.promise];
    fx.members = [
      {
        data: [
          {
            user_id: '44444444-4444-4444-8444-444444444444',
            role: 'player',
            name: 'Recipient',
            player_number: '2',
            chip_balance: 10,
          },
        ],
        error: null,
      },
    ];
    render(
      <WalletCashierModal
        {...props}
        initialDestination="player_wallet"
        initialRecipientId="44444444-4444-4444-8444-444444444444"
      />
    );
    await screen.findByRole('region', { name: 'Selected Player' });
    const amount = screen.getByRole('textbox', { name: 'Chips To Send' });
    fireEvent.change(amount, { target: { value: '10' } });
    const confirm = screen.getByRole('button', { name: 'Confirm', exact: true });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(fx.calls.some((c) => c.fn === 'fn_club_bank_send')).toBe(true));
    expect(amount).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Reason' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Send Into' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Send From' })).toBeDisabled();
    for (const tab of screen.getAllByRole('tab')) expect(tab).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mint Chips Into The Club Bank' })).toBeDisabled();
    await act(async () => pending.resolve({ data: { success: true }, error: null }));
    await waitFor(() => expect(amount).not.toBeDisabled());
  });
});

describe('promo ledger ownership and failed file handoffs', () => {
  it('removes the previous promo account history during a source switch', async () => {
    const pending = deferred<Answer>();
    fx.agentRow = { agent_wallet_balance: 40, promo_wallet_balance: 15 };
    const promo = (note: string) => ({
      data: {
        authorized: true,
        total: 1,
        totals: { in: 10, out: 0, net: 10 },
        rows: [
          {
            ...row(note, 'mint'),
            direction: 'in',
            category: 'mint',
            counterparty_name: 'Recipient',
            actor_name: 'Sender',
          },
        ],
      },
      error: null,
    });
    fx.promoLedgers = [promo('Old Promo Receipt'), pending.promise];
    render(<WalletCashierModal {...props} walletType="promo_wallet" />);
    await screen.findByRole('radio', { name: /My Promo Float/ });
    fireEvent.click(screen.getByRole('tab', { name: 'Transaction Ledger' }));
    await screen.findByText('Old Promo Receipt');
    fireEvent.click(screen.getByRole('radio', { name: /My Promo Float/ }));
    await screen.findByText('Loading Ledger...');
    expect(screen.queryByText('Old Promo Receipt')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    await act(async () => pending.resolve(promo('New Promo Receipt')));
    expect(await screen.findByText('New Promo Receipt')).toBeInTheDocument();
  });
  it('catches a native share rejection and allows a new export attempt', async () => {
    let reject!: (reason: Error) => void;
    fx.handoff = new Promise<boolean>((_, r) => {
      reject = r;
    });
    await openLedger();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await act(async () => reject(new Error('Could Not Save The File')));
    expect(fx.toast.success).not.toHaveBeenCalled();
    expect(fx.toast.error).toHaveBeenCalledWith('Could Not Save The File');
    fx.handoff = true;
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(fx.toast.success).toHaveBeenCalledTimes(1));
  });
});

describe('wallet balances and ledger movements retain separate formats', () => {
  it.each(['club_bank', 'promo_wallet'] as const)(
    '%s keeps compact movements and aggregates beside exact wallet snapshots',
    async (walletType) => {
      fx.club.chip_treasury = 12500.5;
      fx.club.promo_balance = 12500.5;
      const receipt = {
        ...row('Formatting Receipt', 'club_bank_send'),
        amount: 1250.5,
        balance_after: 11250,
        direction: 'out',
        category: 'send',
        counterparty_name: 'Recipient',
      };
      fx.ledgers = [
        {
          data: {
            authorized: true,
            total: 1,
            types: [],
            totals: { into_bank: 2500.5, out_of_bank: 1250.5, net: 1250 },
            rows: [receipt],
          },
          error: null,
        },
      ];
      fx.promoLedgers = [
        {
          data: {
            authorized: true,
            total: 1,
            totals: { in: 2500.5, out: 1250.5, net: 1250 },
            rows: [receipt],
          },
          error: null,
        },
      ];
      render(<WalletCashierModal {...props} walletType={walletType} />);
      await waitFor(() =>
        expect(document.querySelector('.cbc-bank strong')).toHaveTextContent('12,500.50')
      );
      fireEvent.click(screen.getByRole('tab', { name: 'Transaction Ledger' }));
      await screen.findByText('Formatting Receipt');
      expect(
        Array.from(document.querySelectorAll('.cbc-totals strong'), (n) => n.textContent)
      ).toEqual(['2.5K', '1.2K', '1.2K']);
      expect(document.querySelector('.cbc-tx-amount')).toHaveTextContent(
        walletType === 'promo_wallet' ? '-1.2K' : '1.2K'
      );
      expect(
        screen.getByText(
          walletType === 'promo_wallet' ? 'Wallet After 11,250.00' : 'Bank After 11,250.00'
        )
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
    }
  );

  it('keeps agent claim history compact while the wallet and actionable claim stay exact', async () => {
    fx.agentRow = { agent_wallet_balance: 12500.5, promo_wallet_balance: 0 };
    fx.reversible = [
      {
        transaction_id: 'claim-receipt',
        to_name: 'Recipient',
        destination: 'player_wallet',
        amount: 2500.5,
        remaining: 1250.5,
        claimed_back: 1250,
        seconds_left: 500,
      },
    ];
    render(<WalletCashierModal {...props} role="agent" walletType="agent_wallet" />);
    await waitFor(() =>
      expect(document.querySelector('.cbc-bank strong')).toHaveTextContent('12,500.50')
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Claim Back' }));
    await screen.findByText('Sent 2.5K, 1.2K Already Claimed Back');
    expect(document.querySelector('.cbc-tx-amount')).toHaveTextContent('1,250.50');
    expect(screen.getByRole('button', { name: 'Claim Back 1,250.50 Chips' })).toBeInTheDocument();
    expect(fx.calls.some((c) => /send|claim_back|reverse/.test(c.fn))).toBe(false);
  });
});
