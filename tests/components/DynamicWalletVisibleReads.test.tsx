import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  bank: 100,
  unionBank: 250,
  agent: 40,
  chipWallet: true,
  failure: false,
  requests: [] as string[],
  rpc: vi.fn(),
  channel: vi.fn(),
}));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({ useMasterBusSubscriptions: vi.fn() }));
vi.mock('../../src/hooks/useSpinsWallet', () => ({
  useSpinsWallet: () => ({ balance: 0, state: {} }),
}));
vi.mock('../../src/components/arena/arenaAccess', () => ({
  useArenaHasChipWallet: () => fixture.chipWallet,
}));
vi.mock('../../src/lib/bbjPoolFeed', () => ({ watchBbjPool: () => () => {} }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/lib/walletCache', () => ({
  walletCacheKey: (...args: string[]) => args.join(':'),
  readWalletCacheEntry: () => null,
  writeWalletCacheDebounced: vi.fn(),
  dedupedFetch: (_key: string, read: () => unknown) => read(),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        abortSignal: () => query,
        maybeSingle: async () => {
          fixture.requests.push(table);
          return {
            error: null,
            data:
              table === 'profiles'
                ? { diamonds: 8 }
                : table === 'club_members'
                  ? { chip_balance: 12 }
                  : { agent_wallet_balance: fixture.agent, promo_wallet_balance: 15 },
          };
        },
      };
      return query;
    },
    rpc: (name: string, args: unknown) => {
      fixture.rpc(name, args);
      const result = () => ({
        error: fixture.failure ? { message: 'Read failed' } : null,
        data: {
          authorized: true,
          scope: 'union',
          in_union: true,
          union_id: 'union-1',
          club_treasury: fixture.bank,
          club_promo_wallet: 7,
          union_bank: fixture.unionBank,
          rake_treasury: 9,
          union_promo: 11,
          bbj: { main: 50, backup: 10 },
          next_close_at: '2026-10-01T00:00:00Z',
        },
      });
      return {
        abortSignal: async () => result(),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
    },
    channel: (...args: unknown[]) => {
      fixture.channel(...args);
      const channel = { on: () => channel, subscribe: () => channel };
      return channel;
    },
    removeChannel: vi.fn(),
  },
}));

import DynamicWallet from '../../src/components/wallet/DynamicWallet';
import * as clubIds from '../../src/utils/clubIdResolver';
const base = {
  userId: '11111111-1111-4111-8111-111111111111',
  clubId: '22222222-2222-4222-8222-222222222222',
  role: 'owner',
  roleReady: true,
};
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  await act(() => vi.advanceTimersByTimeAsync(450));
};
const value = (container: HTMLElement, key: string) =>
  container.querySelector(`[data-wallet-key="${key}"] .dw__row-value`);

describe('wallet displays follow authenticated reads, not unpublished channels', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(fixture, {
      bank: 100,
      unionBank: 250,
      agent: 40,
      chipWallet: true,
      failure: false,
      requests: [],
    });
    fixture.rpc.mockClear();
    fixture.channel.mockClear();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refreshes club and agent figures changed by a second session without exposing union money', async () => {
    const view = render(<DynamicWallet {...base} variant="club" />);
    await flush();
    expect(value(view.container, 'club_bank')).toHaveTextContent('100');
    fixture.bank = 64;
    fixture.agent = 23;
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    await flush();
    expect(value(view.container, 'club_bank')).toHaveTextContent('64');
    expect(value(view.container, 'agent_wallet')).toHaveTextContent('23');
    expect(view.container.querySelector('[data-wallet-key="union_bank"]')).toBeNull();
    expect(fixture.channel).not.toHaveBeenCalled();
  });

  it('refreshes the union bank through the existing permission-aware money panel', async () => {
    const view = render(<DynamicWallet {...base} variant="union" />);
    await flush();
    expect(value(view.container, 'union_bank')).toHaveTextContent('250');
    fixture.unionBank = 225;
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    await flush();
    expect(value(view.container, 'union_bank')).toHaveTextContent('225');
    expect(fixture.rpc).toHaveBeenCalledWith('fn_club_money_panel', { p_club_id: base.clubId });
  });

  it('retains the last figure with a visible failure indication when a read fails', async () => {
    const view = render(<DynamicWallet {...base} variant="club" />);
    await flush();
    fixture.failure = true;
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    await flush();
    expect(value(view.container, 'club_bank')).toHaveTextContent('100');
    expect(view.container).toHaveTextContent('Balances Unavailable');
  });

  it('keeps diamond-only arenas free of chip reads on initial and subsequent refreshes', async () => {
    fixture.chipWallet = false;
    render(<DynamicWallet {...base} variant="club" />);
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(fixture.requests.length).toBeGreaterThan(1);
    expect(fixture.requests.every((table) => table === 'profiles')).toBe(true);
    expect(fixture.rpc).not.toHaveBeenCalled();
  });

  it('ignores an old club lookup that finishes after the new club is already displayed', async () => {
    const resolved = new Map<string, string>();
    const finish = new Map<string, (uuid: string) => void>();
    vi.spyOn(clubIds, 'resolveClubUUIDSync').mockImplementation((id) => resolved.get(id) ?? null);
    vi.spyOn(clubIds, 'resolveClubUUID').mockImplementation(
      (id) =>
        new Promise<string>((resolve) => {
          finish.set(id, (uuid) => {
            resolved.set(id, uuid);
            resolve(uuid);
          });
        })
    );
    const view = render(<DynamicWallet {...base} clubId="111111" variant="club" />);
    await flush();
    view.rerender(<DynamicWallet {...base} clubId="222222" variant="club" />);
    await act(async () => finish.get('222222')!(base.clubId));
    await flush();
    expect(value(view.container, 'club_bank')).toHaveTextContent('100');
    await act(async () => finish.get('111111')!('33333333-3333-4333-8333-333333333333'));
    fixture.bank = 61;
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    await flush();
    expect(value(view.container, 'club_bank')).toHaveTextContent('61');
    expect(fixture.rpc.mock.calls.every(([, args]) => args.p_club_id === base.clubId)).toBe(true);
  });
});
