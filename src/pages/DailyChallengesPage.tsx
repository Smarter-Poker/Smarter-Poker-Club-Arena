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
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { getAuthUser } from '../lib/supabase';
import { useToast } from '../components/common/Toast';
import {
  CasinoControlIcon,
  MissionInstrumentGlyph,
  type CasinoControlIconVariant,
} from '../components/challenges';
import { motion, useReducedMotion } from 'framer-motion';
import { masterBus } from '../core/MasterBus';
import { triggerHaptic } from '../services/HapticService';
import {
  DAILY_MISSION_REROLL_COST,
  dailyChallengeService,
  type TieredUserChallenge,
  type Tier,
  type ChallengeType,
  type ChallengeStreak,
  type DailyChallengeDashboard,
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
import { prefetchIntent } from '../utils/ChunkPreloader';
import {
  dailyMissionRevisionFromPayload,
  isCurrentDailyMissionDashboardReceipt,
  shouldRefreshQueuedDailyMissionRealtime,
} from '../utils/dailyMissionReceipt';
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
import { signInUrl } from '../lib/signIn';
import { useClubWorkspace } from '../contexts/ClubWorkspaceContext';
import { withClubContext } from '../utils/clubScopedPath';

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

const TIER_LABELS: Record<Tier, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

const TIER_COLORS: Record<Tier, string> = {
  daily: 'var(--realism-cyan, #55e8ff)',
  weekly: 'var(--realism-chrome, #b8c4c9)',
  monthly: 'var(--realism-gold, #ffc93c)',
};

const TIER_CONTROL_ICONS: Record<Tier, CasinoControlIconVariant> = {
  daily: 'cycle-daily',
  weekly: 'cycle-weekly',
  monthly: 'cycle-monthly',
};

const TIER_PRESENTATION: Record<Tier, { title: string; eyebrow: string; description: string }> = {
  daily: {
    title: 'Daily Challenges',
    eyebrow: 'Club Arena / Daily Challenge Vault',
    description:
      'Complete Live Poker Objectives, Protect Your Streak, And Collect Real Diamond Rewards At The Club Arena Rewards Desk.',
  },
  weekly: {
    title: 'Weekly Challenges',
    eyebrow: 'Club Arena / Weekly Challenge Circuit',
    description:
      'Build Momentum Across The Weekly Poker Circuit, Complete Larger Objectives, And Settle Premium Diamond Rewards.',
  },
  monthly: {
    title: 'Monthly Challenges',
    eyebrow: 'Club Arena / Monthly High-Roller Ledger',
    description:
      "Chase Long-Form Poker Milestones, Track Your Monthly Run, And Secure The Vault's Largest Diamond Rewards.",
  },
};

const TIERS: Tier[] = ['daily', 'weekly', 'monthly'];

const MISSION_HERO_DESKTOP = 'images/challenges/daily-missions-casino-v2.webp';
const MISSION_HERO_MOBILE = 'images/challenges/daily-missions-casino-v2-mobile.webp';
const MISSION_REWARD_ARTWORK = 'images/challenges/daily-missions-reward-pedestal-v1.webp';
const MISSION_FREEZE_ARTWORK = 'images/challenges/daily-missions-streak-freeze-v1.webp';
const MISSION_DIAMOND_ARTWORK = 'images/challenges/daily-missions-diamond-96-v1.webp';
const MISSION_RESET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});
const MISSION_SYNC_FORMATTER = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});
const MISSION_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

/** Restore keyboard focus after a state update removes the activated control. */
function focusAfterMissionUpdate(targetId: string): void {
  requestAnimationFrame(() => document.getElementById(targetId)?.focus());
}

function MissionHeroArtwork({ tier }: { tier: Tier }) {
  return (
    <div className={styles.heroPicture} data-hero-cycle={tier} aria-hidden="true">
      <picture>
        <source media="(max-width: 680px)" srcSet={mediaUrl(MISSION_HERO_MOBILE)} />
        <img
          className={styles.heroArtwork}
          src={mediaUrl(MISSION_HERO_DESKTOP)}
          alt=""
          width="1717"
          height="916"
          loading="eager"
          decoding="async"
          fetchPriority="high"
        />
      </picture>
      <span className={styles.heroCycleAtmosphere} />
      <span className={styles.heroCycleInstrument} data-cycle-instrument={tier}>
        <CasinoControlIcon variant={TIER_CONTROL_ICONS[tier]} state="active" size="lg" />
      </span>
    </div>
  );
}

function DiamondMark({ className = '' }: { className?: string }) {
  return (
    <img
      className={`${styles.inlineDiamond} ${className}`}
      src={mediaUrl(MISSION_DIAMOND_ARTWORK)}
      alt=""
      width="96"
      height="96"
      loading="lazy"
      decoding="async"
      aria-hidden="true"
    />
  );
}

