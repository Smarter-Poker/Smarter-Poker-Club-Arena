import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE CASHIER DIALOGS MERGE (2026-10-09). The first cashier swarm (audit C2)
 * and the launch audit (D-, R-, S- findings) both changed the Club Bank
 * cashier and the in-table cashier. These cases pin what only the merged
 * code does: each one fails against either side alone.
 *
 *  - the promo float switch is offered on `hasFloat`, the agents row itself,
 *    because a missing row now reads as an empty float (0), not an unknown one;
 *  - the in-table cashier keeps the swarm's Retry and its table-maximum
 *    sentence, but prints both INSIDE the painted frame (R-05), on the money
 *    plate and the status line, never on bare black below the art;
 *  - a Club Bank move that got no answer says so inside the frame and re-reads
 *    the figures, holding its key: the toast door silences connection errors,
 *    so the merged cashier said nothing at all on an unknown outcome.
 */

const CLUB = '22222222-2222-4222-8222-222222222222';

const fx = vi.hoisted(() => ({ rpc: vi.fn(), balances: vi.fn() }));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: '11111111-1111-4111-8111-111111111111' }, isHydrating: false }),
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));
vi.mock('../../src/components/wallet/ChipMintModal', () => ({ default: () => null }));
vi.mock('../../src/services/cashierBalanceRead', () => ({
  readCashierBalances: (...args: unknown[]) => fx.balances(...args),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => fx.rpc(...args),
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'abortSignal', 'order', 'limit']) q[m] = () => q;
      q.maybeSingle = async () => ({ data: null, error: null });
      return q;
    },
  },
}));

import WalletCashierModal from '../../src/components/wallet/WalletCashierModal';
import { CashierModal } from '../../src/components/table/CashierModal';

const promoSnapshot = (over: Record<string, unknown>) => ({
  clubId: CLUB,
  name: 'Test Club',
  inUnion: false,
  bank: 0,
  credit: 0,
  promoPot: 25,
  promoFloat: 0,
  hasFloat: false,
  ...over,
});

