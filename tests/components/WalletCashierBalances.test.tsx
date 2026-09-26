import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  bank: 100,
  pot: 25,
  agent: 40,
  float: 15,
  failure: false,
  reads: [] as Array<{ table: string; fields: string; filters: Record<string, string> }>,
  rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
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
                data:
                  table === 'clubs'
                    ? {
                        id: request.filters.id,
                        name: 'Test Club',
                        union_id: null,
                        chip_treasury: fixture.bank,
                        promo_balance: fixture.pot,
                      }
                    : { agent_wallet_balance: fixture.agent, promo_wallet_balance: fixture.float },
              };
        },
      };
      return builder;
    },
    rpc: fixture.rpc,
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
    Object.assign(fixture, { bank: 100, pot: 25, agent: 40, float: 15, failure: false, reads: [] });
    fixture.rpc.mockClear();
    fixture.channel.mockClear();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows a concurrent club-bank withdrawal without reopening or a row event', async () => {
    const view = render(<WalletCashierModal {...base} walletType="club_bank" />);
    await flush();
    expect(view.container.querySelector('.cbc-bank strong')).toHaveTextContent('100');
    fixture.bank = 70;
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(view.container.querySelector('.cbc-bank strong')).toHaveTextContent('70');
    expect(fixture.channel).not.toHaveBeenCalled();
    expect(fixture.rpc.mock.calls.every(([name]) => name === 'fn_club_cashier_members')).toBe(true);
    expect(fixture.reads.every((read) => read.filters.id === CLUB && read.table === 'clubs')).toBe(
      true
    );
  });

  it('updates the viewer’s agent float using both club and user filters', async () => {
    const view = render(<WalletCashierModal {...base} role="agent" walletType="agent_wallet" />);
    await flush();
    expect(view.container.querySelector('.cbc-bank strong')).toHaveTextContent('40');
    fixture.agent = 19;
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(view.container.querySelector('.cbc-bank strong')).toHaveTextContent('19');
    for (const read of fixture.reads.filter((r) => r.table === 'agents')) {
      expect(read.filters).toEqual({
        club_id: CLUB,
        user_id: '11111111-1111-4111-8111-111111111111',
      });
    }
  });

  it('keeps the club promo pot separate from the viewer’s promo float', async () => {
    const view = render(<WalletCashierModal {...base} walletType="promo_wallet" />);
    await flush();
    expect(view.container.querySelector('.cbc-bank strong')).toHaveTextContent('25');
    fixture.pot = 31;
    fixture.float = 99;
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(view.container.querySelector('.cbc-bank strong')).toHaveTextContent('31');
  });

  it('shows unavailable after a refused refresh, never the previous spendable number or zero', async () => {
    const view = render(<WalletCashierModal {...base} walletType="club_bank" />);
    await flush();
    fixture.failure = true;
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(view.container.querySelector('.cbc-bank strong')).toHaveTextContent('Unavailable');
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