function FreezeVaultGraphic() {
  return (
    <div className={styles.freezeVaultGraphic} aria-hidden="true">
      <span className={styles.freezeVaultHalo} />
      <img
        className={styles.freezeVaultArtwork}
        src={mediaUrl(MISSION_FREEZE_ARTWORK)}
        alt=""
        width="720"
        height="720"
        loading="eager"
        decoding="async"
      />
      <span className={styles.freezeVaultScan} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CARDS
// ═══════════════════════════════════════════════════════════════════════════════

function ChallengeCard({
  challenge,
  tier,
  claiming,
  rerolling,
  economyBusy,
  canAffordReroll,
  confirmingReroll,
  rerollConfirmationOpen,
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
  economyBusy: boolean;
  canAffordReroll: boolean;
  confirmingReroll: boolean;
  rerollConfirmationOpen: boolean;
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
  const rerollFocusRestorePendingRef = useRef(false);
  const c = challenge.challenge;
  const pct = c.requirement > 0 ? Math.min((challenge.progress / c.requirement) * 100, 100) : 0;
  const done = challenge.completed;
  const claimed = challenge.claimed;
  const remaining = Math.max(0, c.requirement - challenge.progress);
  const missionAction = getChallengeMissionAction(c.type);

  useEffect(() => {
    if (wasConfirmingRerollRef.current && !confirmingReroll) {
      // A different card can become the active confirmation in the same
      // render. In that case its auto-focused cancel action owns focus; the
      // card that just closed must not queue a restoration over it.
      rerollFocusRestorePendingRef.current = !rerollConfirmationOpen;
    }
    if (
      rerollFocusRestorePendingRef.current &&
      !confirmingReroll &&
      !rerollConfirmationOpen &&
      !economyBusy
    ) {
      rerollFocusRestorePendingRef.current = false;
      const frame = requestAnimationFrame(() => {
        const rerollButton = rerollButtonRef.current;
        if (rerollButton && !rerollButton.disabled) {
          rerollButton.focus();
          return;
        }
        document.getElementById(`mission-card-${challenge.id}`)?.focus();
      });
      wasConfirmingRerollRef.current = confirmingReroll;
      return () => cancelAnimationFrame(frame);
    }
    wasConfirmingRerollRef.current = confirmingReroll;
    return undefined;
  }, [challenge.id, confirmingReroll, economyBusy, rerollConfirmationOpen]);

  const handleClaim = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (done && !claimed && !claiming) onClaim(challenge);
  };

  return (
    <article
      id={`mission-card-${challenge.id}`}
      tabIndex={-1}
      data-mission-tier={tier}
      data-mission-state={claimed ? 'claimed' : done ? 'complete' : 'active'}
      aria-busy={claiming || rerolling}
      className={`
        ${styles.challengeCard}
        ${done ? styles.cardCompleted : ''}
        ${claimed ? styles.cardClaimed : ''}
        ${celebrating ? styles.cardCelebrating : ''}
      `}
      style={
        {
          '--card-tier-color': TIER_COLORS[tier],
          '--mission-progress': `${pct}%`,
        } as React.CSSProperties
      }
    >
      <span className={styles.bevelFrame} aria-hidden="true" />
      <div className={styles.cardTopline} data-mission-topline="">
        <span>{TIER_LABELS[tier]} Challenge</span>
        <span className={styles.cardState}>
          {claimed ? 'Reward Collected' : done ? 'Ready To Claim' : 'In Progress'}
        </span>
      </div>

      <div className={styles.cardHeader}>
        <div
          className={styles.iconAssembly}
          data-mission-icon={c.type}
          data-icon-state={claimed ? 'claimed' : done ? 'complete' : 'active'}
          aria-hidden="true"
        >
          <span className={styles.iconOrbit} />
          <span className={styles.iconBox}>
            <MissionInstrumentGlyph
              type={c.type}
              state={claimed ? 'claimed' : done ? 'complete' : 'active'}
              progress={pct}
              size="lg"
            />
          </span>
          <span className={styles.iconPulse} />
          <span className={styles.iconScanner} />
        </div>
        <div className={styles.cardTitles}>
          <h3 className={styles.cardName}>{c.name}</h3>
          <p className={styles.cardDesc}>{c.description}</p>
        </div>
        <div className={styles.rewardReadout} role="group" aria-label="Challenge Reward">
          <img
            className={styles.rewardGem}
            src={mediaUrl(MISSION_DIAMOND_ARTWORK)}
            alt=""
            width="96"
            height="96"
            loading="lazy"
            decoding="async"
            aria-hidden="true"
          />
          <div>
            <span className={styles.rewardLabel}>Reward</span>
            {/* 2026-09-05: this led with "{chipReward} Chips" and put the diamonds
              second. A mission reward is diamonds (Dan: nothing ever earns
              chips, only diamonds), and as of migration 20260905114421 no code
              path credits a chip for one. */}
            <strong className={styles.diamondReward}>
              {c.diamondReward.toLocaleString()} Diamonds
            </strong>
          </div>
        </div>
      </div>

      <div className={styles.progressBlock}>
        <div className={styles.progressLabels}>
          <span>Challenge Progress</span>
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
            ? 'Reward Collected'
            : done
              ? 'Objective Cleared'
              : `${remaining.toLocaleString()} Remaining`}
        </span>
        <div className={styles.cardActions}>
          {claimed && (
            <div className={styles.claimedBadge}>
              <CasinoControlIcon variant="claim" state="success" size="sm" />
              Already Claimed
            </div>
          )}
          {done && !claimed && (
            <button
              type="button"
              className={styles.claimButton}
              onClick={handleClaim}
              disabled={claiming || economyBusy}
              aria-label={`Claim Reward For ${c.name}`}
            >
              <CasinoControlIcon
                variant="claim"
                state={claiming ? 'pending' : economyBusy ? 'disabled' : 'active'}
                size="sm"
              />
              {claiming ? 'Claiming...' : 'Claim Reward'}
            </button>
          )}
          {!done && !confirmingReroll && (
            <>
              <button
                {...prefetchIntent(missionAction.path)}
                type="button"
                className={styles.missionActionButton}
                onClick={() => onOpenMission(c.type)}
                aria-label={`${missionAction.label} To Advance ${c.name}`}
              >
                <CasinoControlIcon variant="play" state="active" size="sm" />
                {missionAction.label}
              </button>
              <button
                ref={rerollButtonRef}
                type="button"
                className={styles.rerollButton}
                onClick={() => onRequestReroll(challenge)}
                disabled={rerolling || economyBusy || rerollConfirmationOpen || !canAffordReroll}
                aria-label={
                  canAffordReroll
                    ? `Reroll ${DAILY_MISSION_REROLL_COST} Diamond For ${c.name}`
                    : `Need ${DAILY_MISSION_REROLL_COST} Diamond To Reroll ${c.name}`
                }
              >
                <CasinoControlIcon
                  variant="reroll"
                  state={
                    rerolling
                      ? 'pending'
                      : economyBusy || rerollConfirmationOpen || !canAffordReroll
                        ? 'disabled'
                        : 'idle'
                  }
                  size="sm"
                />
                {canAffordReroll ? 'Reroll ' : 'Need '}
                <span className={styles.buttonPrice}>
                  <DiamondMark /> {DAILY_MISSION_REROLL_COST}
                  {!canAffordReroll && ' Diamond'}
                </span>
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
              <span className={styles.rerollPrompt}>
                Spend <DiamondMark /> {DAILY_MISSION_REROLL_COST} Diamond? Current Progress Will Be
                Replaced.
              </span>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={onCancelReroll}
                disabled={rerolling || economyBusy}
                autoFocus
              >
                <CasinoControlIcon
                  variant="keep"
                  state={rerolling || economyBusy ? 'disabled' : 'idle'}
                  size="sm"
                />
                Keep It
              </button>
              <button
                type="button"
                className={styles.confirmButton}
                onClick={() => onConfirmReroll(challenge)}
                disabled={rerolling || economyBusy || !canAffordReroll}
              >
                <CasinoControlIcon
                  variant="confirm"
                  state={
                    rerolling
                      ? 'pending'
                      : economyBusy || !canAffordReroll
                        ? 'disabled'
                        : 'attention'
                  }
                  size="sm"
                />
                {rerolling
                  ? 'Replacing...'
                  : canAffordReroll
                    ? 'Replace'
                    : `Need ${DAILY_MISSION_REROLL_COST} Diamond`}
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function MissionLoadingState({ tier }: { tier: Tier }) {
  const presentation = TIER_PRESENTATION[tier];
  return (
    <StandardContentLayout className={styles.container}>
      <div
        className={styles.page}
        data-mission-cycle={tier}
        role="region"
        aria-busy="true"
        aria-label={`Loading ${presentation.title}`}
      >
        <section className={`${styles.hero} ${styles.loadingHero}`}>
          <span className={styles.bevelFrame} aria-hidden="true" />
          <MissionHeroArtwork tier={tier} />
          <div className={styles.heroShade} />
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>{presentation.eyebrow}</span>
            <h1>{presentation.title}</h1>
            <p>Preparing Your Challenge Ledger, Streak, And Diamond Reward Vault.</p>
            <div className={styles.loadingSignal} role="status">
              <span className={styles.loadingSignalBar} />
              <strong>Preparing Challenge Ledger</strong>
            </div>
          </div>
        </section>
        <section className={styles.loadingBoard} aria-hidden="true">
          <span className={styles.bevelFrame} />
          <div className={styles.loadingBoardHeader} />
          <div className={styles.loadingCardGrid}>
            {Array.from({ length: tier === 'daily' ? 5 : tier === 'weekly' ? 3 : 2 }).map(
              (_, index) => (
                <div key={index} className={styles.loadingCard} data-loading-mission-card="">
                  <span className={styles.bevelFrame} />
                  <span className={styles.loadingCardInstrument}>
                    <CasinoControlIcon variant="sync" state="pending" size="lg" />
                  </span>
                  <span className={styles.loadingCardTitle} />
                  <span className={styles.loadingCardCopy} />
                  <span className={styles.loadingCardProgress} />
                  <span className={styles.loadingCardAction} />
                </div>
              )
            )}
          </div>
        </section>
      </div>
    </StandardContentLayout>
  );
}

function MissionUnavailableState({
  tier,
  message,
  onRetry,
}: {
  tier: Tier;
  message: string;
  onRetry: () => void;
}) {
  const presentation = TIER_PRESENTATION[tier];
  return (
    <StandardContentLayout className={styles.container}>
      <div className={styles.page} data-mission-cycle={tier}>
        <section className={`${styles.hero} ${styles.unavailableHero}`}>
          <span className={styles.bevelFrame} aria-hidden="true" />
          <MissionHeroArtwork tier={tier} />
          <div className={styles.heroShade} />
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>{presentation.eyebrow}</span>
            <h1>{presentation.title}</h1>
            <p>Your Challenge Progress Is Protected While The Private Ledger Reconnects.</p>
          </div>
        </section>
        <section className={`${styles.emptyState} ${styles.unavailableState}`} role="alert">
          <span className={styles.bevelFrame} aria-hidden="true" />
          <span className={styles.panelLabel}>Secure Ledger Connection</span>
          <h2>Challenge Ledger Unavailable</h2>
          <p>{message}</p>
          <button type="button" className={styles.retryButton} onClick={onRetry}>
            <CasinoControlIcon variant="retry" state="attention" size="sm" />
            Retry Challenge Ledger
          </button>
        </section>
      </div>
    </StandardContentLayout>
  );
}

/** Countdown leaf: its 1 Hz clock never enters DailyChallengesPage state. */
function MissionCycleCountdown({
  tier,
  serverClockOffsetMs,
}: {
  tier: Tier;
  serverClockOffsetMs: number | null;
}) {
  const clientNow = useChallengeClockNow();
  if (serverClockOffsetMs === null) return <>Synchronizing</>;
  const serverNow = clientNow + serverClockOffsetMs;
  return <>{formatChallengeCountdown(msUntilChallengeReset(tier, serverNow))}</>;
}

/** The only reset panel subtree that re-renders as the wall clock advances. */
function MissionResetReadout({
  tier,
  isRefreshing,
  activeUnclaimed,
  serverClockOffsetMs,
}: {
  tier: Tier;
  isRefreshing: boolean;
  activeUnclaimed: number;
  serverClockOffsetMs: number | null;
}) {
  const clientNow = useChallengeClockNow();
  const serverNow = serverClockOffsetMs === null ? null : clientNow + serverClockOffsetMs;
  const resetMs = serverNow === null ? null : msUntilChallengeReset(tier, serverNow);
  const urgent = resetMs !== null && resetMs <= 60 * 60 * 1000;
  const resetLabel = useMemo(
    () =>
      serverNow === null
        ? 'Server Time Pending'
        : MISSION_RESET_FORMATTER.format(getChallengeResetAt(tier, serverNow)),
    [tier, serverNow]
  );

  return (
    <div className={`${styles.resetReadout} ${urgent ? styles.resetUrgent : ''}`}>
      <span>{isRefreshing ? 'Refreshing Challenge Ledger' : `${TIER_LABELS[tier]} Reset`}</span>
      <strong>{resetMs === null ? 'Synchronizing' : formatChallengeCountdown(resetMs)}</strong>
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
        if (!cancelled) setError('Challenge Alert Status Is Temporarily Unavailable.');
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
      toast.success('Daily Challenge Reset Alerts Are On For This Device');
      capture('daily_mission_alerts_changed', { enabled: true, surface: 'daily_missions' });
      recordDailyMissionOperation({
        userId,
        event: 'alerts_enabled',
        durationMs: performance.now() - startedAt,
      });
    } catch (err) {
      reportError(err, 'DailyChallengesPage.alert_enable_failed');
      const message = 'Challenge Alerts Could Not Be Enabled. Please Try Again.';
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
      toast.success('Daily Challenge Reset Alerts Are Off');
      capture('daily_mission_alerts_changed', { enabled: false, surface: 'daily_missions' });
      recordDailyMissionOperation({
        userId,
        event: 'alerts_disabled',
        durationMs: performance.now() - startedAt,
      });
    } catch (err) {
      reportError(err, 'DailyChallengesPage.alert_disable_failed');
      setError('Challenge Alerts Could Not Be Turned Off. Please Try Again.');
      toast.error('Challenge Alerts Could Not Be Turned Off');
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
  const unsupportedBrowser = !isWebPushSupported() && !unsupportedIos;
  const deviceNeedsConnection = enabled && !deviceConnected;
  const enrollmentBlocked = permission === 'denied' || unsupportedIos || unsupportedBrowser;
  const status = loading
    ? 'Checking Alert Link'
    : enabled && deviceConnected
      ? 'On For This Device'
      : deviceNeedsConnection
        ? 'Preference On, Device Disconnected'
        : permission === 'denied'
          ? 'Blocked In Browser Settings'
          : unsupportedIos
            ? 'Install App To Enable'
            : unsupportedBrowser
              ? 'Unavailable In This Browser'
              : 'Off Until You Opt In';

  return (
    <aside
      className={styles.alertConsole}
      aria-labelledby="mission-alerts-title"
      aria-busy={loading || busy}
    >
      <span className={styles.bevelFrame} aria-hidden="true" />
      <div className={styles.alertIcon} aria-hidden="true">
        <CasinoControlIcon
          variant={enabled && deviceConnected ? 'alert-on' : 'alert-off'}
          state={
            loading || busy
              ? 'pending'
              : enabled && deviceConnected
                ? 'active'
                : error
                  ? 'error'
                  : 'idle'
          }
          size="lg"
          className={styles.alertControlIcon}
        />
      </div>
      <div className={styles.alertCopy}>
        <span className={styles.panelLabel}>Daily Cycle Utility / Optional Challenge Alerts</span>
        <h2 id="mission-alerts-title">Daily Reset Alerts</h2>
        <p>
          Get One Alert When A Fresh Daily Challenge Set Opens. This Is Off By Default And Does Not
          Change Seat, Message, Tournament, Or Club Alerts.
        </p>
        {unsupportedIos && (
          <small>
            Add Smarter Poker To Your Home Screen, Then Open The Installed App To Enable.
          </small>
        )}
        {unsupportedBrowser && (
          <small>
            This Browser Does Not Support Challenge Alerts. Use A Supported Browser Or Device.
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
        >
          <CasinoControlIcon
            variant={enabled && deviceConnected ? 'alert-off' : 'alert-on'}
            state={
              loading || busy
                ? 'pending'
                : enrollmentBlocked && (!enabled || deviceNeedsConnection)
                  ? 'disabled'
                  : 'active'
            }
            size="sm"
          />
          {busy
            ? 'Updating...'
            : enabled && deviceConnected
              ? 'Turn Off Challenge Alerts'
              : deviceNeedsConnection
                ? 'Reconnect This Device'
                : 'Turn On Challenge Alerts'}
        </button>
        {deviceNeedsConnection && (
          <button
            type="button"
            className={styles.alertSecondaryButton}
            onClick={disableAlerts}
            disabled={loading || busy}
          >
            <CasinoControlIcon
              variant="alert-off"
              state={loading || busy ? 'pending' : 'idle'}
              size="sm"
            />
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

/** Keep the complete application shell unavailable behind a body-level dialog. */
function useInertAppShell(active: boolean) {
  useEffect(() => {
    if (!active) return undefined;
    const appRoot = document.getElementById('root');
    if (!appRoot) return undefined;
    const hadInert = appRoot.hasAttribute('inert');
    const previousAriaHidden = appRoot.getAttribute('aria-hidden');
    appRoot.setAttribute('inert', '');
    appRoot.setAttribute('aria-hidden', 'true');
    return () => {
      if (!hadInert) appRoot.removeAttribute('inert');
      if (previousAriaHidden === null) appRoot.removeAttribute('aria-hidden');
      else appRoot.setAttribute('aria-hidden', previousAriaHidden);
    };
  }, [active]);
}

export default function DailyChallengesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { cycle } = useParams<{ cycle?: string }>();
  const { routeClubId } = useClubWorkspace();
  const isMountedRef = useIsMounted();
  const toast = useToast();
  const reduceMotion = useReducedMotion();

  const [userId, setUserId] = useState<string | null>(null);
  const [authRetryNonce, setAuthRetryNonce] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState<number | null>(null);
  const [realtimeState, setRealtimeState] = useState<'connecting' | 'live' | 'degraded'>(
    'connecting'
  );
  const [activeTier, setActiveTier] = useState<Tier>(
    cycle === 'weekly' || cycle === 'monthly' ? cycle : 'daily'
  );

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
  const [buyingFreeze, setBuyingFreeze] = useState(false);
  const [confirmingFreeze, setConfirmingFreeze] = useState(false);
  const [economyBusy, setEconomyBusy] = useState(false);
  const claimGuardRef = useRef(new Set<string>()); // Prevent double-clicks bypassing React state
  const claimAllGuardRef = useRef(false);
  const rerollGuardRef = useRef(new Set<string>());
  const buyFreezeGuardRef = useRef(false);
  const economyGuardRef = useRef(false);
  const freezeFocusRestorePendingRef = useRef(false);

  // Celebration state
  const [celebratingIds, setCelebratingIds] = useState<Set<string>>(new Set());
  /* No `chips` field: a mission reward is diamonds, and since migration
     20260905114421 the RPC returns a literal 0 for every chip figure. A field
     that can only ever be zero is an invitation to render "+0 Chips". */
  const [reward, setReward] = useState<{
    name: string;
    diamonds: number;
    challengeDiamonds: number;
    milestoneDiamonds: number;
    diamondBalance: number;
    returnFocusId: string;
  } | null>(null);
  const celebrateDialogRef = useFocusTrap(!!reward, '#challenge-reward-title');
  const freezeDialogRef = useFocusTrap(confirmingFreeze, '#freeze-purchase-title');
  useInertAppShell(!!reward || confirmingFreeze);

  const loadRequestRef = useRef(0);
  const mutationEpochRef = useRef(0);
  const serverClockOffsetRef = useRef<number | null>(null);
  const periodKeysRef = useRef<Record<Tier, string> | null>(null);
  const lastResumeRefreshRef = useRef(0);
  const initialLoadSettledRef = useRef(false);
  const dashboardRevisionRef = useRef(0);
  const diamondBalanceRef = useRef(0);
  const dashboardRequestsInFlightRef = useRef(0);
  const queuedRealtimeRevisionRef = useRef<number | null>(null);
  const queuedUnversionedRealtimeRef = useRef(false);
  const realtimeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const realtimeStatusRef = useRef<'connecting' | 'live' | 'degraded'>('connecting');
  // Every subscription status, channel error, account change and unmount opens
  // a new catch-up generation. A cursor reply from an older generation is
  // discarded, so a retired channel can never repaint this page.
  const catchUpGenerationRef = useRef(0);
  // One bounded cursor read at a time. A lifecycle wake that lands while a
  // read is in flight is folded into exactly one follow-up read.
  const cursorReadInFlightRef = useRef(false);
  const cursorCatchUpPendingRef = useRef(false);
  const userIdRef = useRef<string | null>(null);
  const loadChallengesRef = useRef<
    (uid: string, mode: 'initial' | 'refresh' | 'silent') => Promise<void>
  >(async () => undefined);

  useEffect(() => {
    document.title = `${TIER_PRESENTATION[activeTier].title} | Smarter Poker`;
  }, [activeTier]);

  useEffect(() => {
    document.body.dataset.toastTheme = 'daily-missions-casino';
    return () => {
      if (document.body.dataset.toastTheme === 'daily-missions-casino') {
        delete document.body.dataset.toastTheme;
      }
    };
  }, []);

  // Each mission cycle is a real, bookmarkable subpage. Old or malformed
  // bookmarks fail safely to Daily instead of producing an empty dashboard.
  useEffect(() => {
    if (!cycle) {
      setActiveTier('daily');
      setConfirmingRerollId(null);
      return;
    }
    if (cycle === 'daily' || cycle === 'weekly' || cycle === 'monthly') {
      setActiveTier(cycle);
      setConfirmingRerollId(null);
      return;
    }
    navigate(withClubContext(`/challenges${location.search}${location.hash}`, routeClubId), {
      replace: true,
    });
  }, [cycle, location.hash, location.search, navigate, routeClubId]);

  // Escape always cancels the active reroll confirmation, even after focus
  // moves to another card. The inline control still owns the visible prompt,
  // while this page-level listener guarantees a consistent keyboard exit.
  useEffect(() => {
    if (!confirmingRerollId) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmingRerollId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmingRerollId]);

  // ── Loaders ──
  const installDashboardProjection = useCallback(
    (dashboard: DailyChallengeDashboard): boolean => {
      if (!isMountedRef.current || dashboard.revision < dashboardRevisionRef.current) return false;

      const acceptedAt = Date.now();
      const serverSyncedAt = Date.parse(dashboard.syncedAt);
      if (!Number.isFinite(serverSyncedAt)) {
        throw new Error('The challenge clock receipt was invalid');
      }
      const nextServerClockOffsetMs = serverSyncedAt - acceptedAt;
      serverClockOffsetRef.current = nextServerClockOffsetMs;
      periodKeysRef.current = dashboard.periodKeys;
      dashboardRevisionRef.current = dashboard.revision;
      diamondBalanceRef.current = dashboard.diamondBalance;

      setChallenges(dashboard.missions);
      setStats(dashboard.stats);
      setStreak(dashboard.streak);
      setDiamondBalance(dashboard.diamondBalance);
      setRewardVault(dashboard.vault);
      setLoadError(null);
      setServerClockOffsetMs(nextServerClockOffsetMs);
      setLastSyncedAt(serverSyncedAt);
      return true;
    },
    [isMountedRef]
  );

  const loadChallenges = useCallback(
    async (uid: string, mode: 'initial' | 'refresh' | 'silent') => {
      const startedAt = performance.now();
      const requestId = ++loadRequestRef.current;
      const mutationEpoch = mutationEpochRef.current;
      dashboardRequestsInFlightRef.current += 1;
      if (mode === 'initial') {
        setIsLoading(true);
      } else if (mode === 'refresh') {
        setIsRefreshing(true);
      }

      try {
        const dashboard = await dailyChallengeService.getDashboard(uid);
        if (
          !isMountedRef.current ||
          uid !== userIdRef.current ||
          !isCurrentDailyMissionDashboardReceipt(
            requestId,
            loadRequestRef.current,
            mutationEpoch,
            mutationEpochRef.current
          )
        )
          return;

        if (!installDashboardProjection(dashboard)) return;
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
        if (
          !isMountedRef.current ||
          !isCurrentDailyMissionDashboardReceipt(
            requestId,
            loadRequestRef.current,
            mutationEpoch,
            mutationEpochRef.current
          )
        )
          return;

        reportError(err, 'DailyChallengesPage.load_failed');
        recordDailyMissionOperation({
          userId: uid,
          event: 'dashboard_failed',
          durationMs: performance.now() - startedAt,
          reasonCode: dailyMissionReasonCode(err),
        });
        setLoadError('Challenge Ledger Unavailable. Your Progress Is Safe. Please Retry.');
      } finally {
        dashboardRequestsInFlightRef.current = Math.max(
          0,
          dashboardRequestsInFlightRef.current - 1
        );
        if (isMountedRef.current && requestId === loadRequestRef.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
        if (isMountedRef.current && dashboardRequestsInFlightRef.current === 0) {
          const queuedRevision = queuedRealtimeRevisionRef.current;
          const queuedUnversionedEvent = queuedUnversionedRealtimeRef.current;
          queuedRealtimeRevisionRef.current = null;
          queuedUnversionedRealtimeRef.current = false;
          if (
            shouldRefreshQueuedDailyMissionRealtime(
              queuedRevision,
              queuedUnversionedEvent,
              dashboardRevisionRef.current
            )
          ) {
            if (realtimeRefreshTimerRef.current) clearTimeout(realtimeRefreshTimerRef.current);
            realtimeRefreshTimerRef.current = setTimeout(() => {
              realtimeRefreshTimerRef.current = null;
              void loadChallengesRef.current(uid, 'silent');
            }, 250);
          }
        }
      }
    },
    [installDashboardProjection, isMountedRef]
  );

  useEffect(() => {
    loadChallengesRef.current = loadChallenges;
  }, [loadChallenges]);

  // ── Initialization ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoadError(null);
        const authResult = await getAuthUser();
        if (cancelled) return;
        if (authResult.error || ('failed' in authResult && authResult.failed)) {
          throw authResult.error || new Error('Secure session check failed');
        }
        const authUser = authResult.data.user;
        if (!authUser) {
          setIsLoading(false);
          return;
        }
        if (userIdRef.current !== authUser.id) {
          // A different account has nothing rendered yet. Retire every cursor
          // and queued event that belonged to the previous account so its
          // revision numbers cannot fence out the new account's first receipt.
          userIdRef.current = authUser.id;
          catchUpGenerationRef.current += 1;
          cursorCatchUpPendingRef.current = false;
          dashboardRevisionRef.current = 0;
          queuedRealtimeRevisionRef.current = null;
          queuedUnversionedRealtimeRef.current = false;
          initialLoadSettledRef.current = false;
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
  }, [authRetryNonce, loadChallenges]);

  const dismissReward = useCallback(() => {
    const returnFocusId = reward?.returnFocusId;
    setReward(null);
    requestAnimationFrame(() => {
      const origin = returnFocusId ? document.getElementById(returnFocusId) : null;
      const fallback =
        document.getElementById('mission-board-title') ??
        document.getElementById(`mission-tab-${activeTier}`);
      (origin ?? fallback)?.focus();
    });
  }, [activeTier, reward]);

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
    if (!userId || serverClockOffsetMs === null) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    const scheduleRollover = () => {
      const serverNow = Date.now() + serverClockOffsetMs;
      const delay = Math.max(250, msUntilChallengeReset('daily', serverNow) + 250);
      timer = setTimeout(() => {
        loadChallenges(userId, 'silent');
        scheduleRollover();
      }, delay);
    };
    scheduleRollover();
    return () => clearTimeout(timer);
  }, [userId, serverClockOffsetMs, loadChallenges]);

  const scheduleRealtimeRefresh = useCallback(
    (payload?: unknown) => {
      if (!userId) return;
      const announcedRevision = dailyMissionRevisionFromPayload(payload);

      if (dashboardRequestsInFlightRef.current > 0) {
        if (announcedRevision === null) {
          queuedUnversionedRealtimeRef.current = true;
        } else {
          queuedRealtimeRevisionRef.current = Math.max(
            queuedRealtimeRevisionRef.current ?? 0,
            announcedRevision
          );
        }
        return;
      }

      // The dashboard RPC can assign a brand-new account's first missions. Those
      // inserts broadcast their revision before the same atomic RPC receipt
      // reaches the browser. Scheduling another full dashboard read here made a
      // cold open perform two identical RPCs. Keep the event for the debounce,
      // then compare it with the revision actually rendered by the first receipt:
      // the matching echo is already covered; a genuinely newer mutation still
      // refreshes immediately.
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

  // Realtime is the immediate path. Everything else is a lifecycle event (a
  // new subscription generation or a tab resume) that performs ONE bounded
  // read of the durable per-user revision cursor and fetches the dashboard
  // only when that cursor is newer than the revision on screen. There is no
  // repeating timer: the cursor row is the durable record of the obligation
  // and the owned reconnect lifecycle is what re-enters this path.
  const requestCursorCatchUp = useCallback(() => {
    const uid = userIdRef.current;
    if (!uid || !isMountedRef.current) return;
    if (cursorReadInFlightRef.current) {
      cursorCatchUpPendingRef.current = true;
      return;
    }
    const generation = catchUpGenerationRef.current;
    cursorReadInFlightRef.current = true;
    void dailyChallengeService
      .getDashboardRevision(uid)
      .then((revision) => {
        if (!isMountedRef.current || uid !== userIdRef.current) return;
        if (generation !== catchUpGenerationRef.current) return;
        if (revision > dashboardRevisionRef.current) scheduleRealtimeRefresh({ revision });
      })
      .catch(() => {
        // The service records the read failure. Keep the confirmed page; the
        // next lifecycle event (rejoin or resume) performs the next read.
      })
      .finally(() => {
        cursorReadInFlightRef.current = false;
        const followUp = cursorCatchUpPendingRef.current;
        cursorCatchUpPendingRef.current = false;
        if (followUp && isMountedRef.current && uid === userIdRef.current) {
          requestCursorCatchUp();
        }
      });
  }, [isMountedRef, scheduleRealtimeRefresh]);

  // Browsers throttle timers and live sockets in background tabs. Reconcile on
  // resume so a table left open overnight never shows yesterday's contracts.
  // The resume is an event: one bounded cursor read decides whether the
  // dashboard is fetched again. A UTC date change is product timing and still
  // reloads directly, because the rendered contracts belong to a finished day.
  useEffect(() => {
    if (!userId) return undefined;

    const refreshAfterResume = () => {
      if (document.visibilityState !== 'visible') return;
      // setUserId installs this listener before the first dashboard receipt
      // settles. A focus event in that window used to see receiptAt=0 and start
      // a duplicate cold-load request.
      if (!initialLoadSettledRef.current) return;
      const resumedAt = Date.now();
      if (resumedAt - lastResumeRefreshRef.current < 1000) return;

      const clockOffset = serverClockOffsetRef.current;
      const renderedDailyKey = periodKeysRef.current?.daily;
      const dateChanged =
        clockOffset === null ||
        renderedDailyKey === undefined ||
        getUtcDateKey(resumedAt + clockOffset) !== renderedDailyKey;
      lastResumeRefreshRef.current = resumedAt;
      if (dateChanged) {
        loadChallenges(userId, 'silent');
        return;
      }
      requestCursorCatchUp();
    };

    document.addEventListener('visibilitychange', refreshAfterResume);
    window.addEventListener('focus', refreshAfterResume);
    return () => {
      document.removeEventListener('visibilitychange', refreshAfterResume);
      window.removeEventListener('focus', refreshAfterResume);
    };
  }, [userId, loadChallenges, requestCursorCatchUp]);

  useEffect(
    () => () => {
      if (realtimeRefreshTimerRef.current) clearTimeout(realtimeRefreshTimerRef.current);
    },
    []
  );

  useEffect(
    () => () => {
      catchUpGenerationRef.current += 1;
      cursorCatchUpPendingRef.current = false;
    },
    [userId]
  );

  useMasterBusBroadcastChannel({
    channelName: userId ? `daily-mission-revision:${userId}` : null,
    event: 'daily_mission_revision_changed',
    enabled: !!userId,
    private: true,
    onPayload: scheduleRealtimeRefresh,
    onSubscriptionError: () => {
      // A channel error, timeout or closure only marks the page degraded and
      // retires any cursor reply still in flight. No fetch happens here: the
      // owned reconnect lifecycle (supabase-js rejoin, the MasterBus channel
      // factory and the connection watchdog) ends in a new SUBSCRIBED status,
      // and that status is what performs the bounded catch-up read.
      catchUpGenerationRef.current += 1;
      realtimeStatusRef.current = 'degraded';
      setRealtimeState('degraded');
      recordDailyMissionOperation({ userId, event: 'realtime_degraded' });
    },
    onSubscriptionStatus: (status) => {
      catchUpGenerationRef.current += 1;
      if (status !== 'SUBSCRIBED') return;
      const recovered = realtimeStatusRef.current === 'degraded';
      realtimeStatusRef.current = 'live';
      setRealtimeState('live');
      if (recovered) recordDailyMissionOperation({ userId, event: 'realtime_recovered' });
      // The first snapshot can precede the first joined channel, and a rejoin
      // can follow any number of dropped frames. Both are the same event: one
      // bounded cursor read per subscription generation, which preserves a
      // single dashboard RPC when the receipt on screen already covers the
      // server's current revision.
      requestCursorCatchUp();
    },
  });

  // A completion can arrive from another table or device while this card's
  // inline reroll confirmation is open. Once that assignment is no longer
  // rerollable, close the stale confirmation so it cannot keep every other
  // card's reroll control disabled.
  useEffect(() => {
    if (!confirmingRerollId) return;
    const confirmingChallenge = challenges.find((challenge) => challenge.id === confirmingRerollId);
    if (!confirmingChallenge || confirmingChallenge.completed || confirmingChallenge.claimed) {
      setConfirmingRerollId(null);
    }
  }, [challenges, confirmingRerollId]);

  // ── Claim handler ──
  const handleClaim = useCallback(
    async (challenge: TieredChallenge) => {
      if (!userId) return;
      if (claimGuardRef.current.has(challenge.id) || economyGuardRef.current) return;
      economyGuardRef.current = true;
      setEconomyBusy(true);
      claimGuardRef.current.add(challenge.id);
      setClaimingIds((prev) => new Set(prev).add(challenge.id));
      const startedAt = performance.now();

      try {
        const paid = await dailyChallengeService.claimChallenges(userId, [challenge.id]);
        const newlyClaimed = paid.claimedIds.includes(challenge.id);
        const alreadyClaimed = paid.alreadyClaimedIds.includes(challenge.id);

        mutationEpochRef.current += 1;
        const projectionInstalled = paid.dashboard
          ? installDashboardProjection(paid.dashboard)
          : false;
        const rewardBalance = paid.dashboard
          ? projectionInstalled
            ? paid.dashboard.diamondBalance
            : diamondBalanceRef.current
          : paid.settlementDiamondBalance;
        if (!paid.dashboard) void loadChallenges(userId, 'silent');

        if (alreadyClaimed && !newlyClaimed) {
          toast.info('You Already Claimed This One');
          focusAfterMissionUpdate(`mission-card-${challenge.id}`);
        } else if (newlyClaimed) {
          setReward({
            name: challenge.challenge.name,
            diamonds: paid.diamondsCredited,
            challengeDiamonds: paid.challengeDiamonds,
            milestoneDiamonds: paid.milestoneDiamonds,
            diamondBalance: rewardBalance,
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
            diamond_reward: paid.diamondsCredited,
            challenge_diamonds: paid.challengeDiamonds,
            milestone_diamonds: paid.milestoneDiamonds,
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
            rewardAmount: paid.diamondsCredited,
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
        if (isMountedRef.current) {
          toast.error('Reward Status Could Not Be Confirmed. Refreshing Your Challenge Ledger.');
        }
        loadChallenges(userId, 'silent');
      } finally {
        claimGuardRef.current.delete(challenge.id);
        economyGuardRef.current = false;
        if (isMountedRef.current) {
          setEconomyBusy(false);
          setClaimingIds((prev) => {
            const next = new Set(prev);
            next.delete(challenge.id);
            return next;
          });
        }
      }
    },
    [userId, installDashboardProjection, loadChallenges, toast, isMountedRef]
  );

  // ── Claim All ──
  //
  // One database-owned batch settles every currently vaulted reward under one
  // profile lock and one request receipt. The overlay shows the combined total
  // rather than flashing once for every challenge.

  const dismissFreezePurchase = useCallback(() => {
    if (buyFreezeGuardRef.current) return;
    freezeFocusRestorePendingRef.current = true;
    setConfirmingFreeze(false);
  }, []);

  useEffect(() => {
    if (confirmingFreeze || economyBusy || !freezeFocusRestorePendingRef.current) return undefined;

    freezeFocusRestorePendingRef.current = false;
    const frame = requestAnimationFrame(() => {
      const buyButton = document.getElementById('buy-streak-freeze') as HTMLButtonElement | null;
      if (buyButton && !buyButton.disabled) {
        buyButton.focus();
        return;
      }
      document.getElementById('streak-console-title')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [confirmingFreeze, economyBusy]);

  useEffect(() => {
    if (!confirmingFreeze) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissFreezePurchase();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmingFreeze, dismissFreezePurchase]);

  const handleBuyFreeze = useCallback(async () => {
    if (!userId || buyingFreeze || buyFreezeGuardRef.current || economyGuardRef.current) return;
    if (diamondBalance < 5000) {
      freezeFocusRestorePendingRef.current = true;
      setConfirmingFreeze(false);
      toast.error('Not Enough Diamonds. You Need 5,000 Diamonds To Buy A Freeze.');
      return;
    }

    // Keep the portal and inert shell until the request settles. Removing
    // them on the first click lets a second click activate navigation below.
    freezeFocusRestorePendingRef.current = true;
    buyFreezeGuardRef.current = true;
    economyGuardRef.current = true;
    mutationEpochRef.current += 1;
    setBuyingFreeze(true);
    setEconomyBusy(true);

    const startedAt = performance.now();
    try {
      const res = await dailyChallengeService.buyStreakFreeze(userId);
      if (res.success) {
        // A dashboard read can begin while the purchase RPC is in flight and
        // still represent the pre-purchase snapshot. Invalidate that receipt
        // before applying the authoritative purchase result.
        mutationEpochRef.current += 1;
        capture('daily_mission_freeze_purchased', {
          replayed: res.alreadyPurchased,
          diamond_cost: res.diamondsSpent ?? 0,
        });
        recordDailyMissionOperation({
          userId,
          event: 'freeze_succeeded',
          durationMs: performance.now() - startedAt,
        });
        toast.success(
          res.alreadyPurchased ? 'Streak Freeze Purchase Confirmed.' : 'Streak Freeze Purchased.'
        );
        // The purchase receipt proves the spend, but its balance/inventory can
        // already be behind another tab. Paint only the revision-bearing
        // dashboard projection read after the mutation.
        await loadChallenges(userId, 'silent');
      } else {
        recordDailyMissionOperation({
          userId,
          event: 'freeze_failed',
          durationMs: performance.now() - startedAt,
          reasonCode: 'rejected',
        });
        toast.error(
          'Streak Freeze Status Could Not Be Confirmed. Refreshing Your Diamond Balance.'
        );
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
      toast.error('Streak Freeze Status Could Not Be Confirmed. Refreshing Your Diamond Balance.');
      loadChallenges(userId, 'silent');
    } finally {
      buyFreezeGuardRef.current = false;
      economyGuardRef.current = false;
      if (isMountedRef.current) {
        setConfirmingFreeze(false);
        setBuyingFreeze(false);
        setEconomyBusy(false);
      }
    }
  }, [userId, buyingFreeze, diamondBalance, toast, loadChallenges, isMountedRef]);

  const handleReroll = useCallback(
    async (challenge: TieredUserChallenge) => {
      if (!userId) return;
      if (rerollGuardRef.current.has(challenge.id) || economyGuardRef.current) return;
      if (diamondBalance < DAILY_MISSION_REROLL_COST) {
        setConfirmingRerollId(null);
        toast.error(`Not Enough Diamonds. ${DAILY_MISSION_REROLL_COST} Diamond Required.`);
        return;
      }

      economyGuardRef.current = true;
      setEconomyBusy(true);
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
          toast.error(
            'Challenge Reroll Status Could Not Be Confirmed. Refreshing Your Diamond Balance.'
          );
          loadChallenges(userId, 'silent');
          return;
        }
        setConfirmingRerollId(null);
        mutationEpochRef.current += 1;
        capture('daily_mission_rerolled', {
          tier: challenge.tier,
          replayed: result.alreadyRerolled,
          diamond_cost: result.diamondsSpent ?? 0,
        });
        recordDailyMissionOperation({
          userId,
          event: 'reroll_succeeded',
          tier: challenge.tier,
          durationMs: performance.now() - startedAt,
          itemCount: 1,
        });
        toast.success(
          result.alreadyRerolled
            ? 'Challenge Already Replaced. Refreshing The Live Ledger.'
            : 'New Challenge Ready. Refreshing The Live Ledger.'
        );
        // The receipt projection may predate a newer action in another tab.
        // Paint only a freshly read, revision-bearing dashboard snapshot.
        await loadChallenges(userId, 'silent');
        // Global wallet surfaces perform their own authoritative profile read.
        // This keeps them wired even when the profile realtime frame is lost.
        masterBus.emit('BALANCE_UPDATED', { source: 'daily_challenge_reroll', userId });
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
        if (isMountedRef.current) {
          toast.error(
            'Challenge Reroll Status Could Not Be Confirmed. Refreshing Your Diamond Balance.'
          );
        }
        loadChallenges(userId, 'silent');
      } finally {
        rerollGuardRef.current.delete(challenge.id);
        economyGuardRef.current = false;
        if (isMountedRef.current) {
          setEconomyBusy(false);
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
    if (!userId || claimAllGuardRef.current || economyGuardRef.current) return;
    claimAllGuardRef.current = true;
    economyGuardRef.current = true;

    setClaimingAll(true);
    setEconomyBusy(true);
    const startedAt = performance.now();
    let ready: TieredChallenge[] = [];
    let readyIds: string[] = [];

    try {
      // Reconcile with the authoritative vault at the instant of settlement.
      // Realtime and the cursor catch-up deliberately coalesce bursts, so
      // the rendered vault can briefly contain only the first completed row.
      // Claim All must never turn that transient view into a partial payout.
      const dashboard = await dailyChallengeService.getDashboard(userId);
      if (!isMountedRef.current) return;

      ready = dashboard.vault.items;
      if (ready.length === 0) {
        setRewardVault(dashboard.vault);
        toast.info('Those Rewards Were Already Claimed.');
        focusAfterMissionUpdate('mission-board-title');
        return;
      }

      readyIds = ready.map((challenge) => challenge.id);
      readyIds.forEach((id) => claimGuardRef.current.add(id));
      setClaimingIds((prev) => new Set([...prev, ...readyIds]));

      const paid = await dailyChallengeService.claimChallenges(userId, readyIds);
      if (!isMountedRef.current) return;

      mutationEpochRef.current += 1;
      const projectionInstalled = paid.dashboard
        ? installDashboardProjection(paid.dashboard)
        : false;
      const rewardBalance = paid.dashboard
        ? projectionInstalled
          ? paid.dashboard.diamondBalance
          : diamondBalanceRef.current
        : paid.settlementDiamondBalance;
      if (!paid.dashboard) void loadChallenges(userId, 'silent');
      const settledIds = new Set([...paid.claimedIds, ...paid.alreadyClaimedIds]);
      setChallenges((prev) =>
        prev.map((challenge) =>
          settledIds.has(challenge.id) ? { ...challenge, claimed: true } : challenge
        )
      );
      if (paid.claimedIds.length > 0) {
        capture('daily_mission_claimed', {
          tier: 'vault',
          diamond_reward: paid.diamondsCredited,
          challenge_diamonds: paid.challengeDiamonds,
          milestone_diamonds: paid.milestoneDiamonds,
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
          name: `${paid.claimedIds.length} Challenge${paid.claimedIds.length === 1 ? '' : 's'}`,
          diamonds: paid.diamondsCredited,
          challengeDiamonds: paid.challengeDiamonds,
          milestoneDiamonds: paid.milestoneDiamonds,
          diamondBalance: rewardBalance,
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
        toast.info('Those Rewards Were Already Claimed.');
        focusAfterMissionUpdate('mission-board-title');
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
      toast.error('Reward Status Could Not Be Confirmed. Refreshing Your Challenge Ledger.');
      loadChallenges(userId, 'silent');
    } finally {
      readyIds.forEach((id) => claimGuardRef.current.delete(id));
      claimAllGuardRef.current = false;
      economyGuardRef.current = false;
      if (isMountedRef.current) {
        setClaimingAll(false);
        setEconomyBusy(false);
        setClaimingIds((prev) => {
          const next = new Set(prev);
          readyIds.forEach((id) => next.delete(id));
          return next;
        });
      }
    }
  }, [userId, toast, installDashboardProjection, loadChallenges, isMountedRef]);

  // ── Derived ──
  const tierCounts = useMemo(() => {
    const counts: Record<Tier, { total: number; done: number }> = {
      daily: { total: 0, done: 0 },
      weekly: { total: 0, done: 0 },
      monthly: { total: 0, done: 0 },
    };
    challenges.forEach((c) => {
      counts[c.tier].total++;
      if (c.completed) counts[c.tier].done++;
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

  const openTier = useCallback(
    (tier: Tier) => {
      setActiveTier(tier);
      setConfirmingRerollId(null);
      navigate(
        withClubContext(`/challenges/${tier}${location.search}${location.hash}`, routeClubId)
      );
    },
    [location.hash, location.search, navigate, routeClubId]
  );

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
      openTier(nextTier);
      requestAnimationFrame(() => document.getElementById(`mission-tab-${nextTier}`)?.focus());
    },
    [openTier]
  );

  const handleOpenMission = useCallback(
    (type: ChallengeType) => {
      const action = getChallengeMissionAction(type);
      capture('daily_mission_cta_clicked', { mission_type: type, destination: action.path });
      recordDailyMissionOperation({ userId, event: 'mission_cta_opened', tier: activeTier });
      navigate(withClubContext(action.path, routeClubId));
    },
    [activeTier, navigate, routeClubId, userId]
  );

  // ── Render ──

  if (isLoading) {
    return <MissionLoadingState tier={activeTier} />;
  }

  if (!userId) {
    return (
      <StandardContentLayout
        className={styles.container}
        title={TIER_PRESENTATION[activeTier].title}
      >
        <div className={styles.emptyState}>
          <span className={styles.bevelFrame} aria-hidden="true" />
          <span className={styles.eyebrow}>Private Challenge Vault</span>
          <h2>
            {loadError
              ? 'Secure Session Check Failed'
              : `Sign In To See Your ${TIER_LABELS[activeTier]} Challenges`}
          </h2>
          {loadError && <p>{loadError}</p>}
          <div className={styles.emptyActions}>
            {loadError && (
              <button
                type="button"
                className={styles.retryButton}
                onClick={() => {
                  setIsLoading(true);
                  setAuthRetryNonce((value) => value + 1);
                }}
              >
                <CasinoControlIcon variant="retry" state="attention" size="sm" />
                Retry Session Check
              </button>
            )}
            <button
              type="button"
              className={styles.playButton}
              onClick={() => {
                const returnUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
                window.location.assign(signInUrl(returnUrl));
              }}
            >
              <CasinoControlIcon variant="sign-in" state="active" size="sm" />
              Sign In
            </button>
          </div>
        </div>
      </StandardContentLayout>
    );
  }

  if (loadError && lastSyncedAt === null) {
    return (
      <MissionUnavailableState
        tier={activeTier}
        message={loadError}
        onRetry={() => loadChallenges(userId, 'initial')}
      />
    );
  }

  return (
    <StandardContentLayout className={styles.container}>
      <div
        className={styles.page}
        id="daily-missions"
        data-arena-surface="missions"
        data-mission-cycle={activeTier}
        aria-busy={isRefreshing}
        aria-hidden={reward || confirmingFreeze ? true : undefined}
        inert={reward || confirmingFreeze ? true : undefined}
      >
        <section className={styles.hero} aria-labelledby="missions-title">
          <span className={styles.bevelFrame} aria-hidden="true" />
          <MissionHeroArtwork tier={activeTier} />
          <div className={styles.heroShade} />
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>{TIER_PRESENTATION[activeTier].eyebrow}</span>
            <h1 id="missions-title">{TIER_PRESENTATION[activeTier].title}</h1>
            <p>{TIER_PRESENTATION[activeTier].description}</p>
            <div className={styles.heroMeters}>
              <div>
                <span>{TIER_LABELS[activeTier]} Cycle</span>
                <strong>
                  <MissionCycleCountdown
                    tier={activeTier}
                    serverClockOffsetMs={serverClockOffsetMs}
                  />
                </strong>
                <small>Until {TIER_LABELS[activeTier]} Reset</small>
              </div>
              <div>
                <span>Available Diamonds</span>
                <strong className={styles.balanceWithGem}>
                  <DiamondMark /> {diamondBalance.toLocaleString()}
                </strong>
                <small>Spendable Balance</small>
              </div>
            </div>
            <div className={styles.heroActions}>
              <button
                type="button"
                className={styles.playButton}
                onClick={() => {
                  document.getElementById('mission-board-title')?.scrollIntoView({
                    behavior: reduceMotion ? 'auto' : 'smooth',
                    block: 'start',
                  });
                  requestAnimationFrame(() =>
                    document.getElementById('mission-board-title')?.focus()
                  );
                }}
              >
                <CasinoControlIcon variant="ledger" state="active" size="sm" />
                View Challenge Ledger
              </button>
              <button
                type="button"
                className={styles.backButton}
                onClick={() => navigate(routeClubId ? `/clubs/${routeClubId}` : '/')}
              >
                <CasinoControlIcon variant="back" state="idle" size="sm" />
                Back To Arena
              </button>
            </div>
          </div>
          <div className={styles.heroSeal} role="status" aria-live="polite">
            <span>{syncLabel}</span>
            <strong>
              {tierCounts[activeTier].done}/{tierCounts[activeTier].total}
            </strong>
            <small>{TIER_LABELS[activeTier]} Cleared</small>
          </div>
        </section>

        {loadError && (
          <aside className={`${styles.syncNotice} ${styles.syncNoticeError}`} role="alert">
            <span className={styles.bevelFrame} aria-hidden="true" />
            <div>
              <span className={styles.panelLabel}>Challenge Ledger Interrupted</span>
              <strong>{loadError}</strong>
              {lastSyncedAt && (
                <small>Last Successful Sync: {MISSION_SYNC_FORMATTER.format(lastSyncedAt)}</small>
              )}
            </div>
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => userId && loadChallenges(userId, 'refresh')}
              disabled={isRefreshing}
            >
              <CasinoControlIcon
                variant="sync"
                state={isRefreshing ? 'pending' : 'attention'}
                size="sm"
              />
              {isRefreshing ? 'Reconnecting...' : 'Retry Sync'}
            </button>
          </aside>
        )}

        <section className={styles.commandDeck} aria-label="Challenge Status">
          <div className={styles.streakConsole}>
            <span className={styles.bevelFrame} aria-hidden="true" />
            <div className={styles.streakCore}>
              <span className={styles.streakFireVisual} aria-hidden="true">
                <CasinoControlIcon
                  variant="streak"
                  state={(streak?.streak ?? stats?.currentStreak ?? 0) > 0 ? 'active' : 'idle'}
                  size="lg"
                />
              </span>
              <div className={styles.streakInfo}>
                <span className={styles.panelLabel}>Daily Streak Circuit</span>
                <h2 id="streak-console-title" className={styles.streakCount} tabIndex={-1}>
                  {(streak?.streak ?? stats?.currentStreak ?? 0).toLocaleString()} Day Streak
                </h2>
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
                  {streak.usedFreeze && streak.lastFrozenDate && (
                    <div
                      className={styles.freezeReceipt}
                      role="status"
                      aria-label={`Streak Freeze Applied For ${MISSION_DATE_FORMATTER.format(new Date(`${streak.lastFrozenDate}T00:00:00Z`))}`}
                    >
                      <CasinoControlIcon variant="freeze" state="success" size="md" />
                      <div>
                        <strong>Streak Freeze Applied</strong>
                        <small>
                          {MISSION_DATE_FORMATTER.format(
                            new Date(`${streak.lastFrozenDate}T00:00:00Z`)
                          )}{' '}
                          Cycle Protected
                        </small>
                        {streak.honoredFrozenDates > 1 && (
                          <small>
                            {streak.honoredFrozenDates.toLocaleString()} Protected Cycles In Current
                            Streak
                          </small>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className={styles.freezeAction}>
                  <button
                    id="buy-streak-freeze"
                    type="button"
                    className={styles.buyFreezeBtn}
                    onClick={() => {
                      if (!economyGuardRef.current) setConfirmingFreeze(true);
                    }}
                    disabled={
                      buyingFreeze ||
                      economyBusy ||
                      diamondBalance < 5000 ||
                      streak.freezesAvailable >= 3
                    }
                    aria-describedby="freeze-action-hint"
                    aria-haspopup="dialog"
                  >
                    <CasinoControlIcon
                      variant="freeze"
                      state={
                        buyingFreeze
                          ? 'pending'
                          : economyBusy || diamondBalance < 5000 || streak.freezesAvailable >= 3
                            ? 'disabled'
                            : 'active'
                      }
                      size="sm"
                    />
                    {buyingFreeze
                      ? 'Securing...'
                      : streak.freezesAvailable >= 3
                        ? 'Freeze Vault Full'
                        : diamondBalance < 5000
                          ? 'Need More Diamonds'
                          : 'Buy Streak Freeze'}
                    {streak.freezesAvailable < 3 && (
                      <span className={styles.buttonPrice}>
                        <DiamondMark /> 5,000
                        <span className={styles.srOnly}>Diamonds</span>
                      </span>
                    )}
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
            <span className={styles.bevelFrame} aria-hidden="true" />
            <div className={styles.summaryTile}>
              <span className={styles.summaryLabel}>{TIER_LABELS[activeTier]} Cycle</span>
              <strong className={styles.summaryValue}>
                {tierCounts[activeTier].done}/{tierCounts[activeTier].total}
              </strong>
              <small>Completed</small>
            </div>
            <div className={styles.summaryTile}>
              <span className={styles.summaryLabel}>Career</span>
              <strong className={styles.summaryValue}>
                {(stats?.totalCompleted || 0).toLocaleString()}
              </strong>
              <small>Challenges Cleared</small>
            </div>
            <div className={styles.summaryTile}>
              <span className={styles.summaryLabel}>Earned Here</span>
              <strong
                className={`${styles.summaryValue} ${styles.diamond} ${styles.balanceWithGem}`}
              >
                <DiamondMark /> {(stats?.totalDiamondsEarned || 0).toLocaleString()}
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
            <span className={styles.bevelFrame} aria-hidden="true" />
            <img
              className={styles.vaultArtwork}
              src={mediaUrl(MISSION_REWARD_ARTWORK)}
              alt=""
              width="640"
              height="474"
              loading="lazy"
              decoding="async"
              aria-hidden="true"
            />
            <div className={styles.vaultCopy}>
              <span className={styles.panelLabel}>Reward Vault Open</span>
              <strong>
                {unclaimed.count} Challenge{unclaimed.count === 1 ? '' : 's'} Ready
              </strong>
              <small>+{unclaimed.diamonds.toLocaleString()} Diamonds</small>
            </div>
            <button
              type="button"
              className={styles.claimAllButton}
              onClick={handleClaimAll}
              disabled={claimingAll || economyBusy}
            >
              <CasinoControlIcon
                variant="claim"
                state={claimingAll ? 'pending' : economyBusy ? 'disabled' : 'active'}
                size="sm"
              />
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
          <span className={styles.bevelFrame} aria-hidden="true" />
          <header className={styles.boardHeader}>
            <div>
              <span className={styles.eyebrow}>Challenge Ledger</span>
              <h2 id="mission-board-title" tabIndex={-1}>
                {TIER_LABELS[activeTier]} Challenge Ledger
              </h2>
            </div>
            <MissionResetReadout
              tier={activeTier}
              isRefreshing={isRefreshing}
              activeUnclaimed={activeUnclaimed}
              serverClockOffsetMs={serverClockOffsetMs}
            />
          </header>

          <div className={styles.tabs} role="tablist" aria-label="Challenge Period">
            <span className={styles.bevelFrame} aria-hidden="true" />
            {TIERS.map((tier) => (
              <button
                key={tier}
                id={`mission-tab-${tier}`}
                type="button"
                role="tab"
                aria-selected={activeTier === tier}
                aria-controls="mission-panel"
                tabIndex={activeTier === tier ? 0 : -1}
                className={`${styles.tab} ${activeTier === tier ? styles.tabActive : ''}`}
                style={{ '--tier-color': TIER_COLORS[tier] } as React.CSSProperties}
                onKeyDown={(event) => handleTierKeyDown(event, tier)}
                onClick={() => {
                  openTier(tier);
                }}
              >
                <CasinoControlIcon
                  variant={TIER_CONTROL_ICONS[tier]}
                  state={activeTier === tier ? 'active' : 'idle'}
                  size="sm"
                />
                <span className={styles.tabLabel}>{TIER_LABELS[tier]}</span>
                <span className={styles.tabCount}>
                  {tierCounts[tier].done}/{tierCounts[tier].total} Complete
                </span>
              </button>
            ))}
          </div>

          <section
            id="mission-panel"
            className={styles.list}
            role="tabpanel"
            aria-labelledby={`mission-tab-${activeTier}`}
            tabIndex={0}
          >
            {visible.length === 0 ? (
              <div className={styles.emptyState}>
                <span className={styles.bevelFrame} aria-hidden="true" />
                <h3>{loadError ? 'Challenge Ledger Offline' : 'No Challenges Assigned'}</h3>
                <p>
                  {loadError
                    ? 'Use Retry Sync Above To Reconnect. Your Recorded Progress Is Safe.'
                    : `Your Next ${TIER_LABELS[activeTier]} Challenge Set Is Being Prepared.`}
                </p>
                {!loadError && (
                  <button
                    type="button"
                    className={styles.retryButton}
                    onClick={() => loadChallenges(userId, 'refresh')}
                    disabled={isRefreshing}
                  >
                    <CasinoControlIcon
                      variant="retry"
                      state={isRefreshing ? 'pending' : 'attention'}
                      size="sm"
                    />
                    {isRefreshing ? 'Preparing...' : 'Refresh Challenge Ledger'}
                  </button>
                )}
              </div>
            ) : (
              visible.map((c, i) => (
                <motion.div
                  key={c.id}
                  initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
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
                    economyBusy={economyBusy}
                    canAffordReroll={diamondBalance >= DAILY_MISSION_REROLL_COST}
                    confirmingReroll={confirmingRerollId === c.id}
                    rerollConfirmationOpen={confirmingRerollId !== null}
                    celebrating={celebratingIds.has(c.id)}
                    onClaim={handleClaim}
                    onRequestReroll={(challenge) => setConfirmingRerollId(challenge.id)}
                    onCancelReroll={() => setConfirmingRerollId(null)}
                    onConfirmReroll={handleReroll}
                    onOpenMission={handleOpenMission}
                  />
                </motion.div>
              ))
            )}
          </section>
        </section>

        <footer className={styles.footer}>
          <span className={styles.bevelFrame} aria-hidden="true" />
          <div>
            <span className={styles.eyebrow}>Casino Floor Concierge</span>
            <h2>Play Poker. Your Challenge Ledger Updates Automatically.</h2>
            <p>
              Hand Results, Pots, Showdowns, Tournaments, And Social Goals Update Automatically.
              Daily Challenges Reset At Midnight UTC, Weekly Challenges Each Monday, And Monthly
              Challenges On The First.
            </p>
          </div>
          <button
            type="button"
            className={styles.playButton}
            onClick={() => navigate(routeClubId ? `/clubs/${routeClubId}` : '/')}
          >
            <CasinoControlIcon variant="play" state="active" size="sm" />
            Browse Cash Games
          </button>
        </footer>
      </div>

      {confirmingFreeze &&
        createPortal(
          <div
            className={styles.celebrateOverlay}
            role="dialog"
            aria-modal="true"
            aria-labelledby="freeze-purchase-title"
            aria-describedby="freeze-purchase-description"
            onClick={dismissFreezePurchase}
          >
            <div
              ref={freezeDialogRef}
              className={`${styles.celebrateCard} ${styles.freezeDialogCard}`}
              data-dialog-card="fixed-frame"
              onClick={(event) => event.stopPropagation()}
            >
              <span className={styles.bevelFrame} data-dialog-frame="fixed" aria-hidden="true" />
              <div className={styles.celebrateCardScroll} data-dialog-scroll="true">
                <FreezeVaultGraphic />
                <span className={styles.panelLabel}>Streak Protection Desk</span>
                <h2 id="freeze-purchase-title" className={styles.celebrateTitle} tabIndex={-1}>
                  Secure A Streak Freeze?
                </h2>
                <p id="freeze-purchase-description" className={styles.freezeDialogDescription}>
                  One Freeze Protects Your Current Run Through One Missed Daily Challenge Cycle.
                </p>
                <div className={styles.freezePurchaseLedger}>
                  <div>
                    <span>Vault Price</span>
                    <strong className={styles.balanceWithGem}>
                      <DiamondMark /> 5,000 Diamonds
                    </strong>
                  </div>
                  <div>
                    <span>Balance After Purchase</span>
                    <strong className={styles.balanceWithGem}>
                      <DiamondMark /> {Math.max(0, diamondBalance - 5000).toLocaleString()} Diamonds
                    </strong>
                  </div>
                </div>
                <div className={styles.freezeDialogActions}>
                  <button
                    type="button"
                    className={styles.cancelButton}
                    disabled={buyingFreeze}
                    onClick={dismissFreezePurchase}
                  >
                    <CasinoControlIcon variant="keep" state="idle" size="sm" />
                    Keep My Diamonds
                  </button>
                  <button
                    type="button"
                    className={styles.confirmButton}
                    onClick={handleBuyFreeze}
                    disabled={buyingFreeze}
                    aria-busy={buyingFreeze}
                  >
                    <CasinoControlIcon
                      variant="freeze"
                      state={buyingFreeze ? 'pending' : 'attention'}
                      size="sm"
                    />
                    {buyingFreeze ? 'Confirming Purchase...' : 'Buy Streak Freeze'}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}

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
              data-dialog-card="fixed-frame"
              onClick={(event) => event.stopPropagation()}
            >
              <span className={styles.bevelFrame} data-dialog-frame="fixed" aria-hidden="true" />
              <div className={styles.celebrateCardScroll} data-dialog-scroll="true">
                <img
                  className={styles.celebrateArtwork}
                  src={mediaUrl(MISSION_REWARD_ARTWORK)}
                  alt=""
                  width="640"
                  height="474"
                  decoding="async"
                  aria-hidden="true"
                />
                <h2 id="challenge-reward-title" className={styles.celebrateTitle} tabIndex={-1}>
                  Reward Settled
                </h2>
                <p id="challenge-reward-description" className={styles.celebrateName}>
                  {reward.name}
                </p>

                <div className={styles.celebratePayouts} role="group" aria-label="Rewards Earned">
                  {reward.challengeDiamonds > 0 && (
                    <div className={styles.celebrateDiamondPayout}>
                      <span className={styles.celebratePayoutValue}>
                        +{reward.challengeDiamonds.toLocaleString()}
                      </span>
                      <span className={styles.celebratePayoutLabel}>
                        Challenge {reward.challengeDiamonds === 1 ? 'Diamond' : 'Diamonds'}
                      </span>
                    </div>
                  )}
                  {reward.milestoneDiamonds > 0 && (
                    <div className={styles.celebrateMilestonePayout}>
                      <span className={styles.celebratePayoutValue}>
                        +{reward.milestoneDiamonds.toLocaleString()}
                      </span>
                      <span className={styles.celebratePayoutLabel}>Streak Bonus Diamonds</span>
                    </div>
                  )}
                </div>

                {reward.diamonds > 0 && (
                  <div className={styles.celebrateBalanceLedger}>
                    <p className={styles.celebrateTotal}>
                      Total Credited: +{reward.diamonds.toLocaleString()} Diamonds
                    </p>
                    <p className={styles.celebrateBalance}>
                      New Balance: {reward.diamondBalance.toLocaleString()} Diamonds
                    </p>
                  </div>
                )}

                <p className={styles.celebrateReceipt} role="status">
                  Added To Your Club Arena Diamond Balance
                </p>

                <button type="button" className={styles.celebrateButton} onClick={dismissReward}>
                  <CasinoControlIcon variant="continue" state="success" size="sm" />
                  Continue
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </StandardContentLayout>
  );
}
