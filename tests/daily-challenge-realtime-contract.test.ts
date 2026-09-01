import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
const page = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.tsx'), 'utf8');
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

  it('subscribes through the recoverable MasterBus channel with a server-side user filter', () => {
    expect(page).toContain('useMasterBusChannel({');
    expect(page).toContain("table: 'daily_challenge_dashboard_revisions'");
    expect(page).toContain('filter: userId ? `user_id=eq.${userId}` : null');
    expect(page).toContain('onSubscriptionError:');
    expect(page).toContain('onSubscriptionStatus:');
    expect(page).not.toContain('.channel(`daily-challenges:');
    expect(page).not.toContain("table: 'user_daily_challenges'");
  });

  it('coalesces event bursts and repairs dropped events with a visible-tab cursor read', () => {
    expect(page).toContain('scheduleRealtimeRefresh');
    expect(page).toContain("loadChallenges(userId, 'silent')");
    expect(page).toContain('dailyChallengeService.getDashboardRevision(userId)');
    expect(page).toContain('revision > dashboardRevisionRef.current');
    expect(page).toContain("document.visibilityState === 'visible'");
    expect(page).toContain('setTimeout(reconcileRevision, 15_000)');
    expect(page).not.toContain("'CHALLENGE_PROGRESS_UPDATED'");
    expect(page).not.toMatch(/setInterval\s*\(/);
  });

  it('keeps the live clock outside page state and inside subscribing leaves', () => {
    expect(clock).toContain('useSyncExternalStore');
    expect(clock).toContain('export const challengeClock = new ChallengeClockStore()');
    expect(page).toContain('function MissionCycleCountdown');
    expect(page).toContain('function MissionResetReadout');
    expect(page).not.toContain('const [now, setNow]');
  });
});
