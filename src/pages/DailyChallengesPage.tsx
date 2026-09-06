/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE - Daily Challenges Page
 * Dedicated challenges hub: today's rotating challenges, weekly and monthly
 * goals, streak tracking, and reward claiming.
 *
 * Challenges rotate every day at 00:00 UTC via the seeded selection in
 * DailyChallengeService - the same set for every player on a given day.
 * NO HARDCODED DATA - all progress comes from Supabase.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { getAuthUser } from '../lib/supabase';
import { StreakFire } from '../components/gamification/StreakFire';
import { useToast } from '../components/common/Toast';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { masterBus } from '../core/MasterBus';
import { triggerHaptic } from '../services/HapticService';
import {
  dailyChallengeService,
  type TieredUserChallenge,
  type Tier,
  type ChallengeType,
  type ChallengeStreak,
  type DailyChallengeStats,
  type DailyChallengeRewardVault,
} from '../services/DailyChallengeService';
import { useIsMounted } from '../hooks/useIsMounted';
import { useMasterBusBroadcastChannel } from '../hooks/useMasterBusBroadcastChannel';
import { useChallengeClockNow } from '../hooks/useChallengeClock';
import { useFocusTrap } from '../hooks/useFocusTrap';
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
import { getChallengeMissionAction } from '../utils/challengeMissionAction';
import { capture } from '../lib/analytics';
import {
  enablePush,
  hasLocalSubscription,
  isIos,
  isIosStandalonePwa,
  isWebPushSupported,
  notificationPermission,
} from '../lib/pushClient';
import {
  getDailyMissionAlertPreference,
  setDailyMissionAlertPreference,
} from '../services/DailyMissionNotificationService';
import {
  dailyMissionReasonCode,
  recordDailyMissionOperation,
} from '../services/DailyMissionTelemetryService';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

// Tier and TieredChallenge now come from the service, which is also what the
// server-catalog fetch returns -- one definition, so a tier added there cannot
// silently disagree with the tabs here.
type TieredChallenge = TieredUserChallenge;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Unicode glyph per challenge type - no emoji (SWC-safe) */
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
  onOpenMission,
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
  onOpenMission: (type: ChallengeType) => void;
}) {
  const reduceMotion = useReducedMotion();
  const rerollButtonRef = useRef<HTMLButtonElement>(null);
  const wasConfirmingRerollRef = useRef(confirmingReroll);
  const c = challenge.challenge;
  const pct = c.requirement > 0 ? Math.min((challenge.progress / c.requirement) * 100, 100) : 0;
  const done = challenge.completed;
  const claimed = challenge.claimed;
  const remaining = Math.max(0, c.requirement - challenge.progress);
  const missionAction = getChallengeMissionAction(c.type);

  useEffect(() => {
    if (wasConfirmingRerollRef.current && !confirmingReroll) {
      requestAnimationFrame(() => rerollButtonRef.current?.focus());
    }
    wasConfirmingRerollRef.current = confirmingReroll;
  }, [confirmingReroll]);

  const handleClaim = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (done && !claimed && !claiming) onClaim(challenge);
  };

  return (
    <article
      id={`mission-card-${challenge.id}`}
      tabIndex={-1}
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
        <div className={styles.rewardReadout} aria-label="Challenge Rewards">
          <span className={styles.rewardLabel}>Reward</span>
          {/* 2026-09-05: this led with "{chipReward} Chips" and put the diamonds
              second. A mission reward is diamonds (Dan: nothing ever earns
              chips, only diamonds), and as of migration 20260905114421 no code
              path credits a chip for one. */}
          <strong className={styles.diamondReward}>◆ {c.diamondReward.toLocaleString()}</strong>
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
          aria-label={`${c.name} Progress`}
          aria-valuemin={0}
          aria-valuemax={c.requirement}
          aria-valuenow={Math.min(challenge.progress, c.requirement)}
          aria-valuetext={`${Math.min(challenge.progress, c.requirement).toLocaleString()} Of ${c.requirement.toLocaleString()} Complete`}
        >
          <motion.div
            className={styles.progressFill}
            initial={reduceMotion ? false : { width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: reduceMotion ? 0 : 0.8, ease: 'easeOut' }}
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
            <div className={styles.claimedBadge} aria-label="Already Claimed">
              {'\u2713'} Claimed
            </div>
          )}
          {done && !claimed && (
            <button
              type="button"
              className={styles.claimButton}
              onClick={handleClaim}
              disabled={claiming}
              aria-label={`Claim Reward For ${c.name}`}
            >
              {claiming ? 'Claiming...' : 'Claim Reward'}
            </button>
          )}
          {!done && !confirmingReroll && (
            <>
              <button
                type="button"
                className={styles.missionActionButton}
                onClick={() => onOpenMission(c.type)}
                aria-label={`${missionAction.label} To Advance ${c.name}`}
              >
                {missionAction.label}
              </button>
              <button
                ref={rerollButtonRef}
                type="button"
                className={styles.rerollButton}
                onClick={() => onRequestReroll(challenge)}
                disabled={rerolling}
                aria-label={`Reroll ${c.name} For 10 Diamonds`}
              >
                Reroll <span>◆ 10</span>
              </button>
            </>
          )}
          {!done && confirmingReroll && (
            <div
              className={styles.rerollConfirm}
              role="group"
              aria-label={`Confirm Reroll For ${c.name}`}
              aria-live="polite"
              onKeyDown={(event) => {
                if (event.key === 'Escape') onCancelReroll();
              }}
            >
              <span>Spend ◆ 10? Current Progress Will Be Replaced.</span>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={onCancelReroll}
                disabled={rerolling}
                autoFocus
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
      <div className={styles.page} aria-busy="true" aria-label="Loading Daily Missions">
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
      </div>
    </StandardContentLayout>
  );
}

