import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  club: 'first-club',
  rpc: vi.fn(),
  wallet: vi.fn(),
  member: vi.fn(),
  roster: vi.fn(),
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
  signals: [] as AbortSignal[],
}));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ clubId: state.club }),
  useSearchParams: () => [new URLSearchParams()],
  useNavigate: () => vi.fn(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'viewer' } }) }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/strictClubIdResolver', () => ({
  resolveClubUUIDStrict: async (club: string) => club,
}));
vi.mock('../../src/services/ClubRosterService', () => ({
  default: { getRoster: (...args: unknown[]) => state.roster(...args) },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      const request = state.rpc(name, args);
      return {
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          request.then(resolve, reject),
        abortSignal: (signal: AbortSignal) => {
          state.signals.push(signal);
          return request;
        },
      };
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        abortSignal: (signal: AbortSignal) => {
          state.signals.push(signal);
          return chain;
        },
        maybeSingle: () => {
          return table === 'club_diamond_wallets' ? state.wallet() : state.member();
        },
      };
      return chain;
    },
  },
}));
import userEvent from '@testing-library/user-event';
import PromoVaultPage from '../../src/pages/PromoVaultPage';
const catalog = [
  { item_key: 'time-bank', category: 'feature', label: 'Time Bank', quantity: 3, diamond_cost: 10 },
];
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.club = 'first-club';
  state.rpc.mockImplementation(async (name: string) => ({
    data: name === 'ca_promo_vault_catalog' ? catalog : [],
    error: null,
  }));
  state.wallet.mockResolvedValue({ data: { balance: 100 }, error: null });
  state.member.mockResolvedValue({ data: { role: 'owner' }, error: null });
  state.roster.mockResolvedValue([
    { user_id: 'viewer', role: 'owner', alias: 'Viewer', username: 'viewer', player_number: '123' },
  ]);
});
afterEach(cleanup);
async function page() {
  const view = render(<PromoVaultPage />);
  await screen.findByText('Click An Item To Grant');
  return view;
}
describe('Promo Vault keyboard accessibility', () => {
  it('names an admin zero-stock tile Buy and restores it after cancelling without a purchase', async () => {
    const user = userEvent.setup();
    state.rpc.mockImplementation(async (name: string) => ({
      data: name === 'ca_promo_vault_catalog' ? [{ ...catalog[0], quantity: 0 }] : [],
      error: null,
    }));
    state.roster.mockResolvedValue([
      { user_id: 'viewer', role: 'admin', alias: 'Viewer', username: 'viewer' },
    ]);
    await page();
    const opener = screen.getByRole('button', { name: 'Buy Time Bank', exact: true });
    await user.click(opener);
    const dialog = within(screen.getByRole('dialog', { name: 'Buy Time Bank' }));
    await waitFor(() =>
      expect(dialog.getByRole('spinbutton', { name: 'Quantity To Buy' })).toHaveFocus()
    );
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(opener).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      state.rpc.mock.calls.some(([name]) =>
        ['ca_promo_vault_buy', 'ca_promo_vault_grant'].includes(name)
      )
    ).toBe(false);
  });
  it('names a read-only zero-stock tile Check Availability and reports no stock without mutation', async () => {
    const user = userEvent.setup();
    state.rpc.mockImplementation(async (name: string) => ({
      data: name === 'ca_promo_vault_catalog' ? [{ ...catalog[0], quantity: 0 }] : [],
      error: null,
    }));
    state.roster.mockResolvedValue([
      { user_id: 'viewer', role: 'player', alias: 'Viewer', username: 'viewer' },
    ]);
    await page();
    const tile = screen.getByRole('button', {
      name: 'Check Availability For Time Bank',
      exact: true,
    });
    await user.click(tile);
    expect(tile).toHaveFocus();
    expect(state.toast.info).toHaveBeenCalledWith('The Vault Holds None Of This Item Yet');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      state.rpc.mock.calls.some(([name]) =>
        ['ca_promo_vault_buy', 'ca_promo_vault_grant'].includes(name)
      )
    ).toBe(false);
  });
  it('focuses Help, contains both Tab directions and restores the opener after Escape', async () => {
    const user = userEvent.setup();
    await page();
    const opener = screen.getByRole('button', { name: 'How The Promo Vault Works' });
    await user.click(opener);
    const gotIt = within(screen.getByRole('dialog')).getByRole('button', { name: 'Got It' });
    await waitFor(() => expect(gotIt).toHaveFocus());
    await user.tab();
    expect(gotIt).toHaveFocus();
    await user.tab({ shift: true });
    expect(gotIt).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
  it('traps Buy controls while excluding disabled actions and retains focus across quantity rerenders', async () => {
    const user = userEvent.setup();
    state.wallet.mockResolvedValue({ data: { balance: 0 }, error: null });
    await page();
    const opener = screen.getByRole('button', { name: 'Buy More Time Bank' });
    await user.click(opener);
    const dialog = within(screen.getByRole('dialog'));
    const input = dialog.getByRole('spinbutton', { name: 'Quantity To Buy' });
    await waitFor(() => expect(input).toHaveFocus());
    expect(dialog.getByRole('button', { name: 'Fewer' })).toBeDisabled();
    expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await user.tab({ shift: true });
    expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();
    await user.click(dialog.getByRole('button', { name: 'More' }));
    expect(dialog.getByRole('button', { name: 'More' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(opener).toHaveFocus();
    expect(state.rpc.mock.calls.some(([name]) => name === 'ca_promo_vault_buy')).toBe(false);
  });
  it.each(['pointer', 'keyboard'] as const)(
    'keeps immediate focus inside Grant across %s recipient transitions',
    async (activation) => {
      const user = userEvent.setup();
      await page();
      const opener = screen.getByRole('button', { name: 'Grant Time Bank' });
      await user.click(opener);
      const dialog = within(screen.getByRole('dialog'));
      await waitFor(() =>
        expect(dialog.getByRole('textbox', { name: 'Search Players' })).toHaveFocus()
      );
      const choose = dialog.getByRole('button', { name: /Viewer/ });
      if (activation === 'pointer') await user.click(choose);
      else {
        choose.focus();
        await user.keyboard('{Enter}');
      }
      expect(dialog.getByRole('spinbutton', { name: 'Quantity To Send' })).toHaveFocus();
      const more = dialog.getByRole('button', { name: 'More' });
      await user.click(more);
      expect(more).toHaveFocus();
      expect(dialog.getByRole('spinbutton', { name: 'Quantity To Send' })).toHaveValue(2);
      await user.tab({ shift: true });
      expect(dialog.getByRole('spinbutton', { name: 'Quantity To Send' })).toHaveFocus();
      await user.tab({ shift: true });
      expect(dialog.getByRole('button', { name: 'Fewer' })).toHaveFocus();
      await user.tab({ shift: true });
      expect(dialog.getByRole('button', { name: 'Change' })).toHaveFocus();
      await user.tab({ shift: true });
      expect(dialog.getByRole('button', { name: 'Confirm' })).toHaveFocus();
      const change = dialog.getByRole('button', { name: 'Change' });
      if (activation === 'pointer') await user.click(change);
      else {
        change.focus();
        await user.keyboard('{Enter}');
      }
      expect(dialog.getByRole('textbox', { name: 'Search Players' })).toHaveFocus();
      await user.tab({ shift: true });
      expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveFocus();
      await user.tab();
      expect(dialog.getByRole('textbox', { name: 'Search Players' })).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(opener).toHaveFocus();
      expect(state.rpc.mock.calls.some(([name]) => name === 'ca_promo_vault_grant')).toBe(false);
    }
  );
  it('keeps a pending purchase disabled and trapped without changing its existing Cancel behavior', async () => {
    const user = userEvent.setup();
    const pending = deferred<{ data: unknown; error: null }>();
    state.rpc.mockImplementation((name: string) =>
      name === 'ca_promo_vault_buy'
        ? pending.promise
        : Promise.resolve({ data: catalog, error: null })
    );
    await page();
    const opener = screen.getByRole('button', { name: 'Buy More Time Bank' });
    await user.click(opener);
    const dialog = within(screen.getByRole('dialog'));
    await waitFor(() => expect(dialog.getByRole('spinbutton')).toHaveFocus());
    await user.click(dialog.getByRole('button', { name: 'Confirm' }));
    expect(dialog.getByRole('button', { name: 'Buying...' })).toBeDisabled();
    await user.tab();
    expect(dialog.getByRole('spinbutton')).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(opener).toHaveFocus();
    await act(async () =>
      pending.resolve({ data: { success: false, error: 'Refused' }, error: null })
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(state.rpc.mock.calls.filter(([name]) => name === 'ca_promo_vault_buy')).toHaveLength(1);
  });
  it('focuses and restores the read-only Grant close control', async () => {
    const user = userEvent.setup();
    state.roster.mockResolvedValue([
      { user_id: 'viewer', role: 'player', alias: 'Viewer', username: 'viewer' },
    ]);
    await page();
    const opener = screen.getByRole('button', { name: 'Grant Time Bank' });
    await user.click(opener);
    const close = within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' });
    await waitFor(() => expect(close).toHaveFocus());
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    await user.click(close);
    expect(opener).toHaveFocus();
    expect(state.rpc.mock.calls.some(([name]) => name === 'ca_promo_vault_grant')).toBe(false);
  });
  it('does not reinitialize Help focus when its inline callback rerenders', async () => {
    const user = userEvent.setup();
    const view = await page();
    const opener = screen.getByRole('button', { name: 'How The Promo Vault Works' });
    await user.click(opener);
    const gotIt = screen.getByRole('button', { name: 'Got It' });
    await waitFor(() => expect(gotIt).toHaveFocus());
    view.rerender(<PromoVaultPage />);
    expect(gotIt).toHaveFocus();
    await user.click(gotIt);
    expect(opener).toHaveFocus();
  });
  it('links panels and moves the single tab stop with Arrow, Home and End keys', async () => {
    const user = userEvent.setup();
    await page();
    const items = screen.getByRole('tab', { name: 'Items' });
    const records = screen.getByRole('tab', { name: 'Records' });
    expect(items).toHaveAttribute('tabindex', '0');
    expect(records).toHaveAttribute('tabindex', '-1');
    items.focus();
    await user.keyboard('{ArrowRight}');
    expect(records).toHaveFocus();
    expect(records).toHaveAttribute('aria-selected', 'true');
    await screen.findByText('No Records Yet');
    const panel = screen.getByRole('tabpanel', { name: 'Records' });
    expect(records).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', records.id);
    await user.keyboard('{ArrowRight}');
    expect(items).toHaveFocus();
    await user.keyboard('{End}');
    expect(records).toHaveFocus();
    await user.keyboard('{Home}');
    expect(items).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(records).toHaveFocus();
    expect(state.rpc.mock.calls.filter(([name]) => name === 'ca_promo_vault_records')).toHaveLength(
      1
    );
  });
});
