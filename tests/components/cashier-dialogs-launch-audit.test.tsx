import { cashierRecoveryRpc } from '../helpers/cashierRecoveryRpc';
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CLUB ARENA CASHIER LAUNCH AUDIT, DIALOGS (2026-10-09): the behavioural
 * half of tests/cashier-dialogs-launch-audit.law.test.ts. Each case renders
 * the real dialog against a scripted Supabase and proves the fixed behaviour,
 * not the source text.
 *
 * MERGED 2026-10-09 with the first cashier swarm (audit C2-17): the Club Bank
 * cashier renders into <body> now (clear of <main>'s isolated stacking
 * context), so its text and panels are read from the document rather than
 * the render container, and its balances print the house way (compactChips:
 * 1,000 is "1K", 9,500 is "9.5K"). What each case requires is unchanged.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const CLUB = '22222222-2222-4222-8222-222222222222';
const PLAYER = '33333333-3333-4333-8333-333333333333';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const recovery = cashierRecoveryRpc();
const fx = vi.hoisted(() => ({
  rpc: vi.fn(),
  tables: vi.fn(),
  balances: vi.fn(),
  downloads: [] as Array<{ name: string; blob: Blob }>,
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: '11111111-1111-4111-8111-111111111111' }, isHydrating: false }),
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeDebounced: vi.fn(() => () => {}),
  },
}));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: vi.fn(),
  useMasterBusSubscriptions: vi.fn(),
}));
vi.mock('../../src/utils/clubIdResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/clubIdResolver')>()),
  resolveClubUUID: async (id: string) => id,
  resolveClubUUIDSync: (id: string) => id,
  isUUID: (id: string) => /^[0-9a-f-]{36}$/i.test(id),
}));
vi.mock('../../src/hooks/useBridgeRate', () => ({
  useBridgeRate: () => ({ diamondsPerChip: 1, failed: false }),
}));
vi.mock('../../src/lib/ownProfile', () => ({
  ownProfile: () => ({
    select: () => ({ maybeSingle: async () => ({ data: { diamonds: 5000 }, error: null }) }),
  }),
}));
vi.mock('../../src/services/cashierBalanceRead', () => ({
  readCashierBalances: (...args: unknown[]) => fx.balances(...args),
}));
vi.mock('../../src/utils/downloadCsv', () => ({
  downloadBlob: (name: string, blob: Blob) => fx.downloads.push({ name, blob }),
}));
vi.mock('../../src/components/arena/DiamondCustodyBalance', () => ({
  default: () => <p>Diamond Balance</p>,
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown> = {}) =>
      recovery.answer(name, args) ?? fx.rpc(name, args),
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          filters[k] = v;
          return q;
        },
        or: () => q,
        limit: () => q,
        range: () => q,
        order: () => q,
        abortSignal: () => q,
        maybeSingle: () => fx.tables(table, filters),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(fx.tables(table, filters)).then(resolve),
      };
      return q;
    },
  },
}));

import WalletCashierModal from '../../src/components/wallet/WalletCashierModal';
import PlayerWalletModal from '../../src/components/wallet/PlayerWalletModal';
import ChipMintModal from '../../src/components/wallet/ChipMintModal';
import DiamondWalletModal from '../../src/components/wallet/DiamondWalletModal';
import { CashierModal } from '../../src/components/table/CashierModal';

/* An agent by default: the Club Bank's Send tab opens on the agent wallet,
   which a plain player cannot hold, so a player would be kept off the short
   list. The Claim case asks for a player explicitly. */
const member = (id: string, chip_balance: number, role = 'agent') => ({
  user_id: id,
  role,
  name: 'Fish Finder',
  chip_balance,
  avatar_url: '',
  username: 'fish',
  player_number: '0001',
});

const ledgerPage = (overrides: Record<string, unknown> = {}) => ({
  authorized: true,
  total: 1,
  types: ['send'],
  totals: { into_bank: 0, out_of_bank: 500, net: -500 },
  rows: [
    {
      id: 'tx-1',
      created_at: '2026-10-09T12:00:00.000Z',
      amount: 500,
      transaction_type: 'send',
      notes: '=1+1',
      balance_after: 9500,
      from_name: 'Club Bank',
      to_name: '-2+3|cmd',
      metadata: { destination: 'agent_wallet' },
      is_reversed: false,
      reversible: false,
    },
  ],
  ...overrides,
});

