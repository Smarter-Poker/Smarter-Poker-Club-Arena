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
import { mediaUrl } from '../utils/mediaBase';
import {
  formatChallengeCountdown,
  getChallengeResetAt,
  getUtcDateKey,
  msUntilChallengeReset,
} from '../utils/challengeReset';

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

const TIERS: Tier[] = ['daily', 'weekly', 'monthly'];

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
  const remaining = Math.max(0, c.requirement - challenge.progress);

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
        <span className={styles.completionReadout}>
          {claimed
            ? 'Contract Settled'
            : done
              ? 'Objective Cleared'
              : `${remaining.toLocaleString()} Remaining`}
        </span>
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
              <span>Spend ◆ 10? Current Progress Will Be Replaced.</span>
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

function MissionLoadingState() {
  return (
    <StandardContentLayout className={styles.container}>
      <main className={styles.page} aria-busy="true" aria-label="Loading daily missions">
        <section className={`${styles.hero} ${styles.loadingHero}`}>
          <img
            className={styles.heroArtwork}
            src={mediaUrl('images/challenges/daily-missions-vault-v1.webp')}
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
            <h1>Daily Missions</h1>
            <p>Establishing A Secure Link To Your Live Contracts And Reward Vault.</p>
            <div className={styles.loadingSignal} role="status">
              <span className={styles.loadingSignalBar} />
              <strong>Synchronizing Mission Network</strong>
            </div>
          </div>
        </section>
        <section className={styles.loadingBoard} aria-hidden="true">
          <div className={styles.loadingBoardHeader} />
          <div className={styles.loadingCardGrid}>
            <div className={styles.loadingCard} />
            <div className={styles.loadingCard} />
          </div>
        </section>
      </main>
    </StandardContentLayout>
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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadWarning, setLoadWarning] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
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
  const rerollGuardRef = useRef(new Set<string>());
  const buyFreezeGuardRef = useRef(false);

  // Celebration state
  const [celebratingIds, setCelebratingIds] = useState<Set<string>>(new Set());
  const [reward, setReward] = useState<{
    name: string;
    chips: number;
    diamonds: number;
    diamondBalance: number;
  } | null>(null);

  const [now, setNow] = useState(Date.now());
  const dateKeyRef = useRef<string>('');
  const loadRequestRef = useRef(0);
  const lastSyncedAtRef = useRef(0);
  const lastResumeRefreshRef = useRef(0);

  // ── Loaders ──
  const loadChallenges = useCallback(
    async (uid: string, withSpinner: boolean) => {
      const requestId = ++loadRequestRef.current;
      if (withSpinner) {
        setIsLoading(true);
      } else {
        setIsRefreshing(true);
      }

      try {
        const [missionResult, statsResult, streakResult, balanceResult] = await Promise.allSettled([
          dailyChallengeService.getAllChallenges(uid),
          dailyChallengeService.getStats(uid),
          dailyChallengeService.getStreak(uid),
          dailyChallengeService.getDiamondBalance(uid),
        ]);
        if (!isMountedRef.current || requestId !== loadRequestRef.current) return;

        if (missionResult.status === 'rejected') throw missionResult.reason;

        const { daily, weekly, monthly } = missionResult.value;
        setChallenges([...daily, ...weekly, ...monthly]);
        setLoadError(null);

        const auxiliaryFailures: string[] = [];
        if (statsResult.status === 'fulfilled') setStats(statsResult.value);
        else {
          auxiliaryFailures.push('Career Totals');
          reportError(statsResult.reason, 'DailyChallengesPage.stats_load_failed');
        }
        if (streakResult.status === 'fulfilled') setStreak(streakResult.value);
        else {
          auxiliaryFailures.push('Streak Status');
          reportError(streakResult.reason, 'DailyChallengesPage.streak_load_failed');
        }
        if (balanceResult.status === 'fulfilled') setDiamondBalance(balanceResult.value);
        else {
          auxiliaryFailures.push('Diamond Balance');
          reportError(balanceResult.reason, 'DailyChallengesPage.balance_load_failed');
        }

        setLoadWarning(
          auxiliaryFailures.length > 0
            ? `Missions Are Live, But ${auxiliaryFailures.join(', ')} Could Not Be Refreshed.`
            : null
        );
        const syncedAt = Date.now();
        lastSyncedAtRef.current = syncedAt;
        setLastSyncedAt(syncedAt);
      } catch (err: any) {
        reportError(err, 'DailyChallengesPage.load_failed');
        if (isMountedRef.current && requestId === loadRequestRef.current) {
          setLoadError(
            'Mission Network Unavailable. Your Progress Is Safe - Retry The Secure Link.'
          );
        }
      } finally {
        if (isMountedRef.current && requestId === loadRequestRef.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [isMountedRef]
  );

  // ── Initialization ──
  useEffect(() => {
    dateKeyRef.current = getUtcDateKey();
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
        reportError(err, 'DailyChallengesPage.auth_load_failed');
        if (!cancelled) {
          setLoadError('Secure Session Check Failed. Please Retry Or Sign In Again.');
          setIsLoading(false);
        }
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
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const tickAt = Date.now();
      setNow(tickAt);
      // When the UTC date flips while the page is open, fetch the new day's set
      const key = getUtcDateKey(tickAt);
      if (key !== dateKeyRef.current) {
        dateKeyRef.current = key;
        if (userId) loadChallenges(userId, false);
      }
      // Seconds matter during the last hour. Before that, a 30-second cadence
      // avoids re-rendering every mission card 3,600 times per hour.
      timer = setTimeout(
        tick,
        msUntilChallengeReset('daily', tickAt) <= 60 * 60 * 1000 ? 1000 : 30_000
      );
    };
    timer = setTimeout(tick, 1000);
    return () => clearTimeout(timer);
  }, [userId, loadChallenges]);

  // Browsers throttle timers and live sockets in background tabs. Reconcile on
  // resume so a table left open overnight never shows yesterday's contracts.
  useEffect(() => {
    if (!userId) return undefined;

    const refreshAfterResume = () => {
      if (document.visibilityState !== 'visible') return;
      const resumedAt = Date.now();
      setNow(resumedAt);
      if (resumedAt - lastResumeRefreshRef.current < 1000) return;

      const dateChanged = getUtcDateKey(resumedAt) !== dateKeyRef.current;
      const stale = resumedAt - lastSyncedAtRef.current > 60_000;
      if (dateChanged || stale) {
        lastResumeRefreshRef.current = resumedAt;
        dateKeyRef.current = getUtcDateKey(resumedAt);
        loadChallenges(userId, false);
      }
    };

    document.addEventListener('visibilitychange', refreshAfterResume);
    window.addEventListener('focus', refreshAfterResume);
    return () => {
      document.removeEventListener('visibilitychange', refreshAfterResume);
      window.removeEventListener('focus', refreshAfterResume);
    };
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
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      if (pending) clearTimeout(pending);
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
    if (!userId || buyingFreeze || buyFreezeGuardRef.current) return;
    if (diamondBalance < 5000) {
      toast.error('Not enough diamonds. You need 5,000 Diamonds to buy a freeze.');
      return;
    }

    buyFreezeGuardRef.current = true;
    setBuyingFreeze(true);
    setDiamondBalance((prev) => Math.max(0, prev - 5000));
    setStreak((prev) => (prev ? { ...prev, freezesAvailable: prev.freezesAvailable + 1 } : prev));

    try {
      const res = await dailyChallengeService.buyStreakFreeze(userId);
      if (res.success) {
        toast.success(
          res.alreadyPurchased ? 'Streak Freeze Purchase Confirmed.' : 'Streak Freeze Purchased.'
        );
        if (isMountedRef.current) {
          if (res.diamondBalance != null) setDiamondBalance(res.diamondBalance);
          if (res.freezesAvailable != null) {
            setStreak((prev) =>
              prev ? { ...prev, freezesAvailable: res.freezesAvailable as number } : prev
            );
          }
        }
      } else {
        toast.error(res.error || 'Failed to buy freeze');
        // Revert UI on fail
        loadChallenges(userId, false);
      }
    } catch {
      toast.error('Failed to buy freeze');
      loadChallenges(userId, false);
    } finally {
      buyFreezeGuardRef.current = false;
      if (isMountedRef.current) setBuyingFreeze(false);
    }
  }, [userId, buyingFreeze, diamondBalance, toast, loadChallenges, isMountedRef]);

  const handleReroll = useCallback(
    async (challenge: TieredUserChallenge) => {
      if (!userId) return;
      if (rerollGuardRef.current.has(challenge.id)) return;
      if (diamondBalance < 10) {
        toast.error('Not enough diamonds. 10 Diamonds required.');
        return;
      }

      rerollGuardRef.current.add(challenge.id);
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
        rerollGuardRef.current.delete(challenge.id);
        if (isMountedRef.current) {
          setRerollingIds((prev) => {
            const next = new Set(prev);
            next.delete(challenge.id);
            return next;
          });
        }
      }
    },
    [userId, diamondBalance, loadChallenges, toast, isMountedRef]
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

  const tierResetMs: Record<Tier, number> = {
    daily: msUntilChallengeReset('daily', now),
    weekly: msUntilChallengeReset('weekly', now),
    monthly: msUntilChallengeReset('monthly', now),
  };
  const tierCountdown: Record<Tier, string> = {
    daily: formatChallengeCountdown(tierResetMs.daily),
    weekly: formatChallengeCountdown(tierResetMs.weekly),
    monthly: formatChallengeCountdown(tierResetMs.monthly),
  };

  const visible = useMemo(() => {
    const stateRank = (c: TieredChallenge) => (c.claimed ? 2 : c.completed ? 0 : 1);
    return challenges
      .filter((c) => c.tier === activeTier)
      .sort((a, b) => stateRank(a) - stateRank(b));
  }, [challenges, activeTier]);

  const activeResetLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(getChallengeResetAt(activeTier, now)),
    [activeTier, now]
  );
  const activeResetUrgent = tierResetMs[activeTier] <= 60 * 60 * 1000;
  const activeUnclaimed = visible.filter(
    (challenge) => challenge.completed && !challenge.claimed
  ).length;
  const syncLabel = isRefreshing
    ? 'Synchronizing'
    : lastSyncedAt && now - lastSyncedAt < 60_000
      ? 'Live Now'
      : 'Live Sync';

  const handleTierKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, tier: Tier) => {
      const index = TIERS.indexOf(tier);
      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % TIERS.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TIERS.length) % TIERS.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = TIERS.length - 1;
      else return;

      event.preventDefault();
      const nextTier = TIERS[nextIndex];
      setActiveTier(nextTier);
      setConfirmingRerollId(null);
      requestAnimationFrame(() => document.getElementById(`mission-tab-${nextTier}`)?.focus());
    },
    []
  );

  // ── Render ──

  if (isLoading) {
    return <MissionLoadingState />;
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
      <main
        className={styles.page}
        id="daily-missions"
        data-arena-surface="missions"
        aria-busy={isRefreshing}
      >
        <section className={styles.hero} aria-labelledby="missions-title">
          <img
            className={styles.heroArtwork}
            src={mediaUrl('images/challenges/daily-missions-vault-v1.webp')}
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
            <span>{syncLabel}</span>
            <strong>
              {tierCounts.daily.done}/{tierCounts.daily.total}
            </strong>
            <small>Complete Today</small>
          </div>
        </section>

        {(loadError || loadWarning) && (
          <aside
            className={`${styles.syncNotice} ${loadError ? styles.syncNoticeError : ''}`}
            role={loadError ? 'alert' : 'status'}
          >
            <div>
              <span className={styles.panelLabel}>
                {loadError ? 'Connection Interrupted' : 'Partial Sync'}
              </span>
              <strong>{loadError || loadWarning}</strong>
            </div>
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => userId && loadChallenges(userId, false)}
              disabled={isRefreshing}
            >
              {isRefreshing ? 'Reconnecting...' : 'Retry Sync'}
            </button>
          </aside>
        )}

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
                  title={
                    streak.freezesAvailable >= 3
                      ? 'Your Freeze Vault Is Full.'
                      : diamondBalance < 5000
                        ? 'You Need 5,000 Spendable Diamonds.'
                        : 'Banks One Streak Freeze For A Missed Daily Cycle.'
                  }
                >
                  {buyingFreeze
                    ? 'Securing...'
                    : streak.freezesAvailable >= 3
                      ? 'Freeze Vault Full'
                      : diamondBalance < 5000
                        ? 'Need More Diamonds'
                        : 'Buy Streak Freeze'}
                  {streak.freezesAvailable < 3 && <span>◆ 5,000</span>}
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
            <div
              className={`${styles.resetReadout} ${activeResetUrgent ? styles.resetUrgent : ''}`}
              aria-live="polite"
            >
              <span>
                {isRefreshing ? 'Syncing Mission Network' : `${TIER_LABELS[activeTier]} Reset`}
              </span>
              <strong>{tierCountdown[activeTier]}</strong>
              <small>{activeResetLabel}</small>
              {activeResetUrgent && activeUnclaimed > 0 && (
                <em>
                  Claim {activeUnclaimed} Ready Reward{activeUnclaimed === 1 ? '' : 's'} Before
                  Reset
                </em>
              )}
            </div>
          </header>

          <nav className={styles.tabs} role="tablist" aria-label="Challenge period">
            {TIERS.map((tier) => (
              <button
                key={tier}
                id={`mission-tab-${tier}`}
                type="button"
                role="tab"
                aria-selected={activeTier === tier}
                aria-controls={`mission-panel-${tier}`}
                tabIndex={activeTier === tier ? 0 : -1}
                className={`${styles.tab} ${activeTier === tier ? styles.tabActive : ''}`}
                style={{ '--tier-color': TIER_COLORS[tier] } as React.CSSProperties}
                onKeyDown={(event) => handleTierKeyDown(event, tier)}
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

          <section
            id={`mission-panel-${activeTier}`}
            className={styles.list}
            role="tabpanel"
            aria-labelledby={`mission-tab-${activeTier}`}
            aria-label={`${TIER_LABELS[activeTier]} challenges`}
          >
            {visible.length === 0 ? (
              <div className={styles.emptyState}>
                <h3>{loadError ? 'Mission Link Offline' : 'No Missions Assigned'}</h3>
                <p>
                  {loadError
                    ? 'Reconnect to retrieve your active contracts. Your recorded progress is safe.'
                    : `Your Next ${TIER_LABELS[activeTier]} Mission Set Is Being Prepared.`}
                </p>
                <button
                  type="button"
                  className={styles.retryButton}
                  onClick={() => loadChallenges(userId, false)}
                  disabled={isRefreshing}
                >
                  {isRefreshing ? 'Reconnecting...' : 'Retry Mission Link'}
                </button>
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

              <div className={styles.celebratePayouts} aria-label="Rewards earned">
                {reward.chips > 0 && (
                  <div>
                    <span className={styles.celebratePayoutValue}>
                      +{reward.chips.toLocaleString()}
                    </span>
                    <span className={styles.celebratePayoutLabel}>Chips</span>
                  </div>
                )}
                {reward.diamonds > 0 && (
                  <div className={styles.celebrateDiamondPayout}>
                    <span className={styles.celebratePayoutValue}>
                      +{reward.diamonds.toLocaleString()}
                    </span>
                    <span className={styles.celebratePayoutLabel}>
                      {reward.diamonds === 1 ? 'Diamond' : 'Diamonds'}
                    </span>
                  </div>
                )}
              </div>

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
