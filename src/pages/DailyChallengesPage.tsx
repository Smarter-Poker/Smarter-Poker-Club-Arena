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
import { getAuthUser, supabase } from '../lib/supabase';
import { LoadingState } from '../components/common/EmptyState';
import { StreakFire } from '../components/gamification/StreakFire';
import { useToast } from '../components/common/Toast';
import { motion, AnimatePresence } from 'framer-motion';
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
import StandardContentLayout from '../components/layouts/StandardContentLayout';
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
  rerolling,
  confirmingReroll,
  celebrating,
  onClaim,
  onRequestReroll,
  onCancelReroll,
  onConfirmReroll,
}: {
  challenge: TieredChallenge;
  tier: Tier;
  claiming: boolean;
  rerolling: boolean;
  confirmingReroll: boolean;
  celebrating: boolean;
  onClaim: (c: TieredChallenge) => void;
  onRequestReroll: (c: TieredChallenge) => void;
  onCancelReroll: () => void;
  onConfirmReroll: (c: TieredChallenge) => void;
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
    <article
      className={`
        ${styles.challengeCard}
        ${done ? styles.cardCompleted : ''}
        ${claimed ? styles.cardClaimed : ''}
        ${celebrating ? styles.cardCelebrating : ''}
      `}
      style={{ '--card-tier-color': TIER_COLORS[tier] } as React.CSSProperties}
    >
      <div className={styles.cardTopline}>
        <span>{TIER_LABELS[tier]} Mission</span>
        <span className={styles.cardState}>
          {claimed ? 'Reward Collected' : done ? 'Ready To Claim' : 'In Progress'}
        </span>
      </div>

      <div className={styles.cardHeader}>
        <div className={styles.iconAssembly} aria-hidden="true">
          <span className={styles.iconBox}>{TYPE_GLYPHS[c.type] || '\u2605'}</span>
          <span className={styles.iconPulse} />
        </div>
        <div className={styles.cardTitles}>
          <h3 className={styles.cardName}>{c.name}</h3>
          <p className={styles.cardDesc}>{c.description}</p>
        </div>
        <div className={styles.rewardReadout} aria-label="Challenge rewards">
          <span className={styles.rewardLabel}>Reward</span>
          <strong>{c.chipReward.toLocaleString()} Chips</strong>
          {c.diamondReward > 0 && (
            <strong className={styles.diamondReward}>◆ {c.diamondReward}</strong>
          )}
        </div>
      </div>

      <div className={styles.progressBlock}>
        <div className={styles.progressLabels}>
          <span>Mission Progress</span>
          <strong>
            {Math.min(challenge.progress, c.requirement).toLocaleString()} /{' '}
            {c.requirement.toLocaleString()}
          </strong>
        </div>
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-label={`${c.name} progress`}
          aria-valuemin={0}
          aria-valuemax={c.requirement}
          aria-valuenow={Math.min(challenge.progress, c.requirement)}
        >
          <motion.div
            className={styles.progressFill}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          />
        </div>
      </div>

      <div className={styles.cardFooter}>
        <span className={styles.completionReadout}>{Math.round(pct)}% Complete</span>
        <div className={styles.cardActions}>
          {claimed && (
            <div className={styles.claimedBadge} aria-label="Already claimed">
              {'\u2713'} Claimed
            </div>
          )}
          {done && !claimed && (
            <button
              type="button"
              className={styles.claimButton}
              onClick={handleClaim}
              disabled={claiming}
              aria-label={`Claim reward for ${c.name}`}
            >
              {claiming ? 'Claiming...' : 'Claim Reward'}
            </button>
          )}
          {!done && !confirmingReroll && (
            <button
              type="button"
              className={styles.rerollButton}
              onClick={() => onRequestReroll(challenge)}
              disabled={rerolling}
              aria-label={`Reroll ${c.name} for 10 diamonds`}
            >
              Reroll <span>◆ 10</span>
            </button>
          )}
          {!done && confirmingReroll && (
            <div
              className={styles.rerollConfirm}
              role="group"
              aria-label={`Confirm reroll for ${c.name}`}
            >
              <span>Replace This Mission For ◆ 10?</span>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={onCancelReroll}
                disabled={rerolling}
              >
                Keep It
              </button>
              <button
                type="button"
                className={styles.confirmButton}
                onClick={() => onConfirmReroll(challenge)}
                disabled={rerolling}
              >
                {rerolling ? 'Replacing...' : 'Replace'}
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
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
  const [diamondBalance, setDiamondBalance] = useState(0);

  // Claiming state
  const [claimingIds, setClaimingIds] = useState<Set<string>>(new Set());
  const [claimingAll, setClaimingAll] = useState(false);
  const [rerollingIds, setRerollingIds] = useState<Set<string>>(new Set());
  const [confirmingRerollId, setConfirmingRerollId] = useState<string | null>(null);
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
        const [{ daily, weekly, monthly }, challengeStats, streakInfo, spendableDiamonds] =
          await Promise.all([
            dailyChallengeService.getAllChallenges(uid),
            dailyChallengeService.getStats(uid),
            dailyChallengeService.getStreak(uid),
            dailyChallengeService.getDiamondBalance(uid),
          ]);
        if (!isMountedRef.current) return;

        setChallenges([...daily, ...weekly, ...monthly]);
        setStats(challengeStats);
        setStreak(streakInfo);
        setDiamondBalance(spendableDiamonds);
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
      } catch {
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
      setStats((prev) =>
        prev
          ? {
              ...prev,
              totalChipsEarned: prev.totalChipsEarned + (challenge.challenge.chipReward || 0),
              totalDiamondsEarned:
                prev.totalDiamondsEarned + (challenge.challenge.diamondReward || 0),
            }
          : prev
      );

      try {
        const paid = await dailyChallengeService.claimChallenge(
          userId,
          challenge.id,
          challenge.challenge.chipReward
        );
        if (paid.alreadyClaimed) {
          toast.info('You already claimed this one');
        } else if (paid.claimed) {
          setDiamondBalance(paid.diamondBalance);
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

  const [buyingFreeze, setBuyingFreeze] = useState(false);
  const handleBuyFreeze = useCallback(async () => {
    if (!userId || buyingFreeze) return;
    if (diamondBalance < 5000) {
      toast.error('Not enough diamonds. You need 5,000 Diamonds to buy a freeze.');
      return;
    }

    setBuyingFreeze(true);
    setDiamondBalance((prev) => Math.max(0, prev - 5000));
    setStreak((prev) => (prev ? { ...prev, freezesAvailable: prev.freezesAvailable + 1 } : prev));

    try {
      const res = await dailyChallengeService.buyStreakFreeze(userId);
      if (res.success) {
        toast.success('Streak Freeze purchased.');
        const currentBalance = await dailyChallengeService.getDiamondBalance(userId);
        if (isMountedRef.current) setDiamondBalance(currentBalance);
      } else {
        toast.error(res.error || 'Failed to buy freeze');
        // Revert UI on fail
        loadChallenges(userId, false);
      }
    } catch {
      toast.error('Failed to buy freeze');
      loadChallenges(userId, false);
    } finally {
      if (isMountedRef.current) setBuyingFreeze(false);
    }
  }, [userId, buyingFreeze, diamondBalance, toast, loadChallenges, isMountedRef]);

  const handleReroll = useCallback(
    async (challenge: TieredUserChallenge) => {
      if (!userId) return;
      if (rerollingIds.has(challenge.id)) return;
      if (diamondBalance < 10) {
        toast.error('Not enough diamonds. 10 Diamonds required.');
        return;
      }

      setRerollingIds((prev) => new Set(prev).add(challenge.id));
      try {
        const result = await dailyChallengeService.rerollChallenge(
          userId,
          challenge.id,
          challenge.challengeId
        );
        if (!result.success) {
          toast.error(result.error || 'Challenge reroll failed');
          return;
        }
        if (result.diamondBalance != null) setDiamondBalance(result.diamondBalance);
        setConfirmingRerollId(null);
        toast.success(
          result.alreadyRerolled ? 'Challenge already replaced.' : 'New mission online.'
        );
        await loadChallenges(userId, false);
      } finally {
        if (isMountedRef.current) {
          setRerollingIds((prev) => {
            const next = new Set(prev);
            next.delete(challenge.id);
            return next;
          });
        }
      }
    },
    [userId, rerollingIds, diamondBalance, loadChallenges, toast, isMountedRef]
  );

  const handleClaimAll = useCallback(async () => {
    if (!userId || claimingAll) return;
    const ready = challenges.filter((c) => c.completed && !c.claimed);
    if (ready.length === 0) return;

    setClaimingAll(true);
    const optChips = ready.reduce((acc, c) => acc + (c.challenge.chipReward || 0), 0);
    const optDiamonds = ready.reduce((acc, c) => acc + (c.challenge.diamondReward || 0), 0);
    setStats((prev) =>
      prev
        ? {
            ...prev,
            totalChipsEarned: prev.totalChipsEarned + optChips,
            totalDiamondsEarned: prev.totalDiamondsEarned + optDiamonds,
          }
        : prev
    );
    let chips = 0;
    let diamonds = 0;
    let balance = 0;
    let failures = 0;
    const claimedIds: string[] = [];

    for (const c of ready) {
      if (claimGuardRef.current.has(c.id)) continue;
      claimGuardRef.current.add(c.id);
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
      setDiamondBalance(balance);
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

  const visible = useMemo(() => {
    const stateRank = (c: TieredChallenge) => (c.claimed ? 2 : c.completed ? 0 : 1);
    return challenges
      .filter((c) => c.tier === activeTier)
      .sort((a, b) => stateRank(a) - stateRank(b));
  }, [challenges, activeTier]);

  // ── Render ──

  if (isLoading) {
    return <LoadingState message="Loading Challenges..." />;
  }

  if (!userId) {
    return (
      <StandardContentLayout className={styles.container} title="Daily Missions">
        <div className={styles.emptyState}>
          <h2>Sign In To See Your Daily Challenges</h2>
          <button className={styles.playButton} onClick={() => navigate('/auth')}>
            Sign In
          </button>
        </div>
      </StandardContentLayout>
    );
  }

  return (
    <StandardContentLayout className={styles.container}>
      <main className={styles.page} id="daily-missions">
        <section className={styles.hero} aria-labelledby="missions-title">
          <img
            className={styles.heroArtwork}
            src="/hub/club-arena/images/challenges/daily-missions-vault-v1.webp"
            alt=""
            width="1774"
            height="887"
            loading="eager"
            decoding="async"
            fetchPriority="high"
            aria-hidden="true"
          />
          <div className={styles.heroShade} />
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>Club Arena // Mission Control</span>
            <h1 id="missions-title">Daily Missions</h1>
            <p>
              Complete Live Poker Objectives, Protect Your Streak, And Unlock Real Chip And Diamond
              Rewards.
            </p>
            <div className={styles.heroMeters}>
              <div>
                <span>Mission Cycle</span>
                <strong>{tierCountdown.daily}</strong>
                <small>Until Daily Reset</small>
              </div>
              <div>
                <span>Available Diamonds</span>
                <strong>◆ {diamondBalance.toLocaleString()}</strong>
                <small>Spendable Balance</small>
              </div>
            </div>
            <button type="button" className={styles.backButton} onClick={() => navigate('/')}>
              Back To Arena
            </button>
          </div>
          <div className={styles.heroSeal} aria-hidden="true">
            <span>Live</span>
            <strong>
              {tierCounts.daily.done}/{tierCounts.daily.total}
            </strong>
            <small>Complete Today</small>
          </div>
        </section>

        <section className={styles.commandDeck} aria-label="Challenge status">
          <div className={styles.streakConsole}>
            <div className={styles.streakCore}>
              <StreakFire streakCount={streak?.streak ?? stats?.currentStreak ?? 0} size="md" />
              <div className={styles.streakInfo}>
                <span className={styles.panelLabel}>Current Run</span>
                <strong className={styles.streakCount}>
                  {(streak?.streak ?? stats?.currentStreak ?? 0).toLocaleString()} Day Streak
                </strong>
                <span className={styles.streakDesc}>Play Every Day To Keep The Circuit Alive.</span>
              </div>
            </div>
            <div className={styles.milestoneTracker}>
              <div className={styles.milestoneLabels}>
                <span>{(streak?.streak ?? stats?.currentStreak ?? 0).toLocaleString()} Days</span>
                <span>Next Reward At {stats?.nextMilestone.toLocaleString()}</span>
              </div>
              <div className={styles.milestoneBar}>
                <motion.div
                  className={styles.milestoneFill}
                  initial={{ width: 0 }}
                  animate={{
                    width: `${Math.min((((streak?.streak ?? stats?.currentStreak ?? 0) % 7) / 7) * 100, 100)}%`,
                  }}
                  transition={{ duration: 1, ease: 'easeOut' }}
                />
              </div>
            </div>
            {streak && (
              <div className={styles.freezeLine}>
                <div className={styles.freezeInfo}>
                  <span>{streak.freezesAvailable} Banked</span>
                  <small>
                    {streak.nextFreezeIn != null
                      ? `Next Free Freeze In ${streak.nextFreezeIn} Day${streak.nextFreezeIn === 1 ? '' : 's'}`
                      : 'Freeze Inventory Ready'}
                  </small>
                </div>
                <button
                  type="button"
                  className={styles.buyFreezeBtn}
                  onClick={handleBuyFreeze}
                  disabled={buyingFreeze || diamondBalance < 5000 || streak.freezesAvailable >= 3}
                >
                  {buyingFreeze ? 'Securing...' : 'Buy Streak Freeze'}
                  <span>◆ 5,000</span>
                </button>
              </div>
            )}
          </div>

          <div className={styles.summaryGrid}>
            <div className={styles.summaryTile}>
              <span className={styles.summaryLabel}>Today</span>
              <strong className={styles.summaryValue}>
                {tierCounts.daily.done}/{tierCounts.daily.total}
              </strong>
              <small>Completed</small>
            </div>
            <div className={styles.summaryTile}>
              <span className={styles.summaryLabel}>Career</span>
              <strong className={styles.summaryValue}>
                {(stats?.totalCompleted || 0).toLocaleString()}
              </strong>
              <small>Missions Cleared</small>
            </div>
            <div className={styles.summaryTile}>
              <span className={styles.summaryLabel}>Earned Here</span>
              <strong className={`${styles.summaryValue} ${styles.diamond}`}>
                ◆ {(stats?.totalDiamondsEarned || 0).toLocaleString()}
              </strong>
              <small>Lifetime Diamonds</small>
            </div>
            <div className={styles.summaryTile}>
              <span className={styles.summaryLabel}>Next Milestone</span>
              <strong className={`${styles.summaryValue} ${styles.gold}`}>
                +{(stats?.milestoneReward || 0).toLocaleString()}
              </strong>
              <small>Bonus Chips</small>
            </div>
          </div>
        </section>

        {unclaimed.count > 0 && (
          <aside className={styles.unclaimedBar} aria-label="Unclaimed challenge rewards">
            <div>
              <span className={styles.panelLabel}>Reward Vault Open</span>
              <strong>
                {unclaimed.count} Mission{unclaimed.count === 1 ? '' : 's'} Ready
              </strong>
              <small>
                +{unclaimed.chips.toLocaleString()} Chips
                {unclaimed.diamonds > 0 ? ` + ◆ ${unclaimed.diamonds.toLocaleString()}` : ''}
              </small>
            </div>
            <button
              type="button"
              className={styles.claimAllButton}
              onClick={handleClaimAll}
              disabled={claimingAll}
            >
              {claimingAll ? 'Claiming Rewards...' : `Claim All ${unclaimed.count}`}
            </button>
          </aside>
        )}

        <section className={styles.missionBoard} aria-labelledby="mission-board-title">
          <header className={styles.boardHeader}>
            <div>
              <span className={styles.eyebrow}>Active Contracts</span>
              <h2 id="mission-board-title">Choose Your Mission Cycle</h2>
            </div>
            <div className={styles.resetReadout} aria-live="polite">
              <span>{TIER_LABELS[activeTier]} Reset</span>
              <strong>{tierCountdown[activeTier]}</strong>
            </div>
          </header>

          <nav className={styles.tabs} role="tablist" aria-label="Challenge period">
            {(['daily', 'weekly', 'monthly'] as Tier[]).map((tier) => (
              <button
                key={tier}
                type="button"
                role="tab"
                aria-selected={activeTier === tier}
                className={`${styles.tab} ${activeTier === tier ? styles.tabActive : ''}`}
                style={{ '--tier-color': TIER_COLORS[tier] } as React.CSSProperties}
                onClick={() => {
                  setActiveTier(tier);
                  setConfirmingRerollId(null);
                }}
              >
                <span className={styles.tabLabel}>{TIER_LABELS[tier]}</span>
                <span className={styles.tabCount}>
                  {tierCounts[tier].done}/{tierCounts[tier].total} Complete
                </span>
              </button>
            ))}
          </nav>

          <section className={styles.list} aria-label={`${TIER_LABELS[activeTier]} challenges`}>
            {visible.length === 0 ? (
              <div className={styles.emptyState}>
                <h3>No Missions Assigned</h3>
                <p>Your Next {TIER_LABELS[activeTier]} Mission Set Is Being Prepared.</p>
              </div>
            ) : (
              <AnimatePresence mode="popLayout">
                {visible.map((c, i) => (
                  <motion.div
                    key={c.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    transition={{ duration: 0.22, delay: Math.min(i * 0.035, 0.14) }}
                    layout
                  >
                    <ChallengeCard
                      challenge={c}
                      tier={c.tier}
                      claiming={claimingIds.has(c.id)}
                      rerolling={rerollingIds.has(c.id)}
                      confirmingReroll={confirmingRerollId === c.id}
                      celebrating={celebratingIds.has(c.id)}
                      onClaim={handleClaim}
                      onRequestReroll={(challenge) => setConfirmingRerollId(challenge.id)}
                      onCancelReroll={() => setConfirmingRerollId(null)}
                      onConfirmReroll={handleReroll}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            )}
          </section>
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
            <ConfettiEffect
              isActive={true}
              intensity="heavy"
              colors={['#00f0ff', '#0ff', '#ffffff']}
              duration={4000}
            />
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

        <footer className={styles.footer}>
          <div>
            <span className={styles.eyebrow}>Automatic Tracking</span>
            <h2>Play Poker. The Mission System Does The Rest.</h2>
            <p>
              Hand Results, Pots, Showdowns, Tournaments, And Social Goals Update Automatically.
              Daily Missions Reset At Midnight UTC, Weekly Missions Each Monday, And Monthly
              Missions On The First.
            </p>
          </div>
          <button type="button" className={styles.playButton} onClick={() => navigate('/')}>
            Go Play
          </button>
        </footer>
      </main>
    </StandardContentLayout>
  );
}