const snapshot = (name = 'Test Club') => ({
  clubId: CLUB,
  name,
  inUnion: false,
  bank: 10000,
  credit: 0,
  promoPot: 0,
  promoFloat: null,
  hasFloat: null,
});

const settle = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });

beforeEach(() => {
  recovery.clear();
  fx.downloads.length = 0;
  fx.rpc.mockReset();
  fx.tables.mockReset();
  fx.balances.mockReset();
  fx.balances.mockResolvedValue(snapshot());
  fx.tables.mockResolvedValue({ data: null, error: null });
  fx.rpc.mockImplementation(async (name: string) => {
    if (name === 'fn_club_cashier_members') return { data: [member(PLAYER, 1000)], error: null };
    if (name === 'fn_club_bank_ledger') return { data: ledgerPage(), error: null };
    if (name === 'fn_club_money_panel')
      return {
        data: {
          authorized: true,
          scope: 'club',
          club_name: 'Test Club',
          in_union: false,
          union_id: null,
        },
        error: null,
      };
    return { data: { success: true }, error: null };
  });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

const openCashier = async (
  props: Partial<React.ComponentProps<typeof WalletCashierModal>> = {}
) => {
  const onClose = vi.fn();
  const view = render(
    <WalletCashierModal
      isOpen
      onClose={onClose}
      clubId={CLUB}
      role="owner"
      walletType="club_bank"
      {...props}
    />
  );
  await waitFor(() => expect(screen.getByText('Fish Finder')).toBeTruthy());
  return { onClose, view };
};

describe('D-01: Escape belongs to the top sheet', () => {
  it('closes the stacked mint and leaves the cashier open', async () => {
    const { onClose } = await openCashier();
    fireEvent.click(screen.getByText('Mint Chips Into The Club Bank'));
    await waitFor(() => expect(screen.getByLabelText('Diamonds To Convert')).toBeTruthy());

    fireEvent.keyDown(document, { key: 'Escape' });
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Diamonds To Convert')).toBeNull();

    // With the mint gone, Escape reaches the cashier again.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('never closes the cashier while a mint is in flight', async () => {
    const mint = deferred<{ data: unknown; error: null }>();
    fx.rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_club_cashier_members') return { data: [member(PLAYER, 1000)], error: null };
      if (name === 'fn_club_money_panel')
        return { data: { authorized: true, scope: 'club', club_name: 'Test Club' }, error: null };
      if (name === 'fn_mint_chips_from_diamonds') return mint.promise;
      return { data: null, error: null };
    });
    const { onClose } = await openCashier();
    fireEvent.click(screen.getByText('Mint Chips Into The Club Bank'));
    const input = await screen.findByLabelText('Diamonds To Convert');
    await waitFor(() => expect(screen.getByText('Mint Chips')).toBeTruthy());
    fireEvent.change(input, { target: { value: '100' } });
    await settle();
    fireEvent.click(screen.getByText('Mint Chips'));
    await settle();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Diamonds To Convert')).toBeTruthy();

    await act(async () => {
      mint.resolve({ data: { success: true, chips: 100, diamonds_after: 4900 }, error: null });
      await settle();
    });
  });
});

describe('D-02: the corner X respects the in-flight lock', () => {
  it('is absent while a send is travelling, and the cashier closes itself once it lands', async () => {
    const send = deferred<{ data: unknown; error: null }>();
    fx.rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_club_cashier_members') return { data: [member(PLAYER, 1000)], error: null };
      if (name === 'fn_club_bank_send') return send.promise;
      return { data: null, error: null };
    });
    const { onClose } = await openCashier();
    expect(screen.getByTestId('sc-close')).toBeTruthy();
    fireEvent.click(screen.getByText('Fish Finder'));
    fireEvent.change(screen.getByLabelText('Chips To Send'), { target: { value: '100' } });
    await settle();
    fireEvent.click(screen.getByText('Confirm', { selector: '.sc-plate__text' }));
    await settle();

    expect(screen.queryByTestId('sc-close')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      send.resolve({ data: { success: true }, error: null });
      await settle();
    });
    // Dan, 2026-10-22: a confirmed send toasts and closes the cashier by
    // itself; nobody has to X off a finished movement.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('D-16: an agent without a float row is told so', () => {
  it('prints "No Agent Float Yet" rather than "Unavailable" or an invented 0', async () => {
    fx.balances.mockResolvedValue({
      ...snapshot(),
      bank: 0,
      promoFloat: 0,
      hasFloat: false,
    });
    await openCashier({ walletType: 'agent_wallet', role: 'agent' });
    await waitFor(() => expect(screen.getByText('No Agent Float Yet')).toBeTruthy());
    expect(document.body.textContent).not.toContain('Unavailable');
    expect(screen.getByText('No Agent Float Yet').tagName).toBe('STRONG');
  });
});

