import { cashierRecoveryRpc } from './helpers/cashierRecoveryRpc';
import { webcrypto } from 'node:crypto';
/**
 * Audit C2, the Club Bank, Agent Wallet and Promo Wallet cashier
 * (WalletCashierModal), rendered (2026-10-09). Each test names the finding it
 * pins; every one of them fails against the modal as it stood before the fix.
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
  ledgers: [] as Array<{ data: unknown; error: unknown }>,
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  blobs: [] as Blob[],
}));

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
  downloadBlob: (_name: string, blob: Blob) => {
    fx.blobs.push(blob);
    return true;
  },
}));
const recoveries = cashierRecoveryRpc();

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
const P1 = '44444444-4444-4444-8444-444444444444';
const kingfish = {
  user_id: P1,
  role: 'player',
  name: 'kingfish',
  username: 'kf',
  player_number: '1234',
  avatar_url: '',
  chip_balance: 5,
};
const sends = (fn: string) => fx.calls.filter((c) => c.fn === fn);

function openCashier(props: Partial<React.ComponentProps<typeof WalletCashierModal>> = {}) {
  const onClose = vi.fn();
  const view = render(
    <WalletCashierModal isOpen onClose={onClose} clubId={CLUB} role="owner" {...props} />
  );
  return { onClose, view };
}
async function pick(name: RegExp) {
  fireEvent.click(await screen.findByRole('button', { name }));
}
/** The Club Bank opens on the Agent Wallet destination; a player is sent to on Player Wallet. */
async function toPlayerWallet() {
  fireEvent.click(await screen.findByRole('button', { name: 'Player Wallet' }));
}
function typeAmount(value: string) {
  fireEvent.change(screen.getByLabelText('Chips To Send'), { target: { value } });
}
const plate = (name: string | RegExp) => screen.getByRole('button', { name });
const bankFigure = () => document.querySelector('.cbc-bank strong');

beforeEach(() => {
  recoveries.clear();
  localStorage.clear();
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  fx.club = { name: 'Test Club', union_id: null, chip_treasury: 1000, promo_balance: 0 };
  fx.agentRow = null;
  fx.members = [{ data: [kingfish], error: null }];
  fx.sends = [];
  fx.ledgers = [{ data: { authorized: true, total: 0, types: [], rows: [] }, error: null }];
  fx.calls = [];
  fx.blobs = [];
  fx.toast.success.mockClear();
  fx.toast.error.mockClear();
});
afterEach(() => {
  cleanup();
});

describe('C2-1: the Agent Wallet sends against the float plus the credit line', () => {
  it('sends 50 from an empty float when 100 of credit is still drawable', async () => {
    fx.agentRow = {
      agent_wallet_balance: 0,
      promo_wallet_balance: 0,
      is_prepaid: false,
      credit_limit: 100,
      credit_used: 0,
    };
    openCashier({ role: 'agent', walletType: 'agent_wallet' });
    await pick(/Kingfish/);
    typeAmount('50');
    await waitFor(() => expect(plate('Send Chips')).not.toBeDisabled());
    fireEvent.click(plate('Send Chips'));
    // Borrowing on the line always asks first, and says how much is borrowed.
    expect(await screen.findByText(/50 Of Them Are Drawn From Your Credit Line/)).toBeTruthy();
    fireEvent.click(plate('Yes, Send It'));
    await waitFor(() => expect(sends('fn_agent_wallet_send')).toHaveLength(1));
    expect(sends('fn_agent_wallet_send')[0].args.p_amount).toBe(50);
  });

  it('still stops at float plus line', async () => {
    fx.agentRow = {
      agent_wallet_balance: 0,
      promo_wallet_balance: 0,
      is_prepaid: false,
      credit_limit: 100,
      credit_used: 0,
    };
    openCashier({ role: 'agent', walletType: 'agent_wallet' });
    await pick(/Kingfish/);
    typeAmount('101');
    expect(await screen.findByText(/Cover 100\.00 Chips/)).toBeTruthy();
    expect(plate('Send Chips')).toBeDisabled();
  });
});

