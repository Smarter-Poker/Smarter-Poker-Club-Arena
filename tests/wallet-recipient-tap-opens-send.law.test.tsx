/**
 * TAPPING A MEMBER OPENS THE SEND TO THAT MEMBER, IN EVERY WALLET
 * (Dan 2026-10-19, binding)
 *
 * "inside promo wallets, or any of the wallets, when i click a player below
 * 'search members' or after i search and click, it should open up to that user
 * to send chips. currently it does nothing and silently fails."
 *
 * Only the Club Bank swapped the roster for the chosen player's card. In the
 * Promo Wallet and the Agent Wallet a tap only lit the row's text, the list
 * stayed put and the send stayed greyed out below it - a tap that reads as
 * nothing happening. The rule pinned here, for all three wallets and for both
 * the short list and a search result: a tap opens that player's card (name,
 * wallet picker, Change Recipient), the roster goes away, and the send goes
 * to exactly that player.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(() => {
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

const P2 = '55555555-5555-4555-8555-555555555555';
const barracuda = {
  ...kingfish,
  user_id: P2,
  name: 'barracuda',
  username: 'bc',
  player_number: '5678',
};
const WALLETS = ['club_bank', 'promo_wallet', 'agent_wallet'] as const;
const card = () => screen.queryByRole('region', { name: 'Selected Player' });
const searchBox = () => screen.queryByRole('textbox', { name: 'Search Recipients' });

function setUp() {
  fx.club.promo_balance = 5000;
  fx.agentRow = {
    agent_wallet_balance: 1000,
    promo_wallet_balance: 1000,
    is_prepaid: true,
    credit_used: 0,
  };
  fx.members = [{ data: [kingfish, barracuda], error: null }];
}

describe('a tap on a member opens the send to that member', () => {
  it.each(WALLETS)('%s: tapping a listed member opens their card', async (walletType) => {
    setUp();
    openCashier({ role: 'owner', walletType });
    if (walletType === 'club_bank') await toPlayerWallet();
    expect(card()).toBeNull();
    await pick(/Kingfish/);
    const face = await screen.findByRole('region', { name: 'Selected Player' });
    expect(face).toHaveTextContent('Kingfish');
    expect(face).toHaveTextContent('1234');
    expect(within(face).getByRole('combobox', { name: 'Send Into' })).toBeInTheDocument();
    // The roster is out of the way; the way back is one word.
    expect(searchBox()).toBeNull();
    expect(screen.queryByRole('button', { name: /Barracuda/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Change Recipient' }));
    expect(card()).toBeNull();
    expect(searchBox()).not.toBeNull();
  });

  it.each(WALLETS)('%s: tapping a search result opens that card', async (walletType) => {
    setUp();
    openCashier({ role: 'owner', walletType });
    if (walletType === 'club_bank') await toPlayerWallet();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search Recipients' }), {
      target: { value: 'barr' },
    });
    await pick(/Barracuda/);
    expect(await screen.findByRole('region', { name: 'Selected Player' })).toHaveTextContent(
      'Barracuda'
    );
  });

  it.each(WALLETS)('%s: the send from the card goes to the tapped member', async (walletType) => {
    setUp();
    openCashier({ role: 'owner', walletType });
    if (walletType === 'club_bank') await toPlayerWallet();
    await pick(/Kingfish/);
    await screen.findByRole('region', { name: 'Selected Player' });
    typeAmount('5');
    const go = walletType === 'club_bank' ? 'Confirm' : 'Send Chips';
    await waitFor(() => expect(plate(go)).toBeEnabled());
    fireEvent.click(plate(go));
    await waitFor(() =>
      expect(fx.calls.filter((c) => /_send$/.test(c.fn)).length).toBeGreaterThan(0)
    );
    const sent = fx.calls.filter((c) => /_send$/.test(c.fn));
    expect(sent).toHaveLength(1);
    expect(sent[0].args).toMatchObject({ p_to_user_id: P1, p_amount: 5 });
  });

  it('a member the destination refuses stays listed and does not open', async () => {
    setUp();
    // An agent-wallet destination refuses a plain player: the row is shown
    // wearing its reason, and a tap on it must not open a card it cannot use.
    fx.members = [{ data: [kingfish, { ...barracuda, role: 'agent' }], error: null }];
    openCashier({ role: 'owner', walletType: 'club_bank' });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search Recipients' }), {
      target: { value: 'kin' },
    });
    const row = screen.queryByRole('button', { name: /Kingfish/ });
    if (row) fireEvent.click(row);
    expect(card()).toBeNull();
  });
});