describe('D-03: nothing from the previous club survives a reopen', () => {
  it('drops the previous club name and ledger figures while the next club loads', async () => {
    const { view } = await openCashier();
    fireEvent.click(screen.getByText('Transaction Ledger'));
    await waitFor(() => expect(screen.getByText('Test Club')).toBeTruthy());
    await waitFor(() => expect(document.body.textContent).toContain('Bank After 9,500.00'));

    // Club B: balances and ledger never answer, so whatever prints is a leak.
    fx.balances.mockReturnValue(new Promise(() => {}));
    fx.rpc.mockImplementation(() => new Promise(() => {}));
    view.rerender(
      <WalletCashierModal
        isOpen
        onClose={() => {}}
        clubId={PLAYER}
        role="owner"
        walletType="club_bank"
      />
    );
    await settle();
    expect(document.body.textContent).not.toContain('Test Club');
    expect(document.body.textContent).toContain('Club Arena');
    expect(document.body.textContent).not.toContain('9.5K');
    expect(document.body.textContent).not.toContain('-500');
  });
});

describe('promo account balances survive role resolution', () => {
  it('re-reads both balances when the viewer role changes while the promo cashier stays open', async () => {
    fx.balances.mockResolvedValue({ ...snapshot(), promoPot: 3000, promoFloat: 0, hasFloat: true });
    const { view } = await openCashier({ walletType: 'promo_wallet' });
    const figure = () => document.querySelector('.cbc-bank strong')?.textContent;
    await waitFor(() => expect(figure()).toBe('3,000.00'));
    fireEvent.click(screen.getByRole('radio', { name: 'My Promo Float 0.00' }));
    await waitFor(() => expect(figure()).toBe('0.00'));
    view.rerender(
      <WalletCashierModal
        isOpen
        onClose={() => {}}
        clubId={CLUB}
        role="co_owner"
        walletType="promo_wallet"
      />
    );
    await waitFor(() => expect(figure()).toBe('3,000.00'));
    expect(fx.balances).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('radio', { name: 'My Promo Float 0.00' })).toBeTruthy();
  });
});

describe('agents reclaim from their own wallets at any time', () => {
  it.each(['agent', 'super_agent', 'sub_agent'])(
    'opens the personal claim form for %s with no recent send',
    async (role) => {
      const original = fx.rpc.getMockImplementation()!;
      fx.rpc.mockImplementation(async (name, args) =>
        name === 'fn_cashier_recipient_wallet_balances'
          ? {
              data: [{ user_id: USER, player_wallet: 250, agent_wallet: 500, promo_wallet: 20 }],
              error: null,
            }
          : name === 'fn_agent_wallet_reversible'
            ? { data: [], error: null }
            : original(name, args)
      );
      await openCashier({ walletType: 'agent_wallet', role });
      fireEvent.click(screen.getByRole('tab', { name: 'Claim Back' }));
      fireEvent.click(screen.getByRole('button', { name: 'Claim From My Wallets' }));
      await waitFor(() =>
        expect(screen.getByRole('region', { name: 'Selected Player' })).toHaveTextContent('250.00')
      );
      const returns = screen.getByRole('combobox', { name: 'Claim Into' });
      expect(returns).toHaveValue('agent_wallet');
      expect(within(returns).getByRole('option', { name: 'My Promo Wallet' })).toBeTruthy();
      expect(within(returns).queryByRole('option', { name: 'My Player Wallet' })).toBeNull();
      fireEvent.change(screen.getByLabelText('Chips To Claim Back'), { target: { value: '50' } });
      fireEvent.click(screen.getByRole('button', { name: 'Claim Chips', exact: true }));
      fireEvent.click(screen.getByRole('button', { name: 'Yes, Claim It', exact: true }));
      await waitFor(() =>
        expect(fx.rpc).toHaveBeenCalledWith(
          'fn_club_wallet_claim_back',
          expect.objectContaining({
            p_from_user_id: USER,
            p_source: 'player_wallet',
            p_destination: 'agent_wallet',
            p_amount: 50,
          })
        )
      );
      const args = fx.rpc.mock.calls.find(([name]) => name === 'fn_club_wallet_claim_back')![1];
      expect(args.p_transaction_id).toBeUndefined();
    }
  );
});