beforeEach(() => {
  fx.rpc.mockReset();
  fx.balances.mockReset();
  fx.rpc.mockImplementation(async () => ({ data: [], error: null }));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

describe('the promo float switch is offered on the agents row itself', () => {
  const openPromo = () =>
    render(
      <WalletCashierModal
        isOpen
        onClose={() => {}}
        clubId={CLUB}
        role="owner"
        walletType="promo_wallet"
      />
    );

  it('a Club Bank role with no agents row stands at the club pot alone', async () => {
    fx.balances.mockResolvedValue(promoSnapshot({ promoFloat: 0, hasFloat: false }));
    openPromo();
    await waitFor(() => expect(document.querySelector('.cbc-bank strong')?.textContent).toBe('25'));
    // The empty float reads 0 now, which is not a float this owner holds.
    expect(screen.queryByRole('radiogroup', { name: 'Promo Wallet Source' })).toBeNull();
    expect(screen.queryByText('My Promo Float')).toBeNull();
  });

  it('a Club Bank role who holds a float may switch between the two', async () => {
    fx.balances.mockResolvedValue(promoSnapshot({ promoFloat: 15, hasFloat: true }));
    openPromo();
    const group = await screen.findByRole('radiogroup', { name: 'Promo Wallet Source' });
    expect(group.textContent).toContain('Club Promo Wallet');
    expect(group.textContent).toContain('My Promo Float');
    fireEvent.click(screen.getByRole('radio', { name: /My Promo Float/ }));
    await waitFor(() => expect(document.querySelector('.cbc-bank strong')?.textContent).toBe('15'));
  });
});

describe('a Club Bank move that got no answer says so', () => {
  const AGENT = '33333333-3333-4333-8333-333333333333';
  const bankSnapshot = {
    clubId: CLUB,
    name: 'Test Club',
    inUnion: false,
    bank: 10000,
    credit: 0,
    promoPot: 0,
    promoFloat: null,
    hasFloat: null,
  };
  const sends = () =>
    fx.rpc.mock.calls.filter(([name]) => name === 'fn_club_bank_send') as Array<
      [string, { p_op_id: string }]
    >;
  const openAndSend = async (answers: unknown[]) => {
    fx.balances.mockResolvedValue(bankSnapshot);
    fx.rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_club_cashier_members')
        return {
          data: [{ user_id: AGENT, role: 'agent', name: 'Fish Finder', chip_balance: 10 }],
          error: null,
        };
      if (name === 'fn_club_bank_send') return answers.shift() ?? { data: { success: true } };
      return { data: [], error: null };
    });
    render(
      <WalletCashierModal
        isOpen
        onClose={() => {}}
        clubId={CLUB}
        role="owner"
        walletType="club_bank"
      />
    );
    fireEvent.click(await screen.findByText('Fish Finder'));
    fireEvent.change(screen.getByLabelText('Chips To Send'), { target: { value: '100' } });
    const plate = () =>
      screen.getByText('Confirm', { selector: '.sc-plate__text' }).closest('button')!;
    await waitFor(() => expect(plate().disabled).toBe(false));
    fireEvent.click(plate());
    return plate;
  };

  it('a transport failure is an unknown outcome: said in the frame, figures re-read, key held', async () => {
    const plate = await openAndSend([
      { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } },
      { data: { success: true, replayed: true }, error: null },
    ]);
    const alert = await screen.findByText(/That Send Got No Answer And May Have Gone Through/);
    expect(alert.closest('.cbc-panel')).toBeTruthy();
    await waitFor(() => expect(fx.balances.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(plate().disabled).toBe(false));
    fireEvent.click(plate());
    await waitFor(() => expect(sends()).toHaveLength(2));
    expect(sends()[1][1].p_op_id).toBe(sends()[0][1].p_op_id);
    await waitFor(() => expect(screen.queryByText(/Got No Answer/)).toBeNull());
  });

  it('a refusal is not an unknown outcome', async () => {
    await openAndSend([{ data: { success: false, error: 'Refused For Test' }, error: null }]);
    await waitFor(() => expect(sends()).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen.getByText('Confirm', { selector: '.sc-plate__text' }).closest('button')!.disabled
      ).toBe(false)
    );
    expect(screen.queryByText(/Got No Answer/)).toBeNull();
  });

  it('a server error with a SQLSTATE rolled back, so it is not an unknown outcome', async () => {
    await openAndSend([{ data: null, error: { message: 'permission denied', code: '42501' } }]);
    await waitFor(() => expect(sends()).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen.getByText('Confirm', { selector: '.sc-plate__text' }).closest('button')!.disabled
      ).toBe(false)
    );
    expect(screen.queryByText(/Got No Answer/)).toBeNull();
  });
});

describe('the in-table cashier speaks inside its frame', () => {
  const table = (props: Partial<React.ComponentProps<typeof CashierModal>> = {}) =>
    render(
      <CashierModal
        isOpen
        onClose={() => {}}
        onAddChips={vi.fn().mockResolvedValue(true)}
        currentStack={100}
        accountBalance={null}
        maxBuyIn={300}
        maxStack={300}
        {...props}
      />
    );
  const timer = () => document.querySelector('.addon-console__timer')?.textContent ?? '';

  it('offers the Retry on the money plate when a re-read is wired', () => {
    const retry = vi.fn();
    table({ onRetryBalance: retry });
    expect(timer()).toContain('Balance Unavailable');
    const plate = screen.getByRole('button', { name: 'Retry' });
    expect(plate.classList.contains('addon-console__plate--primary')).toBe(true);
    expect((plate as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(plate);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.addon-console__messages')).toBeNull();
  });

  it('without a re-read the plate stays the disabled top-up, never a dead Retry', () => {
    table();
    expect(timer()).toContain('Balance Unavailable');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Add 0' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('says a stack at the table maximum has nothing to add, inside the frame', () => {
    table({ accountBalance: 5000, currentStack: 300 });
    expect(timer()).toContain('Your Stack Is At The Table Maximum, So There Is Nothing To Add.');
    expect(timer()).not.toContain('Available To Add');
    expect(document.querySelector('.addon-console__messages')).toBeNull();
  });

  it('a refusal outranks every other sentence on the status line', async () => {
    const onAddChips = vi.fn().mockResolvedValue(false);
    table({ accountBalance: 5000, currentStack: 100, onAddChips });
    fireEvent.click(screen.getByText('MAX'));
    fireEvent.click(screen.getByRole('button', { name: 'Add 200' }));
    await waitFor(() => expect(timer()).toContain('That Top-Up Did Not Complete.'));
    expect(screen.getByRole('alert').closest('.addon-console__timer')).toBeTruthy();
  });
});
