import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  emit: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mocks.rpc(...args) },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: (...args: unknown[]) => mocks.emit(...args) },
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...args: unknown[]) => mocks.reportError(...args),
}));

vi.mock('../../src/utils/retryFetch', () => ({
  retryFetch: (operation: () => Promise<unknown>) => operation(),
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: (operation: () => Promise<unknown>) => operation(),
}));

vi.mock('../../src/utils/uuid', () => ({
  uuid: () => '22222222-2222-4222-8222-222222222222',
}));

const { dailyChallengeService } = await import('../../src/services/DailyChallengeService');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CHALLENGE_ROW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const PERIOD_KEYS = {
  daily: '2026-09-06',
  weekly: 'W2026-08-31',
  monthly: 'M2026-09',
} as const;

function mission(tier: keyof typeof PERIOD_KEYS, index: number) {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${(index + 10).toString(16).padStart(12, '0')}`,
    challenge_id: `${tier}_${index}`,
    assigned_date: PERIOD_KEYS[tier],
    progress: 0,
    completed: false,
    claimed: false,
    completed_at: null,
    name: `${tier} challenge ${index}`,
    description: `complete ${tier} challenge ${index}`,
    challenge_type: 'hands_played',
    requirement: 10,
    diamond_reward: 10,
    tier,
  };
}

function dashboardReceipt(streak: Record<string, unknown>) {
  return {
    missions: [
      ...Array.from({ length: 5 }, (_, index) => mission('daily', index)),
      ...Array.from({ length: 3 }, (_, index) => mission('weekly', index + 5)),
      ...Array.from({ length: 2 }, (_, index) => mission('monthly', index + 8)),
    ],
    periodKeys: PERIOD_KEYS,
    stats: {
      totalCompleted: 3,
      totalClaimed: 3,
      currentStreak: 3,
      totalDiamondsEarned: 40,
      milestoneStart: 0,
      nextMilestone: 7,
      milestoneReward: 25,
      milestoneRewardCurrency: 'diamonds',
      milestoneProgressPercent: 42,
      daysToMilestone: 4,
    },
    streak,
    diamondBalance: 135,
    vault: { count: 0, diamonds: 0, items: [], pageSize: 100, hasMore: false },
    revision: 7,
    syncedAt: '2026-09-06T12:00:00.000Z',
  };
}

function activeStreakReceipt() {
  return {
    streak: 3,
    freezesAvailable: 1,
    usedFreeze: false,
    frozenDate: null,
    lastFrozenDate: null,
    honoredFrozenDates: 0,
    consumedFreeze: false,
    consumedFrozenDate: null,
    nextFreezeIn: 4,
    freezeReceiptVersion: 2,
  };
}

function claimReceipt(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    replayed: false,
    claimedIds: [CHALLENGE_ROW_ID],
    alreadyClaimedIds: [],
    diamonds: 10,
    challengeDiamonds: 10,
    milestoneDiamonds: 25,
    diamondsCredited: 35,
    settlementDiamondBalance: 135,
    diamondBalance: 135,
    settlementVersion: 2,
    stats: { totalClaimed: 1, totalDiamondsEarned: 35 },
    vault: { count: 0, diamonds: 0, items: [], pageSize: 100, hasMore: false },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.emit.mockReset();
  mocks.reportError.mockReset();
});

describe('Daily Missions settlement receipt v2', () => {
  it('returns every Diamond component and broadcasts the exact combined wallet delta', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: claimReceipt(), error: null })
      .mockResolvedValueOnce({ data: dashboardReceipt(activeStreakReceipt()), error: null });

    const result = await dailyChallengeService.claimChallenges(USER_ID, [CHALLENGE_ROW_ID]);

    expect(result).toMatchObject({
      diamonds: 10,
      challengeDiamonds: 10,
      milestoneDiamonds: 25,
      diamondsCredited: 35,
      settlementDiamondBalance: 135,
      diamondBalance: 135,
    });
    expect(mocks.emit).toHaveBeenNthCalledWith(1, 'BALANCE_UPDATED', {
      source: 'daily_challenge_claim',
      userId: USER_ID,
    });
    expect(mocks.emit).toHaveBeenNthCalledWith(2, 'DIAMOND_BALANCE_CHANGED', {
      newBalance: 135,
      delta: 35,
      source: 'daily_challenge_claim',
    });
  });

  it.each([
    { challengeDiamonds: 9 },
    { milestoneDiamonds: 24, diamondsCredited: 35 },
    { diamondsCredited: 34 },
    { settlementDiamondBalance: 34 },
  ])('rejects a contradictory settlement breakdown before emitting: %o', async (override) => {
    mocks.rpc.mockResolvedValue({ data: claimReceipt(override), error: null });

    await expect(
      dailyChallengeService.claimChallenges(USER_ID, [CHALLENGE_ROW_ID])
    ).rejects.toThrow('invalid claim settlement totals receipt');
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('keeps the immutable settlement balance while broadcasting the current replay projection', async () => {
    const currentDashboard = dashboardReceipt(activeStreakReceipt());
    currentDashboard.diamondBalance = 184;
    currentDashboard.stats.totalDiamondsEarned = 79;
    mocks.rpc
      .mockResolvedValueOnce({
        data: claimReceipt({
          replayed: true,
          settlementDiamondBalance: 135,
          diamondBalance: 184,
        }),
        error: null,
      })
      .mockResolvedValueOnce({ data: currentDashboard, error: null });

    const result = await dailyChallengeService.claimChallenges(USER_ID, [CHALLENGE_ROW_ID]);

    expect(result).toMatchObject({
      replayed: true,
      settlementDiamondBalance: 135,
      diamondBalance: 184,
      diamondsCredited: 35,
      stats: { totalDiamondsEarned: 79 },
      dashboard: { revision: 7, diamondBalance: 184 },
    });
    expect(mocks.emit).toHaveBeenNthCalledWith(2, 'DIAMOND_BALANCE_CHANGED', {
      newBalance: 184,
      delta: 35,
      source: 'daily_challenge_claim',
    });
  });

  it('accepts a legacy challenge-only receipt during a database-first rolling deploy', async () => {
    const legacy: Record<string, unknown> = claimReceipt();
    delete legacy.challengeDiamonds;
    delete legacy.milestoneDiamonds;
    delete legacy.diamondsCredited;
    delete legacy.settlementDiamondBalance;
    delete legacy.settlementVersion;
    mocks.rpc
      .mockResolvedValueOnce({ data: legacy, error: null })
      .mockResolvedValueOnce({ data: dashboardReceipt(activeStreakReceipt()), error: null });

    await expect(
      dailyChallengeService.claimChallenges(USER_ID, [CHALLENGE_ROW_ID])
    ).resolves.toMatchObject({
      diamonds: 10,
      challengeDiamonds: 10,
      milestoneDiamonds: 0,
      diamondsCredited: 10,
    });
  });

  it('accepts a legacy replay after later spending while retaining its original settlement balance', async () => {
    const legacy: Record<string, unknown> = claimReceipt({
      replayed: true,
      diamonds: 10,
      settlementDiamondBalance: 135,
      diamondBalance: 0,
    });
    delete legacy.challengeDiamonds;
    delete legacy.milestoneDiamonds;
    delete legacy.diamondsCredited;
    delete legacy.settlementVersion;
    const currentDashboard = dashboardReceipt(activeStreakReceipt());
    currentDashboard.diamondBalance = 0;
    mocks.rpc
      .mockResolvedValueOnce({ data: legacy, error: null })
      .mockResolvedValueOnce({ data: currentDashboard, error: null });

    await expect(
      dailyChallengeService.claimChallenges(USER_ID, [CHALLENGE_ROW_ID])
    ).resolves.toMatchObject({
      replayed: true,
      diamondsCredited: 10,
      settlementDiamondBalance: 135,
      diamondBalance: 0,
    });
    expect(mocks.emit).toHaveBeenNthCalledWith(2, 'DIAMOND_BALANCE_CHANGED', {
      newBalance: 0,
      delta: 10,
      source: 'daily_challenge_claim',
    });
  });

  it('returns a current revision-bearing projection instead of stale embedded stats and vault', async () => {
    const currentDashboard = dashboardReceipt(activeStreakReceipt());
    currentDashboard.diamondBalance = 172;
    currentDashboard.stats.totalClaimed = 3;
    currentDashboard.stats.totalDiamondsEarned = 72;
    mocks.rpc
      .mockResolvedValueOnce({ data: claimReceipt(), error: null })
      .mockResolvedValueOnce({ data: currentDashboard, error: null });

    const result = await dailyChallengeService.claimChallenges(USER_ID, [CHALLENGE_ROW_ID]);

    expect(result).toMatchObject({
      diamondBalance: 172,
      stats: { totalClaimed: 3, totalDiamondsEarned: 72 },
      dashboard: {
        revision: 7,
        diamondBalance: 172,
        stats: { totalClaimed: 3, totalDiamondsEarned: 72 },
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'get_daily_challenge_dashboard_v3');
  });

  it('refuses a dashboard projection that regresses below the immutable receipt lifetime totals', async () => {
    const staleDashboard = dashboardReceipt(activeStreakReceipt());
    mocks.rpc
      .mockResolvedValueOnce({
        data: claimReceipt({
          stats: { totalClaimed: 100, totalDiamondsEarned: 5_000 },
        }),
        error: null,
      })
      .mockResolvedValueOnce({ data: staleDashboard, error: null });

    const result = await dailyChallengeService.claimChallenges(USER_ID, [CHALLENGE_ROW_ID]);

    expect(result).toMatchObject({
      dashboard: null,
      stats: { totalClaimed: 100, totalDiamondsEarned: 5_000 },
    });
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'DailyChallengeService.claimChallenges_invalid_receipt'
    );
  });
});

describe('Daily Missions streak-freeze receipts', () => {
  it.each([
    {
      alreadyPurchased: false,
      diamondsSpent: 5000,
      freezesAvailable: 2,
      diamondBalance: 5000,
      expectedDelta: -5000,
    },
    {
      alreadyPurchased: true,
      diamondsSpent: 0,
      freezesAvailable: 2,
      diamondBalance: 5000,
      expectedDelta: 0,
    },
  ])(
    'returns and broadcasts the authoritative spend on fresh and replayed purchases: %o',
    async ({ expectedDelta, ...receipt }) => {
      mocks.rpc.mockResolvedValue({ data: { success: true, ...receipt }, error: null });

      const result = await dailyChallengeService.buyStreakFreeze(USER_ID);

      expect(result).toMatchObject(receipt);
      expect(mocks.emit).toHaveBeenCalledWith('DIAMOND_BALANCE_CHANGED', {
        newBalance: receipt.diamondBalance,
        delta: expectedDelta,
        source: 'streak_freeze_purchase',
      });
    }
  );

  it('keeps active-run freeze history after reload without inventing a second spend', async () => {
    mocks.rpc.mockResolvedValue({
      data: dashboardReceipt({
        streak: 3,
        freezesAvailable: 1,
        usedFreeze: true,
        frozenDate: '2026-09-04',
        lastFrozenDate: '2026-09-04',
        honoredFrozenDates: 1,
        consumedFreeze: false,
        consumedFrozenDate: null,
        nextFreezeIn: 4,
        freezeReceiptVersion: 2,
      }),
      error: null,
    });

    const dashboard = await dailyChallengeService.getDashboard(USER_ID);

    expect(dashboard.streak).toEqual({
      streak: 3,
      freezesAvailable: 1,
      usedFreeze: true,
      frozenDate: '2026-09-04',
      lastFrozenDate: '2026-09-04',
      honoredFrozenDates: 1,
      consumedFreeze: false,
      consumedFrozenDate: null,
      nextFreezeIn: 4,
    });
  });

  it('accepts the v1 rolling-deploy consumption receipt whose honored count is one call behind', async () => {
    mocks.rpc.mockResolvedValue({
      data: dashboardReceipt({
        streak: 3,
        freezesAvailable: 0,
        usedFreeze: true,
        frozenDate: '2026-09-04',
        honoredFrozenDates: 0,
        nextFreezeIn: 4,
      }),
      error: null,
    });

    const dashboard = await dailyChallengeService.getDashboard(USER_ID);

    expect(dashboard.streak).toEqual({
      streak: 3,
      freezesAvailable: 0,
      usedFreeze: true,
      frozenDate: '2026-09-04',
      lastFrozenDate: '2026-09-04',
      honoredFrozenDates: 1,
      consumedFreeze: true,
      consumedFrozenDate: '2026-09-04',
      nextFreezeIn: 4,
    });
  });

  it('rejects freeze history whose aliases or protected-date count disagree', async () => {
    mocks.rpc.mockResolvedValue({
      data: dashboardReceipt({
        streak: 3,
        freezesAvailable: 1,
        usedFreeze: true,
        frozenDate: '2026-09-04',
        lastFrozenDate: '2026-09-03',
        honoredFrozenDates: 0,
        consumedFreeze: false,
        consumedFrozenDate: null,
        nextFreezeIn: 4,
      }),
      error: null,
    });

    await expect(dailyChallengeService.getDashboard(USER_ID)).rejects.toThrow(
      'invalid frozen date receipt'
    );
    expect(mocks.reportError).toHaveBeenCalled();
  });

  it('rejects a newly consumed freeze that is absent from persistent active-run history', async () => {
    mocks.rpc.mockResolvedValue({
      data: dashboardReceipt({
        streak: 3,
        freezesAvailable: 1,
        usedFreeze: false,
        frozenDate: null,
        lastFrozenDate: null,
        honoredFrozenDates: 0,
        consumedFreeze: true,
        consumedFrozenDate: '2026-09-04',
        nextFreezeIn: 4,
        freezeReceiptVersion: 2,
      }),
      error: null,
    });

    await expect(dailyChallengeService.getDashboard(USER_ID)).rejects.toThrow(
      'invalid frozen date receipt'
    );
    expect(mocks.reportError).toHaveBeenCalled();
  });
});
