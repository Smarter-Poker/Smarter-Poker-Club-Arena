import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const fixtures = vi.hoisted(() => ({
  account: '11111111-1111-4111-8111-111111111111',
  progress: vi.fn(),
  claims: vi.fn(),
  confirm: vi.fn(),
  transfer: vi.fn(),
}));
const accountB = '22222222-2222-4222-8222-222222222222';
vi.mock('@/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: fixtures.account } }) }));
vi.mock('@/stores/useUserStore', () => ({
  useUserStore: Object.assign(
    (selector: any) =>
      selector({ user: { id: fixtures.account, player_number: 12 }, currentClubId: null }),
    { getState: () => ({ user: { id: fixtures.account } }) }
  ),
}));
vi.mock('@/stores/useWalletStore', () => {
  const store = {
    balances: {
      BUSINESS: { total: 0, available: 0, locked: 0 },
      PLAYER: { total: 0, available: 0, locked: 0 },
      PROMO: { total: 0, available: 0, locked: 0 },
    },
    diamonds: 100,
    loadBalances: async () => {},
    loadDiamonds: async () => {},
  };
  return {
    WALLET_STORE_FRESH_MS: 5000,
    useWalletStore: Object.assign(() => store, {
      getState: () => ({ ...store, _balancesAt: 1, _balancesUserId: fixtures.account }),
    }),
  };
});
vi.mock('@/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: () => {} }));
vi.mock('@/hooks/useRealtimeFinancials', () => ({ useRealtimeFinancials: () => {} }));
vi.mock('@/hooks/useDiamondWalletSummary', () => ({
  useDiamondWalletSummary: () => ({ summary: undefined, load: async () => {} }),
}));
vi.mock('@/hooks/useDiamondLedger', () => ({
  useDiamondLedger: () => ({ rows: [], load: async () => {}, hasMore: false }),
}));
vi.mock('@/hooks/useNextDiamondFreeroll', () => ({
  useDiamondFreerollCountdown: () => ({ startsAt: null, text: '' }),
}));
vi.mock('@/hooks/useReferralCount', () => ({ useReferralCount: () => 0 }));
vi.mock('@/hooks/useMasterBusSubscription', () => ({ useMasterBusSubscriptions: () => {} }));
vi.mock('@/core/MasterBus', () => ({
  masterBus: {
    subscribeDebounced: () => () => {},
    subscribe: () => () => {},
    emit: vi.fn(),
    removeRegisteredChannel: vi.fn(),
    getOrCreateChannel: () => {
      const c: any = { on: () => c, subscribe: () => c };
      return c;
    },
  },
}));
vi.mock('@/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('@/components/common/confirmDialog', () => ({ confirmDialog: fixtures.confirm }));
vi.mock('@/services/DiamondService', () => ({
  DiamondService: { getLifetimeStats: async () => ({ earned: 0, spent: 0 }) },
}));
vi.mock('@/services/PromotionService', () => ({
  promotionService: { getUserClaims: fixtures.claims, claimPromotion: vi.fn() },
}));
vi.mock('@/pages/marketplace/marketplaceShared', () => ({
  storeFetch: (path: string, opts: any) =>
    path === '/api/rewards/progress' ? fixtures.progress(opts) : fixtures.transfer(path, opts),
}));
vi.mock('@/services/CashierResilience', () => ({ readCashierOnlineState: () => true }));
vi.mock('@/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('@/utils/clubIdResolver', () => ({ resolveClubUUID: async (v: string) => v }));
vi.mock('@/utils/resolvePageClubId', () => ({ resolvePageClubId: async () => null }));
vi.mock('@/lib/supabase', () => {
  const offer = {
    id: 'offer-1',
    title: 'Live Offer',
    description: 'Real Existing Offer',
    type: 'special',
    start_date: '2020-01-01',
    end_date: '2099-01-01',
    status: 'active',
  };
  return {
    supabase: {
      from: (table: string) => {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          in: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: { player_number: 12 }, error: null }),
          then: (resolve: any) =>
            Promise.resolve({
              data:
                table === 'promotions'
                  ? [offer]
                  : table === 'friendships'
                    ? [{ friend_id: '33333333-3333-4333-8333-333333333333' }]
                    : table === 'profiles'
                      ? [
                          {
                            id: '33333333-3333-4333-8333-333333333333',
                            poker_alias: 'Accepted Friend',
                          },
                        ]
                      : [],
              error: null,
            }).then(resolve),
        };
        return chain;
      },
    },
  };
});
vi.mock('@/components/layouts/StandardContentLayout', () => ({
  default: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@/components/rewards/RewardsSurfaceHeader', () => ({
  default: ({ title, children }: any) => (
    <section>
      <h1>{title}</h1>
      {children}
    </section>
  ),
}));
vi.mock('@/components/games/DiamondsToChipsButton', () => ({ default: () => null }));
vi.mock('@/components/wallet/TransactionHistory', () => ({ TransactionHistory: () => null }));
vi.mock('@/components/wallet/ChipStatement', () => ({ default: () => null }));
vi.mock('@/components/wallet/DiamondArenaStatement', () => ({ default: () => null }));
vi.mock('@/components/wallet/DiamondFlowPanel', () => ({ default: () => null }));
vi.mock('@/components/wallet/DepositWithdrawModal', () => ({ default: () => null }));
vi.mock('@/components/wallet/DisputeSubmitModal', () => ({ default: () => null }));
vi.mock('@/components/social/ReferralModal', () => ({ default: () => null }));
vi.mock('@/components/leaderboard/LeaderboardCard', () => ({ default: () => null }));
vi.mock('@/components/table/ThrowableImage', () => ({ ThrowableImage: () => null }));

import PlayerWalletPage from '@/pages/PlayerWalletPage';
import PromotionsPage from '@/pages/PromotionsPage';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const progress = (streak: number, claimed: boolean) => ({
  earnedToday: 0,
  dailyCap: 100,
  dailyRemaining: 100,
  loginStreak: streak,
  loginClaimedToday: claimed,
  nextLoginReward: 10,
  multiplier: 1,
  isVip: false,
  partial: false,
});
afterEach(cleanup);
beforeEach(() => {
  fixtures.account = '11111111-1111-4111-8111-111111111111';
  vi.clearAllMocks();
  fixtures.claims.mockResolvedValue([]);
});

describe('Rewards page account ownership', () => {
  it('a different player gets fresh Earn progress and their own daily claim eligibility', async () => {
    fixtures.progress
      .mockResolvedValueOnce(progress(17, true))
      .mockResolvedValueOnce(progress(2, false));
    const view = render(
      <MemoryRouter>
        <PlayerWalletPage />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Earn' }));
    await screen.findByText('17 Days');
    fixtures.account = accountB;
    view.rerender(
      <MemoryRouter>
        <PlayerWalletPage />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Earn' }));
    await screen.findByText('2 Days');
    expect(screen.queryByText('17 Days')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Claim Daily Diamonds' }) as HTMLButtonElement).disabled
    ).toBe(false);
    expect(fixtures.progress.mock.calls.at(-1)?.[0]).toMatchObject({ expectedUserId: accountB });
  });

  it('a delayed old-player progress read cannot replace the new player', async () => {
    const old = deferred<any>();
    fixtures.progress.mockReturnValueOnce(old.promise).mockResolvedValueOnce(progress(3, false));
    const view = render(
      <MemoryRouter>
        <PlayerWalletPage />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Earn' }));
    await waitFor(() => expect(fixtures.progress).toHaveBeenCalledTimes(1));
    fixtures.account = accountB;
    view.rerender(
      <MemoryRouter>
        <PlayerWalletPage />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Earn' }));
    await screen.findByText('3 Days');
    await act(async () => old.resolve(progress(98, true)));
    expect(screen.queryByText('98 Days')).toBeNull();
    expect(screen.getByText('3 Days')).toBeTruthy();
  });

  it('delayed claims from the old player cannot mark the new player claimed', async () => {
    const old = deferred<any[]>();
    fixtures.claims.mockReturnValueOnce(old.promise).mockResolvedValueOnce([]);
    const view = render(
      <MemoryRouter>
        <PromotionsPage />
      </MemoryRouter>
    );
    await screen.findByText('Live Offer');
    fixtures.account = accountB;
    view.rerender(
      <MemoryRouter>
        <PromotionsPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(fixtures.claims).toHaveBeenCalledTimes(2));
    await act(async () => old.resolve([{ promotionId: 'offer-1' }]));
    expect(screen.queryByText('Claimed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Claim' })).toBeTruthy();
  });

  it('a send confirmation from the previous account cannot send as the new account', async () => {
    const confirmation = deferred<boolean>();
    fixtures.confirm.mockReturnValue(confirmation.promise);
    const view = render(
      <MemoryRouter>
        <PlayerWalletPage />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Send' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Recipient') as HTMLSelectElement).disabled).toBe(false)
    );
    fireEvent.change(screen.getByLabelText('Recipient'), {
      target: { value: '33333333-3333-4333-8333-333333333333' },
    });
    fireEvent.change(screen.getByLabelText('Amount (Diamonds)'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Diamonds' }));
    expect(fixtures.confirm).toHaveBeenCalledTimes(1);
    fixtures.account = accountB;
    view.rerender(
      <MemoryRouter>
        <PlayerWalletPage />
      </MemoryRouter>
    );
    await act(async () => confirmation.resolve(true));
    expect(fixtures.transfer).not.toHaveBeenCalled();
  });

  it('returning to an account retries an unknown exact transfer with its original request', async () => {
    fixtures.confirm.mockResolvedValue(true);
    fixtures.transfer
      .mockRejectedValueOnce(new Error('Transfer Receipt Unconfirmed'))
      .mockResolvedValueOnce({ success: true, amount: 5 });
    const view = render(
      <MemoryRouter>
        <PlayerWalletPage />
      </MemoryRouter>
    );
    const send = async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Send' }));
      await waitFor(() =>
        expect((screen.getByLabelText('Recipient') as HTMLSelectElement).disabled).toBe(false)
      );
      fireEvent.change(screen.getByLabelText('Recipient'), {
        target: { value: '33333333-3333-4333-8333-333333333333' },
      });
      fireEvent.change(screen.getByLabelText('Amount (Diamonds)'), { target: { value: '5' } });
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send Diamonds' })));
    };
    await send();
    const first = fixtures.transfer.mock.calls[0][1];
    fixtures.account = accountB;
    view.rerender(
      <MemoryRouter>
        <PlayerWalletPage />
      </MemoryRouter>
    );
    fixtures.account = '11111111-1111-4111-8111-111111111111';
    view.rerender(
      <MemoryRouter>
        <PlayerWalletPage />
      </MemoryRouter>
    );
    await send();
    expect(fixtures.transfer.mock.calls[1][1]).toMatchObject({
      idempotencyKey: first.idempotencyKey,
      expectedUserId: fixtures.account,
    });
  });
});
