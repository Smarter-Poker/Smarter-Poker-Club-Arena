/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ACHIEVEMENTS — a login streak counts DAYS, and the SERVER counts them
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-29: `onLogin` ran on every Supabase auth event (INITIAL_SESSION,
 * SIGNED_IN, TOKEN_REFRESHED) and incremented three streak achievements each
 * time, so reloading the page advanced "Log in 7 days in a row". That was fixed
 * by counting the UTC day - but the day was still decided in the browser and
 * written straight to profiles.login_streak / last_login_date by it, so the
 * streak behind streak_30 and streak_100 was a number the player could type.
 *
 * 2026-10-19 those two pay DIAMONDS (100 and 500, through award_diamonds_v2),
 * so the browser no longer touches the streak at all: fn_achievement_record_login
 * counts the day on the server clock, keeps the columns itself (browser UPDATE
 * on them is revoked), records the three achievements and pays once. These
 * tests pin the browser's half: it never writes the profile, it asks the server
 * exactly once per call, and it announces only what the server says it paid.
 * The server's half (same day writes nothing, yesterday continues, older
 * restarts at 1, pays once) is proved on native PostgreSQL by
 * scripts/ci/test-achievement-diamonds-postgres.py.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcCalls: string[] = [];
const tableTouches: string[] = [];
let loginAnswer: { data: unknown; error: unknown } = { data: null, error: null };

vi.mock('../../src/lib/supabase', () => ({
  getAuthUser: vi.fn(),
  supabase: {
    from: (table: string) => {
      tableTouches.push(table);
      throw new Error('the login path must not touch a table from the browser: ' + table);
    },
    rpc: (name: string) => {
      rpcCalls.push(name);
      return Promise.resolve(
        name === 'fn_achievement_record_login' ? loginAnswer : { data: null, error: null }
      );
    },
  },
}));

const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }),
    subscribe: vi.fn(() => vi.fn()),
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { achievementTriggerService } from '../../src/services/AchievementTriggerService';
import { reportError } from '../../src/utils/errorReporter';

beforeEach(() => {
  rpcCalls.length = 0;
  tableTouches.length = 0;
  emitted.length = 0;
  vi.mocked(reportError).mockClear();
  loginAnswer = { data: { ok: true, counted: false, streak: 3, unlocked: [] }, error: null };
});

describe('a login streak is counted by the server, not the browser', () => {
  it('never writes the profile from the browser, however often it runs', async () => {
    await achievementTriggerService.onLogin('u1');
    await achievementTriggerService.onLogin('u1');
    await achievementTriggerService.onLogin('u1');

    expect(tableTouches).toEqual([]);
    expect(rpcCalls).toEqual([
      'fn_achievement_record_login',
      'fn_achievement_record_login',
      'fn_achievement_record_login',
    ]);
  });

  it('announces nothing when the server has already counted today', async () => {
    const result = await achievementTriggerService.onLogin('u1');
    expect(result.triggeredAchievements).toEqual([]);
    expect(result.diamondsAwarded).toBe(0);
    expect(emitted).toEqual([]);
  });

  it('announces exactly the unlocks the server reports, with the diamonds it credited', async () => {
    loginAnswer = {
      data: {
        ok: true,
        counted: true,
        streak: 30,
        unlocked: [
          { achievement_id: 'streak_7', diamonds_awarded: 0 },
          { achievement_id: 'streak_30', diamonds_awarded: 100 },
        ],
      },
      error: null,
    };
    const result = await achievementTriggerService.onLogin('u1');

    expect(result.triggeredAchievements.map((a) => a.id)).toEqual(['streak_7', 'streak_30']);
    expect(result.diamondsAwarded).toBe(100);
    const toasts = emitted.filter((e) => e.event === 'MILESTONE_UNLOCKED');
    expect(toasts.map((t) => [t.payload.milestoneId, t.payload.rewardDiamonds])).toEqual([
      ['streak_7', undefined],
      ['streak_30', 100],
    ]);
  });

  it('a refused count is reported and credits nothing (never read as a streak of zero)', async () => {
    loginAnswer = { data: null, error: { message: 'permission denied' } };
    const result = await achievementTriggerService.onLogin('u1');

    expect(result.diamondsAwarded).toBe(0);
    expect(result.triggeredAchievements).toEqual([]);
    expect(emitted).toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
