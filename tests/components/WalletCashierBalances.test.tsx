import { act, cleanup, render, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  bank: 100,
  pot: 25,
  agent: 40,
  float: 15,
  failure: false,
  roster: [] as Array<Record<string, unknown>>,
  reads: [] as Array<{ table: string; fields: string; filters: Record<string, string> }>,
  rpc: vi.fn(),
  channel: vi.fn(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: '11111111-1111-4111-8111-111111111111' } }),
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn() } }));
vi.mock('../../src/components/wallet/ChipMintModal', () => ({ default: () => null }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const request = { table, fields: '', filters: {} as Record<string, string> };
      const builder = {
        select: (fields: string) => {
          request.fields = fields;
          return builder;
        },
        eq: (key: string, value: string) => {
          request.filters[key] = value;
          return builder;
        },
        abortSignal: () => builder,
        maybeSingle: async () => {
          fixture.reads.push(request);
          return fixture.failure
            ? { data: null, error: { message: 'Permission denied' } }
            : {
                error: null,
                data: { agent_wallet_balance: fixture.agent, promo_wallet_balance: fixture.float },
              };
        },
      };
      return builder;
    },
    /* The club figures come from fn_club_money_panel, the role-checked read
       (S-07, launch audit 2026-10-09); clubs.chip_treasury is never selected.
       The panel is a one-row rpc the service reads with .abortSignal(), and it
       is recorded as a read of the 'clubs' money so the filter assertions below
       still cover it. */
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name !== 'fn_club_money_panel') {
        fixture.rpc(name, args);
        return Promise.resolve({
          data:
            name === 'fn_club_cashier_members'
              ? fixture.roster
              : name === 'fn_club_bank_ledger'
                ? {
                    authorized: true,
                    total: 1,
                    types: ['send'],
                    totals: { into_bank: 0, out_of_bank: 10, net: -10 },
                    rows: [
                      {
                        id: 'ledger-1',
                        amount: 10,
                        transaction_type: 'send',
                        notes: 'Preserved Ledger Entry',
                        balance_after: 90,
                        created_at: '2026-10-16T12:00:00Z',
                      },
                    ],
                  }
                : [],
          error: null,
        });
      }
      const request = {
        table: 'clubs',
        fields: 'fn_club_money_panel',
        filters: { id: args.p_club_id as string },
      };
      const answer = async () => {
        fixture.reads.push(request);
        return fixture.failure
          ? { data: null, error: { message: 'Permission denied' } }
          : {
              error: null,
              data: {
                authorized: true,
                scope: 'club',
                club_id: args.p_club_id,
                club_name: 'Test Club',
                in_union: false,
                union_id: null,
                club_treasury: fixture.bank,
                club_promo_wallet: fixture.pot,
              },
            };
      };
      const thenable = {
        abortSignal: () => answer(),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          answer().then(resolve, reject),
      };
      return thenable;
    },
    channel: (...args: unknown[]) => {
      fixture.channel(...args);
      const channel = { on: () => channel, subscribe: () => channel };
      return channel;
    },
    removeChannel: vi.fn(),
  },
}));

import WalletCashierModal from '../../src/components/wallet/WalletCashierModal';
const CLUB = '22222222-2222-4222-8222-222222222222';
const base = { isOpen: true, onClose: () => {}, clubId: CLUB, role: 'owner' };
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

