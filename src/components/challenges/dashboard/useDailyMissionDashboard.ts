import { useCallback, useEffect, useRef, useState } from 'react';
import { getAuthUser } from '../../../lib/supabase';
import {
  dailyChallengeService,
  type Tier,
  type ChallengeStreak,
  type DailyChallengeDashboard,
  type DailyChallengeStats,
  type DailyChallengeRewardVault,
} from '../../../services/DailyChallengeService';
import type { useIsMounted } from '../../../hooks/useIsMounted';
import { reportError } from '../../../utils/errorReporter';
import { msUntilChallengeReset } from '../../../utils/challengeReset';
import {
  isCurrentDailyMissionDashboardReceipt,
  shouldRefreshQueuedDailyMissionRealtime,
} from '../../../utils/dailyMissionReceipt';
import { capture } from '../../../lib/analytics';
import {
  dailyMissionReasonCode,
  recordDailyMissionOperation,
} from '../../../services/DailyMissionTelemetryService';
import type { TieredChallenge } from './missionPresentation';

/**
 * The Daily Challenges dashboard: its state, the shared refs bag, the
 * revision-fenced projection, the dashboard loader, the secure-session
 * initialization and the UTC daily-reset rollover.
 */
export function useDailyMissionDashboard({
  isMountedRef,
}: {
  isMountedRef: ReturnType<typeof useIsMounted>;
}) {
  const [userId, setUserId] = useState<string | null>(null);
  const [authRetryNonce, setAuthRetryNonce] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState<number | null>(null);

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
  // One owner for every loader, catch-up and mutation ref. The realtime
  // catch-up and the action handlers receive this bag, so the queue the
  // loader drains in `finally` is the queue the broadcast handler fills.
  const refs = useRef({
    loadRequestRef,
    mutationEpochRef,
    serverClockOffsetRef,
    periodKeysRef,
    lastResumeRefreshRef,
    initialLoadSettledRef,
    dashboardRevisionRef,
    diamondBalanceRef,
    dashboardRequestsInFlightRef,
    queuedRealtimeRevisionRef,
    queuedUnversionedRealtimeRef,
    realtimeRefreshTimerRef,
    realtimeStatusRef,
    catchUpGenerationRef,
    cursorReadInFlightRef,
    cursorCatchUpPendingRef,
    userIdRef,
    loadChallengesRef,
  }).current;

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

  return {
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
  };
}

export type DailyMissionDashboardRefs = ReturnType<typeof useDailyMissionDashboard>['refs'];
