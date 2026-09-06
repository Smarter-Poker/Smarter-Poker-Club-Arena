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
    progress: index === 0 ? 3 : 0,
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
    periodKeys: { ...PERIOD_KEYS } as Record<keyof typeof PERIOD_KEYS, string>,
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

  it('accepts a complete server-clock receipt, preserves progress, and title-cases data', async () => {
    mocks.rpc.mockResolvedValue({ data: dashboardPayload(), error: null });

    const dashboard = await dailyChallengeService.getDashboard(USER_ID);

    expect(mocks.rpc).toHaveBeenCalledWith('get_daily_challenge_dashboard_v3');
    expect(dashboard.missions).toHaveLength(10);
    expect(dashboard.periodKeys).toEqual(PERIOD_KEYS);
    expect(dashboard.missions[0]).toMatchObject({
      progress: 3,
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
      'duplicate catalog contract',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.missions[1].challenge_id = payload.missions[0].challenge_id;
      },
    ],
    [
      'progress beyond its requirement',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.missions[0].progress = 11;
      },
    ],
    [
      'completed flag that disagrees with progress',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.missions[0].completed = true;
      },
    ],
    [
      'completed challenge without a completion time',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.missions[0].progress = 10;
        payload.missions[0].completed = true;
      },
    ],
    [
      'incomplete challenge with a completion time',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.missions[0].completed_at = '2026-09-06T00:00:00.000Z';
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
      'impossible calendar period',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.periodKeys.daily = '2026-02-31';
      },
    ],
    [
      'weekly period that is not the dashboard week',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.periodKeys.weekly = 'W2026-08-24';
      },
    ],
    [
      'invalid balance',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.diamondBalance = Number.NaN;
      },
    ],
    [
      'synchronization time from a different UTC cycle',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.syncedAt = '2026-09-07T00:00:00.001Z';
      },
    ],
    [
      'inconsistent vault',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.vault.count = 1;
      },
    ],
    [
      'vault page larger than the claim batch contract',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.vault.pageSize = 101;
      },
    ],
    [
      'vault total that contradicts the challenge totals',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.stats.totalCompleted = 1;
      },
    ],
    [
      'paginated vault total smaller than its visible reward page',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.stats.totalCompleted = 101;
        payload.vault = {
          count: 101,
          diamonds: 0,
          items: Array.from({ length: 100 }, (_, index) =>
            mission('daily', index + 100, {
              progress: 10,
              completed: true,
              completed_at: '2026-09-06T00:00:00.000Z',
            })
          ),
          pageSize: 100,
          hasMore: true,
        };
      },
    ],
    [
      'freeze inventory above its server cap',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.streak.freezesAvailable = 4;
      },
    ],
    [
      'freeze usage without a frozen date',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.streak.usedFreeze = true;
      },
    ],
    [
      'full freeze inventory with a next reward distance',
      (payload: ReturnType<typeof dashboardPayload>) => {
        payload.streak.freezesAvailable = 3;
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

  it.each([
    [
      'positive payout with no newly claimed challenge',
      [REQUESTED_ID],
      claimReceipt({
        claimedIds: [],
        alreadyClaimedIds: [REQUESTED_ID],
        diamonds: 10,
        replayed: true,
      }),
    ],
    [
      'career claim total below the settled batch',
      [REQUESTED_ID, UNRELATED_ID],
      claimReceipt({
        claimedIds: [REQUESTED_ID, UNRELATED_ID],
        stats: { totalClaimed: 1, totalDiamondsEarned: 20 },
      }),
    ],
    [
      'career earned total below the current payout',
      [REQUESTED_ID],
      claimReceipt({
        diamonds: 20,
        stats: { totalClaimed: 1, totalDiamondsEarned: 10 },
      }),
    ],
  ])('rejects a %s receipt', async (_label, ids, receipt) => {
    mocks.rpc.mockResolvedValue({ data: receipt, error: null });

    await expect(dailyChallengeService.claimChallenges(USER_ID, ids)).rejects.toThrow(
      'invalid claim settlement totals receipt'
    );
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it.each([
    ['new purchase', false, 10],
    ['replayed purchase', true, 0],
  ])(
    'rejects a %s reroll receipt that keeps the paid catalog contract',
    async (_, replayed, spent) => {
      mocks.rpc.mockResolvedValue({
        data: {
          success: true,
          alreadyRerolled: replayed,
          requestId: REQUESTED_ID,
          diamondsSpent: spent,
          challengeId: 'daily_0',
          challenge: mission('daily', 0, { id: REQUESTED_ID }),
          diamondBalance: 90,
        },
        error: null,
      });

      await expect(
        dailyChallengeService.rerollChallenge(USER_ID, REQUESTED_ID, 'daily_0')
      ).resolves.toMatchObject({ success: false });
      expect(mocks.emit).not.toHaveBeenCalled();
    }
  );
});