it.each(
  ['agent', 'super_agent', 'sub_agent'].flatMap((role) =>
    ['0.01', '1.13'].map((amount) => [role, amount])
  )
)('moves %s personal player chips to their agent wallet exactly: %s', async (role, amount) => {
  const original = fx.rpc.getMockImplementation()!;
  fx.rpc.mockImplementation(async (name, args) =>
    name === 'fn_cashier_recipient_wallet_balances'
      ? {
          data: [{ user_id: USER, player_wallet: 250.13, agent_wallet: 500, promo_wallet: 20 }],
          error: null,
        }
      : name === 'fn_agent_wallet_reversible'
        ? { data: [], error: null }
        : original(name, args)
  );
  await openCashier({ walletType: 'agent_wallet', role });
  fireEvent.click(screen.getByRole('tab', { name: 'Claim Back' }));
  fireEvent.click(screen.getByRole('button', { name: 'Claim From My Wallets' }));
  await waitFor(() =>
    expect(screen.getByRole('region', { name: 'Selected Player' })).toHaveTextContent('250.13')
  );
  const input = screen.getByLabelText('Chips To Claim Back');
  expect(input).toHaveAttribute('inputmode', 'decimal');
  fireEvent.change(input, { target: { value: amount } });
  const submit = screen.getByRole('button', { name: 'Claim Chips', exact: true });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  expect(screen.getByRole('alert')).toHaveTextContent(
    `Claim ${amount} Chips From My Account Into My Agent Wallet?`
  );
  fireEvent.click(screen.getByRole('button', { name: 'Yes, Claim It', exact: true }));
  await waitFor(() =>
    expect(fx.rpc).toHaveBeenCalledWith(
      'fn_club_wallet_claim_back',
      expect.objectContaining({
        p_from_user_id: USER,
        p_source: 'player_wallet',
        p_destination: 'agent_wallet',
        p_amount: Number(amount),
      })
    )
  );
  const args = fx.rpc.mock.calls.find(([name]) => name === 'fn_club_wallet_claim_back')![1];
  expect(args.p_transaction_id).toBeUndefined();
});

it('starts an admin personal claim on its eligible agent wallet', async () => {
  const original = fx.rpc.getMockImplementation()!;
  fx.rpc.mockImplementation(async (name, args) =>
    name === 'fn_cashier_recipient_wallet_balances'
      ? {
          data: [{ user_id: USER, player_wallet: null, agent_wallet: 0, promo_wallet: 0 }],
          error: null,
        }
      : name === 'fn_agent_wallet_reversible'
        ? { data: [], error: null }
        : original(name, args)
  );
  await openCashier({ walletType: 'agent_wallet', role: 'admin' });
  fireEvent.click(screen.getByRole('tab', { name: 'Claim Back' }));
  fireEvent.click(screen.getByRole('button', { name: 'Claim From My Wallets' }));
  await waitFor(() =>
    expect(screen.getByRole('region', { name: 'Selected Player' })).toHaveTextContent('0.00')
  );
  expect(screen.getByRole('combobox', { name: 'Claim From' })).toHaveValue('agent_wallet');
  expect(screen.getByRole('combobox', { name: 'Claim Into' })).toHaveValue('club_bank');
  expect(screen.getByRole('button', { name: 'Claim Chips', exact: true })).toBeDisabled();
});

