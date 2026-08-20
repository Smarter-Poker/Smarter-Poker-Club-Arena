/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DAILY CHALLENGE SERVICE — Rotating Challenge Engine
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides rotating daily challenges that refresh each day.
 * Players can complete challenges for chips and other rewards.
 */

import { supabase } from '../lib/supabase';
import { WalletService } from './WalletService';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ChallengeType =
  | 'hands_played'
  | 'hands_won'
  | 'showdowns'
  | 'tournaments_played'
  | 'login_streak'
  | 'rakeback_earned'
  | 'friends_added';

export interface DailyChallenge {
  id: string;
  name: string;
  description: string;
  type: ChallengeType;
  requirement: number;
  chipReward: number;
  icon: string;
}

export interface UserDailyChallenge {
  id: string;
  challengeId: string;
  userId: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
  completedAt?: string;
  challenge: DailyChallenge;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHALLENGE POOL
// ═══════════════════════════════════════════════════════════════════════════════

export const CHALLENGE_POOL: DailyChallenge[] = [
  // Easy Challenges (daily grind)
  {
    id: 'hands_10',
    name: 'Warm Up',
    description: 'Play 10 hands today',
    type: 'hands_played',
    requirement: 10,
    chipReward: 50,
    icon: '',
  },
  {
    id: 'hands_25',
    name: 'Getting Serious',
    description: 'Play 25 hands today',
    type: 'hands_played',
    requirement: 25,
    chipReward: 100,
    icon: '',
  },
  {
    id: 'hands_50',
    name: 'Grinder',
    description: 'Play 50 hands today',
    type: 'hands_played',
    requirement: 50,
    chipReward: 200,
    icon: '',
  },
  {
    id: 'hands_15',
    name: 'Card Shark',
    description: 'Play 15 hands today',
    type: 'hands_played',
    requirement: 15,
    chipReward: 75,
    icon: '',
  },
  {
    id: 'hands_40',
    name: 'Table Regular',
    description: 'Play 40 hands today',
    type: 'hands_played',
    requirement: 40,
    chipReward: 160,
    icon: '',
  },
  {
    id: 'hands_75',
    name: 'Session Beast',
    description: 'Play 75 hands today',
    type: 'hands_played',
    requirement: 75,
    chipReward: 300,
    icon: '',
  },
  {
    id: 'hands_100',
    name: 'Century Club',
    description: 'Play 100 hands today',
    type: 'hands_played',
    requirement: 100,
    chipReward: 400,
    icon: '',
  },

  // Win Challenges
  {
    id: 'wins_3',
    name: 'Triple Threat',
    description: 'Win 3 hands today',
    type: 'hands_won',
    requirement: 3,
    chipReward: 75,
    icon: '',
  },
  {
    id: 'wins_5',
    name: 'High Five',
    description: 'Win 5 hands today',
    type: 'hands_won',
    requirement: 5,
    chipReward: 150,
    icon: '',
  },
  {
    id: 'wins_10',
    name: 'Ten Bagger',
    description: 'Win 10 hands today',
    type: 'hands_won',
    requirement: 10,
    chipReward: 300,
    icon: '',
  },
  {
    id: 'wins_7',
    name: 'Lucky Seven',
    description: 'Win 7 hands today',
    type: 'hands_won',
    requirement: 7,
    chipReward: 200,
    icon: '',
  },
  {
    id: 'wins_15',
    name: 'Rush Mode',
    description: 'Win 15 hands today',
    type: 'hands_won',
    requirement: 15,
    chipReward: 450,
    icon: '',
  },

  // Showdown Challenges
  {
    id: 'showdown_3',
    name: 'Show Your Cards',
    description: 'Reach 3 showdowns today',
    type: 'showdowns',
    requirement: 3,
    chipReward: 60,
    icon: '',
  },
  {
    id: 'showdown_5',
    name: 'Showdown King',
    description: 'Reach 5 showdowns today',
    type: 'showdowns',
    requirement: 5,
    chipReward: 120,
    icon: '',
  },
  {
    id: 'showdown_8',
    name: 'All The Way',
    description: 'Reach 8 showdowns today',
    type: 'showdowns',
    requirement: 8,
    chipReward: 200,
    icon: '',
  },
  {
    id: 'showdown_10',
    name: 'Fearless',
    description: 'Reach 10 showdowns today',
    type: 'showdowns',
    requirement: 10,
    chipReward: 260,
    icon: '',
  },

  // Tournament Challenges
  {
    id: 'tourney_1',
    name: 'Tournament Time',
    description: 'Play 1 tournament today',
    type: 'tournaments_played',
    requirement: 1,
    chipReward: 100,
    icon: '',
  },
  {
    id: 'tourney_3',
    name: 'Tournament Regular',
    description: 'Play 3 tournaments today',
    type: 'tournaments_played',
    requirement: 3,
    chipReward: 300,
    icon: '',
  },
  {
    id: 'tourney_2',
    name: 'Double Entry',
    description: 'Play 2 tournaments today',
    type: 'tournaments_played',
    requirement: 2,
    chipReward: 200,
    icon: '',
  },

  // Social Challenges
  {
    id: 'friend_1',
    name: 'Make a Friend',
    description: 'Add 1 friend today',
    type: 'friends_added',
    requirement: 1,
    chipReward: 50,
    icon: '',
  },
];

export const WEEKLY_CHALLENGE_POOL: DailyChallenge[] = [
  {
    id: 'weekly_hands_250',
    name: 'Weekly Grinder',
    description: 'Play 250 hands this week',
    type: 'hands_played',
    requirement: 250,
    chipReward: 1000,
    icon: '',
  },
  {
    id: 'weekly_wins_50',
    name: 'Weekly Winner',
    description: 'Win 50 hands this week',
    type: 'hands_won',
    requirement: 50,
    chipReward: 1500,
    icon: '',
  },
  {
    id: 'weekly_tourneys_10',
    name: 'Tournament Specialist',
    description: 'Play 10 tournaments this week',
    type: 'tournaments_played',
    requirement: 10,
    chipReward: 2000,
    icon: '',
  },
  {
    id: 'weekly_showdowns_20',
    name: 'Showdown Machine',
    description: 'Reach 20 showdowns this week',
    type: 'showdowns',
    requirement: 20,
    chipReward: 800,
    icon: '',
  },
];

export const MONTHLY_CHALLENGE_POOL: DailyChallenge[] = [
  {
    id: 'monthly_hands_1000',
    name: 'Monthly Marathon',
    description: 'Play 1,000 hands this month',
    type: 'hands_played',
    requirement: 1000,
    chipReward: 5000,
    icon: '',
  },
  {
    id: 'monthly_wins_250',
    name: 'Monthly Dominator',
    description: 'Win 250 hands this month',
    type: 'hands_won',
    requirement: 250,
    chipReward: 10000,
    icon: '',
  },
  {
    id: 'monthly_tourneys_50',
    name: 'Tournament Master',
    description: 'Play 50 tournaments this month',
    type: 'tournaments_played',
    requirement: 50,
    chipReward: 15000,
    icon: '',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class DailyChallengeServiceClass {
  /**
   * Fetch (and assign, if needed) the rows for one period.
   *
   * SERVER-AUTHORITATIVE (2026-08-19). The client used to INSERT its own rows
   * and UPDATE its own progress. That required INSERT/UPDATE grants on
   * user_daily_challenges, and the UPDATE policy had no WITH CHECK — so any
   * logged-in user could PATCH {progress: 999999, completed: true} and claim,
   * or INSERT unlimited rows of the highest-paying challenge at made-up period
   * keys. Those grants are now revoked; assignment goes through the
   * assign_user_challenges RPC, which validates every id against
   * daily_challenge_catalog and enforces the period-key shape.
   *
   * The RPC is idempotent: it only inserts when the period is empty, and it
   * always returns the canonical rows, so two tabs racing get the same set.
   */
  private async fetchOrAssign(
    userId: string,
    periodKey: string,
    pool: DailyChallenge[],
    count: number,
    context: string
  ): Promise<any[]> {
    const { data: existing, error: existErr } = await supabase
      .from('user_daily_challenges')
      .select('*')
      .eq('user_id', userId)
      .eq('assigned_date', periodKey);
    if (existErr) reportError(existErr, `DailyChallengeService.${context}_fetch_error`);

    if (existing && existing.length > 0) return existing;

    const chosen =
      pool === CHALLENGE_POOL
        ? this.selectDailyChallenges(count)
        : this.selectChallenges(pool, count, periodKey);

    const { data: assigned, error: rpcErr } = await supabase.rpc('assign_user_challenges', {
      p_assigned_date: periodKey,
      p_challenge_ids: chosen.map((c) => c.id),
    });

    if (rpcErr) {
      reportError(rpcErr, `DailyChallengeService.${context}_assign_error`);
      // Re-read: another tab may have won the assignment race.
      const { data: retry } = await supabase
        .from('user_daily_challenges')
        .select('*')
        .eq('user_id', userId)
        .eq('assigned_date', periodKey);
      return retry || [];
    }

    return assigned || [];
  }

  /**
   * Get today's challenges for a user. Assigns a fresh, seeded set if the day
   * has not been assigned yet.
   */
  async getTodaysChallenges(userId: string): Promise<UserDailyChallenge[]> {
    const rows = await this.fetchOrAssign(
      userId,
      this.getTodayKey(),
      CHALLENGE_POOL,
      5,
      'getTodaysChallenges'
    );
    return rows.map((r) => this.mapToUserChallenge(r));
  }

  /**
   * Get this week's challenges for a user
   */
  async getWeeklyChallenges(userId: string): Promise<(UserDailyChallenge & { tier: 'weekly' })[]> {
    const rows = await this.fetchOrAssign(
      userId,
      this.getWeekKey(),
      WEEKLY_CHALLENGE_POOL,
      3,
      'getWeeklyChallenges'
    );
    return rows.map((r) => ({ ...this.mapToUserChallenge(r), tier: 'weekly' as const }));
  }

  /**
   * Get this month's challenges for a user
   */
  async getMonthlyChallenges(
    userId: string
  ): Promise<(UserDailyChallenge & { tier: 'monthly' })[]> {
    const rows = await this.fetchOrAssign(
      userId,
      this.getMonthKey(),
      MONTHLY_CHALLENGE_POOL,
      2,
      'getMonthlyChallenges'
    );
    return rows.map((r) => ({ ...this.mapToUserChallenge(r), tier: 'monthly' as const }));
  }

  /**
   * Streak, with insurance.
   *
   * Server-computed so the freeze can be spent atomically -- freezes are
   * currency, and the client has no write access to challenge_streak_state.
   * A freeze covers exactly one missed day once the streak is worth protecting;
   * the covered day counts, because "your streak was protected" that then shows
   * a smaller number reads as the protection having failed.
   */
  async getStreak(userId: string): Promise<{
    streak: number;
    freezesAvailable: number;
    usedFreeze: boolean;
    frozenDate: string | null;
    nextFreezeIn: number | null;
  }> {
    const fallback = {
      streak: 0,
      freezesAvailable: 0,
      usedFreeze: false,
      frozenDate: null,
      nextFreezeIn: null,
    };
    try {
      const { data, error } = await supabase.rpc('get_challenge_streak', {
        p_user_id: userId,
      });
      if (error) {
        reportError(error, 'DailyChallengeService.getStreak_failed');
        return fallback;
      }
      return {
        streak: Number(data?.streak) || 0,
        freezesAvailable: Number(data?.freezesAvailable) || 0,
        usedFreeze: data?.usedFreeze === true,
        frozenDate: data?.frozenDate || null,
        nextFreezeIn: data?.nextFreezeIn == null ? null : Number(data.nextFreezeIn),
      };
    } catch (e) {
      reportError(e, 'DailyChallengeService.getStreak_threw');
      return fallback;
    }
  }

  /**
   * Advance SEVERAL challenge types in ONE round trip.
   *
   * This is the hot path: it runs for every player on every completed hand.
   * The per-type updateProgress() below costs a SELECT plus one RPC per
   * matching row, so a single hand that played + won + reached showdown could
   * cost ~3 selects and ~8 RPCs per player. bump_challenge_progress does the
   * whole thing in one statement, server-side, reading each requirement from
   * daily_challenge_catalog.
   *
   * @param amounts e.g. { hands_played: 1, hands_won: 1 }
   * @returns the challenges that CROSSED into completion on this call
   */
  async bumpProgress(
    userId: string,
    amounts: Partial<Record<ChallengeType, number>>
  ): Promise<{ completed: Array<{ id: string; challengeId: string; chipReward: number }> }> {
    const cleaned: Record<string, number> = {};
    for (const [k, v] of Object.entries(amounts)) {
      if (typeof v === 'number' && v > 0) cleaned[k] = v;
    }
    if (Object.keys(cleaned).length === 0) return { completed: [] };

    try {
      const { data, error } = await supabase.rpc('bump_challenge_progress', {
        p_user_id: userId,
        p_amounts: cleaned,
        p_daily_key: this.getTodayKey(),
        p_weekly_key: this.getWeekKey(),
        p_monthly_key: this.getMonthKey(),
      });
      if (error) {
        reportError(error, 'DailyChallengeService.bumpProgress_failed');
        return { completed: [] };
      }
      return {
        completed: (data || []).map((r: any) => ({
          id: r.id,
          challengeId: r.challenge_id,
          chipReward: Number(r.chip_reward) || 0,
        })),
      };
    } catch (e) {
      reportError(e, 'DailyChallengeService.bumpProgress_threw');
      return { completed: [] };
    }
  }

  /**
   * Update progress on a SINGLE challenge type.
   *
   * Prefer bumpProgress() when advancing more than one type at once -- this
   * form costs a select plus an RPC per matching row. Kept for callers that
   * genuinely only move one counter (a friend added, a tournament entered).
   */
  async updateProgress(
    userId: string,
    type: ChallengeType,
    amount: number = 1
  ): Promise<{ completed: UserDailyChallenge[] }> {
    const today = this.getTodayKey();
    const weekKey = this.getWeekKey();
    const monthKey = this.getMonthKey();
    const completed: UserDailyChallenge[] = [];

    // Get today's/week's/month's active challenges of this type
    const { data: challenges, error: chErr } = await supabase
      .from('user_daily_challenges')
      .select('*')
      .eq('user_id', userId)
      .in('assigned_date', [today, weekKey, monthKey])
      .eq('completed', false);
    if (chErr) reportError(chErr, 'DailyChallengeService.updateProgress_fetch_error');

    if (!challenges) return { completed };

    for (const uc of challenges) {
      // Find challenge from all pools
      const challenge =
        CHALLENGE_POOL.find((c) => c.id === uc.challenge_id) ||
        WEEKLY_CHALLENGE_POOL.find((c) => c.id === uc.challenge_id) ||
        MONTHLY_CHALLENGE_POOL.find((c) => c.id === uc.challenge_id);

      if (!challenge || challenge.type !== type) continue;

      // The RPC is the ONLY way progress moves. The client has no UPDATE grant
      // on user_daily_challenges (revoked 2026-08-19 — see fetchOrAssign).
      //
      // The old direct-UPDATE fallback is gone: it could not work post-lockdown,
      // and it was actively harmful before it. PostgREST reports no error for an
      // UPDATE that matches zero rows, so when the RPC declined (row missing, or
      // auth.uid() mismatch) the fallback "succeeded" against nothing and then
      // pushed a fabricated entry onto `completed[]` — firing a
      // "Challenge complete!" toast and a CHALLENGE_PROGRESS_UPDATED bus event
      // for a challenge that had not advanced.
      //
      // p_requirement is still sent for signature compatibility with clients
      // mid-rollout; the server ignores it and reads the catalog instead
      // (passing p_requirement:1 used to complete any challenge instantly).
      const { data: rpcResult, error: rpcErr } = await supabase.rpc(
        'increment_challenge_progress',
        {
          p_user_id: userId,
          p_challenge_row_id: uc.id,
          p_amount: amount,
          p_requirement: challenge.requirement,
        }
      );

      if (rpcErr) {
        reportError(rpcErr, 'DailyChallengeService.Progress_rpc_failed');
        continue;
      }
      if (!rpcResult?.updated) {
        // Not an error: the row was already complete, or belongs to someone else.
        continue;
      }

      const newProgress: number = rpcResult.progress;
      const isComplete: boolean = rpcResult.completed;

      if (isComplete) {
        completed.push({
          id: uc.id,
          challengeId: uc.challenge_id,
          userId,
          progress: newProgress,
          completed: true,
          claimed: false,
          completedAt: new Date().toISOString(),
          challenge,
        });
      }
    }

    return { completed };
  }

  /**
   * Claim standard chip reward directly from UI
   */
  async claimChallenge(
    userId: string,
    challengeRowId: string,
    rewardAmount: number
  ): Promise<boolean> {
    // Rows that only exist client-side (offline fallback) have a synthetic id,
    // not a uuid. Sending one produces a raw Postgres 22P02 in the user's face.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(challengeRowId)) {
      throw new Error('This challenge is not ready to claim yet. Refresh and try again.');
    }

    // retryAsync retries transient network errors (fetch/timeout/503).
    // The RPC is idempotent: a second claim of an already-claimed row returns
    // false rather than raising, so a commit whose response was lost to a
    // network blip no longer surfaces "Challenge already claimed" as an error
    // for chips the player actually received.
    await retryAsync(async () => {
      const result = await supabase.rpc('claim_daily_challenge', {
        p_user_id: userId,
        p_challenge_row_id: challengeRowId,
        p_reward_amount: rewardAmount,
      });
      if (result.error) {
        if (/already claimed/i.test(result.error.message || '')) return result; // treat as success
        reportError(result.error, 'DailyChallengeService.RPC_claim_error');
        throw new Error(result.error.message);
      }
      return result;
    }, 3);

    // NOTE: no client-side ledger write here. claim_daily_challenge credits via
    // atomic_credit_wallet_and_log under the idempotency key
    // 'challenge_claim:<row id>', which already writes the transaction record.
    // The previous WalletService.logTransaction call double-logged with the
    // CLIENT-supplied amount, which the RPC deliberately ignores in favour of
    // the catalog value — so any drift made the audit trail disagree with the
    // wallet, and a retry logged the same reward twice.
    masterBus.emit('BALANCE_UPDATED', { source: 'daily_challenge_claim', userId });
    return true;
  }

  /**
   * Get challenge completion stats for a user
   */
  async getStats(userId: string): Promise<{
    totalCompleted: number;
    currentStreak: number;
    totalChipsEarned: number;
    nextMilestone: number;
    milestoneReward: number;
  }> {
    // ORDER BY is load-bearing: an unordered LIMIT returns an arbitrary subset
    // in Postgres, so once a user passed QUERY_LIMITS.MODERATE completions the
    // streak scan below walked a random slice and collapsed to a wrong value.
    const { data, error: statErr } = await supabase
      .from('user_daily_challenges')
      .select('challenge_id, completed, claimed, assigned_date')
      .eq('user_id', userId)
      .eq('completed', true)
      .order('assigned_date', { ascending: false })
      .limit(QUERY_LIMITS.MODERATE);
    if (statErr) reportError(statErr, 'DailyChallengeService.getStats_error');

    if (!data) {
      return {
        totalCompleted: 0,
        currentStreak: 0,
        totalChipsEarned: 0,
        nextMilestone: 7,
        milestoneReward: 500,
      };
    }

    const totalCompleted = data.length;
    let totalChipsEarned = 0;

    for (const uc of data) {
      // Only CLAIMED rewards are money the player actually has. Counting
      // completed-but-unclaimed rows made "Chips Earned" overstate the balance.
      if (!uc.claimed) continue;
      const challenge =
        CHALLENGE_POOL.find((c) => c.id === uc.challenge_id) ||
        WEEKLY_CHALLENGE_POOL.find((c) => c.id === uc.challenge_id) ||
        MONTHLY_CHALLENGE_POOL.find((c) => c.id === uc.challenge_id);
      if (challenge) {
        totalChipsEarned += challenge.chipReward;
      }
    }

    // Calculate streak (consecutive days with at least 1 completion)
    // CRITICAL: Filter to DAILY keys only. Weekly keys start with "W" and
    // monthly keys start with "M" — these are NOT valid dates and would
    // produce Invalid Date from subtractDays(), silently breaking the streak.
    const dailyDates = data
      .map((d) => d.assigned_date)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)); // Only YYYY-MM-DD
    const dates = [...new Set(dailyDates)].sort().reverse();
    let currentStreak = 0;
    const today = this.getTodayKey();
    const yesterday = this.subtractDays(today, 1);

    // Anchor the walk at today OR yesterday. Anchoring only at today meant a
    // player with a 30-day streak saw "0 day streak" from 00:00 UTC until they
    // completed something — the streak looked broken at the exact moment the
    // UI is trying to persuade them to keep it alive.
    const anchor = dates[0] === today ? today : dates[0] === yesterday ? yesterday : null;
    if (anchor) {
      for (const date of dates) {
        const expectedDate = this.subtractDays(anchor, currentStreak);
        if (date === expectedDate) {
          currentStreak++;
        } else {
          break;
        }
      }
    }

    // Dynamic streak milestones — tiered rewards escalate with longer streaks
    const MILESTONES = [
      { days: 7, reward: 500 },
      { days: 14, reward: 1500 },
      { days: 30, reward: 5000 },
      { days: 60, reward: 15000 },
      { days: 100, reward: 50000 },
    ];
    const nextMilestoneEntry =
      MILESTONES.find((m) => m.days > currentStreak) || MILESTONES[MILESTONES.length - 1];
    const nextMilestone = nextMilestoneEntry.days;
    const milestoneReward = nextMilestoneEntry.reward;

    return { totalCompleted, currentStreak, totalChipsEarned, nextMilestone, milestoneReward };
  }

