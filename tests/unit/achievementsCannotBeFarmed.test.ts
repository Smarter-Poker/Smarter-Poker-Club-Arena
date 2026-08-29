/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ACHIEVEMENTS — a login streak counts DAYS, not page loads
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Pins the 2026-08-29 fix. `onLogin` ran on every Supabase auth event
 * (INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED) and incremented three streak
 * achievements each time, so reloading the page advanced "Log in 7 days in a
 * row". `streak_30` pays 100 chips and `streak_100` pays 500 through
 * `add_to_promo_wallet`. Production carried the proof: 3 of 5 `streak_7`
 * unlocks and 1 of 2 `streak_30` unlocks were stamped `unlocked_at` on the
 * SAME day the row was created.
 *
 * These tests describe the rule, not the implementation: a second visit on the
 * same UTC day must write nothing at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const profileRow = { login_streak: 0, last_login_date: null as string | null };
const updates: Array<Record<string, unknown>> = [];
const recorded: Array<{ id: string; progress: number }> = [];

vi.mock('../../src/lib/supabase', () => ({
  getAuthUser: vi.fn(),
  supabase: {
    from: (table: string) => {
      if (table !== 'profiles') throw new Error('unexpected table ' + table);
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { ...profileRow }, error: null }) }),
        }),
        update: (patch: Record<string, unknown>) => {
          updates.push(patch);
          return { eq: async () => ({ error: null }) };
        },
      };
    },
    rpc: async () => ({ data: false, error: null }),
  },
}));

vi.mock('../../src/services/AchievementService', () => ({
  ACHIEVEMENTS: [],
  achievementService: {
    incrementProgressTo: async (_u: string, id: string, progress: number) => {
      recorded.push({ id, progress });
      return { unlocked: false };
    },
  },
}));

vi.mock('../../src/services/PushNotificationService', () => ({ pushNotificationService: {} }));
vi.mock('../../src/services/DailyChallengeService', () => ({
  dailyChallengeService: {},
  handRankScore: () => 0,
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { achievementTriggerService } from '../../src/services/AchievementTriggerService';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

beforeEach(() => {
  updates.length = 0;
  recorded.length = 0;
  profileRow.login_streak = 0;
  profileRow.last_login_date = null;
});

describe('a login streak counts days, not page loads', () => {
  it('writes NOTHING when the day has already been counted', async () => {
    profileRow.last_login_date = today();
    profileRow.login_streak = 3;

    await achievementTriggerService.onLogin('u1');
    await achievementTriggerService.onLogin('u1');
    await achievementTriggerService.onLogin('u1');

    expect(updates).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it('continues the run when the last count was yesterday', async () => {
    profileRow.last_login_date = daysAgo(1);
    profileRow.login_streak = 6;

    await achievementTriggerService.onLogin('u1');

    expect(updates[0]).toMatchObject({ login_streak: 7, last_login_date: today() });
    expect(recorded.map((r) => r.progress)).toEqual([7, 7, 7]);
  });

  it('restarts at 1 when a day was missed', async () => {
    profileRow.last_login_date = daysAgo(3);
    profileRow.login_streak = 42;

    await achievementTriggerService.onLogin('u1');

    expect(updates[0]).toMatchObject({ login_streak: 1 });
    expect(recorded.every((r) => r.progress === 1)).toBe(true);
  });

  it('starts at 1 for someone who has never been counted', async () => {
    await achievementTriggerService.onLogin('u1');
    expect(updates[0]).toMatchObject({ login_streak: 1, last_login_date: today() });
  });

  it('writes the three streak achievements in one pass, not one at a time', async () => {
    profileRow.last_login_date = daysAgo(1);
    profileRow.login_streak = 1;
    await achievementTriggerService.onLogin('u1');
    expect(recorded.map((r) => r.id).sort()).toEqual(['streak_100', 'streak_30', 'streak_7']);
  });
});