describe('D-04: the holder figure follows the roster after a claim', () => {
  it('re-reads the chosen player from the refreshed members', async () => {
    let claimed = false;
    fx.rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_club_cashier_members')
        return { data: [member(PLAYER, claimed ? 500 : 1000, 'player')], error: null };
      if (name === 'fn_club_wallet_claim_back') {
        claimed = true;
        return { data: { success: true }, error: null };
      }
      return { data: null, error: null };
    });
    await openCashier({ initialDestination: 'player_wallet' });
    fireEvent.click(screen.getByText('Claim Back'));
    // A player holds no agent wallet, so the source is their player wallet.
    fireEvent.click(screen.getByText('Player Wallet', { selector: '.cbc-seg button' }));
    const player = await screen.findByText('Fish Finder');
    fireEvent.click(player);
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Selected Player' })).getByText('1,000.00')
      ).toBeTruthy()
    );

    fireEvent.change(screen.getByLabelText('Chips To Claim Back'), { target: { value: '500' } });
    await settle();
    fireEvent.click(screen.getByText('Confirm', { selector: '.sc-plate__text' }));
    await settle();
    fireEvent.click(screen.getByText('Yes, Claim It', { selector: '.sc-plate__text' }));
    await waitFor(() => expect(claimed).toBe(true));
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Selected Player' })).getByText('500.00')
      ).toBeTruthy()
    );
  });
});

