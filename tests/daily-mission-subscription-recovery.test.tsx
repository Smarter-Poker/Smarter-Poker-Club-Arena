import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DailyChallengesPage from '../src/pages/DailyChallengesPage';
import type { DailyChallengeDashboard } from '../src/services/DailyChallengeService';

const mocks = vi.hoisted(() => ({
  dashboard: vi.fn(),
  revision: vi.fn(),
  subscribed: null as null | ((status: string) => void),
  buyFreeze: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../src/lib/supabase', () => ({
  getAuthUser: vi.fn().mockResolvedValue({ data: { user: { id: 'freeze-player' } }, error: null }),
}));
vi.mock('../src/services/DailyChallengeService', () => ({
  DAILY_MISSION_REROLL_COST: 100,
  dailyChallengeService: {
    getDashboard: mocks.dashboard,
    getDashboardRevision: mocks.revision,
    buyStreakFreeze: mocks.buyFreeze,
  },
}));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => mocks }));
vi.mock('../src/hooks/useMasterBusBroadcastChannel', () => ({
  useMasterBusBroadcastChannel: (options: {
    enabled: boolean;
    onSubscriptionStatus: (status: string) => void;
  }) => {
    if (options.enabled) mocks.subscribed = options.onSubscriptionStatus;
  },
}));
vi.mock('../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), on: vi.fn(() => () => undefined) },
}));
vi.mock('../src/lib/analytics', () => ({ capture: vi.fn() }));
vi.mock('../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/utils/ChunkPreloader', () => ({ prefetchIntent: vi.fn() }));
vi.mock('../src/services/DailyMissionTelemetryService', () => ({
  recordDailyMissionOperation: vi.fn(),
  dailyMissionReasonCode: () => 'test_error',
}));
vi.mock('../src/services/DailyMissionNotificationService', () => ({
  getDailyMissionAlertPreference: vi.fn().mockResolvedValue(false),
  setDailyMissionAlertPreference: vi.fn(),
}));
vi.mock('../src/lib/pushClient', () => ({
  enablePush: vi.fn(),
  hasLocalSubscription: vi.fn().mockResolvedValue(false),
  isIos: () => false,
  isIosStandalonePwa: () => false,
  isWebPushSupported: () => false,
  notificationPermission: () => 'default',
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function dashboard(revision = 1): DailyChallengeDashboard {
  return {
    missions: [],
    periodKeys: { daily: new Date().toISOString().slice(0, 10), weekly: 'week', monthly: 'month' },
    stats: {
      totalCompleted: 0,
      totalClaimed: 0,
      currentStreak: 1,
      totalDiamondsEarned: 0,
      milestoneStart: 0,
      nextMilestone: 7,
      milestoneReward: 100,
      milestoneProgressPercent: 14,
      daysToMilestone: 6,
    },
    streak: {
      streak: 1,
      freezesAvailable: revision - 1,
      usedFreeze: false,
      frozenDate: null,
      lastFrozenDate: null,
      honoredFrozenDates: 0,
      consumedFreeze: false,
      consumedFrozenDate: null,
      nextFreezeIn: null,
    },
    diamondBalance: revision === 1 ? 10000 : 5000,
    vault: { count: 0, diamonds: 0, items: [], pageSize: 100, hasMore: false },
    revision,
    syncedAt: new Date().toISOString(),
  };
}

async function mountPage() {
  const shell = document.createElement('div');
  shell.id = 'root';
  document.body.appendChild(shell);
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <MemoryRouter>
        <DailyChallengesPage />
      </MemoryRouter>,
      { container: shell }
    );
  });
  return { shell, ...view };
}

async function subscribe() {
  expect(mocks.subscribed).not.toBeNull();
  await act(async () => mocks.subscribed!('SUBSCRIBED'));
}

function visibleBalance() {
  return screen
    .getByText('Available Diamonds')
    .parentElement?.querySelector('strong')
    ?.textContent?.trim();
}