describe('C2-3: the corner X cannot close the cashier with a send in flight', () => {
  it('offers no working X while the send is pending', async () => {
    let settle!: (answer: Answer) => void;
    fx.sends = [new Promise<Answer>((resolve) => (settle = resolve))];
    const { onClose } = openCashier({ walletType: 'club_bank' });
    await toPlayerWallet();
    await pick(/Kingfish/);
    typeAmount('10');
    await waitFor(() => expect(plate('Confirm')).not.toBeDisabled());
    fireEvent.click(plate('Confirm'));
    await waitFor(() => expect(sends('fn_club_bank_send')).toHaveLength(1));
    const x = document.querySelector('[data-testid="sc-close"]');
    if (x) fireEvent.click(x);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => settle({ data: { success: true }, error: null }));
  });
});

describe('C2-4: with the Chip Mint open, the cashier behind it does not close', () => {
  it('ignores Escape and a tap on its own backdrop while the mint is up', async () => {
    const { onClose } = openCashier({ walletType: 'club_bank' });
    fireEvent.click(await screen.findByRole('button', { name: 'Mint Chips Into The Club Bank' }));
    expect(await screen.findByTestId('chip-mint')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(document.querySelector('.cbc-overlay') as Element);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('chip-mint')).toBeTruthy();
  });
});