  // emitDailyResetReminder removed — was dead code (never called from any file)

  /**
   * Batch fetch all challenge tiers for a user in a single call.
   * Reduces boilerplate in ProfilePage and DailyChallengesWidget.
   */
  async getAllChallenges(userId: string): Promise<{
    daily: UserDailyChallenge[];
    weekly: (UserDailyChallenge & { tier: 'weekly' })[];
    monthly: (UserDailyChallenge & { tier: 'monthly' })[];
  }> {
    const [daily, weekly, monthly] = await Promise.all([
      this.getTodaysChallenges(userId),
      this.getWeeklyChallenges(userId),
      this.getMonthlyChallenges(userId),
    ]);
    return { daily, weekly, monthly };
  }

  /**
   * Select random challenges for today
   */
  private selectDailyChallenges(count: number): DailyChallenge[] {
    // Use date-based seed for consistent challenges across all users
    const seed = this.getTodayKey().replace(/-/g, '');
    return this.seededDiverseSelect(CHALLENGE_POOL, count, seed);
  }

  private selectChallenges(
    pool: DailyChallenge[],
    count: number,
    periodKey: string
  ): DailyChallenge[] {
    // Use period-specific seed for DETERMINISTIC selection — prevents race conditions
    // when multiple tabs/instances call this simultaneously before DB insert.
    // Each pool (weekly/monthly) gets a unique seed prefix to avoid collisions.
    const seed = periodKey.replace(/[^a-zA-Z0-9]/g, '');
    return this.seededDiverseSelect(pool, count, seed);
  }

