import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readDailyChallengesSurface,
  readDailyChallengesUnit,
} from './helpers/dailyChallengesSources';

const migration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260831130000_daily_challenge_dashboard_realtime_revision.sql'
  ),
  'utf8'
);
const publicationRepair = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260901074500_daily_mission_revision_publication_repair.sql'
  ),
  'utf8'
);
const publicationRefresh = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260902050000_daily_mission_realtime_publication_refresh.sql'
  ),
  'utf8'
);
const privateBroadcast = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260902060000_daily_mission_private_broadcast.sql'),
  'utf8'
);
const certificationRepair = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260906093500_daily_mission_certification_repairs.sql'
  ),
  'utf8'
);
const page = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.tsx'), 'utf8');
const dashboard = readDailyChallengesUnit('useDailyMissionDashboard.ts');
const realtime = readDailyChallengesUnit('useDailyMissionRealtimeCatchUp.ts');
const surface = readDailyChallengesSurface();
const completionListener = readFileSync(
  resolve(__dirname, '../src/components/notifications/ChallengeToastListener.tsx'),
  'utf8'
);
const broadcastHook = readFileSync(
  resolve(__dirname, '../src/hooks/useMasterBusBroadcastChannel.ts'),
  'utf8'
);
const clock = readFileSync(resolve(__dirname, '../src/hooks/useChallengeClock.ts'), 'utf8');

