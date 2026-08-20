/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Daily Challenges Page
 * Dedicated challenges hub: today's rotating challenges, weekly and monthly
 * goals, streak tracking, and reward claiming.
 *
 * Challenges rotate every day at 00:00 UTC via the seeded selection in
 * DailyChallengeService — the same set for every player on a given day.
 * NO HARDCODED DATA — all progress comes from Supabase.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAuthUser } from '../lib/supabase';
import { LoadingState } from '../components/common/EmptyState';
import { StreakFire } from '../components/gamification/StreakFire';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import { triggerHaptic } from '../services/HapticService';
import {
  dailyChallengeService,
  type UserDailyChallenge,
  type ChallengeType,
} from '../services/DailyChallengeService';
import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import styles from './DailyChallengesPage.module.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

type Tier = 'daily' | 'weekly' | 'monthly';

interface TieredChallenge extends UserDailyChallenge {
  tier: Tier;
}

interface StreakInfo {
  streak: number;
  freezesAvailable: number;
  usedFreeze: boolean;
  frozenDate: string | null;
  nextFreezeIn: number | null;
}

interface ChallengeStats {
  totalCompleted: number;
  currentStreak: number;
  totalChipsEarned: number;
  nextMilestone: number;
  milestoneReward: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Unicode glyph per challenge type — no emoji (SWC-safe) */
const TYPE_GLYPHS: Record<ChallengeType, string> = {
  hands_played: '♠', // spade
  hands_won: '★', // star
  showdowns: '♦', // diamond suit
  tournaments_played: '♛', // queen
  login_streak: '◉',
  rakeback_earned: '◈',
  friends_added: '♣', // club
};

const TIER_LABELS: Record<Tier, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

const TIER_COLORS: Record<Tier, string> = {
  daily: '#00d4ff',
  weekly: '#ffa726',
  monthly: '#c084fc',
};

/** ms until 00:00 UTC tomorrow */
function msUntilUtcMidnight(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return next - now.getTime();
}

/** ms until next Monday 00:00 UTC */
function msUntilNextMondayUtc(): number {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sun
  const daysToMonday = ((8 - day) % 7) || 7;
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMonday);
  return next - now.getTime();
}

