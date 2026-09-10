import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DailyChallengesPage from '../src/pages/DailyChallengesPage';
import type { DailyChallengeDashboard } from '../src/services/DailyChallengeService';

const mocks = vi.hoisted(() => ({
  dashboard: vi.fn(),
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
    getDashboardRevision: vi.fn().mockResolvedValue(1),
    buyStreakFreeze: mocks.buyFreeze,
  },
}));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => mocks }));
vi.mock('../src/hooks/useMasterBusBroadcastChannel', () => ({
  useMasterBusBroadcastChannel: vi.fn(),
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

async function openPurchase() {
  const shell = document.createElement('div');
  shell.id = 'root';
  document.body.appendChild(shell);
  render(
    <MemoryRouter>
      <DailyChallengesPage />
    </MemoryRouter>,
    { container: shell }
  );
  const launcher = await waitFor(() => {
    const button = document.getElementById('buy-streak-freeze') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(false);
    return button!;
  });
  fireEvent.click(launcher);
  const dialog = screen.getByRole('dialog', { name: 'Secure A Streak Freeze?' });
  return {
    shell,
    launcher,
    dialog,
    confirm: within(dialog).getByRole('button', { name: 'Buy Streak Freeze' }),
  };
}

describe('Daily Missions freeze purchase interaction ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dashboard.mockResolvedValue(dashboard());
  });
  afterEach(() => {
    cleanup();
    document.getElementById('root')?.remove();
  });

  it('holds the dialog and shell protection through purchase and ledger reconciliation', async () => {
    const purchase = deferred<{ success: boolean }>();
    const refresh = deferred<DailyChallengeDashboard>();
    mocks.buyFreeze.mockReturnValue(purchase.promise);
    const { shell, confirm } = await openPurchase();
    mocks.dashboard.mockReturnValue(refresh.promise);

    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(mocks.buyFreeze).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Secure A Streak Freeze?' })).not.toBeNull();
    expect(shell.hasAttribute('inert')).toBe(true);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).not.toBeNull();

    await act(async () => purchase.resolve({ success: true }));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(shell.hasAttribute('inert')).toBe(true);
    await act(async () => refresh.resolve(dashboard(2)));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.getElementById('daily-missions')).not.toBeNull();
    expect(shell.hasAttribute('inert')).toBe(false);
    expect(mocks.buyFreeze).toHaveBeenCalledTimes(1);
  });

  it.each(['rejection', 'network error'])(
    'releases protection after a %s without losing the page',
    async (outcome) => {
      const purchase = deferred<{ success: boolean }>();
      mocks.buyFreeze.mockReturnValue(purchase.promise);
      const { shell, confirm } = await openPurchase();
      fireEvent.click(confirm);
      expect(screen.queryByRole('dialog')).not.toBeNull();
      await act(async () => {
        if (outcome === 'network error') purchase.reject(new Error('unavailable'));
        else purchase.resolve({ success: false });
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(shell.hasAttribute('inert')).toBe(false);
      expect(document.getElementById('daily-missions')).not.toBeNull();
      expect(mocks.error).toHaveBeenCalled();
      expect(mocks.buyFreeze).toHaveBeenCalledTimes(1);
    }
  );

  it('still permits cancellation before a purchase starts', async () => {
    const { shell } = await openPurchase();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(shell.hasAttribute('inert')).toBe(false);
    expect(mocks.buyFreeze).not.toHaveBeenCalled();
  });
});