/** Countdown leaf: its 1 Hz clock never enters DailyChallengesPage state. */
function MissionCycleCountdown({ tier }: { tier: Tier }) {
  const now = useChallengeClockNow();
  return <>{formatChallengeCountdown(msUntilChallengeReset(tier, now))}</>;
}

/** The only reset panel subtree that re-renders as the wall clock advances. */
function MissionResetReadout({
  tier,
  isRefreshing,
  activeUnclaimed,
}: {
  tier: Tier;
  isRefreshing: boolean;
  activeUnclaimed: number;
}) {
  const now = useChallengeClockNow();
  const resetMs = msUntilChallengeReset(tier, now);
  const urgent = resetMs <= 60 * 60 * 1000;
  const resetLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(getChallengeResetAt(tier, now)),
    [tier, now]
  );

  return (
    <div className={`${styles.resetReadout} ${urgent ? styles.resetUrgent : ''}`}>
      <span>{isRefreshing ? 'Syncing Mission Network' : `${TIER_LABELS[tier]} Reset`}</span>
      <strong>{formatChallengeCountdown(resetMs)}</strong>
      <small>{resetLabel}</small>
      {urgent && activeUnclaimed > 0 && (
        <em>
          Claim {activeUnclaimed} Ready Reward{activeUnclaimed === 1 ? '' : 's'} Before Reset
        </em>
      )}
    </div>
  );
}

