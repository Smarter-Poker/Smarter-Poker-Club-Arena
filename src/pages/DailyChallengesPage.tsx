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
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { getAuthUser, supabase } from '../lib/supabase';
import { LoadingState } from '../components/common/EmptyState';
import { StreakFire } from '../components/gamification/StreakFire';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import { triggerHaptic } from '../services/HapticService';
import {
  dailyChallengeService,
  type TieredUserChallenge,
  type Tier,
  type ChallengeType,
} from '../services/DailyChallengeService';
import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import { ConfettiEffect } from '../components/effects/ConfettiEffect';
import { TopStreaksLeaderboard } from '../components/gamification/TopStreaksLeaderboard';
import styles from './DailyChallengesPage.module.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

// Tier and TieredChallenge now come from the service, which is also what the
// server-catalog fetch returns -- one definition, so a tier added there cannot
// silently disagree with the tabs here.
type TieredChallenge = TieredUserChallenge;

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
  totalDiamondsEarned: number;
  nextMilestone: number;
  milestoneReward: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Unicode glyph per challenge type — no emoji (SWC-safe) */
const TYPE_GLYPHS: Record<ChallengeType, string> = {
  hands_played: '\u2660', // spade
  hands_won: '\u2605', // star
  showdowns: '\u2666', // diamond suit
  showdowns_won: '\u2617', // black shogi piece, a shown-down hand
  hands_won_no_showdown: '\u25D1', // half-filled circle, cards never revealed
  tournaments_played: '\u265B', // queen
  big_pots: '\u25C6', // solid diamond, the pot
  strong_hands: '\u2665', // heart, the hand
  chips_won: '\u25CE', // bullseye, stacked chips
  friends_added: '\u263A', // face
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
  const daysToMonday = (8 - day) % 7 || 7;
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMonday);
  return next - now.getTime();
}

/** ms until 1st of next month 00:00 UTC */
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