describe('D-15: the amount is read from its spelling', () => {
  it('refuses "1e3" on the cashier even though Number() reads a thousand', async () => {
    await openCashier();
    fireEvent.click(screen.getByText('Fish Finder'));
    fireEvent.change(screen.getByLabelText('Chips To Send'), { target: { value: '1e3' } });
    await settle();
    const plate = screen.getByText('Confirm', { selector: '.sc-plate__text' }).closest('button');
    expect(plate?.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Chips To Send'), { target: { value: '1000' } });
    await settle();
    expect(
      screen.getByText('Confirm', { selector: '.sc-plate__text' }).closest('button')?.disabled
    ).toBe(false);
  });
});

describe('S-04: the ledger CSV cannot carry a formula', () => {
  it('prefixes formula triggers, keeps figures raw and writes the BOM', async () => {
    const ledger = deferred<{ data: ReturnType<typeof ledgerPage>; error: null }>();
    const original = fx.rpc.getMockImplementation()!;
    fx.rpc.mockImplementation((name: string, args: Record<string, unknown>) =>
      name === 'fn_club_bank_ledger' ? ledger.promise : original(name, args)
    );
    await openCashier();
    fireEvent.click(screen.getByText('Transaction Ledger'));
    const exportButton = await screen.findByRole('button', { name: 'Export CSV' });
    // The control is rendered before its rows arrive. Visibility is not readiness.
    await waitFor(() => expect(exportButton).toBeDisabled());
    expect(fx.downloads).toHaveLength(0);
    await act(async () => ledger.resolve({ data: ledgerPage(), error: null }));
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    await waitFor(() => expect(fx.downloads).toHaveLength(1));
    const text = await fx.downloads[0].blob.text();
    expect(text.startsWith('﻿')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe(
      '"When","Type","Amount","From","To","Into Wallet","Bank Balance After","Reversed","Note"'
    );
    expect(lines[1]).toContain('"\'=1+1"');
    expect(lines[1]).toContain('"\'-2+3|cmd"');
    expect(lines[1]).toContain('"500"');
    expect(lines[1]).toContain('"9500"');
    expect(lines[1]).toContain('"2026-10-09T12:00:00.000Z"');
  });
});

describe('D-05: the player wallet paints the club that was asked for last', () => {
  it('discards club A when its slow answer lands after club B', async () => {
    const slow = deferred<{ data: unknown; error: null }>();
    fx.rpc.mockImplementation(async (name: string, args: { p_club_id: string }) => {
      if (name !== 'fn_my_wallet_ledger') return { data: null, error: null };
      if (args.p_club_id === CLUB) return slow.promise;
      return {
        data: {
          authorized: true,
          role: 'player',
          total: 0,
          balances: { player_wallet: 42 },
          rows: [],
        },
        error: null,
      };
    });
    const view = render(<PlayerWalletModal isOpen onClose={() => {}} clubId={CLUB} />);
    await settle();
    view.rerender(<PlayerWalletModal isOpen={false} onClose={() => {}} clubId={CLUB} />);
    view.rerender(<PlayerWalletModal isOpen onClose={() => {}} clubId={PLAYER} />);
    await waitFor(() =>
      expect(view.container.querySelector('.cbc-bank strong')).toHaveTextContent('42')
    );
    await act(async () => {
      slow.resolve({
        data: {
          authorized: true,
          role: 'player',
          total: 0,
          balances: { player_wallet: 999999 },
          rows: [],
        },
        error: null,
      });
      await settle();
    });
    expect(view.container.querySelector('.cbc-bank strong')).toHaveTextContent('42');
    expect(view.container.textContent).not.toContain('999,999');
  });
});

describe('D-11: focus is moved in, kept in and returned', () => {
  const trigger = () => {
    const button = document.createElement('button');
    button.textContent = 'Open';
    document.body.appendChild(button);
    button.focus();
    return button;
  };

  it('PlayerWalletModal traps Tab inside its panel and returns focus on close', async () => {
    fx.rpc.mockResolvedValue({
      data: {
        authorized: true,
        role: 'player',
        total: 0,
        balances: { player_wallet: 1 },
        rows: [],
      },
      error: null,
    });
    const opener = trigger();
    const view = render(<PlayerWalletModal isOpen onClose={() => {}} clubId={CLUB} />);
    const panel = view.container.querySelector('.cbc-panel')!;
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    expect(document.activeElement?.classList.contains('sc__close')).toBe(false);

    const focusable = panel.querySelectorAll<HTMLElement>('button:not([disabled])');
    focusable[focusable.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusable[0]);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);

    view.rerender(<PlayerWalletModal isOpen={false} onClose={() => {}} clubId={CLUB} />);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('the cashier hands the keyboard to the stacked mint and takes it back', async () => {
    const opener = trigger();
    await openCashier();
    const panel = document.querySelector('.cbc-panel')!;
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    fireEvent.click(screen.getByText('Mint Chips Into The Club Bank'));
    const input = await screen.findByLabelText('Diamonds To Convert');
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.querySelector('.cmm-panel')!.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    opener.remove();
  });
});

describe('G-05: the cashier keeps its trap under the stacked mint', () => {
  const FOCUSABLE =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  it('focus never drops behind the overlay, Tab cycles in the mint, and returns to the Mint control', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open';
    document.body.appendChild(opener);
    opener.focus();
    const { view, onClose } = await openCashier();
    const panel = document.querySelector('.cbc-panel')!;
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    let openerFocused = 0;
    opener.addEventListener('focus', () => {
      openerFocused += 1;
    });

    const mintControl = screen.getByText('Mint Chips Into The Club Bank').closest('button')!;
    mintControl.focus();
    fireEvent.click(mintControl);
    const input = await screen.findByLabelText('Diamonds To Convert');
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(openerFocused).toBe(0);

    // Both traps are active; only the top one (the mint) acts on Tab.
    const mintPanel = document.querySelector('.cmm-panel')!;
    const mintFocusable = mintPanel.querySelectorAll<HTMLElement>(FOCUSABLE);
    // A Tab from the mint's first control is the browser's to move; the
    // cashier's trap underneath does not drag focus back to itself.
    mintFocusable[0].focus();
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(true);
    expect(document.activeElement).toBe(mintFocusable[0]);
    mintFocusable[mintFocusable.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(mintFocusable[0]);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(mintFocusable[mintFocusable.length - 1]);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('.cmm-panel')).toBeNull());
    await settle();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(document.activeElement).toBe(mintControl);
    expect(openerFocused).toBe(0);

    // The cashier owns Tab again once the mint is gone.
    const cashierFocusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
    cashierFocusable[cashierFocusable.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(cashierFocusable[0]);

    // Closing the cashier still returns focus to what opened it.
    view.rerender(
      <WalletCashierModal
        isOpen={false}
        onClose={onClose}
        clubId={CLUB}
        role="owner"
        walletType="club_bank"
      />
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('S-07: the mint pre-flight is the role-checked panel', () => {
  const mint = () => render(<ChipMintModal isOpen onClose={() => {}} clubId={CLUB} />);

  it('asks fn_club_money_panel, never the clubs table, and mints for club staff', async () => {
    fx.tables.mockImplementation(async (table: string) =>
      table === 'club_members'
        ? { data: { role: 'admin' }, error: null }
        : { data: null, error: null }
    );
    mint();
    await waitFor(() => expect(screen.getByText('Mint Chips')).toBeTruthy());
    expect(fx.rpc).toHaveBeenCalledWith('fn_club_money_panel', { p_club_id: CLUB });
    expect(fx.tables.mock.calls.some(([table]) => table === 'clubs')).toBe(false);
  });

  it('a manager, a refusal and a failed read all fall to denied', async () => {
    fx.tables.mockImplementation(async (table: string) =>
      table === 'club_members'
        ? { data: { role: 'manager' }, error: null }
        : { data: null, error: null }
    );
    const first = mint();
    await waitFor(() =>
      expect(screen.getByText('Only A Club Owner Or Admin May Mint')).toBeTruthy()
    );
    first.unmount();

    fx.rpc.mockImplementation(async (name: string) =>
      name === 'fn_club_money_panel'
        ? { data: { authorized: false, reason: 'not_a_member' }, error: null }
        : { data: null, error: null }
    );
    const second = mint();
    await waitFor(() =>
      expect(screen.getByText('Only A Club Owner Or Admin May Mint')).toBeTruthy()
    );
    second.unmount();

    fx.rpc.mockImplementation(async () => ({ data: null, error: { message: 'boom' } }));
    mint();
    await waitFor(() => expect(screen.getByText('Mint Rights Could Not Be Checked')).toBeTruthy());
    expect(screen.queryByText('Mint Chips')).toBeNull();
  });

  it('union staff mint into the union bank; a club member in a union is revoked', async () => {
    fx.rpc.mockImplementation(async (name: string) =>
      name === 'fn_club_money_panel'
        ? {
            data: { authorized: true, scope: 'union', in_union: true, union_id: 'u-1' },
            error: null,
          }
        : { data: null, error: null }
    );
    fx.tables.mockImplementation(async (table: string) =>
      table === 'unions'
        ? { data: { name: 'Midway Union' }, error: null }
        : { data: null, error: null }
    );
    const first = mint();
    await waitFor(() => expect(screen.getByText(/Midway Union Bank/)).toBeTruthy());
    first.unmount();

    fx.rpc.mockImplementation(async (name: string) =>
      name === 'fn_club_money_panel'
        ? {
            data: { authorized: true, scope: 'club', in_union: true, union_id: 'u-1' },
            error: null,
          }
        : { data: null, error: null }
    );
    mint();
    // Wait for the revoked state itself: it renders only after both the panel
    // and the union-name read resolve. 'Mint Chips' is already absent while
    // the dialog is still loading, so waiting on its absence passed at once
    // and the union name was asserted before it had arrived (CI, 2026-10-19).
    await waitFor(() => expect(screen.getByText(/Midway Union/)).toBeTruthy());
    expect(screen.queryByText('Mint Chips')).toBeNull();
  });

  it('refuses "1e3" diamonds while accepting 1000', async () => {
    fx.tables.mockImplementation(async (table: string) =>
      table === 'club_members'
        ? { data: { role: 'owner' }, error: null }
        : { data: null, error: null }
    );
    mint();
    const input = await screen.findByLabelText('Diamonds To Convert');
    fireEvent.change(input, { target: { value: '1e3' } });
    await settle();
    expect(screen.getByText('Enter A Whole Number Of Diamonds.')).toBeTruthy();
    expect(
      screen.getByText('Mint Chips', { selector: '.sc-plate__text' }).closest('button')?.disabled
    ).toBe(true);
    fireEvent.change(input, { target: { value: '1000' } });
    await settle();
    expect(
      screen.getByText('Mint Chips', { selector: '.sc-plate__text' }).closest('button')?.disabled
    ).toBe(false);
  });
});

describe('D-13: the Diamond Wallet holds its door while a transfer travels', () => {
  it('ignores Escape, the backdrop and the plate until the RPC answers', async () => {
    const transfer = deferred<{ data: unknown; error: null }>();
    fx.tables.mockImplementation(async (table: string) =>
      table === 'profiles'
        ? { data: { id: PLAYER, alias: 'Fish', username: 'fish' }, error: null }
        : table === 'friendships'
          ? { data: [{ id: 'f-1' }], error: null }
          : { data: [], error: null }
    );
    fx.rpc.mockImplementation(async (name: string) =>
      name === 'send_wallet_diamond_transfer' ? transfer.promise : { data: null, error: null }
    );
    const onClose = vi.fn();
    const view = render(<DiamondWalletModal isOpen onClose={onClose} />);
    fireEvent.click(screen.getByText('Send Diamonds'));
    fireEvent.change(screen.getByLabelText('Friend Player ID'), { target: { value: PLAYER } });
    fireEvent.change(screen.getByLabelText('Diamond Amount'), { target: { value: '25' } });
    fireEvent.click(screen.getByText('Review Transfer'));
    await waitFor(() => expect(screen.getByText('Confirm Transfer')).toBeTruthy());
    fireEvent.click(screen.getByText('Confirm Transfer'));
    await settle();

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(document.querySelector('.diamond-wallet-backdrop')!);
    fireEvent.click(screen.getByText('Back', { selector: '.sc-plate__text' }));
    /* The desk's Close is under the sheet: inert and hidden from assistive
       tech while the sheet is up (2026-10-17), and disabled while money moves. */
    const deskClose = screen.getByRole('button', { name: 'Close', hidden: true });
    expect(deskClose.closest('[inert]')).not.toBeNull();
    fireEvent.click(deskClose);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sc-close')).toBeNull();
    // The sheet itself is still open: Back did not dismiss a travelling transfer.
    expect(screen.getByText('Back', { selector: '.sc-plate__text' })).toBeTruthy();

    await act(async () => {
      transfer.resolve({
        data: {
          success: true,
          sender_id: USER,
          recipient_id: PLAYER,
          request_id: expect.anything(),
          amount: 25,
        },
        error: null,
      });
      await settle();
    });
    await waitFor(() => expect(screen.getByTestId('sc-close')).toBeTruthy());
    // Escape closes the transfer sheet first, then the wallet desk.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('the in-table cashier', () => {
  const table = (props: Partial<React.ComponentProps<typeof CashierModal>> = {}) => {
    const onAddChips = vi.fn().mockResolvedValue(true);
    render(
      <CashierModal
        isOpen
        onClose={() => {}}
        onAddChips={onAddChips}
        currentStack={100}
        accountBalance={1000}
        maxBuyIn={300}
        maxStack={300}
        {...props}
      />
    );
    return onAddChips;
  };

  it('D-10: a thrown failure never claims nothing moved', async () => {
    const onAddChips = table();
    onAddChips.mockRejectedValue(new Error());
    fireEvent.change(screen.getByLabelText('Amount To Add'), { target: { value: '50' } });
    fireEvent.click(screen.getByText('Add 50', { selector: '.addon-console__fit' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('Nothing Was Moved');
    expect(alert.textContent).toContain('Did Not Complete');
  });

  it('D-22: says when it capped the amount, and marks an unreadable spelling invalid', () => {
    table();
    const input = screen.getByLabelText('Amount To Add') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '500' } });
    expect(input.value).toBe('200');
    expect(screen.getByText(/Capped At 200/)).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('false');

    fireEvent.change(input, { target: { value: '1e3' } });
    expect(input.value).toBe('1e3');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText(/Capped At/)).toBeNull();
    expect(
      screen.getByText('Add 0', { selector: '.addon-console__fit' }).closest('button')?.disabled
    ).toBe(true);

    fireEvent.change(input, { target: { value: '150' } });
    expect(input.value).toBe('150');
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });

  it('R-05 / R-14: the status line lives inside the frame and says when the balance is unknown', () => {
    const { container } = render(
      <CashierModal
        isOpen
        onClose={() => {}}
        onAddChips={vi.fn().mockResolvedValue(true)}
        currentStack={100}
        accountBalance={null}
        maxBuyIn={300}
        maxStack={300}
      />
    );
    expect(container.querySelector('.addon-console__messages')).toBeNull();
    expect(container.querySelector('.addon-console__timer')?.textContent).toContain(
      'Balance Unavailable'
    );
  });
});