function MissionAlertsPanel({ userId }: { userId: string }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(false);
  const [deviceConnected, setDeviceConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getDailyMissionAlertPreference(userId), hasLocalSubscription()])
      .then(([preference, subscribed]) => {
        if (cancelled) return;
        setEnabled(preference.enabled);
        setDeviceConnected(subscribed);
        setError(null);
      })
      .catch((err) => {
        reportError(err, 'DailyChallengesPage.alert_preference_load_failed');
        if (!cancelled) setError('Mission Alert Status Is Temporarily Unavailable.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  /** Keep this directly on the click path so iOS preserves the permission gesture. */
  const enableAlerts = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const startedAt = performance.now();
    const pushResultPromise = enablePush();
    try {
      const pushResult = await pushResultPromise;
      if (!pushResult.ok) throw new Error(pushResult.error || 'Push enrollment failed');
      const preference = await setDailyMissionAlertPreference(userId, true);
      setEnabled(preference.enabled);
      setDeviceConnected(true);
      toast.success('Daily Mission reset alerts are on for this device');
      capture('daily_mission_alerts_changed', { enabled: true, surface: 'daily_missions' });
      recordDailyMissionOperation({
        userId,
        event: 'alerts_enabled',
        durationMs: performance.now() - startedAt,
      });
    } catch (err) {
      reportError(err, 'DailyChallengesPage.alert_enable_failed');
      const message = err instanceof Error ? err.message : 'Mission alerts could not be enabled.';
      setError(message);
      toast.error(message);
      recordDailyMissionOperation({
        userId,
        event: 'alerts_failed',
        durationMs: performance.now() - startedAt,
        reasonCode: dailyMissionReasonCode(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const disableAlerts = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const startedAt = performance.now();
    try {
      const preference = await setDailyMissionAlertPreference(userId, false);
      setEnabled(preference.enabled);
      toast.success('Daily Mission reset alerts are off');
      capture('daily_mission_alerts_changed', { enabled: false, surface: 'daily_missions' });
      recordDailyMissionOperation({
        userId,
        event: 'alerts_disabled',
        durationMs: performance.now() - startedAt,
      });
    } catch (err) {
      reportError(err, 'DailyChallengesPage.alert_disable_failed');
      setError('Mission alerts could not be turned off. Please try again.');
      toast.error('Mission alerts could not be turned off');
      recordDailyMissionOperation({
        userId,
        event: 'alerts_failed',
        durationMs: performance.now() - startedAt,
        reasonCode: dailyMissionReasonCode(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const permission = notificationPermission();
  const unsupportedIos = !isWebPushSupported() && isIos() && !isIosStandalonePwa();
  const deviceNeedsConnection = enabled && !deviceConnected;
  const enrollmentBlocked = permission === 'denied' || unsupportedIos;
  const status = loading
    ? 'Checking Alert Link'
    : enabled && deviceConnected
      ? 'On For This Device'
      : enabled
        ? 'Preference On, Device Disconnected'
        : permission === 'denied'
          ? 'Blocked In Browser Settings'
          : unsupportedIos
            ? 'Install App To Enable'
            : 'Off Until You Opt In';

  return (
    <aside className={styles.alertConsole} aria-labelledby="mission-alerts-title">
      <div className={styles.alertIcon} aria-hidden="true">
        {'\u25C7'}
      </div>
      <div className={styles.alertCopy}>
        <span className={styles.panelLabel}>Optional Mission Signal</span>
        <h2 id="mission-alerts-title">Daily Reset Alerts</h2>
        <p>
          Get One Alert When A Fresh Daily Mission Set Opens. This Is Off By Default And Does Not
          Change Seat, Message, Tournament, Or Club Alerts.
        </p>
        {unsupportedIos && (
          <small>
            Add Smarter Poker To Your Home Screen, Then Open The Installed App To Enable.
          </small>
        )}
        {permission === 'denied' && (
          <small>
            Allow Notifications For Smarter Poker In Your Browser Settings, Then Reload.
          </small>
        )}
        {error && (
          <small className={styles.alertError} role="alert">
            {error}
          </small>
        )}
      </div>
      <div className={styles.alertControls}>
        <span className={enabled && deviceConnected ? styles.alertStatusOn : styles.alertStatus}>
          {status}
        </span>
        <button
          type="button"
          className={styles.alertButton}
          onClick={enabled && deviceConnected ? disableAlerts : enableAlerts}
          disabled={loading || busy || (enrollmentBlocked && (!enabled || deviceNeedsConnection))}
          aria-pressed={enabled}
        >
          {busy
            ? 'Updating...'
            : enabled && deviceConnected
              ? 'Turn Off Mission Alerts'
              : deviceNeedsConnection
                ? 'Reconnect This Device'
                : 'Turn On Mission Alerts'}
        </button>
        {deviceNeedsConnection && (
          <button
            type="button"
            className={styles.alertSecondaryButton}
            onClick={disableAlerts}
            disabled={loading || busy}
          >
            Turn Off Without Reconnecting
          </button>
        )}
      </div>
    </aside>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function dailyMissionRevisionFromPayload(payload: unknown): number | null {
  const records: unknown[] = [payload];
  if (payload && typeof payload === 'object') {
    const envelope = payload as Record<string, unknown>;
    records.push(envelope.payload, envelope.data);
    if (envelope.payload && typeof envelope.payload === 'object') {
      records.push((envelope.payload as Record<string, unknown>).data);
    }
  }

  for (const candidate of records) {
    if (!candidate || typeof candidate !== 'object') continue;
    const revision = Number((candidate as Record<string, unknown>).revision);
    if (Number.isFinite(revision) && revision > 0) return revision;
  }
  return null;
}

export default function DailyChallengesPage() {
  const navigate = useNavigate();
  const isMountedRef = useIsMounted();
  const toast = useToast();
  const reduceMotion = useReducedMotion();

  const [userId, setUserId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [realtimeState, setRealtimeState] = useState<'connecting' | 'live' | 'degraded'>(
    'connecting'
  );
  const [activeTier, setActiveTier] = useState<Tier>('daily');

  const [challenges, setChallenges] = useState<TieredChallenge[]>([]);
  const [stats, setStats] = useState<DailyChallengeStats | null>(null);
  const [streak, setStreak] = useState<ChallengeStreak | null>(null);
  const [diamondBalance, setDiamondBalance] = useState(0);
  const [rewardVault, setRewardVault] = useState<DailyChallengeRewardVault>({
    count: 0,
    diamonds: 0,
    items: [],
    pageSize: 100,
    hasMore: false,
  });

  // Claiming state
  const [claimingIds, setClaimingIds] = useState<Set<string>>(new Set());
  const [claimingAll, setClaimingAll] = useState(false);
  const [rerollingIds, setRerollingIds] = useState<Set<string>>(new Set());
  const [confirmingRerollId, setConfirmingRerollId] = useState<string | null>(null);
  const claimGuardRef = useRef(new Set<string>()); // Prevent double-clicks bypassing React state
  const claimAllGuardRef = useRef(false);
  const rerollGuardRef = useRef(new Set<string>());
  const buyFreezeGuardRef = useRef(false);

  // Celebration state
  const [celebratingIds, setCelebratingIds] = useState<Set<string>>(new Set());
  /* No `chips` field: a mission reward is diamonds, and since migration
     20260905114421 the RPC returns a literal 0 for every chip figure. A field
     that can only ever be zero is an invitation to render "+0 Chips". */
  const [reward, setReward] = useState<{
    name: string;
    diamonds: number;
    diamondBalance: number;
    returnFocusId: string;
  } | null>(null);
  const celebrateDialogRef = useFocusTrap(!!reward);

  const dateKeyRef = useRef<string>('');
  const loadRequestRef = useRef(0);
  const lastSyncedAtRef = useRef(0);
  const lastResumeRefreshRef = useRef(0);
  const initialLoadSettledRef = useRef(false);
  const dashboardRevisionRef = useRef(0);
  const realtimeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const realtimeStatusRef = useRef<'connecting' | 'live' | 'degraded'>('connecting');

  // ── Loaders ──
  const loadChallenges = useCallback(
    async (uid: string, mode: 'initial' | 'refresh' | 'silent') => {
      const startedAt = performance.now();
      const requestId = ++loadRequestRef.current;
      if (mode === 'initial') {
        setIsLoading(true);
      } else if (mode === 'refresh') {
        setIsRefreshing(true);
      }

      try {
        const dashboard = await dailyChallengeService.getDashboard(uid);
        if (!isMountedRef.current || requestId !== loadRequestRef.current) return;

        setChallenges(dashboard.missions);
        setStats(dashboard.stats);
        setStreak(dashboard.streak);
        setDiamondBalance(dashboard.diamondBalance);
        setRewardVault(dashboard.vault);
        dashboardRevisionRef.current = dashboard.revision;
        setLoadError(null);
        const receiptTime = Date.parse(dashboard.syncedAt);
        const syncedAt = Number.isFinite(receiptTime) ? receiptTime : Date.now();
        lastSyncedAtRef.current = syncedAt;
        setLastSyncedAt(syncedAt);
        recordDailyMissionOperation({
          userId: uid,
          event: 'dashboard_loaded',
          durationMs: performance.now() - startedAt,
          itemCount: dashboard.missions.length,
        });
        if (mode === 'initial') {
          capture('daily_missions_viewed', {
            mission_count: dashboard.missions.length,
            reward_vault_count: dashboard.vault.count,
            load_duration_ms: Math.round(performance.now() - startedAt),
          });
        }
      } catch (err: any) {
        reportError(err, 'DailyChallengesPage.load_failed');
        recordDailyMissionOperation({
          userId: uid,
          event: 'dashboard_failed',
          durationMs: performance.now() - startedAt,
          reasonCode: dailyMissionReasonCode(err),
        });
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
        await loadChallenges(authUser.id, 'initial');
        if (!cancelled) initialLoadSettledRef.current = true;
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

  const dismissReward = useCallback(() => {
    const returnFocusId = reward?.returnFocusId;
    setReward(null);
    if (returnFocusId) {
      requestAnimationFrame(() => document.getElementById(returnFocusId)?.focus());
    }
  }, [reward]);

  // ── Reward Overlay keyboard dismissal ──
  useEffect(() => {
    if (!reward) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissReward();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [reward, dismissReward]);

  // Schedule the one stateful event the clock owns: UTC rollover. Countdown
  // text itself lives in isolated leaves above and cannot re-render this page.
  useEffect(() => {
    if (!userId) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    const scheduleRollover = () => {
      const delay = Math.max(250, msUntilChallengeReset('daily') + 250);
      timer = setTimeout(() => {
        dateKeyRef.current = getUtcDateKey();
        loadChallenges(userId, 'silent');
        scheduleRollover();
      }, delay);
    };
    scheduleRollover();
    return () => clearTimeout(timer);
  }, [userId, loadChallenges]);

  // Browsers throttle timers and live sockets in background tabs. Reconcile on
  // resume so a table left open overnight never shows yesterday's contracts.
  useEffect(() => {
    if (!userId) return undefined;

    const refreshAfterResume = () => {
      if (document.visibilityState !== 'visible') return;
      // setUserId installs this listener before the first dashboard receipt
      // settles. A focus event in that window used to see syncedAt=0 and start
      // a duplicate cold-load request.
      if (!initialLoadSettledRef.current) return;
      const resumedAt = Date.now();
      if (resumedAt - lastResumeRefreshRef.current < 1000) return;

      const dateChanged = getUtcDateKey(resumedAt) !== dateKeyRef.current;
      const stale = resumedAt - lastSyncedAtRef.current > 60_000;
      if (dateChanged || stale) {
        lastResumeRefreshRef.current = resumedAt;
        dateKeyRef.current = getUtcDateKey(resumedAt);
        loadChallenges(userId, 'silent');
      }
    };

    document.addEventListener('visibilitychange', refreshAfterResume);
    window.addEventListener('focus', refreshAfterResume);
    return () => {
      document.removeEventListener('visibilitychange', refreshAfterResume);
      window.removeEventListener('focus', refreshAfterResume);
    };
  }, [userId, loadChallenges]);

  const scheduleRealtimeRefresh = useCallback(
    (payload?: unknown) => {
      if (!userId) return;
      const announcedRevision = dailyMissionRevisionFromPayload(payload);

      // The dashboard RPC can assign a brand-new account's first missions. Those
      // inserts broadcast their revision before the same atomic RPC receipt
      // reaches the browser. Scheduling another full dashboard read here made a
      // cold open perform two identical RPCs. Keep the event for the debounce,
      // then compare it with the revision actually rendered by the first receipt:
      // the matching echo is already covered; a genuinely newer mutation still
      // refreshes immediately.
      if (announcedRevision === null && !initialLoadSettledRef.current) return;
      if (announcedRevision !== null && announcedRevision <= dashboardRevisionRef.current) return;
      if (realtimeRefreshTimerRef.current) clearTimeout(realtimeRefreshTimerRef.current);
      realtimeRefreshTimerRef.current = setTimeout(() => {
        realtimeRefreshTimerRef.current = null;
        if (announcedRevision !== null && announcedRevision <= dashboardRevisionRef.current) return;
        loadChallenges(userId, 'silent');
      }, 250);
    },
    [userId, loadChallenges]
  );

  // Realtime is the immediate path, while this tiny cursor read is the durable
  // repair path for a WebSocket event that was lost after subscription. It
  // never polls the full dashboard and only schedules a receipt when the
  // server cursor is newer than the one rendered on screen.
  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const reconcileRevision = async () => {
      try {
        if (document.visibilityState === 'visible' && initialLoadSettledRef.current) {
          const revision = await dailyChallengeService.getDashboardRevision(userId);
          if (!cancelled && revision > dashboardRevisionRef.current) {
            scheduleRealtimeRefresh();
          }
        }
      } catch {
        // The Realtime channel remains the primary path. The service records
        // the cursor error, and the next visible-tab pass retries naturally.
      } finally {
        if (!cancelled) timer = setTimeout(reconcileRevision, 15_000);
      }
    };

    timer = setTimeout(reconcileRevision, 15_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [userId, scheduleRealtimeRefresh]);

  useEffect(
    () => () => {
      if (realtimeRefreshTimerRef.current) clearTimeout(realtimeRefreshTimerRef.current);
    },
    []
  );

  useMasterBusBroadcastChannel({
    channelName: userId ? `daily-mission-revision:${userId}` : null,
    event: 'daily_mission_revision_changed',
    enabled: !!userId,
    private: true,
    onPayload: scheduleRealtimeRefresh,
    onSubscriptionError: () => {
      realtimeStatusRef.current = 'degraded';
      setRealtimeState('degraded');
      recordDailyMissionOperation({ userId, event: 'realtime_degraded' });
      // Reconcile immediately while the channel factory reconnects. The
      // visible-tab cursor watchdog below remains the bounded missed-frame
      // fallback when a joined channel never reports an error.
      scheduleRealtimeRefresh();
    },
    onSubscriptionStatus: (status) => {
      if (status !== 'SUBSCRIBED') return;
      const recovered = realtimeStatusRef.current === 'degraded';
      realtimeStatusRef.current = 'live';
      setRealtimeState('live');
      if (recovered) {
        recordDailyMissionOperation({ userId, event: 'realtime_recovered' });
        scheduleRealtimeRefresh();
      }
    },
  });

  // ── Claim handler ──
  const handleClaim = useCallback(
    async (challenge: TieredChallenge) => {
      if (!userId) return;
      if (claimGuardRef.current.has(challenge.id)) return;
      claimGuardRef.current.add(challenge.id);
      setClaimingIds((prev) => new Set(prev).add(challenge.id));
      const startedAt = performance.now();

      try {
        const paid = await dailyChallengeService.claimChallenges(userId, [challenge.id]);
        const newlyClaimed = paid.claimedIds.includes(challenge.id);
        const alreadyClaimed = paid.alreadyClaimedIds.includes(challenge.id);

        setDiamondBalance(paid.diamondBalance);
        setRewardVault(paid.vault);
        setStats((prev) => (prev ? { ...prev, ...paid.stats } : prev));

        if (alreadyClaimed && !newlyClaimed) {
          toast.info('You already claimed this one');
        } else if (newlyClaimed) {
          setReward({
            name: challenge.challenge.name,
            diamonds: paid.diamonds,
            diamondBalance: paid.diamondBalance,
            returnFocusId: `mission-card-${challenge.id}`,
          });
        } else {
          throw new Error('The claim receipt did not settle this reward');
        }

        setChallenges((prev) =>
          prev.map((c) => (c.id === challenge.id ? { ...c, claimed: true } : c))
        );
        if (newlyClaimed) {
          capture('daily_mission_claimed', {
            tier: challenge.tier,
            diamond_reward: paid.diamonds,
            claim_count: 1,
          });
          recordDailyMissionOperation({
            userId,
            event: 'claim_succeeded',
            tier: challenge.tier,
            durationMs: performance.now() - startedAt,
            itemCount: 1,
          });
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
            rewardType: 'diamonds',
            rewardAmount: paid.diamonds,
          });
        }
      } catch (err: any) {
        reportError(err, 'DailyChallengesPage.claim_failed');
        recordDailyMissionOperation({
          userId,
          event: 'claim_failed',
          tier: challenge.tier,
          durationMs: performance.now() - startedAt,
          itemCount: 1,
          reasonCode: dailyMissionReasonCode(err),
        });
        if (isMountedRef.current) toast.error(err?.message || 'Failed to claim reward');
        loadChallenges(userId, 'silent');
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
    [userId, loadChallenges, toast, isMountedRef]
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

    const startedAt = performance.now();
    try {
      const res = await dailyChallengeService.buyStreakFreeze(userId);
      if (res.success) {
        capture('daily_mission_freeze_purchased', {
          replayed: res.alreadyPurchased,
          diamond_cost: 5000,
        });
        recordDailyMissionOperation({
          userId,
          event: 'freeze_succeeded',
          durationMs: performance.now() - startedAt,
        });
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
        recordDailyMissionOperation({
          userId,
          event: 'freeze_failed',
          durationMs: performance.now() - startedAt,
          reasonCode: 'rejected',
        });
        toast.error(res.error || 'Failed to buy freeze');
        // Revert UI on fail
        loadChallenges(userId, 'silent');
      }
    } catch (err) {
      reportError(err, 'DailyChallengesPage.freeze_failed');
      recordDailyMissionOperation({
        userId,
        event: 'freeze_failed',
        durationMs: performance.now() - startedAt,
        reasonCode: dailyMissionReasonCode(err),
      });
      toast.error('Failed to buy freeze');
      loadChallenges(userId, 'silent');
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
      const startedAt = performance.now();
      try {
        const result = await dailyChallengeService.rerollChallenge(
          userId,
          challenge.id,
          challenge.challengeId
        );
        if (!result.success) {
          recordDailyMissionOperation({
            userId,
            event: 'reroll_failed',
            tier: challenge.tier,
            durationMs: performance.now() - startedAt,
            reasonCode: 'rejected',
          });
          toast.error(result.error || 'Challenge reroll failed');
          return;
        }
        if (result.diamondBalance != null) setDiamondBalance(result.diamondBalance);
        if (!result.challenge) {
          toast.error('The replacement mission receipt was incomplete. Refreshing...');
          loadChallenges(userId, 'silent');
          return;
        }
        setChallenges((prev) =>
          prev.map((item) => (item.id === challenge.id ? result.challenge! : item))
        );
        setConfirmingRerollId(null);
        capture('daily_mission_rerolled', {
          tier: challenge.tier,
          replayed: result.alreadyRerolled,
          diamond_cost: 10,
        });
        recordDailyMissionOperation({
          userId,
          event: 'reroll_succeeded',
          tier: challenge.tier,
          durationMs: performance.now() - startedAt,
          itemCount: 1,
        });
        toast.success(
          result.alreadyRerolled ? 'Challenge already replaced.' : 'New mission online.'
        );
      } catch (err) {
        reportError(err, 'DailyChallengesPage.reroll_failed');
        recordDailyMissionOperation({
          userId,
          event: 'reroll_failed',
          tier: challenge.tier,
          durationMs: performance.now() - startedAt,
          itemCount: 1,
          reasonCode: dailyMissionReasonCode(err),
        });
        if (isMountedRef.current) toast.error('Challenge reroll failed. Nothing was deducted.');
        loadChallenges(userId, 'silent');
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
    if (!userId || claimAllGuardRef.current) return;
    claimAllGuardRef.current = true;

    setClaimingAll(true);
    const startedAt = performance.now();
    let ready: TieredChallenge[] = [];
    let readyIds: string[] = [];

    try {
      // Reconcile with the authoritative vault at the instant of settlement.
      // Realtime and the revision watchdog deliberately coalesce bursts, so
      // the rendered vault can briefly contain only the first completed row.
      // Claim All must never turn that transient view into a partial payout.
      const dashboard = await dailyChallengeService.getDashboard(userId);
      if (!isMountedRef.current) return;

      ready = dashboard.vault.items;
      if (ready.length === 0) {
        setRewardVault(dashboard.vault);
        toast.info('Those rewards were already claimed.');
        return;
      }

      readyIds = ready.map((challenge) => challenge.id);
      readyIds.forEach((id) => claimGuardRef.current.add(id));
      setClaimingIds((prev) => new Set([...prev, ...readyIds]));

      const paid = await dailyChallengeService.claimChallenges(userId, readyIds);
      if (!isMountedRef.current) return;

      const settledIds = new Set([...paid.claimedIds, ...paid.alreadyClaimedIds]);
      setChallenges((prev) =>
        prev.map((challenge) =>
          settledIds.has(challenge.id) ? { ...challenge, claimed: true } : challenge
        )
      );
      setRewardVault(paid.vault);
      setStats((prev) => (prev ? { ...prev, ...paid.stats } : prev));
      setDiamondBalance(paid.diamondBalance);

      if (paid.claimedIds.length > 0) {
        capture('daily_mission_claimed', {
          tier: 'vault',
          diamond_reward: paid.diamonds,
          claim_count: paid.claimedIds.length,
        });
        recordDailyMissionOperation({
          userId,
          event: 'claim_all_succeeded',
          durationMs: performance.now() - startedAt,
          itemCount: paid.claimedIds.length,
        });
        const newlyClaimedIds = new Set(paid.claimedIds);
        triggerHaptic('success');
        setReward({
          name: `${paid.claimedIds.length} challenge${paid.claimedIds.length === 1 ? '' : 's'}`,
          diamonds: paid.diamonds,
          diamondBalance: paid.diamondBalance,
          returnFocusId: 'mission-board-title',
        });
        for (const challenge of ready) {
          if (!newlyClaimedIds.has(challenge.id)) continue;
          masterBus.emit('MISSION_CLAIMED', {
            missionId: challenge.id,
            tier: challenge.tier,
            rewardType: 'diamonds',
            rewardAmount: challenge.challenge.diamondReward,
          });
        }
      } else {
        toast.info('Those rewards were already claimed.');
      }
    } catch (err) {
      reportError(err, 'DailyChallengesPage.claimAll_failed');
      recordDailyMissionOperation({
        userId,
        event: 'claim_all_failed',
        durationMs: performance.now() - startedAt,
        itemCount: readyIds.length,
        reasonCode: dailyMissionReasonCode(err),
      });
      toast.error('Rewards could not be claimed. Nothing was deducted. Refreshing...');
      loadChallenges(userId, 'silent');
    } finally {
      readyIds.forEach((id) => claimGuardRef.current.delete(id));
      claimAllGuardRef.current = false;
      if (isMountedRef.current) {
        setClaimingAll(false);
        setClaimingIds((prev) => {
          const next = new Set(prev);
          readyIds.forEach((id) => next.delete(id));
          return next;
        });
      }
    }
  }, [userId, toast, loadChallenges, isMountedRef]);

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

  const unclaimed = rewardVault;

  const visible = useMemo(() => {
    const stateRank = (c: TieredChallenge) => (c.claimed ? 2 : c.completed ? 0 : 1);
    return challenges
      .filter((c) => c.tier === activeTier)
      .sort((a, b) => stateRank(a) - stateRank(b));
  }, [challenges, activeTier]);

  const activeUnclaimed = visible.filter(
    (challenge) => challenge.completed && !challenge.claimed
  ).length;
  const syncLabel =
    realtimeState === 'degraded'
      ? 'Reconnecting'
      : isRefreshing
        ? 'Synchronizing'
        : realtimeState === 'live'
          ? 'Live Now'
          : lastSyncedAt
            ? 'Connecting'
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

  const handleOpenMission = useCallback(
    (type: ChallengeType) => {
      const action = getChallengeMissionAction(type);
      capture('daily_mission_cta_clicked', { mission_type: type, destination: action.path });
      recordDailyMissionOperation({ userId, event: 'mission_cta_opened', tier: activeTier });
      navigate(action.path);
    },
    [activeTier, navigate, userId]
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
      <div
        className={styles.page}
        id="daily-missions"
        data-arena-surface="missions"
        aria-busy={isRefreshing}
        aria-hidden={reward ? true : undefined}
        inert={reward ? true : undefined}
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
              Complete Live Poker Objectives, Protect Your Streak, And Unlock Real Diamond Rewards.
            </p>
            <div className={styles.heroMeters}>
              <div>
                <span>Mission Cycle</span>
                <strong>
                  <MissionCycleCountdown tier="daily" />
                </strong>
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
          <div className={styles.heroSeal} role="status" aria-live="polite">
            <span>{syncLabel}</span>
            <strong>
              {tierCounts.daily.done}/{tierCounts.daily.total}
            </strong>
            <small>Complete Today</small>
          </div>
        </section>

        {loadError && (
          <aside className={`${styles.syncNotice} ${styles.syncNoticeError}`} role="alert">
            <div>
              <span className={styles.panelLabel}>Connection Interrupted</span>
              <strong>{loadError}</strong>
            </div>
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => userId && loadChallenges(userId, 'refresh')}
              disabled={isRefreshing}
            >
              {isRefreshing ? 'Reconnecting...' : 'Retry Sync'}
            </button>
          </aside>
        )}

        <section className={styles.commandDeck} aria-label="Challenge Status">
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
              <div
                className={styles.milestoneBar}
                role="progressbar"
                aria-label="Progress Toward The Next Streak Reward"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(stats?.milestoneProgressPercent ?? 0)}
                aria-valuetext={`${(streak?.streak ?? stats?.currentStreak ?? 0).toLocaleString()} Days, Next Reward At ${stats?.nextMilestone.toLocaleString() ?? 0}`}
              >
                <motion.div
                  className={styles.milestoneFill}
                  initial={reduceMotion ? false : { width: 0 }}
                  animate={{
                    width: `${stats?.milestoneProgressPercent ?? 0}%`,
                  }}
                  transition={{ duration: reduceMotion ? 0 : 1, ease: 'easeOut' }}
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
                <div className={styles.freezeAction}>
                  <button
                    type="button"
                    className={styles.buyFreezeBtn}
                    onClick={handleBuyFreeze}
                    disabled={buyingFreeze || diamondBalance < 5000 || streak.freezesAvailable >= 3}
                    aria-describedby="freeze-action-hint"
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
                  <small id="freeze-action-hint" className={styles.actionHint}>
                    {streak.freezesAvailable >= 3
                      ? 'Use A Banked Freeze Before Buying Another.'
                      : diamondBalance < 5000
                        ? 'Requires 5,000 Spendable Diamonds.'
                        : 'Protects One Missed Daily Cycle.'}
                  </small>
                </div>
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
              <small>Bonus Diamonds</small>
            </div>
          </div>
        </section>

        {unclaimed.count > 0 && (
          <aside className={styles.unclaimedBar} aria-label="Unclaimed Challenge Rewards">
            <div>
              <span className={styles.panelLabel}>Reward Vault Open</span>
              <strong>
                {unclaimed.count} Mission{unclaimed.count === 1 ? '' : 's'} Ready
              </strong>
              <small>
                +{'\u25C6'} {unclaimed.diamonds.toLocaleString()}
              </small>
            </div>
            <button
              type="button"
              className={styles.claimAllButton}
              onClick={handleClaimAll}
              disabled={claimingAll}
            >
              {claimingAll
                ? 'Claiming Rewards...'
                : unclaimed.hasMore
                  ? `Claim Next ${unclaimed.items.length} Of ${unclaimed.count}`
                  : `Claim All ${unclaimed.count}`}
            </button>
          </aside>
        )}

        <MissionAlertsPanel userId={userId} />

        <section className={styles.missionBoard} aria-labelledby="mission-board-title">
          <header className={styles.boardHeader}>
            <div>
              <span className={styles.eyebrow}>Active Contracts</span>
              <h2 id="mission-board-title" tabIndex={-1}>
                Choose Your Mission Cycle
              </h2>
            </div>
            <MissionResetReadout
              tier={activeTier}
              isRefreshing={isRefreshing}
              activeUnclaimed={activeUnclaimed}
            />
          </header>

          <div className={styles.tabs} role="tablist" aria-label="Challenge Period">
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
          </div>

          <section
            id={`mission-panel-${activeTier}`}
            className={styles.list}
            role="tabpanel"
            aria-labelledby={`mission-tab-${activeTier}`}
            tabIndex={0}
          >
            {visible.length === 0 ? (
              <div className={styles.emptyState}>
                <h3>{loadError ? 'Mission Link Offline' : 'No Missions Assigned'}</h3>
                <p>
                  {loadError
                    ? 'Reconnect To Retrieve Your Active Contracts. Your Recorded Progress Is Safe.'
                    : `Your Next ${TIER_LABELS[activeTier]} Mission Set Is Being Prepared.`}
                </p>
                <button
                  type="button"
                  className={styles.retryButton}
                  onClick={() => loadChallenges(userId, 'refresh')}
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
                    initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0, scale: 0.98 }}
                    transition={
                      reduceMotion
                        ? { duration: 0 }
                        : { duration: 0.22, delay: Math.min(i * 0.035, 0.14) }
                    }
                    layout={!reduceMotion}
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
                      onOpenMission={handleOpenMission}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            )}
          </section>
        </section>

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
            Browse Cash Games
          </button>
        </footer>
      </div>

      {reward &&
        createPortal(
          <div
            className={styles.celebrateOverlay}
            role="dialog"
            aria-modal="true"
            aria-labelledby="challenge-reward-title"
            aria-describedby="challenge-reward-description"
            onClick={dismissReward}
          >
            {!reduceMotion && (
              <ConfettiEffect
                isActive={true}
                intensity="heavy"
                colors={['#00f0ff', '#0ff', '#ffffff']}
                duration={4000}
              />
            )}
            <div
              ref={celebrateDialogRef}
              className={styles.celebrateCard}
              onClick={(event) => event.stopPropagation()}
            >
              <div className={styles.celebrateBurst} aria-hidden="true">
                {'\u25C6'}
              </div>
              <h2 id="challenge-reward-title" className={styles.celebrateTitle}>
                Reward Settled
              </h2>
              <p id="challenge-reward-description" className={styles.celebrateName}>
                {reward.name}
              </p>

              <div className={styles.celebratePayouts} aria-label="Rewards Earned">
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

              <p className={styles.celebrateReceipt} role="status">
                Deposited Securely To Your Club Arena Balances
              </p>

              <button className={styles.celebrateButton} onClick={dismissReward}>
                Continue
              </button>
            </div>
          </div>,
          document.body
        )}
    </StandardContentLayout>
  );
}