// ═══════════════════════════════════════════════════════════════════════════════
// CARDS
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
  onReroll?: (c: TieredChallenge) => void;
}) {
  const c = challenge.challenge;
  const pct = c.requirement > 0 ? Math.min((challenge.progress / c.requirement) * 100, 100) : 0;
  const done = challenge.completed;
  const claimed = challenge.claimed;

  const handleClaim = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (done && !claimed && !claiming) onClaim(challenge);
  };

  return (
    <div
      className={`
        ${styles.challengeCard}
        ${done ? styles.cardCompleted : ''}
        ${claimed ? styles.cardClaimed : ''}
        ${celebrating ? styles.cardCelebrating : ''}
      `}
      style={{ '--card-tier-color': TIER_COLORS[tier] } as React.CSSProperties}
    >
      <div className={styles.cardHeader}>
        <div className={styles.iconBox} aria-hidden="true">
          {TYPE_GLYPHS[c.type] || '\u2605'}
        </div>
        <div className={styles.cardTitles}>
          <h3 className={styles.cardName}>{c.name}</h3>
          <p className={styles.cardDesc}>{c.description}</p>
        </div>
        {done && !claimed && (
          <button
            className={styles.claimButton}
            onClick={handleClaim}
            disabled={claiming}
            aria-label={`Claim reward for ${c.name}`}
          >
            {claiming ? 'Claiming' : 'Claim'}
          </button>
        )}
        {claimed && (
          <div className={styles.claimedBadge} aria-label="Already claimed">
            {'\u2713'} Claimed
          </div>
        )}
      </div>

      <div className={styles.progressTrack} aria-hidden="true">
        <div className={styles.progressFill} style={{ width: `${pct}%` }} />
        <span className={styles.progressText}>
          {Math.min(challenge.progress, c.requirement).toLocaleString()} /{' '}
          {c.requirement.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function DailyChallengesPage() {
  const navigate = useNavigate();
  const isMountedRef = useIsMounted();
  const toast = useToast();

  const [userId, setUserId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTier, setActiveTier] = useState<Tier>('daily');

  const [challenges, setChallenges] = useState<TieredChallenge[]>([]);
  const [stats, setStats] = useState<ChallengeStats | null>(null);
  const [streak, setStreak] = useState<StreakInfo | null>(null);

  // Claiming state
  const [claimingIds, setClaimingIds] = useState<Set<string>>(new Set());
  const [claimingAll, setClaimingAll] = useState(false);
  const claimGuardRef = useRef(new Set<string>()); // Prevent double-clicks bypassing React state

  // Celebration state
  const [celebratingIds, setCelebratingIds] = useState<Set<string>>(new Set());
  const [reward, setReward] = useState<{
    name: string;
    chips: number;
    diamonds: number;
    diamondBalance: number;
  } | null>(null);

  const [, setNow] = useState(Date.now());
  const dateKeyRef = useRef<string>('');

  const todayUtcKey = () => new Date().toISOString().split('T')[0];

  // ── Loaders ──
  const loadChallenges = useCallback(
    async (uid: string, withSpinner: boolean) => {
      if (withSpinner) setIsLoading(true);
      try {
        const [{ daily, weekly, monthly }, challengeStats, streakInfo] = await Promise.all([
          dailyChallengeService.getAllChallenges(uid),
          dailyChallengeService.getStats(uid),
          dailyChallengeService.getStreak(uid),
        ]);
        if (!isMountedRef.current) return;

        setChallenges([...daily, ...weekly, ...monthly]);
        setStats(challengeStats);
        setStreak(streakInfo);
      } catch (err: any) {
        reportError(err, 'DailyChallengesPage.load_failed');
        if (isMountedRef.current) toast.error('Could not load challenges. Please try again.');
      } finally {
        if (isMountedRef.current) setIsLoading(false);
      }
    },
    [isMountedRef, toast]
  );

  // ── Initialization ──
  useEffect(() => {
    dateKeyRef.current = todayUtcKey();
    let cancelled = false;
    (async () => {
      try {
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
      } catch (err) {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadChallenges]);

  // ── Reward Overlay auto-dismiss ──
  useEffect(() => {
    if (!reward) return undefined;
    // Auto-dismiss the celebration. Cleared on unmount and on manual dismiss so
    // a quick tap-away followed by another claim cannot leave a stale timer that
    // closes the NEXT celebration early.
    const t = setTimeout(() => {
      if (isMountedRef.current) setReward(null);
    }, 5000);
    // Escape closes it. A full-screen overlay with no keyboard exit is a trap
    // for anyone not using a pointer.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setReward(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [reward, isMountedRef]);

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
    return unsub;
  }, [userId, loadChallenges]);

  // ── Supabase Postgres Changes Subscription ──
  useEffect(() => {
    if (!userId) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let localTimers: ReturnType<typeof setTimeout>[] = [];

    const channel = supabase
      .channel(`daily-challenges:${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_daily_challenges',
          // Server-side filter. Without it every player's progress would be
          // delivered to every open challenges page and thrown away here.
          filter: `user_id=eq.${userId}`,
        },
        () => {
          if (pending) clearTimeout(pending);
          pending = setTimeout(() => {
            pending = null;
            // `false` = refresh in place. A spinner every time a hand ends
            // would make the page flicker for the whole session.
            // The MasterBus subscription above only carries events raised inside THIS
            // tab, and this app is explicitly built for multi-tabling: the normal way to
            // watch a challenge fill is to have it open beside a table, which is a
            // different tab and therefore a different bus. Postgres change events close
            // that gap, so progress earned anywhere -- another tab, a phone, the same
            // account on a second screen -- lands here without a manual refresh.
            if (isMountedRef.current) loadChallenges(userId, false);
          }, 1200);
          if (pending) localTimers.push(pending);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      if (pending) clearTimeout(pending);
      localTimers.forEach(clearTimeout);
      localTimers = [];
    };
  }, [userId, loadChallenges, isMountedRef]);

  // ── Claim handler ──
  const handleClaim = useCallback(
    async (challenge: TieredChallenge) => {
      if (!userId) return;
      if (claimGuardRef.current.has(challenge.id)) return;
      claimGuardRef.current.add(challenge.id);
      setClaimingIds((prev) => new Set(prev).add(challenge.id));

      try {
        // Optimistic UI update: Assume success instantly.
        setStats((prev) =>
          prev
            ? {
                ...prev,
                totalCompleted: prev.totalCompleted + 1,
                totalChipsEarned: prev.totalChipsEarned + (challenge.challenge.chipReward || 0),
                totalDiamondsEarned:
                  prev.totalDiamondsEarned + (challenge.challenge.diamondReward || 0),
              }
            : prev
        );

        setChallenges((prev) =>
          prev.map((c) => (c.id === challenge.id ? { ...c, claimed: true } : c))
        );

        const paid = await dailyChallengeService.claimChallenge(
          userId,
          challenge.id,
          challenge.challenge.chipReward
        );
        if (paid.alreadyClaimed) {
          toast.info('You already claimed this one');
        } else if (paid.claimed) {
          setReward({
            name: challenge.challenge.name,
            chips: paid.chips,
            diamonds: paid.diamonds,
            diamondBalance: paid.diamondBalance,
          });
        } else {
          toast.error('That reward could not be claimed. Refreshing...');
          loadChallenges(userId, false);
          return;
        }

        setChallenges((prev) =>
          prev.map((c) => (c.id === challenge.id ? { ...c, claimed: true } : c))
        );
        triggerHaptic('success');
        setCelebratingIds((prev) => new Set(prev).add(challenge.id));

        setTimeout(() => {
          if (isMountedRef.current) {
            setCelebratingIds((prev) => {
              const next = new Set(prev);
              next.delete(challenge.id);
              return next;
            });
          }
        }, 3000);

        masterBus.emit('MISSION_CLAIMED', {
          missionId: challenge.id,
          tier: challenge.tier,
          rewardType: paid.diamonds > 0 ? 'diamonds' : 'chips',
          rewardAmount: paid.diamonds > 0 ? paid.diamonds : paid.chips,
        });

        // Refresh stats silently
        if (isMountedRef.current) loadChallenges(userId, false);
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
    [userId, loadChallenges, toast]
  );

  // ── Claim All ──
  //
  // Sequential, not Promise.all: each claim credits a wallet, and firing five
  // wallet writes at once invites lock contention on the same profile row for
  // no user-visible gain. The overlay shows the COMBINED total rather than
  // flashing five times in a row.
  const handleReroll = useCallback(
    async (challenge: TieredChallenge) => {
      if (!userId) return;
      if (stats && stats.totalDiamondsEarned < 1000) {
        toast.error('Not enough diamonds (1,000 required).');
        return;
      }

      // Optimistic UI for Reroll
      setStats((prev) =>
        prev ? { ...prev, totalDiamondsEarned: prev.totalDiamondsEarned - 1000 } : prev
      );

      const nextChallenge = await dailyChallengeService.rerollChallenge(userId, challenge.id, 1000);
      if (nextChallenge) {
        setChallenges((prev) =>
          prev.map((c) => (c.id === challenge.id ? { ...c, challenge: nextChallenge } : c))
        );
        toast.success('Challenge Rerolled!');
      } else {
        // Revert if failed
        setStats((prev) =>
          prev ? { ...prev, totalDiamondsEarned: prev.totalDiamondsEarned + 1000 } : prev
        );
        toast.error('Failed to reroll challenge.');
      }
    },
    [userId, stats, toast]
  );

  const handleClaimAll = useCallback(async () => {
    if (!userId || claimingAll) return;
    const ready = challenges.filter((c) => c.completed && !c.claimed);
    if (ready.length === 0) return;

    setClaimingAll(true);
    let chips = 0;
    let diamonds = 0;
    let balance = 0;
    let failures = 0;
    const claimedIds: string[] = [];

    for (const c of ready) {
      if (claimGuardRef.current.has(c.id)) continue;
      claimGuardRef.current.add(c.id);

      // Optimistic UI for Claim All
      setStats((prev) =>
        prev
          ? {
              ...prev,
              totalCompleted: prev.totalCompleted + 1,
              totalChipsEarned: prev.totalChipsEarned + (c.challenge.chipReward || 0),
              totalDiamondsEarned: prev.totalDiamondsEarned + (c.challenge.diamondReward || 0),
            }
          : prev
      );

      setChallenges((prev) => prev.map((ch) => (ch.id === c.id ? { ...ch, claimed: true } : ch)));

      try {
        const paid = await dailyChallengeService.claimChallenge(
          userId,
          c.id,
          c.challenge.chipReward
        );
        if (paid.claimed) {
          chips += paid.chips;
          diamonds += paid.diamonds;
          balance = paid.diamondBalance;
          claimedIds.push(c.id);
        } else if (paid.alreadyClaimed) {
          claimedIds.push(c.id);
        } else {
          failures++;
        }
      } catch (err) {
        failures++;
        reportError(err, 'DailyChallengesPage.claimAll_failed');
      } finally {
        claimGuardRef.current.delete(c.id);
      }
    }

    if (!isMountedRef.current) return;
    setClaimingAll(false);
    if (claimedIds.length > 0) {
      const done = new Set(claimedIds);
      setChallenges((prev) => prev.map((c) => (done.has(c.id) ? { ...c, claimed: true } : c)));
      triggerHaptic('success');
    }
    if (chips > 0 || diamonds > 0) {
      setReward({
        name: `${claimedIds.length} challenge${claimedIds.length === 1 ? '' : 's'}`,
        chips,
        diamonds,
        diamondBalance: balance,
      });
    }
    // Report partial failure honestly rather than letting a silent skip look
    // like a reward that was never owed.
    if (failures > 0) {
      toast.error(
        `${failures} reward${failures === 1 ? '' : 's'} could not be claimed. Refreshing...`
      );
      loadChallenges(userId, false);
    } else if (claimedIds.length > 0) {
      loadChallenges(userId, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, challenges, claimingAll, toast, loadChallenges]);

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

  const unclaimed = useMemo(() => {
    let count = 0;
    let chips = 0;
    let diamonds = 0;
    challenges.forEach((c) => {
      if (c.completed && !c.claimed) {
        count++;
        chips += c.challenge.chipReward;
        diamonds += c.challenge.diamondReward;
      }
    });
    return { count, chips, diamonds };
  }, [challenges]);

  const tierCountdown: Record<Tier, string> = {
    daily: formatCountdown(msUntilUtcMidnight()),
    weekly: formatCountdown(msUntilNextMondayUtc()),
    monthly: formatCountdown(msUntilNextMonthUtc()),
  };

  const visible = useMemo(
    () => challenges.filter((c) => c.tier === activeTier && !c.claimed),
    [challenges, activeTier]
  );

  // ── Render ──

  if (isLoading) {
    return <LoadingState message="Loading Challenges..." />;
  }

  if (!userId) {
    return (
      <div className={styles.container}>
        <div className={styles.emptyState}>
          <h2>Sign In To See Your Daily Challenges</h2>
          <button className={styles.playButton} onClick={() => navigate('/auth')}>
            Sign In
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerTitles}>
          <h1 className={styles.title}>Daily Challenges</h1>
          <p className={styles.subtitle}>Complete Goals To Earn Chips And Diamonds</p>
        </div>
        <button
          className={styles.closeButton}
          onClick={() => navigate('/')}
          aria-label="Close challenges"
        >
          {'\u2715'}
        </button>
      </header>

      {/* Streak banner */}
      <section className={styles.streakBanner}>
        <div className={styles.streakLeft}>
          <StreakFire streakCount={streak?.streak ?? stats?.currentStreak ?? 0} size="md" />
          <div className={styles.streakInfo}>
            <span className={styles.streakCount}>
              {(streak?.streak ?? stats?.currentStreak ?? 0).toLocaleString()} Day Streak
            </span>
            <span className={styles.streakDesc}>
              Play Every Day To Earn Streak Bonuses. Next Reward At{' '}
              {stats?.nextMilestone.toLocaleString()} Days.
            </span>
          </div>
        </div>
        <div className={styles.streakRight}>
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
          {!streak?.usedFreeze && (
            <button
              className="btn-secondary"
              style={{ marginLeft: '10px', fontSize: '12px', padding: '4px 10px' }}
              onClick={handleBuyFreeze}
              disabled={buyingFreeze}
            >
              {buyingFreeze ? 'Working...' : 'Buy Freeze (5k 💎)'}
            </button>
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
          <span className={styles.summaryValue}>
            {(stats?.totalCompleted || 0).toLocaleString()}
          </span>
          <span className={styles.summaryLabel}>All-Time Completed</span>
        </div>
        <div className={styles.summaryTile}>
          <span className={`${styles.summaryValue} ${styles.diamond}`}>
            {'◆'} {(stats?.totalDiamondsEarned || 0).toLocaleString()}
          </span>
          <span className={styles.summaryLabel}>Diamonds Earned</span>
        </div>
      </section>

      {/* Unclaimed rewards callout */}
      {unclaimed.count > 0 && (
        <div className={styles.unclaimedBar}>
          <span>
            {[
              unclaimed.chips > 0 ? `+${unclaimed.chips.toLocaleString()}` : '',
              unclaimed.diamonds > 0 ? `${'◆'} ${unclaimed.diamonds.toLocaleString()}` : '',
            ]
              .filter(Boolean)
              .join('  +  ')}{' '}
            Ready To Claim
          </span>
          <button className={styles.claimAllButton} onClick={handleClaimAll} disabled={claimingAll}>
            {claimingAll
              ? 'Claiming...'
              : `Claim ${unclaimed.count === 1 ? 'It' : `All ${unclaimed.count}`}`}
          </button>
        </div>
      )}

      {/* Tier tabs */}
      <nav className={styles.tabs} role="tablist" aria-label="Challenge period">
        {(['daily', 'weekly', 'monthly'] as Tier[]).map((tier) => (
          <button
            key={tier}
            role="tab"
            aria-selected={activeTier === tier}
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
        {TIER_LABELS[activeTier]} Challenges Reset In {tierCountdown[activeTier]}
      </p>

      {/* Challenge list */}
      <section className={styles.list}>
        {visible.length === 0 ? (
          <div className={styles.emptyState}>
            <p>No {TIER_LABELS[activeTier].toLowerCase()} Challenges Available Right Now.</p>
          </div>
        ) : (
          <AnimatePresence>
            {visible.map((c) => (
              <motion.div
                key={c.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -50, height: 0, marginBottom: 0 }}
                transition={{ duration: 0.3 }}
              >
                <ChallengeCard
                  challenge={c}
                  tier={c.tier}
                  claiming={claimingIds.has(c.id)}
                  celebrating={celebratingIds.has(c.id)}
                  onClaim={handleClaim}
                  onReroll={handleReroll}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </section>

      {/* Celebration — the payoff moment. Deliberately a full overlay rather
          than a corner toast: the whole point of a daily loop is that finishing
          one FEELS like something, and a 3-second slide-in at the edge of the
          screen does not. Dismisses on tap or after 5s. */}
      {reward && (
        <div
          className={styles.celebrateOverlay}
          role="dialog"
          aria-modal="true"
          aria-live="assertive"
          aria-label={[
            `Challenge complete: ${reward.name}.`,
            reward.diamonds > 0 ? `You earned ${reward.diamonds} diamonds.` : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => setReward(null)}
        >
          {challenges.filter((c) => c.tier === 'daily').every((c) => c.completed) ? (
            <ConfettiEffect
              isActive={true}
              intensity="jackpot"
              colors={['#f59e0b', '#fbbf24', '#ffffff', '#00f0ff']}
              duration={8000}
            />
          ) : (
            <ConfettiEffect
              isActive={true}
              intensity="heavy"
              colors={['#00f0ff', '#0ff', '#ffffff']}
              duration={4000}
            />
          )}
          <div className={styles.celebrateCard} onClick={(e) => e.stopPropagation()}>
            <div className={styles.celebrateBurst} aria-hidden="true">
              {'\u25C6'}
            </div>
            <h2 className={styles.celebrateTitle}>Challenge Complete</h2>
            <p className={styles.celebrateName}>{reward.name}</p>

            {reward.diamonds > 0 && (
              <div className={styles.celebrateDiamonds}>
                <span className={styles.celebrateDiamondValue}>
                  +{reward.diamonds.toLocaleString()}
                </span>
                <span className={styles.celebrateDiamondLabel}>
                  {reward.diamonds === 1 ? 'Diamond' : 'Diamonds'}
                </span>
              </div>
            )}

            {reward.diamonds > 0 && (
              <p className={styles.celebrateBalance}>
                New Balance: {reward.diamondBalance.toLocaleString()} Diamonds
              </p>
            )}

            <button className={styles.celebrateButton} onClick={() => setReward(null)} autoFocus>
              Nice
            </button>
          </div>
        </div>
      )}

      {/* How it works */}
      <footer className={styles.footer}>
        <p>
          A New Set Of Daily Challenges Arrives Every Day At Midnight UTC. Weekly Challenges Reset
          Each Monday, Monthly Challenges On The 1St. Play Hands, Win Pots, Hit Showdowns, And Enter
          Tournaments To Make Progress Automatically.
        </p>
        <button className={styles.playButton} onClick={() => navigate('/')}>
          Go Play
        </button>
      </footer>
    </div>
  );
}