describe('C2-5: the reason is part of the retry key', () => {
  it('a reason edited after a refusal is a new operation with a new key', async () => {
    fx.sends = [{ data: { success: false, error: 'Refused For Test' }, error: null }];
    openCashier({ walletType: 'club_bank' });
    await toPlayerWallet();
    await pick(/Kingfish/);
    typeAmount('10');
    await waitFor(() => expect(plate('Confirm')).not.toBeDisabled());
    fireEvent.click(plate('Confirm'));
    await waitFor(() => expect(fx.toast.error).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Weekly Float' } });
    await waitFor(() => expect(plate('Confirm')).not.toBeDisabled());
    fireEvent.click(plate('Confirm'));
    await waitFor(() => expect(sends('fn_club_bank_send')).toHaveLength(2));
    const [first, second] = sends('fn_club_bank_send');
    expect(second.args.p_reason).toBe('Weekly Float');
    expect(second.args.p_op_id).not.toBe(first.args.p_op_id);
  });
});

describe('C2-14: the confirmation names the account being spent', () => {
  it('an agent wallet send is a share of YOUR AGENT WALLET, not the Club Bank', async () => {
    fx.agentRow = { agent_wallet_balance: 40, promo_wallet_balance: 0, is_prepaid: true };
    openCashier({ role: 'agent', walletType: 'agent_wallet' });
    await pick(/Kingfish/);
    typeAmount('20');
    await waitFor(() => expect(plate('Send Chips')).not.toBeDisabled());
    fireEvent.click(plate('Send Chips'));
    const box = await screen.findByRole('alert');
    expect(box).toHaveTextContent('That Is 50.0 Percent Of Your Agent Wallet.');
    expect(box).not.toHaveTextContent('Club Bank');
  });
});

describe('C2-15: a roster that failed to load is not an empty club', () => {
  it('says the list could not be loaded, and Retry reads it again', async () => {
    fx.members = [
      { data: null, error: { message: 'Network Request Failed' } },
      { data: [kingfish], error: null },
    ];
    openCashier({ walletType: 'club_bank' });
    expect(await screen.findByText('The Member List Could Not Be Loaded.')).toBeTruthy();
    expect(screen.queryByText('No Members In This Club Yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await toPlayerWallet();
    expect(await screen.findByRole('button', { name: /Kingfish/ })).toBeTruthy();
  });
});

describe('C2-16: the ledger export cannot carry a spreadsheet formula', () => {
  it('neutralises a cell that begins with = + - or @', async () => {
    fx.ledgers = [
      {
        data: {
          authorized: true,
          total: 1,
          types: [],
          totals: { into_bank: 0, out_of_bank: 10, net: -10 },
          rows: [
            {
              id: 'r1',
              created_at: '2026-10-09T10:00:00Z',
              amount: 10,
              transaction_type: 'club_bank_send',
              notes: '=HYPERLINK("http://x","y")',
              balance_after: 990,
              from_name: '@evil',
              to_name: '+cmd',
              metadata: { destination: 'player_wallet' },
              is_reversed: false,
              reversible: false,
            },
          ],
        },
        error: null,
      },
    ];
    openCashier({ walletType: 'club_bank' });
    fireEvent.click(await screen.findByRole('tab', { name: 'Transaction Ledger' }));
    const exportButton = await screen.findByRole('button', { name: 'Export CSV' });
    await waitFor(() => expect(exportButton).not.toBeDisabled());
    fireEvent.click(exportButton);
    expect(fx.blobs).toHaveLength(1);
    const csv = await fx.blobs[0].text();
    expect(csv).toContain(`'=HYPERLINK`);
    expect(csv).toContain(`'@evil`);
    expect(csv).toContain(`'+cmd`);
    expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/m);
  });
});

describe('C2-17: the modal, item by item', () => {
  it('renders into <body>, clear of <main> and its isolated stacking context', async () => {
    const { view } = openCashier({ walletType: 'club_bank' });
    await screen.findByRole('dialog');
    const overlay = document.querySelector('.cbc-overlay');
    expect(overlay?.parentElement).toBe(document.body);
    expect(view.container.contains(overlay)).toBe(false);
  });

  it('prints exact wallet amounts below one million', async () => {
    fx.club = { ...fx.club, chip_treasury: 12500.5 };
    openCashier({ walletType: 'club_bank' });
    await waitFor(() => expect(bankFigure()).toHaveTextContent('12,500.50'));
  });

  it('reads a missing agents row as an empty wallet, not an unknown one', async () => {
    fx.agentRow = null;
    openCashier({ role: 'agent', walletType: 'agent_wallet' });
    /* UPDATED 2026-10-09 (merged with launch audit D-16): the empty wallet is
       said in words where the figure prints, "No Agent Float Yet", never
       "Unavailable" or "..." (unknown), and it still spends nothing. */
    await waitFor(() => expect(bankFigure()?.textContent).toBe('No Agent Float Yet'));
    expect(document.body.textContent).not.toContain('Unavailable');
  });

  it('never names a member by a slice of their internal id', async () => {
    fx.members = [{ data: [{ ...kingfish, name: null, username: '' }], error: null }];
    openCashier({ walletType: 'club_bank' });
    await toPlayerWallet();
    expect(await screen.findByText('Unnamed Member')).toBeTruthy();
    expect(screen.queryByText(/Member 44444444/)).toBeNull();
  });

  it('title-cases the recipient in the receipt', async () => {
    openCashier({ walletType: 'club_bank' });
    await toPlayerWallet();
    await pick(/Kingfish/);
    typeAmount('10');
    await waitFor(() => expect(plate('Confirm')).not.toBeDisabled());
    fireEvent.click(plate('Confirm'));
    await waitFor(() => expect(fx.toast.success).toHaveBeenCalled());
    expect(fx.toast.success.mock.calls[0][0]).toContain('To Kingfish');
  });

  it('a ledger page that overlaps the last one adds no duplicate rows', async () => {
    const row = (id: string) => ({
      id,
      created_at: '2026-10-09T10:00:00Z',
      amount: 10,
      transaction_type: 'club_bank_send',
      notes: null,
      balance_after: 990,
      from_name: 'Club Bank',
      to_name: 'Kingfish',
      metadata: null,
      is_reversed: false,
      reversible: false,
    });
    fx.ledgers = [
      {
        data: { authorized: true, total: 5, types: [], rows: ['r1', 'r2', 'r3'].map(row) },
        error: null,
      },
      // A row landed between the two reads, so the next offset page starts one early.
      {
        data: { authorized: true, total: 6, types: [], rows: ['r3', 'r4', 'r5'].map(row) },
        error: null,
      },
    ];
    openCashier({ walletType: 'club_bank' });
    fireEvent.click(await screen.findByRole('tab', { name: 'Transaction Ledger' }));
    await waitFor(() => expect(document.querySelectorAll('.cbc-tx')).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Load More' }));
    await waitFor(() => expect(sends('fn_club_bank_ledger')).toHaveLength(2));
    await waitFor(() => expect(document.querySelectorAll('.cbc-tx')).toHaveLength(5));
  });

  it('takes keyboard focus on open, keeps Tab inside, and gives it back on close', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open The Cashier';
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = render(
      <WalletCashierModal
        isOpen
        onClose={onClose}
        clubId={CLUB}
        role="owner"
        walletType="club_bank"
      />
    );
    await screen.findByRole('button', { name: 'Player Wallet' });
    const panel = document.querySelector('.cbc-panel') as HTMLElement;
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    // The same selector the modal cycles through.
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
    focusables[focusables.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(focusables[0]);
    view.rerender(
      <WalletCashierModal
        isOpen={false}
        onClose={onClose}
        clubId={CLUB}
        role="owner"
        walletType="club_bank"
      />
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });
});

describe('the confirm box is still the same box', () => {
  it('a Club Bank send at a quarter of the bank still asks, naming the Club Bank, to one decimal', async () => {
    openCashier({ walletType: 'club_bank' });
    await toPlayerWallet();
    await pick(/Kingfish/);
    typeAmount('250');
    await waitFor(() => expect(plate('Confirm')).not.toBeDisabled());
    fireEvent.click(plate('Confirm'));
    const box = await screen.findByRole('alert');
    expect(within(box).getByText(/That Is 25\.0 Percent Of The Club Bank\./)).toBeTruthy();
  });
});

describe('The Sender Chooses The Recipient Wallet', () => {
  it.each(['owner', 'co_owner', 'super_agent', 'agent', 'sub_agent'])(
    'sends to the player wallet of a %s without replacing the selection',
    async (role) => {
      fx.agentRow = { agent_wallet_balance: 1000, is_prepaid: true, credit_used: 0 };
      fx.members = [{ data: [{ ...kingfish, role }], error: null }];
      openCashier({ role: 'owner', walletType: 'agent_wallet' });
      await pick(/Kingfish/);
      // Picking opens the player's card (2026-10-19); the wallet is chosen on it.
      fireEvent.change(screen.getByRole('combobox', { name: 'Send Into' }), {
        target: { value: 'player_wallet' },
      });
      typeAmount('5');
      await waitFor(() => expect(plate('Send Chips')).not.toBeDisabled());
      fireEvent.click(plate('Send Chips'));
      await waitFor(() => expect(sends('fn_agent_wallet_send')).toHaveLength(1));
      expect(sends('fn_agent_wallet_send')[0].args.p_destination).toBe('player_wallet');
    }
  );

  it.each(['player_wallet', 'agent_wallet'])(
    'funds the owner self from the club bank into %s',
    async (destination) => {
      fx.members = [
        {
          data: [{ ...kingfish, user_id: '11111111-1111-4111-8111-111111111111', role: 'owner' }],
          error: null,
        },
      ];
      openCashier({ role: 'owner', walletType: 'club_bank' });
      if (destination === 'player_wallet') await toPlayerWallet();
      await pick(/Kingfish/);
      typeAmount('5');
      await waitFor(() => expect(plate('Confirm')).not.toBeDisabled());
      fireEvent.click(plate('Confirm'));
      await waitFor(() => expect(sends('fn_club_bank_send')).toHaveLength(1));
      expect(sends('fn_club_bank_send')[0].args).toMatchObject({
        p_to_user_id: '11111111-1111-4111-8111-111111111111',
        p_destination: destination,
      });
    }
  );
});

describe('The Main Bank Never Fails Silently', () => {
  it('shows a definitive bank refusal inside the cashier', async () => {
    fx.members = [{ data: [{ ...kingfish, role: 'agent' }], error: null }];
    fx.sends = [
      { data: { success: false, error: 'Recipient Wallet Is Unavailable' }, error: null },
    ];
    openCashier({ role: 'owner', walletType: 'club_bank' });
    await pick(/Kingfish/);
    typeAmount('5');
    await waitFor(() => expect(plate('Confirm')).not.toBeDisabled());
    fireEvent.click(plate('Confirm'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Recipient Wallet Is Unavailable');
    expect(fx.toast.success).not.toHaveBeenCalled();
    expect(sends('fn_club_bank_send')[0].args.p_destination).toBe('agent_wallet');
  });
});

describe('Club Bank funding follows the selected account', () => {
  it.each([
    ['agent_wallet', 'fn_agent_wallet_send'],
    ['promo_wallet', 'fn_club_promo_wallet_send'],
  ])('uses %s for the spend and keeps the bank ledger', async (source, rpc) => {
    fx.agentRow = { agent_wallet_balance: 1000, promo_wallet_balance: 80, is_prepaid: true };
    fx.club.promo_balance = 6000;
    fx.members = [{ data: [{ ...kingfish, role: 'agent' }], error: null }];
    openCashier({ walletType: 'club_bank' });
    await pick(/Kingfish/);
    typeAmount('5');
    const sourceSelect = screen.getByRole('combobox', { name: 'Send From' });
    fireEvent.change(sourceSelect, { target: { value: source } });
    await waitFor(() => expect(plate('Confirm')).toBeEnabled());
    expect(screen.getByRole('textbox', { name: 'Chips To Send' })).toHaveValue('5');
    expect(screen.getByRole('tab', { name: 'Transaction Ledger' })).toBeInTheDocument();
    const face = screen.getByRole('region', { name: 'Selected Player' });
    if (source === 'promo_wallet') {
      expect(face).toHaveTextContent('Promo Wallet');
      expect(face).toHaveTextContent('80.00');
    }
    fireEvent.click(plate('Confirm'));
    await waitFor(() => expect(sends(rpc)).toHaveLength(1));
    expect(sends(rpc)[0].args).toMatchObject({ p_amount: 5, p_destination: 'agent_wallet' });
    expect(sends('fn_club_bank_send')).toHaveLength(0);
  });
});

describe('Agent Own Player Funding With Full Browser Storage', () => {
  it('discovers the agent and sends to their own player wallet despite quota failure', async () => {
    fx.agentRow = { agent_wallet_balance: 1000, is_prepaid: true, credit_used: 0 };
    fx.members = [
      {
        data: [{ ...kingfish, user_id: '11111111-1111-4111-8111-111111111111', role: 'agent' }],
        error: null,
      },
    ];
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    });
    try {
      openCashier({ role: 'agent', walletType: 'agent_wallet' });
      await pick(/Kingfish/);
      typeAmount('5');
      await waitFor(() => expect(plate('Send Chips')).not.toBeDisabled());
      fireEvent.click(plate('Send Chips'));
      await waitFor(() => expect(sends('fn_agent_wallet_send')).toHaveLength(1));
      expect(sends('fn_agent_wallet_send')[0].args).toMatchObject({
        p_to_user_id: '11111111-1111-4111-8111-111111111111',
        p_destination: 'player_wallet',
        p_amount: 5,
      });
      await waitFor(() => expect(fx.toast.success).toHaveBeenCalled());
    } finally {
      write.mockRestore();
    }
  });
});

it.each(
  ['super_agent', 'agent', 'sub_agent'].flatMap((role) =>
    ['0.01', '1.13'].map((amount) => [role, amount])
  )
)('%s moves %s own agent chips to their player wallet without rounding', async (role, amount) => {
  fx.agentRow = { agent_wallet_balance: 1000, is_prepaid: true, credit_used: 0 };
  fx.members = [
    { data: [{ ...kingfish, user_id: '11111111-1111-4111-8111-111111111111', role }], error: null },
  ];
  openCashier({ role, walletType: 'agent_wallet' });
  const ownEntry = await screen.findByRole('button', { name: 'To My Player Wallet' });
  await waitFor(() => expect(ownEntry).toBeEnabled());
  fireEvent.click(ownEntry);
  typeAmount(amount);
  await waitFor(() => expect(plate('Send Chips')).toBeEnabled());
  fireEvent.click(plate('Send Chips'));
  await waitFor(() => expect(sends('fn_agent_wallet_send')).toHaveLength(1));
  expect(sends('fn_agent_wallet_send')[0].args).toMatchObject({
    p_amount: Number(amount),
    p_destination: 'player_wallet',
    p_to_user_id: '11111111-1111-4111-8111-111111111111',
  });
  await waitFor(() =>
    expect(fx.toast.success.mock.calls.at(-1)?.[0]).toContain(`Sent ${amount} Chips`)
  );
});
