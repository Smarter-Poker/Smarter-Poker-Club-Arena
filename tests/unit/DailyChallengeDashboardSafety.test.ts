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

const { dailyChallengeService } = await import('../../src/services/DailyChallengeService');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTED_ID = '22222222-2222-4222-8222-222222222222';
const UNRELATED_ID = '33333333-3333-4333-8333-333333333333';
const PERIOD_KEYS = {
  daily: '2026-09-06',
  weekly: 'W2026-08-31',
  monthly: 'M2026-09',
} as const;

function mission(
  tier: keyof typeof PERIOD_KEYS,
  index: number,
  overrides: Record<string, unknown> = {}
) {
  const suffix = index.toString(16).padStart(12, '0');
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
    challenge_id: `${tier}_${index}`,
    assigned_date: PERIOD_KEYS[tier],
    progress: index === 0 ? 999 : 0,
    completed: false,
    claimed: false,
    completed_at: null,
    name: index === 0 ? 'play ten hands' : `${tier} challenge ${index}`,
    description: index === 0 ? 'play ten hands today' : `complete ${tier} challenge ${index}`,
    challenge_type: 'hands_played',
    requirement: 10,
    diamond_reward: 10,
    tier,
    ...overrides,
  };
}

function dashboardPayload() {
  return {
    missions: [
      ...Array.from({ length: 5 }, (_, index) => mission('daily', index)),
      ...Array.from({ length: 3 }, (_, index) => mission('weekly', index + 5)),
      ...Array.from({ length: 2 }, (_, index) => mission('monthly', index + 8)),
    ],
    periodKeys: PERIOD_KEYS,
    stats: {
      totalCompleted: 0,
      totalClaimed: 0,
      currentStreak: 0,
      totalDiamondsEarned: 0,
      milestoneStart: 0,
      nextMilestone: 7,
      milestoneReward: 25,
      milestoneRewardCurrency: 'diamonds',
      milestoneProgressPercent: 0,
      daysToMilestone: 7,
    },
    streak: {
      streak: 0,
      freezesAvailable: 0,
      usedFreeze: false,
      frozenDate: null,
      nextFreezeIn: 5,
    },
    diamondBalance: 100,
    vault: { count: 0, diamonds: 0, items: [], pageSize: 100, hasMore: false },
    revision: 4,
    syncedAt: '2026-09-06T00:00:00.000Z',
  };
}

function claimReceipt(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    replayed: false,
    claimedIds: [REQUESTED_ID],
    alreadyClaimedIds: [],
    diamonds: 10,
    diamondBalance: 110,
    stats: { totalClaimed: 1, totalDiamondsEarned: 10 },
    vault: { count: 0, diamonds: 0, items: [], pageSize: 100, hasMore: false },
    ...overrides,
  };
}

describe('Daily Challenge dashboard safety boundary', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.emit.mockReset();
    mocks.reportError.mockReset();
  });

  it('accepts a complete server-clock receipt, clamps display progress, and title-cases data', async () => {
    mocks.rpc.mockResolvedValue({ data: dashboardPayload(), error: null });

    const dashboard = await dailyChallengeService.getDashboard(USER_ID);

    expect(mocks.rpc).toHaveBeenCalledWith('get_daily_challenge_dashboard_v3');
    expect(dashboard.missions).toHaveLength(10);
    expect(dashboard.periodKeys).toEqual(PERIOD_KEYS);
    expect(dashboard.missions[0]).toMatchObject({
      progress: 10,
      challenge: {
        name: 'Play Ten Hands',
        description: 'Play Ten Hands Today',
        type: 'hands_played',
        requirement: 10,
      },
    });
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it.each([
    [
      'malformed row',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.missions[0].challenge_type = 'future_type';
      },
    ],
    [
      'duplicate row',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.missions[1].id = payload.missions[0].id;
      },
    ],
    [
      'wrong tier count',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.missions.pop();
      },
    ],
    [
      'wrong period',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.missions[0].assigned_date = '2026-09-05';
      },
    ],
    [
      'invalid balance',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.diamondBalance = Number.NaN;
      },
    ],
    [
      'inconsistent vault',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.vault.count = 1;
      },
    ],
  ])('rejects a %s instead of partially repainting the dashboard', async (_label, mutate) => {
    const payload = dashboardPayload();
    mutate(payload);
    mocks.rpc.mockResolvedValue({ data: payload, error: null });

    await expect(dailyChallengeService.getDashboard(USER_ID)).rejects.toThrow(/invalid/i);
    expect(mocks.reportError).toHaveBeenCalled();
  });

  it('rejects claim receipts that name an unrelated assignment', async () => {
    mocks.rpc.mockResolvedValue({
      data: claimReceipt({ claimedIds: [UNRELATED_ID] }),
      error: null,
    });

    await expect(dailyChallengeService.claimChallenges(USER_ID, [REQUESTED_ID])).rejects.toThrow(
      'invalid claimed challenge receipt'
    );
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('rejects partial claim coverage and non-finite wallet values before emitting', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: claimReceipt({ claimedIds: [], alreadyClaimedIds: [] }),
        error: null,
      })
      .mockResolvedValueOnce({
        data: claimReceipt({ diamonds: Number.NaN }),
        error: null,
      });

    await expect(dailyChallengeService.claimChallenges(USER_ID, [REQUESTED_ID])).rejects.toThrow(
      'invalid incomplete claim coverage receipt'
    );
    await expect(dailyChallengeService.claimChallenges(USER_ID, [REQUESTED_ID])).rejects.toThrow(
      'invalid claimed diamond total receipt'
    );
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('accepts exact claimed and already-claimed coverage once the whole receipt is valid', async () => {
    mocks.rpc.mockResolvedValue({ data: claimReceipt(), error: null });

    const receipt = await dailyChallengeService.claimChallenges(USER_ID, [REQUESTED_ID]);

    expect(receipt).toMatchObject({
      success: true,
      replayed: false,
      claimedIds: [REQUESTED_ID],
      diamonds: 10,
      diamondBalance: 110,
    });
    expect(mocks.emit).toHaveBeenCalledTimes(2);
  });
});