describe('the open cashier reads the balances that changed elsewhere', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(fixture, {
      bank: 100,
      pot: 25,
      agent: 40,
      float: 15,
      failure: false,
      reads: [],
      roster: [],
    });
    fixture.rpc.mockReset();
    fixture.channel.mockClear();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('excludes player-only members from Agent and Promo destinations, including search', async () => {
    fixture.roster = [
      {
        user_id: 'p1',
        role: 'player',
        name: 'Player Casey',
        player_number: '42',
        chip_balance: 12,
      },
      { user_id: 'a1', role: 'agent', name: 'Agent Casey', player_number: '43', chip_balance: 20 },
    ];
    render(<WalletCashierModal {...base} walletType="club_bank" />);
    await flush();
    const search = screen.getByRole('textbox', { name: 'Search Recipients' });
    expect(screen.queryByText('Player Casey')).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'Casey' } });
    expect(screen.getByText('Agent Casey')).toBeInTheDocument();
    expect(screen.queryByText('Player Casey')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Promo Wallet', exact: true }));
    expect(screen.queryByText('Player Casey')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Player Wallet', exact: true }));
    expect(screen.getByText('Player Casey')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Agent Wallet', exact: true }));
    expect(screen.queryByText('Player Casey')).not.toBeInTheDocument();
    expect(screen.queryByText(/The Float An Agent Carries/)).not.toBeInTheDocument();
    expect(fixture.rpc.mock.calls.some(([name]) => /_send$/.test(name))).toBe(false);
  });

  it('omits the promo source explanation while retaining the account label', async () => {
    render(<WalletCashierModal {...base} walletType="promo_wallet" />);
    await flush();
    expect(screen.getByText('Club Promo Wallet Balance')).toBeInTheDocument();
    expect(screen.queryByText(/Funded By|Your Own Promo Float/)).not.toBeInTheDocument();
  });

  it('keeps the Club Bank ledger accessible beside the Send Out transfer form', async () => {
    fixture.roster = [
      {
        user_id: '11111111-1111-4111-8111-111111111111',
        role: 'owner',
        name: 'KingFish',
        player_number: '1',
        chip_balance: 12,
      },
    ];
    render(
      <WalletCashierModal
        {...base}
        walletType="club_bank"
        initialRecipientId="11111111-1111-4111-8111-111111111111"
      />
    );
    await flush();
    expect(screen.getByRole('heading', { name: 'Send Out' })).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Selected Player' });
    expect(card).toHaveTextContent('KingFish');
    const selector = within(card).getByRole('combobox', { name: 'Send Into' });
    expect(selector.parentElement).toBe(card);
    fireEvent.change(selector, { target: { value: 'player_wallet' } });
    expect(selector).toHaveValue('player_wallet');
    const face = card.cloneNode(true) as HTMLElement;
    face.querySelector('select')!.remove();
    expect(face.textContent).toContain('Player Wallet');
    expect(face.textContent?.match(/12\.00/g)).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'From The Club Bank' })).toHaveTextContent('100');
    const input = screen.getByRole('textbox', { name: 'Chips To Send' });
    fireEvent.change(input, { target: { value: '1,00000' } });
    expect(input).toHaveValue('100,000');
    fireEvent.click(screen.getByRole('tab', { name: 'Transaction Ledger' }));
    await flush();
    expect(fixture.rpc).toHaveBeenCalledWith(
      'fn_club_bank_ledger',
      expect.objectContaining({ p_club_id: CLUB, p_offset: 0 })
    );
    expect(screen.getByText('Preserved Ledger Entry')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export/i })).toBeInTheDocument();
  });

  it('switches bank funding without losing the draft or its bank ledger', async () => {
    fixture.bank = 79345678.12;
    fixture.agent = 6000;
    fixture.pot = 1250000.5;
    fixture.roster = [
      {
        user_id: '33333333-3333-4333-8333-333333333333',
        role: 'agent',
        name: 'Recipient',
        player_number: '42',
        chip_balance: 6000,
      },
    ];
    render(
      <WalletCashierModal
        {...base}
        walletType="club_bank"
        initialRecipientId="33333333-3333-4333-8333-333333333333"
      />
    );
    await flush();
    const input = screen.getByRole('textbox', { name: 'Chips To Send' });
    fireEvent.change(input, { target: { value: '100' } });
    const funding = screen.getByRole('region', { name: 'From The Club Bank' });
    const source = within(funding).getByRole('combobox', { name: 'Send From' });
    expect(source.parentElement).toBe(funding);
    expect(funding).toHaveTextContent('79,345,678.12');
    fireEvent.change(source, { target: { value: 'agent_wallet' } });
    await flush();
    expect(input).toHaveValue('100');
    expect(screen.getByRole('region', { name: 'Selected Player' })).toHaveTextContent('Recipient');
    expect(screen.getByRole('region', { name: 'From Your Agent Wallet' })).toHaveTextContent(
      '6,000.00'
    );
    expect(screen.getByRole('tab', { name: 'Transaction Ledger' })).toBeInTheDocument();
    // A draft source switch never submits a money command.
    expect(fixture.rpc.mock.calls.some(([name]) => /_send$/.test(name))).toBe(false);
    fireEvent.change(input, { target: { value: '6001' } });
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    fireEvent.change(source, { target: { value: 'promo_wallet' } });
    await flush();
    expect(input).toHaveValue('6,001');
    expect(screen.getByRole('region', { name: 'From The Club Promo Wallet' })).toHaveTextContent(
      '1,250,000.50'
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Transaction Ledger' }));
    await flush();
    expect(screen.getByText('Preserved Ledger Entry')).toBeInTheDocument();
  });

  it('keeps the working balance until explicit refresh', async () => {
    render(<WalletCashierModal {...base} walletType="club_bank" />);
    await flush();
    expect(document.querySelector('.cbc-bank strong')).toHaveTextContent('100');
    fixture.bank = 70;
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(document.querySelector('.cbc-bank strong')).toHaveTextContent('100');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Balances' }));
    await flush();
    expect(document.querySelector('.cbc-bank strong')).toHaveTextContent('70');
    expect(fixture.channel).not.toHaveBeenCalled();
    expect(fixture.rpc.mock.calls.every(([name]) => name === 'fn_club_cashier_members')).toBe(true);
    expect(fixture.reads.every((read) => read.filters.id === CLUB && read.table === 'clubs')).toBe(
      true
    );
  });

  it('updates the viewer’s agent float using both club and user filters', async () => {
    render(<WalletCashierModal {...base} role="agent" walletType="agent_wallet" />);
    await flush();
    expect(document.querySelector('.cbc-bank strong')).toHaveTextContent('40');
    fixture.agent = 19;
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Balances' }));
    await flush();
    expect(document.querySelector('.cbc-bank strong')).toHaveTextContent('19');
    for (const read of fixture.reads.filter((r) => r.table === 'agents')) {
      expect(read.filters).toEqual({
        club_id: CLUB,
        user_id: '11111111-1111-4111-8111-111111111111',
      });
    }
  });

  it('keeps the club promo pot separate from the viewer’s promo float', async () => {
    render(<WalletCashierModal {...base} walletType="promo_wallet" />);
    await flush();
    expect(document.querySelector('.cbc-bank strong')).toHaveTextContent('25');
    fixture.pot = 31;
    fixture.float = 99;
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Balances' }));
    await flush();
    expect(document.querySelector('.cbc-bank strong')).toHaveTextContent('31');
  });

  it('shows unavailable after a refused refresh, never the previous spendable number or zero', async () => {
    render(<WalletCashierModal {...base} walletType="club_bank" />);
    await flush();
    fixture.failure = true;
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Balances' }));
    await flush();
    expect(document.querySelector('.cbc-bank strong')).toHaveTextContent('Unavailable');
  });

  it('stops all balance reads when the cashier closes', async () => {
    const view = render(<WalletCashierModal {...base} walletType="club_bank" />);
    await flush();
    const count = fixture.reads.length;
    view.rerender(<WalletCashierModal {...base} isOpen={false} walletType="club_bank" />);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fixture.reads).toHaveLength(count);
  });
});
