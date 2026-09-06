import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dailyMissionReasonCode,
  recordDailyMissionOperation,
  shouldRecordDailyMissionOperation,
} from '../../src/services/DailyMissionTelemetryService';

describe('Daily Mission operational telemetry', () => {
  it('keeps every material action, failure, and recovery signal', () => {
    for (const event of [
      'dashboard_failed',
      'claim_succeeded',
      'claim_failed',
      'claim_all_succeeded',
      'claim_all_failed',
      'reroll_succeeded',
      'reroll_failed',
      'freeze_succeeded',
      'freeze_failed',
      'realtime_degraded',
      'realtime_recovered',
      'alerts_enabled',
      'alerts_disabled',
      'alerts_failed',
    ] as const) {
      expect(shouldRecordDailyMissionOperation(event, 0.999)).toBe(true);
    }
  });

  it('samples routine dashboard and navigation success traffic', () => {
    expect(shouldRecordDailyMissionOperation('dashboard_loaded', 0.1)).toBe(true);
    expect(shouldRecordDailyMissionOperation('dashboard_loaded', 0.9)).toBe(false);
    expect(shouldRecordDailyMissionOperation('mission_cta_opened', 0.1)).toBe(true);
    expect(shouldRecordDailyMissionOperation('mission_cta_opened', 0.9)).toBe(false);
  });

  it('stores bounded reason categories and never throws into the mission path', () => {
    expect(dailyMissionReasonCode({ code: 'PGRST 204 / Bad' })).toBe('pgrst_204_bad');
    expect(() =>
      recordDailyMissionOperation({ userId: null, event: 'dashboard_failed' })
    ).not.toThrow();
  });
});

describe('Daily Mission feedback, consent, and health wiring', () => {
  const page = readFileSync(
    path.resolve(__dirname, '../../src/pages/DailyChallengesPage.tsx'),
    'utf8'
  );
  const preference = readFileSync(
    path.resolve(__dirname, '../../src/services/DailyMissionNotificationService.ts'),
    'utf8'
  );
  const migration = readFileSync(
    path.resolve(
      __dirname,
      '../../supabase/migrations/20260831150000_daily_mission_alerts_and_observability.sql'
    ),
    'utf8'
  );
  const alertContractFix = readFileSync(
    path.resolve(
      __dirname,
      '../../supabase/migrations/20260831150100_daily_mission_alert_enqueue_contract_fix.sql'
    ),
    'utf8'
  );
  const authority = readFileSync(
    path.resolve(
      __dirname,
      '../../supabase/migrations/20260901030000_daily_missions_server_authority.sql'
    ),
    'utf8'
  );
  const operationsIndex = readFileSync(
    path.resolve(
      __dirname,
      '../../supabase/migrations/20260906100500_daily_mission_operations_user_index.sql'
    ),
    'utf8'
  );

  it('keeps push permission on the original click path and stores explicit consent', () => {
    expect(page).toContain('const pushResultPromise = enablePush();');
    expect(page).toMatch(
      /const pushResultPromise = enablePush\(\);[\s\S]{0,120}await pushResultPromise/
    );
    expect(page).toContain('setDailyMissionAlertPreference(userId, true)');
    expect(page).toContain('setDailyMissionAlertPreference(userId, false)');
    expect(page).toContain('Reconnect This Device');
    expect(page).toContain('Turn Off Without Reconnecting');
    expect(preference).toContain(".select('daily_mission_reminders')");
    expect(preference).toContain("{ onConflict: 'user_id' }");
  });

  it('ships explicit opt-in, exactly-once cycle enqueue, and the canonical bridge', () => {
    expect(migration).toMatch(/daily_mission_reminders boolean NOT NULL DEFAULT false/);
    expect(migration).toContain('notifications_daily_mission_cycle_unique');
    expect(migration).toContain('enqueue_daily_mission_reset_notifications');
    expect(migration).toContain("'/hub/club-arena/challenges'");
    expect(migration).toContain("type = 'daily_challenge'");
    expect(migration).not.toMatch(/INSERT INTO public\.push_outbox/i);
    expect(migration).toMatch(/GRANT EXECUTE[\s\S]*TO service_role/);
    expect(alertContractFix).toContain('INSERT INTO public.notifications');
    expect(alertContractFix).toMatch(/title,[\s\S]{0,30}message,[\s\S]{0,30}link,/);
    expect(alertContractFix).not.toMatch(/\n\s*body,?/);
  });

  it('wires settlement feedback and every critical operation into health signals', () => {
    expect(page).toContain('Reward Settled');
    expect(page).toContain('Added To Your Club Arena Diamond Balance');
    for (const event of [
      'dashboard_loaded',
      'dashboard_failed',
      'claim_succeeded',
      'claim_failed',
      'claim_all_succeeded',
      'claim_all_failed',
      'reroll_succeeded',
      'reroll_failed',
      'freeze_succeeded',
      'freeze_failed',
      'realtime_degraded',
      'realtime_recovered',
      'alerts_enabled',
      'alerts_disabled',
      'alerts_failed',
      'mission_cta_opened',
    ]) {
      expect(page).toContain(`event: '${event}'`);
    }
  });

  it('ships private telemetry with explicit retention and aggregate health views', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.daily_mission_operations/);
    expect(migration).toMatch(/WITH CHECK \(user_id = auth\.uid\(\)\)/);
    expect(migration).toContain('v_daily_mission_health_hourly');
    expect(migration).toContain('v_daily_mission_health_daily');
    expect(migration).toContain('fn_prune_daily_mission_operations');
    expect(migration).toMatch(/percentile_disc\(0\.95\)/);
    expect(authority).toContain('DROP POLICY IF EXISTS daily_mission_operations_insert_own');
    expect(authority).toContain(
      'REVOKE INSERT ON public.daily_mission_operations FROM authenticated'
    );
    expect(authority).toContain('CREATE OR REPLACE FUNCTION public.record_daily_mission_operation');
    expect(authority).toContain('>= 60 THEN');
    expect(operationsIndex).toContain('daily_mission_operations_user_created_idx');
    expect(operationsIndex).toContain('(user_id, created_at DESC)');
  });
});