  /**
   * Deterministic seeded selection with type diversity.
   *
   * Shuffles the pool with a well-mixed hash (the old simpleHash barely
   * avalanched: changing the last seed digit shifted every hash by nearly the
   * same amount, so consecutive days produced near-identical sets, and ids
   * with common prefixes clustered — e.g. three tournament challenges the
   * same day). Then greedily picks one challenge per type before allowing a
   * second of any type, so each day's set spans different activities.
   * Fully deterministic per seed — identical across all users/tabs.
   */
  private seededDiverseSelect(
    pool: DailyChallenge[],
    count: number,
    seed: string
  ): DailyChallenge[] {
    const shuffled = [...pool].sort(
      (a, b) => this.mixedHash(`${seed}|${a.id}`) - this.mixedHash(`${seed}|${b.id}`)
    );

    const picked: DailyChallenge[] = [];
    const usedTypes = new Set<ChallengeType>();

    // Pass 1: one per type, in shuffle order
    for (const c of shuffled) {
      if (picked.length >= count) break;
      if (!usedTypes.has(c.type)) {
        usedTypes.add(c.type);
        picked.push(c);
      }
    }
    // Pass 2: fill remaining slots in shuffle order
    for (const c of shuffled) {
      if (picked.length >= count) break;
      if (!picked.includes(c)) picked.push(c);
    }
    return picked;
  }

