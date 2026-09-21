import { useCallback, useEffect, useState } from 'react';
import { dailyChallengeService } from '../../../services/DailyChallengeService';
import { useMasterBusBroadcastChannel } from '../../../hooks/useMasterBusBroadcastChannel';
import type { useIsMounted } from '../../../hooks/useIsMounted';
import { getUtcDateKey } from '../../../utils/challengeReset';
import { dailyMissionRevisionFromPayload } from '../../../utils/dailyMissionReceipt';
import { recordDailyMissionOperation } from '../../../services/DailyMissionTelemetryService';
import type { DailyMissionDashboardRefs } from './useDailyMissionDashboard';

/**
 * Event-driven catch-up for the dashboard: the debounced realtime refresh,
 * the bounded revision-cursor read, the tab resume listener, the unmount
 * and account-change cleanups and the private per-player broadcast channel
 * that reports the live, connecting or degraded state.
 */
export function useDailyMissionRealtimeCatchUp({
  userId,
  refs,
  isMountedRef,
  loadChallenges,
}: {
  userId: string | null;
  refs: DailyMissionDashboardRefs;
  isMountedRef: ReturnType<typeof useIsMounted>;
  loadChallenges: (uid: string, mode: 'initial' | 'refresh' | 'silent') => Promise<void>;
}) {
  const [realtimeState, setRealtimeState] = useState<'connecting' | 'live' | 'degraded'>(
    'connecting'
  );
  const {
    serverClockOffsetRef,
    periodKeysRef,
    lastResumeRefreshRef,
    initialLoadSettledRef,
    dashboardRevisionRef,
    dashboardRequestsInFlightRef,
    queuedRealtimeRevisionRef,
    queuedUnversionedRealtimeRef,
    realtimeRefreshTimerRef,
    realtimeStatusRef,
    catchUpGenerationRef,
    cursorReadInFlightRef,
    cursorCatchUpPendingRef,
    userIdRef,
  } = refs;

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
    [
      userId,
      loadChallenges,
      dashboardRequestsInFlightRef,
      dashboardRevisionRef,
      queuedRealtimeRevisionRef,
      queuedUnversionedRealtimeRef,
      realtimeRefreshTimerRef,
    ]
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
  }, [
    isMountedRef,
    scheduleRealtimeRefresh,
    catchUpGenerationRef,
    cursorCatchUpPendingRef,
    cursorReadInFlightRef,
    dashboardRevisionRef,
    userIdRef,
  ]);

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
  }, [
    userId,
    loadChallenges,
    requestCursorCatchUp,
    initialLoadSettledRef,
    lastResumeRefreshRef,
    periodKeysRef,
    serverClockOffsetRef,
  ]);

  useEffect(
    () => () => {
      if (realtimeRefreshTimerRef.current) clearTimeout(realtimeRefreshTimerRef.current);
    },
    [realtimeRefreshTimerRef]
  );

  useEffect(
    () => () => {
      catchUpGenerationRef.current += 1;
      cursorCatchUpPendingRef.current = false;
    },
    [userId, catchUpGenerationRef, cursorCatchUpPendingRef]
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

  return { realtimeState };
}
