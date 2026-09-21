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

import { useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../components/common/Toast';
import { MissionLedgerList } from '../components/challenges/dashboard/MissionLedgerList';
import { MissionCycleRail } from '../components/challenges/dashboard/MissionCycleRail';
import { MissionStreakConsole } from '../components/challenges/dashboard/MissionStreakConsole';
import { MissionSummaryGrid } from '../components/challenges/dashboard/MissionSummaryGrid';
import { MissionHero } from '../components/challenges/dashboard/MissionHero';
import { MissionSyncNotice } from '../components/challenges/dashboard/MissionSyncNotice';
import { MissionRewardVault } from '../components/challenges/dashboard/MissionRewardVault';
import { MissionFooter } from '../components/challenges/dashboard/MissionFooter';
import { useReducedMotion } from 'framer-motion';
import { type Tier } from '../services/DailyChallengeService';
import { useIsMounted } from '../hooks/useIsMounted';
import { useFocusTrap } from '../hooks/useFocusTrap';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import styles from './DailyChallengesPage.module.css';
import { useClubWorkspace } from '../contexts/ClubWorkspaceContext';
import {
  MISSION_DATE_FORMATTER,
  MISSION_DIAMOND_ARTWORK,
  MISSION_REWARD_ARTWORK,
  MISSION_SYNC_FORMATTER,
  TIER_COLORS,
  TIER_CONTROL_ICONS,
  TIER_LABELS,
  TIER_PRESENTATION,
  TIERS,
  type TieredChallenge,
} from '../components/challenges/dashboard/missionPresentation';
import { DiamondMark, MissionHeroArtwork } from '../components/challenges/dashboard/MissionArtwork';
import { MissionLoadingState } from '../components/challenges/dashboard/MissionLoadingState';
import { MissionUnavailableState } from '../components/challenges/dashboard/MissionUnavailableState';
import {
  MissionCycleCountdown,
  MissionResetReadout,
} from '../components/challenges/dashboard/MissionClockLeaves';
import { MissionAlertsPanel } from '../components/challenges/dashboard/MissionAlertsPanel';
import { MissionFreezePurchaseDialog } from '../components/challenges/dashboard/MissionFreezePurchaseDialog';
import { MissionRewardSettlementDialog } from '../components/challenges/dashboard/MissionRewardSettlementDialog';
import { useDailyMissionDashboard } from '../components/challenges/dashboard/useDailyMissionDashboard';
import { useDailyMissionRealtimeCatchUp } from '../components/challenges/dashboard/useDailyMissionRealtimeCatchUp';
import { useDailyMissionActions } from '../components/challenges/dashboard/useDailyMissionActions';
import { useInertAppShell } from '../components/challenges/dashboard/useInertAppShell';
import { useMissionCycleRoute } from '../components/challenges/dashboard/useMissionCycleRoute';

// ═══════════════════════════════════════════════════════════════════════════════
// CARDS
// ═══════════════════════════════════════════════════════════════════════════════

// The mission card is src/components/challenges/dashboard/MissionCard.tsx (Phase 3, step 9).

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function DailyChallengesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { cycle } = useParams<{ cycle?: string }>();
  const { routeClubId } = useClubWorkspace();
  const isMountedRef = useIsMounted();
  const toast = useToast();
  const reduceMotion = useReducedMotion();

  // Hook order is load-bearing for effect order. Reading top to bottom, the
  // effects run: loader ref sync, initialization, daily-reset rollover
  // (dashboard); resume listener, timer cleanup, generation bump, broadcast
  // channel (realtime); reroll Escape, stale reroll close, freeze focus
  // restore, freeze Escape (actions); the two focus traps and the inert
  // shell; document title and cycle route (route); toast theme; reward
  // Escape. Before the hooks were cut the page declared the title, toast
  // theme, cycle route and reroll Escape effects first; every effect here
  // owns its own DOM node, listener or timer, so the two orders are
  // observably the same.
  const {
    userId,
    setAuthRetryNonce,
    isLoading,
    setIsLoading,
    isRefreshing,
    loadError,
    lastSyncedAt,
    serverClockOffsetMs,
    challenges,
    setChallenges,
    stats,
    streak,
    diamondBalance,
    rewardVault,
    setRewardVault,
    refs,
    installDashboardProjection,
    loadChallenges,
  } = useDailyMissionDashboard({ isMountedRef });
  const { realtimeState } = useDailyMissionRealtimeCatchUp({
    userId,
    refs,
    isMountedRef,
    loadChallenges,
  });
  const {
    claimingIds,
    claimingAll,
    rerollingIds,
    confirmingRerollId,
    setConfirmingRerollId,
    buyingFreeze,
    confirmingFreeze,
    setConfirmingFreeze,
    economyBusy,
    economyGuardRef,
    celebratingIds,
    reward,
    setReward,
    handleClaim,
    dismissFreezePurchase,
    handleBuyFreeze,
    handleReroll,
    handleClaimAll,
  } = useDailyMissionActions({
    userId,
    diamondBalance,
    challenges,
    setChallenges,
    setRewardVault,
    installDashboardProjection,
    loadChallenges,
    refs,
    isMountedRef,
    toast,
  });
  const celebrateDialogRef = useFocusTrap(!!reward, '#challenge-reward-title');
  const freezeDialogRef = useFocusTrap(confirmingFreeze, '#freeze-purchase-title');
  useInertAppShell(!!reward || confirmingFreeze);

  const { activeTier, openTier, handleTierKeyDown, handleOpenMission } = useMissionCycleRoute({
    cycle,
    location,
    navigate,
    routeClubId,
    userId,
    setConfirmingRerollId,
  });

  useEffect(() => {
    document.body.dataset.toastTheme = 'daily-missions-casino';
    return () => {
      if (document.body.dataset.toastTheme === 'daily-missions-casino') {
        delete document.body.dataset.toastTheme;
      }
    };
  }, []);

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
  }, [activeTier, reward, setReward]);

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

  // ── Render ──

  if (isLoading) {
    return <MissionLoadingState tier={activeTier} />;
  }

  if (!userId) {
    if (loadError) {
      return (
        <MissionUnavailableState
          tier={activeTier}
          message={loadError}
          retryLabel="Retry Session Check"
          onRetry={() => {
            setIsLoading(true);
            setAuthRetryNonce((value) => value + 1);
          }}
        />
      );
    }
    // AuthGuard owns the signed-out handoff; a signed-out visitor never mounts this page.
    return null;
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

  const goToArena = () => navigate(routeClubId ? `/clubs/${routeClubId}` : '/');

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
        <MissionHero
          tier={activeTier}
          diamondBalance={diamondBalance}
          syncLabel={syncLabel}
          done={tierCounts[activeTier].done}
          total={tierCounts[activeTier].total}
          reduceMotion={reduceMotion}
          onBackToArena={goToArena}
          artwork={<MissionHeroArtwork tier={activeTier} />}
          countdown={
            <MissionCycleCountdown tier={activeTier} serverClockOffsetMs={serverClockOffsetMs} />
          }
          diamondMark={<DiamondMark />}
          TIER_PRESENTATION={TIER_PRESENTATION}
          TIER_LABELS={TIER_LABELS}
        />

        {loadError && (
          <MissionSyncNotice
            loadError={loadError}
            lastSyncedAt={lastSyncedAt}
            isRefreshing={isRefreshing}
            onRetry={() => userId && loadChallenges(userId, 'refresh')}
            MISSION_SYNC_FORMATTER={MISSION_SYNC_FORMATTER}
          />
        )}

        <section className={styles.commandDeck} aria-label="Challenge Status">
          <MissionStreakConsole
            streak={streak}
            stats={stats}
            diamondBalance={diamondBalance}
            buyingFreeze={buyingFreeze}
            economyBusy={economyBusy}
            reduceMotion={reduceMotion}
            onRequestFreeze={() => {
              if (!economyGuardRef.current) setConfirmingFreeze(true);
            }}
            diamondMark={<DiamondMark />}
            MISSION_DATE_FORMATTER={MISSION_DATE_FORMATTER}
          />

          <MissionSummaryGrid
            tier={activeTier}
            done={tierCounts[activeTier].done}
            total={tierCounts[activeTier].total}
            stats={stats}
            diamondMark={<DiamondMark />}
            TIER_LABELS={TIER_LABELS}
          />
        </section>

        {unclaimed.count > 0 && (
          <MissionRewardVault
            unclaimed={unclaimed}
            claimingAll={claimingAll}
            economyBusy={economyBusy}
            onClaimAll={handleClaimAll}
            MISSION_REWARD_ARTWORK={MISSION_REWARD_ARTWORK}
          />
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

          <MissionCycleRail
            activeTier={activeTier}
            tierCounts={tierCounts}
            onOpenTier={openTier}
            onTierKeyDown={handleTierKeyDown}
            TIERS={TIERS}
            TIER_LABELS={TIER_LABELS}
            TIER_COLORS={TIER_COLORS}
            TIER_CONTROL_ICONS={TIER_CONTROL_ICONS}
          />

          <MissionLedgerList
            visible={visible}
            activeTier={activeTier}
            loadError={loadError}
            isRefreshing={isRefreshing}
            onRefresh={() => loadChallenges(userId, 'refresh')}
            claimingIds={claimingIds}
            rerollingIds={rerollingIds}
            economyBusy={economyBusy}
            diamondBalance={diamondBalance}
            confirmingRerollId={confirmingRerollId}
            celebratingIds={celebratingIds}
            reduceMotion={reduceMotion}
            onClaim={handleClaim}
            onRequestReroll={(challenge) => setConfirmingRerollId(challenge.id)}
            onCancelReroll={() => setConfirmingRerollId(null)}
            onConfirmReroll={handleReroll}
            onOpenMission={handleOpenMission}
            diamondMark={<DiamondMark />}
            TIER_COLORS={TIER_COLORS}
            TIER_LABELS={TIER_LABELS}
            MISSION_DIAMOND_ARTWORK={MISSION_DIAMOND_ARTWORK}
          />
        </section>

        <MissionFooter onBrowseArena={goToArena} />
      </div>

      {confirmingFreeze &&
        createPortal(
          <MissionFreezePurchaseDialog
            diamondBalance={diamondBalance}
            buyingFreeze={buyingFreeze}
            dialogRef={freezeDialogRef}
            onDismiss={dismissFreezePurchase}
            onConfirmPurchase={handleBuyFreeze}
          />,
          document.body
        )}

      {reward &&
        createPortal(
          <MissionRewardSettlementDialog
            reward={reward}
            reduceMotion={reduceMotion}
            dialogRef={celebrateDialogRef}
            onDismiss={dismissReward}
          />,
          document.body
        )}
    </StandardContentLayout>
  );
}