/** ms until the 1st of next month 00:00 UTC */
function msUntilNextMonthUtc(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return next - now.getTime();
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0m';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function todayUtcKey(): string {
  return new Date().toISOString().split('T')[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUBCOMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function ChallengeCard({
  challenge,
  tier,
  claiming,
  celebrating,
  onClaim,
}: {
  challenge: TieredChallenge;
  tier: Tier;
  claiming: boolean;
  celebrating: boolean;
  onClaim: (c: TieredChallenge) => void;
}) {
  const c = challenge.challenge;
  const pct = c.requirement > 0 ? Math.min((challenge.progress / c.requirement) * 100, 100) : 0;
  const glyph = TYPE_GLYPHS[c.type] || '♠';

  return (
    <div
      className={[
        styles.card,
        challenge.completed ? styles.cardComplete : '',
        challenge.claimed ? styles.cardClaimed : '',
        celebrating ? styles.cardCelebrate : '',
      ].join(' ')}
      style={{ '--tier-color': TIER_COLORS[tier] } as React.CSSProperties}
    >
      <div className={styles.cardGlyph}>{glyph}</div>
      <div className={styles.cardBody}>
        <div className={styles.cardTitleRow}>
          <span className={styles.cardTitle}>{c.name}</span>
          <span className={styles.cardReward}>+{c.chipReward.toLocaleString()} chips</span>
        </div>
        <span className={styles.cardDesc}>{c.description}</span>
        <div className={styles.progressTrack}>
          <div className={styles.progressFill} style={{ width: `${pct}%` }} />
          <span className={styles.progressText}>
            {Math.min(challenge.progress, c.requirement)} / {c.requirement}
          </span>
        </div>
      </div>
      <div className={styles.cardAction}>
        {challenge.claimed ? (
          <span className={styles.claimedBadge}>Claimed</span>
        ) : challenge.completed ? (
          <button
            className={styles.claimButton}
            disabled={claiming}
            onClick={() => onClaim(challenge)}
          >
            {claiming ? '...' : 'Claim'}
          </button>
        ) : (
          <span className={styles.pctLabel}>{Math.floor(pct)}%</span>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function DailyChallengesPage() {
  useEffect(() => {
    document.title = 'Daily Challenges | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const toast = useToast();
  const isMountedRef = useIsMounted();

  const [isLoading, setIsLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [challenges, setChallenges] = useState<TieredChallenge[]>([]);
  const [stats, setStats] = useState<ChallengeStats | null>(null);
  const [streak, setStreak] = useState<StreakInfo | null>(null);
  const [activeTier, setActiveTier] = useState<Tier>('daily');
  const [claimingIds, setClaimingIds] = useState<Set<string>>(new Set());
  const [celebratingIds, setCelebratingIds] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  const claimGuardRef = useRef<Set<string>>(new Set());
  const celebrateTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const dateKeyRef = useRef(todayUtcKey());

  // ── Data loading ──
  const loadChallenges = useCallback(async (uid: string, withSpinner: boolean) => {
    if (withSpinner) setIsLoading(true);
    try {
      const [{ daily, weekly, monthly }, challengeStats, streakInfo] = await Promise.all([
        dailyChallengeService.getAllChallenges(uid),
        dailyChallengeService.getStats(uid),
        dailyChallengeService.getStreak(uid),
      ]);
      if (!isMountedRef.current) return;
      setChallenges([
        ...daily.map((c) => ({ ...c, tier: 'daily' as const })),
        ...weekly,
        ...monthly,
      ]);
      setStats(challengeStats);
      setStreak(streakInfo);
    } catch (err) {
      reportError(err, 'DailyChallengesPage.loadChallenges');
      if (isMountedRef.current) toast.error('Failed to load challenges');
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const {
        data: { user: authUser },
      } = await getAuthUser();
      if (cancelled) return;
      if (!authUser) {
        setIsLoading(false);
        return;
      }
      setUserId(authUser.id);
      await loadChallenges(authUser.id, true);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadChallenges]);

  // ── Live countdown + automatic daily rollover ──
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      // When the UTC date flips while the page is open, fetch the new day's set
      const key = todayUtcKey();
      if (key !== dateKeyRef.current) {
        dateKeyRef.current = key;
        if (userId) loadChallenges(userId, false);
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [userId, loadChallenges]);

  // ── Refresh when in-game progress updates ──
  useEffect(() => {
    const unsub = masterBus.subscribeDebounced(
      'CHALLENGE_PROGRESS_UPDATED',
      () => {
        if (userId) loadChallenges(userId, false);
      },
      1000
    );
    return () => {
      unsub();
      celebrateTimersRef.current.forEach(clearTimeout);
    };
  }, [userId, loadChallenges]);

  // ── Claim handler ──
  const handleClaim = useCallback(
    async (challenge: TieredChallenge) => {
      if (!userId) return;
      if (claimGuardRef.current.has(challenge.id)) return;
      claimGuardRef.current.add(challenge.id);
      setClaimingIds((prev) => new Set(prev).add(challenge.id));
      try {
        await dailyChallengeService.claimChallenge(
          userId,
          challenge.id,
          challenge.challenge.chipReward
        );
        if (!isMountedRef.current) return;
        setChallenges((prev) =>
          prev.map((c) => (c.id === challenge.id ? { ...c, claimed: true } : c))
        );
        triggerHaptic('success');
        setCelebratingIds((prev) => new Set(prev).add(challenge.id));
        const t = setTimeout(() => {
          if (isMountedRef.current) {
            setCelebratingIds((prev) => {
              const next = new Set(prev);
              next.delete(challenge.id);
              return next;
            });
          }
        }, 1500);
        celebrateTimersRef.current.push(t);
        masterBus.emit('MISSION_CLAIMED', {
          missionId: challenge.id,
          tier: challenge.tier,
          rewardType: 'chips',
          rewardAmount: challenge.challenge.chipReward,
        });
        toast.success(`+${challenge.challenge.chipReward.toLocaleString()} chips claimed`);
      } catch (err: any) {
        reportError(err, 'DailyChallengesPage.claim_failed');
        if (isMountedRef.current) toast.error(err?.message || 'Failed to claim reward');
      } finally {
        claimGuardRef.current.delete(challenge.id);
        if (isMountedRef.current) {
          setClaimingIds((prev) => {
            const next = new Set(prev);
            next.delete(challenge.id);
            return next;
          });
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId]
  );

  // ── Derived ──
  const tierCounts = useMemo(() => {
    const counts: Record<Tier, { total: number; done: number; claimed: number }> = {
      daily: { total: 0, done: 0, claimed: 0 },
      weekly: { total: 0, done: 0, claimed: 0 },
      monthly: { total: 0, done: 0, claimed: 0 },
    };
    challenges.forEach((c) => {
      counts[c.tier].total++;
      if (c.completed) counts[c.tier].done++;
      if (c.claimed) counts[c.tier].claimed++;
    });
    return counts;
  }, [challenges]);

  const visible = useMemo(
    () =>
      challenges
        .filter((c) => c.tier === activeTier)
        .sort((a, b) => {
          // Claimable first, then in-progress by completion pct desc, claimed last
          const rank = (c: TieredChallenge) =>
            c.completed && !c.claimed ? 0 : !c.completed ? 1 : 2;
          const r = rank(a) - rank(b);
          if (r !== 0) return r;
          const pa = a.challenge.requirement > 0 ? a.progress / a.challenge.requirement : 0;
          const pb = b.challenge.requirement > 0 ? b.progress / b.challenge.requirement : 0;
          return pb - pa;
        }),
    [challenges, activeTier]
  );

  const unclaimedRewards = useMemo(
    () =>
      challenges
        .filter((c) => c.completed && !c.claimed)
        .reduce((sum, c) => sum + c.challenge.chipReward, 0),
    [challenges]
  );

  const tierCountdown: Record<Tier, string> = {
    daily: formatCountdown(msUntilUtcMidnight()),
    weekly: formatCountdown(msUntilNextMondayUtc()),
    monthly: formatCountdown(msUntilNextMonthUtc()),
  };
  void now; // countdown re-renders driven by the 30s interval

  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  if (isLoading) {
    return <LoadingState message="Loading challenges..." />;
  }

  if (!userId) {
    return (
      <div className={styles.page}>
        <div className={styles.emptyState}>
          <p>Sign in to see your daily challenges.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>Daily Challenges</h1>
          <p className={styles.dateLine}>{dateLabel}</p>
        </div>
        <div className={styles.resetBadge}>
          <span className={styles.resetLabel}>New challenges in</span>
          <span className={styles.resetTime}>{tierCountdown.daily}</span>
        </div>
      </header>

      {/* Streak banner — the streak now comes from the server so a freeze can
          be spent atomically. Freezes are earned (one per 7 days, max 3) and
          cover a single missed day, so being ill once does not wipe a month of
          effort and send the most engaged players away for good. */}
      <section className={styles.streakBanner}>
        <div className={styles.streakLeft}>
          <StreakFire streakCount={streak?.streak ?? stats?.currentStreak ?? 0} size="md" />
          <div className={styles.streakInfo}>
            <span className={styles.streakCount}>
              {(streak?.streak ?? stats?.currentStreak ?? 0).toLocaleString()} day streak
            </span>
            <span className={styles.streakSub}>
              {streak?.usedFreeze && streak.frozenDate
                ? `A streak freeze covered ${new Date(streak.frozenDate + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} for you`
                : 'Complete a challenge every day to keep it alive'}
            </span>
          </div>
        </div>

        <div className={styles.milestone}>
          {stats && (
            <>
              <div className={styles.milestoneTrack}>
                <div
                  className={styles.milestoneFill}
                  style={{
                    width: `${Math.min(((streak?.streak ?? stats.currentStreak) / stats.nextMilestone) * 100, 100)}%`,
                  }}
                />
              </div>
              <span className={styles.milestoneText}>
                {(streak?.streak ?? stats.currentStreak).toLocaleString()}/
                {stats.nextMilestone.toLocaleString()} days to +
                {stats.milestoneReward.toLocaleString()} chips
              </span>
            </>
          )}
          {streak && (
            <span className={styles.freezeLine}>
              {streak.freezesAvailable > 0
                ? `${streak.freezesAvailable} streak freeze${streak.freezesAvailable === 1 ? '' : 's'} banked`
                : 'No streak freeze banked'}
              {streak.nextFreezeIn != null
                ? ` - next in ${streak.nextFreezeIn} day${streak.nextFreezeIn === 1 ? '' : 's'}`
                : ''}
            </span>
          )}
        </div>
      </section>

      {/* Summary tiles */}
      <section className={styles.summaryRow}>
        <div className={styles.summaryTile}>
          <span className={styles.summaryValue}>
            {tierCounts.daily.done}/{tierCounts.daily.total}
          </span>
          <span className={styles.summaryLabel}>Today</span>
        </div>
        <div className={styles.summaryTile}>
          <span className={styles.summaryValue}>{(stats?.totalCompleted || 0).toLocaleString()}</span>
          <span className={styles.summaryLabel}>All-Time Completed</span>
        </div>
        <div className={styles.summaryTile}>
          <span className={`${styles.summaryValue} ${styles.gold}`}>
            {(stats?.totalChipsEarned || 0).toLocaleString()}
          </span>
          <span className={styles.summaryLabel}>Chips Earned</span>
        </div>
      </section>

      {/* Unclaimed rewards callout */}
      {unclaimedRewards > 0 && (
        <div className={styles.unclaimedBar}>
          <span>
            {unclaimedRewards.toLocaleString()} chips ready to claim
          </span>
        </div>
      )}

      {/* Tier tabs */}
      <nav className={styles.tabs}>
        {(['daily', 'weekly', 'monthly'] as Tier[]).map((tier) => (
          <button
            key={tier}
            className={`${styles.tab} ${activeTier === tier ? styles.tabActive : ''}`}
            style={{ '--tier-color': TIER_COLORS[tier] } as React.CSSProperties}
            onClick={() => setActiveTier(tier)}
          >
            <span className={styles.tabLabel}>{TIER_LABELS[tier]}</span>
            <span className={styles.tabCount}>
              {tierCounts[tier].done}/{tierCounts[tier].total}
            </span>
          </button>
        ))}
      </nav>

      <p className={styles.tierReset}>
        {TIER_LABELS[activeTier]} challenges reset in {tierCountdown[activeTier]}
      </p>

      {/* Challenge list */}
      <section className={styles.list}>
        {visible.length === 0 ? (
          <div className={styles.emptyState}>
            <p>No {TIER_LABELS[activeTier].toLowerCase()} challenges available right now.</p>
          </div>
        ) : (
          visible.map((c) => (
            <ChallengeCard
              key={c.id}
              challenge={c}
              tier={c.tier}
              claiming={claimingIds.has(c.id)}
              celebrating={celebratingIds.has(c.id)}
              onClaim={handleClaim}
            />
          ))
        )}
      </section>

      {/* How it works */}
      <footer className={styles.footer}>
        <p>
          A new set of daily challenges arrives every day at midnight UTC. Weekly challenges
          reset each Monday, monthly challenges on the 1st. Play hands, win pots, hit
          showdowns, and enter tournaments to make progress automatically.
        </p>
        <button className={styles.playButton} onClick={() => navigate('/')}>
          Go Play
        </button>
      </footer>
    </div>
  );
}
