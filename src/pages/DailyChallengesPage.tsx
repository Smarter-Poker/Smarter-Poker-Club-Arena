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
          <span className={styles.cardReward}>
            {c.diamondReward > 0 && (
              <span className={styles.rewardDiamonds}>
                {'\u25C6'} {c.diamondReward.toLocaleString()}
              </span>
            )}
          </span>
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
  const [claimingAll, setClaimingAll] = useState(false);
  const [celebratingIds, setCelebratingIds] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  // Non-null while the celebration overlay is on screen.
  const [reward, setReward] = useState<{
    name: string;
    chips: number;
    diamonds: number;
    diamondBalance: number;
  } | null>(null);

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
      setChallenges([...daily, ...weekly, ...monthly]);
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

  // Auto-dismiss the celebration. Cleared on unmount and on manual dismiss so
  // a quick tap-away followed by another claim cannot leave a stale timer that
  // closes the NEXT celebration early.
  useEffect(() => {
    if (!reward) return undefined;
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
  }, [reward]);

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

  // ── Cross-tab and cross-device progress ──
  //
  // Dan 2026-08-21: "IT NEEDS TO PULL THE REAL TIME INFO AND DATA AND UPDATE."
  //
  // The MasterBus subscription above only carries events raised inside THIS
  // tab, and this app is explicitly built for multi-tabling: the normal way to
  // watch a challenge fill is to have it open beside a table, which is a
  // different tab and therefore a different bus. Postgres change events close
  // that gap, so progress earned anywhere -- another tab, a phone, the same
  // account on a second screen -- lands here without a manual refresh.
  //
  // Debounced, because at table speed a busy session updates several rows per
  // hand and each one arrives as its own event; without this the page would
  // refetch a dozen times a minute to redraw the same bars.
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
            loadChallenges(userId, false);
          }, 1200);
        }
      )
      .subscribe();

    return () => {
      if (pending) clearTimeout(pending);
      void supabase.removeChannel(channel);
    };
  }, [userId, loadChallenges]);

  // Card-flash timers are cleared on UNMOUNT only. They used to be cleared in
  // the bus-subscription cleanup above, which re-runs whenever userId settles --
  // so a claim made around that moment had its flash cancelled and its id left
  // in celebratingIds permanently. Separate concerns, separate effects.
  useEffect(() => {
    const timers = celebrateTimersRef;
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, []);

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
        if (!isMountedRef.current) return;

        // Celebrate with what the SERVER actually paid, never the card's copy
        // of the reward. If those two ever disagree, showing the client value
        // would announce diamonds the balance never received.
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
          // Neither paid nor already paid. The server declined without raising
          // -- so nothing was credited, and celebrating here would announce a
          // reward of nothing and then hide the Claim button for a reward the
          // player never received. Re-read the truth instead.
          toast.error('That reward could not be claimed. Refreshing...');
          loadChallenges(userId, false);
          return;
        }
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
          rewardType: paid.diamonds > 0 ? 'diamonds' : 'chips',
          rewardAmount: paid.diamonds > 0 ? paid.diamonds : paid.chips,
        });
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

  // ── Claim everything that is ready ──
  //
  // Sequential, not Promise.all: each claim credits a wallet, and firing five
  // wallet writes at once invites lock contention on the same profile row for
  // no user-visible gain. The overlay shows the COMBINED total rather than
  // flashing five times in a row.
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, challenges, claimingAll]);

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

  // Diamonds are the premium currency and the reason to come back, so the
  // "ready to claim" callout has to name them. Counting only chips undersold
  // every unclaimed reward on the page.
  const unclaimed = useMemo(() => {
    let chips = 0;
    let diamonds = 0;
    let count = 0;
    for (const c of challenges) {
      if (!c.completed || c.claimed) continue;
      count++;
      chips += c.challenge.chipReward;
      diamonds += c.challenge.diamondReward;
    }
    return { chips, diamonds, count };
  }, [challenges]);

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
          <span className={styles.resetLabel}>New Challenges In</span>
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
                {stats.nextMilestone.toLocaleString()} days
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
            {[unclaimed.diamonds > 0 ? `${'◆'} ${unclaimed.diamonds.toLocaleString()}` : '']
              .filter(Boolean)
              .join('  +  ')}{' '}
            ready to claim
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
                New balance: {reward.diamondBalance.toLocaleString()} diamonds
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
          A new set of daily challenges arrives every day at midnight UTC. Weekly challenges reset
          each Monday, monthly challenges on the 1st. Play hands, win pots, hit showdowns, and enter
          tournaments to make progress automatically.
        </p>
        <button className={styles.playButton} onClick={() => navigate('/')}>
          Go Play
        </button>
      </footer>
    </div>
  );
}