describe('Daily Missions initial realtime subscription handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.dashboard.mockResolvedValue(dashboard());
    mocks.revision.mockResolvedValue(1);
    mocks.subscribed = null;
  });
  afterEach(() => {
    cleanup();
    document.getElementById('root')?.remove();
    vi.useRealTimers();
  });

  it('repairs a revision missed between the dashboard receipt and the first subscription', async () => {
    await mountPage();
    expect(visibleBalance()).toBe('10,000');
    mocks.revision.mockResolvedValue(2);
    mocks.dashboard.mockResolvedValue(dashboard(2));
    await subscribe();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(251);
    });
    expect(mocks.dashboard).toHaveBeenCalledTimes(2);
    expect(visibleBalance()).toBe('5,000');
  });

  it('keeps a current cold load at one dashboard read', async () => {
    await mountPage();
    await subscribe();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(251);
    });
    expect(mocks.revision).toHaveBeenCalledWith('freeze-player');
    expect(mocks.dashboard).toHaveBeenCalledTimes(1);
    expect(visibleBalance()).toBe('10,000');
  });

  it('retains a newer subscription cursor while the initial dashboard is still in flight', async () => {
    const initial = deferred<DailyChallengeDashboard>();
    mocks.dashboard.mockReturnValueOnce(initial.promise).mockResolvedValue(dashboard(2));
    mocks.revision.mockResolvedValue(2);
    await mountPage();
    await subscribe();
    await act(async () => initial.resolve(dashboard()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(251);
    });
    expect(mocks.dashboard).toHaveBeenCalledTimes(2);
    expect(visibleBalance()).toBe('5,000');
  });

  it('discards a cursor reply from an unmounted page', async () => {
    const cursor = deferred<number>();
    mocks.revision.mockReturnValue(cursor.promise);
    const page = await mountPage();
    await subscribe();
    expect(mocks.revision).toHaveBeenCalledTimes(1);
    page.unmount();
    await act(async () => cursor.resolve(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(251);
    });
    expect(mocks.dashboard).toHaveBeenCalledTimes(1);
  });

  it('keeps the confirmed dashboard after a cursor read fails', async () => {
    mocks.revision.mockRejectedValue(new Error('cursor unavailable'));
    await mountPage();
    await subscribe();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(251);
    });
    expect(mocks.revision).toHaveBeenCalledTimes(1);
    expect(mocks.dashboard).toHaveBeenCalledTimes(1);
    expect(visibleBalance()).toBe('10,000');
  });

  it('does not turn a zero cursor into a second cold dashboard read', async () => {
    mocks.revision.mockResolvedValue(0);
    await mountPage();
    await subscribe();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(251);
    });
    expect(mocks.dashboard).toHaveBeenCalledTimes(1);
  });

  it('retires a pending cursor when its channel closes and reconciles the new join', async () => {
    const retiredCursor = deferred<number>();
    mocks.revision.mockReturnValueOnce(retiredCursor.promise).mockResolvedValue(2);
    await mountPage();
    await subscribe();
    await act(async () => mocks.subscribed!('CLOSED'));
    await act(async () => retiredCursor.resolve(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(251);
    });
    expect(mocks.dashboard).toHaveBeenCalledTimes(1);
    mocks.dashboard.mockResolvedValue(dashboard(2));
    await subscribe();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(251);
    });
    expect(mocks.dashboard).toHaveBeenCalledTimes(2);
    expect(visibleBalance()).toBe('5,000');
  });
  it('recovers automatically when a temporary initial outage has already ended', async () => {
    mocks.dashboard
      .mockRejectedValueOnce(new Error('dashboard retry budget exhausted'))
      .mockResolvedValue(dashboard(2));
    mocks.revision.mockResolvedValue(2);
    await mountPage();
    expect(screen.getByRole('alert')).toHaveTextContent('Challenge Ledger Unavailable');
    await subscribe();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(251);
    });
    expect(mocks.dashboard).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(visibleBalance()).toBe('5,000');
  });

  it('keeps a sustained outage visible through automatic recovery and supports manual retry', async () => {
    mocks.dashboard.mockRejectedValue(new Error('dashboard unavailable'));
    mocks.revision.mockResolvedValue(2);
    await mountPage();
    await subscribe();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(251);
    });
    expect(mocks.dashboard).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toHaveTextContent('Challenge Ledger Unavailable');
    expect(screen.queryByText('Spendable Balance', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '0 Day Streak' })).not.toBeInTheDocument();

    mocks.dashboard.mockResolvedValue(dashboard(2));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry Challenge Ledger' }));
    });
    expect(mocks.dashboard).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(visibleBalance()).toBe('5,000');
  });
});