  /**
   * FNV-1a 32-bit with murmur3 finalizer — strong avalanche so a one-character
   * seed change reorders the whole pool.
   */
  private mixedHash(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  /**
   * Get today's date key (YYYY-MM-DD)
   */
  private getTodayKey(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Monday of the current UTC week.
   *
   * The old form was `date - getUTCDay() + 1`, which is correct Mon-Sat but
   * wrong on Sunday: getUTCDay() returns 0 there, so it produced
   * `date + 1` = tomorrow, i.e. the Monday that STARTS THE NEXT WEEK. A player
   * grinding on Sunday saw their weekly bar stuck at 0 all day while the
   * progress silently accrued to next week's row, and Sunday could hand out a
   * fresh weekly set that "expired" 24h later.
   */
  private getWeekKey(): string {
    const d = new Date();
    const day = d.getUTCDay(); // 0 = Sunday
    d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
    return `W${d.toISOString().split('T')[0]}`;
  }

  /**
   * Month key, zero-padded. Unpadded ('M2026-8') sorted lexically as
   * 'M2026-10' < 'M2026-3' < 'M2026-9', which silently corrupts any ordering,
   * MIN/MAX or range filter over assigned_date. Existing unpadded rows were
   * backfilled by migration daily_challenges_lockdown_and_catalog_parity, and
   * assign_user_challenges now rejects the unpadded shape outright.
   */
  private getMonthKey(): string {
    const d = new Date();
    return `M${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Subtract days from a date
   */
  private subtractDays(dateStr: string, days: number): string {
    // MUST use UTC operations — getTodayKey() returns UTC date (via toISOString()),
    // so streak calculation must also use UTC to avoid timezone boundary mismatches.
    const date = new Date(dateStr + 'T00:00:00Z'); // Force UTC parse
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().split('T')[0];
  }

  /**
   * Simple hash for seeded randomization
   */
  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  /**
   * Map database row to typed object
   */
  private mapToUserChallenge(row: any): UserDailyChallenge {
    const challenge = CHALLENGE_POOL.find((c) => c.id === row.challenge_id) ||
      WEEKLY_CHALLENGE_POOL.find((c) => c.id === row.challenge_id) ||
      MONTHLY_CHALLENGE_POOL.find((c) => c.id === row.challenge_id) || {
        id: row.challenge_id,
        name: 'Unknown',
        description: '',
        type: 'hands_played' as ChallengeType,
        requirement: 0,
        chipReward: 0,
        icon: '?',
      };

    return {
      id: row.id,
      challengeId: row.challenge_id,
      userId: row.user_id,
      progress: row.progress,
      completed: row.completed,
      claimed: row.claimed || false,
      completedAt: row.completed_at,
      challenge,
    };
  }
}

export const dailyChallengeService = new DailyChallengeServiceClass();
export default dailyChallengeService;