describe('Daily Missions realtime and render-isolation contract', () => {
  it('publishes one private per-user revision covering every dashboard input', () => {
    expect(migration).toContain('daily_challenge_dashboard_revisions');
    expect(migration).toContain('users read own daily challenge revision');
    expect(migration).toContain('(SELECT auth.uid()) = user_id');
    expect(migration).toContain('trg_daily_challenge_revision_from_contract');
    expect(migration).toContain('trg_daily_challenge_revision_from_streak');
    expect(migration).toContain('trg_daily_challenge_revision_from_diamonds');
    expect(migration).toContain('ALTER PUBLICATION supabase_realtime');
    expect(migration).toContain('OLD.diamonds IS DISTINCT FROM NEW.diamonds');
  });

  it('repairs the duplicate-version split state under a unique migration version', () => {
    expect(publicationRepair).toContain('20260831130000 was accidentally used by TWO');
    expect(publicationRepair).toContain('ADD TABLE public.daily_challenge_dashboard_revisions');
    expect(publicationRepair).toContain('REPLICA IDENTITY FULL');
    expect(publicationRepair).toContain('users read own daily challenge revision');
    expect(publicationRepair).toContain(
      'Daily Missions revision publication has incomplete trigger coverage'
    );
    const repairVersion = '20260901074500';
    const matchingVersions = readdirSync(resolve(__dirname, '../supabase/migrations')).filter(
      (name) => name.startsWith(`${repairVersion}_`)
    );
    expect(matchingVersions).toEqual([
      '20260901074500_daily_mission_revision_publication_repair.sql',
    ]);
  });

  it('refreshes stale Realtime relation state without exposing browser writes', () => {
    expect(publicationRefresh).toContain('DROP TABLE public.daily_challenge_dashboard_revisions');
    expect(publicationRefresh).toContain('ADD TABLE public.daily_challenge_dashboard_revisions');
    expect(publicationRefresh).toContain('REPLICA IDENTITY FULL');
    expect(publicationRefresh).toContain('FROM PUBLIC, anon, authenticated');
    expect(publicationRefresh).toContain('TO authenticated, service_role');
    expect(publicationRefresh).toContain("'INSERT,UPDATE,DELETE'");
    expect(publicationRefresh.indexOf('DROP TABLE')).toBeLessThan(
      publicationRefresh.indexOf('ADD TABLE')
    );
  });

  it('moves the refresh signal to an authenticated private per-player Broadcast', () => {
    expect(privateBroadcast).toContain('ON realtime.messages');
    expect(privateBroadcast).toContain("realtime.messages.extension = 'broadcast'");
    expect(privateBroadcast).toContain("'daily-mission-revision:' || (SELECT auth.uid())::text");
    expect(privateBroadcast).toContain("'daily_mission_revision_changed'");
    expect(privateBroadcast).toContain('DROP TABLE public.daily_challenge_dashboard_revisions');
    expect(privateBroadcast).toContain("jsonb_build_object('revision', v_revision)");
    expect(privateBroadcast).not.toContain('GRANT INSERT');

    expect(realtime).toContain('useMasterBusBroadcastChannel({');
    expect(realtime).toContain('channelName: userId ? `daily-mission-revision:${userId}` : null');
    expect(realtime).toContain("event: 'daily_mission_revision_changed'");
    expect(realtime).toContain('private: true');
    expect(realtime).toContain('onSubscriptionError:');
    expect(realtime).toContain('onSubscriptionStatus:');
    expect(surface).not.toContain("table: 'user_daily_challenges'");

    expect(broadcastHook).toContain(".on('broadcast', { event }");
    expect(broadcastHook).toContain('await supabase.realtime.setAuth()');
    expect(broadcastHook.indexOf('await supabase.realtime.setAuth()')).toBeLessThan(
      broadcastHook.indexOf('masterBus.getOrCreateChannel')
    );
    expect(broadcastHook).toContain('masterBus.registerChannelFactory');
    expect(broadcastHook).toContain('masterBus.removeRegisteredChannel');
  });

  it('coalesces event bursts and catches up only on lifecycle events', () => {
    expect(realtime).toContain('scheduleRealtimeRefresh');
    expect(realtime).toContain("loadChallenges(userId, 'silent')");
    expect(realtime).toContain('dashboardRequestsInFlightRef.current > 0');
    expect(realtime).toContain('queuedRealtimeRevisionRef.current = Math.max');
    expect(realtime).toContain('queuedUnversionedRealtimeRef.current = true');
    expect(dashboard).toContain('shouldRefreshQueuedDailyMissionRealtime(');
    expect(realtime).toContain('announcedRevision <= dashboardRevisionRef.current');
    expect(realtime).toContain('revision > dashboardRevisionRef.current');
    expect(realtime).toContain("document.visibilityState !== 'visible'");
    expect(surface).not.toContain("'CHALLENGE_PROGRESS_UPDATED'");
    expect(surface).not.toMatch(/setInterval\s*\(/);
  });

  it('owns catch-up with one bounded cursor read per lifecycle event and no repair timer', () => {
    // The durable record is the per-user revision cursor. The wake sources are
    // events only: a broadcast payload, a new subscription generation, a tab
    // resume, and the daily-reset product clock. Nothing repeats on its own.
    expect(realtime).toContain('const requestCursorCatchUp = useCallback(');
    expect(realtime).toContain('.getDashboardRevision(uid)');
    expect(realtime).toContain('catchUpGenerationRef');
    expect(realtime).toContain('cursorReadInFlightRef');
    expect(realtime).toContain('cursorCatchUpPendingRef');
    expect(realtime).toContain('generation !== catchUpGenerationRef.current');
    expect(realtime).toContain('uid !== userIdRef.current');
    expect(surface).not.toContain('reconcileRevision');
    expect(surface).not.toMatch(/15_000/);
    expect(surface).not.toMatch(/setTimeout\(\s*\w*(reconcile|poll|watch|repair|heal)\w*\s*,/i);
    expect(surface).not.toMatch(/setInterval\s*\(/);

    // A channel error only marks the page degraded and retires the generation.
    const onError = realtime.slice(
      realtime.indexOf('onSubscriptionError: () => {'),
      realtime.indexOf('onSubscriptionStatus: (status) => {')
    );
    expect(onError).toContain('catchUpGenerationRef.current += 1');
    expect(onError).toContain("setRealtimeState('degraded')");
    expect(onError).not.toContain('scheduleRealtimeRefresh(');
    expect(onError).not.toContain('loadChallenges(');
    expect(onError).not.toContain('getDashboardRevision');

    // Every SUBSCRIBED status, first join or rejoin, performs the same bounded read.
    const onStatus = realtime.slice(realtime.indexOf('onSubscriptionStatus: (status) => {'));
    const statusBody = onStatus.slice(0, onStatus.indexOf('  });'));
    expect(statusBody).toContain('catchUpGenerationRef.current += 1');
    expect(statusBody).toContain("if (status !== 'SUBSCRIBED') return;");
    expect(statusBody).toContain('requestCursorCatchUp();');
    expect(statusBody).not.toContain('scheduleRealtimeRefresh(');
    expect(statusBody).not.toContain('loadChallenges(');

    // Resume performs the cursor read too; only a UTC date change reloads outright.
    const resume = realtime.slice(
      realtime.indexOf('const refreshAfterResume = () => {'),
      realtime.indexOf("document.addEventListener('visibilitychange', refreshAfterResume);")
    );
    expect(resume).toContain('requestCursorCatchUp();');
    expect(resume).toContain('if (dateChanged) {');
    expect(resume).not.toContain('60_000');

    // The daily-reset clock is product timing and stays.
    expect(dashboard).toContain("msUntilChallengeReset('daily', serverNow)");
  });

  it('broadcasts completion once on a private topic and retains account-delete safety', () => {
    expect(certificationRepair).toContain('users receive own daily mission completion broadcasts');
    expect(certificationRepair).toContain("'daily_mission_completed'");
    expect(certificationRepair).toContain("'daily-mission-completion:' || v_user_id::text");
    expect(certificationRepair).toContain('OLD.completed IS NOT TRUE');
    expect(certificationRepair).toContain('NEW.completed IS TRUE');
    expect(certificationRepair).toContain(
      'EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_user_id)'
    );
    expect(completionListener).toContain(
      'channelName: userId ? `daily-mission-completion:${userId}` : null'
    );
    expect(completionListener).toContain("event: 'daily_mission_completed'");
    expect(completionListener).not.toContain("'postgres_changes'");
  });

  it('keeps the live clock outside page state and inside subscribing leaves', () => {
    expect(clock).toContain('useSyncExternalStore');
    expect(clock).toContain('export const challengeClock = new ChallengeClockStore()');
    const clockLeaves = readDailyChallengesUnit('MissionClockLeaves.tsx');
    expect(clockLeaves).toContain('function MissionCycleCountdown');
    expect(clockLeaves).toContain('function MissionResetReadout');
    expect(readDailyChallengesSurface()).not.toContain('const [now, setNow]');
  });
});
