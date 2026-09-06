import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260906113000_daily_missions_serialized_replay_streak_and_reset_safety.sql'
  ),
  'utf8'
);
const engineProjection = readFileSync(
  resolve(__dirname, '../server/src/engine/dailyMissionEvents.ts'),
  'utf8'
);

const section = (start: string, end: string) => {
  const startAt = migration.indexOf(start);
  const endAt = migration.indexOf(end, startAt + start.length);
  expect(startAt, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endAt, `missing section end: ${end}`).toBeGreaterThan(startAt);
  return migration.slice(startAt, endAt);
};

describe('Daily Missions database safety certification', () => {
  it('serializes one player transaction before locking the profile or revision cursor', () => {
    const lock = section(
      'CREATE OR REPLACE FUNCTION public.fn_lock_daily_mission_user',
      'COMMENT ON FUNCTION public.fn_lock_daily_mission_user'
    );
    expect(lock).toContain('pg_advisory_xact_lock(');
    expect(lock).toContain("hashtextextended('daily-missions-user:'");
    expect(lock.indexOf('pg_advisory_xact_lock(')).toBeLessThan(
      lock.indexOf('FROM public.profiles')
    );
    expect(lock.indexOf('FROM public.profiles')).toBeLessThan(lock.indexOf('FOR UPDATE'));

    for (const signature of [
      'public.fn_assign_current_challenge_period(',
      'public.record_daily_challenge_event(',
      'public.get_daily_challenge_dashboard(',
      'public.get_daily_challenge_dashboard_v2(',
      'public.claim_daily_challenge(',
      'public.claim_daily_challenges(',
      'public.buy_streak_freeze(',
      'public.get_challenge_streak(',
      'public.fn_award_daily_mission_milestones(',
      'public.reroll_daily_challenge(',
    ]) {
      const bodyAt = migration.indexOf(`CREATE FUNCTION ${signature}`);
      const replacementAt = migration.indexOf(`CREATE OR REPLACE FUNCTION ${signature}`);
      const startAt = Math.max(bodyAt, replacementAt);
      expect(startAt, `missing serialized function ${signature}`).toBeGreaterThanOrEqual(0);
      const endAt = migration.indexOf('$function$;', startAt);
      expect(migration.slice(startAt, endAt)).toContain('fn_lock_daily_mission_user');
    }
  });

  it('binds each five-argument reroll to one durable request receipt', () => {
    const reroll = section(
      'CREATE FUNCTION public.reroll_daily_challenge(\n  p_user_id uuid,\n  p_challenge_row_id uuid,\n  p_expected_challenge_id text,\n  p_cost integer,\n  p_request_id uuid',
      'REVOKE ALL ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer, uuid)'
    );
    expect(migration).toContain('CREATE TABLE public.daily_challenge_reroll_receipts');
    expect(migration).toContain('PRIMARY KEY (user_id, request_id)');
    expect(reroll).toContain('request id is already bound to another request');
    expect(reroll).toContain("p_reference_id     := 'challenge_reroll:' || p_request_id::text");
    expect(reroll).toContain("'requestId', p_request_id");
    expect(reroll).toContain("'alreadyRerolled', true");
    expect(reroll).toContain("'diamondsSpent', 0");
    expect(reroll).toContain('RETURN v_receipt.result || jsonb_build_object(');
    expect(migration).toContain(
      'CREATE FUNCTION public.reroll_daily_challenge(\n  p_user_id uuid,\n  p_challenge_row_id uuid,\n  p_expected_challenge_id text,\n  p_cost integer DEFAULT 10'
    );
  });

  it('honors every recorded frozen gap but consumes at most one new freeze per calculation', () => {
    const streak = section(
      'CREATE OR REPLACE FUNCTION public.get_challenge_streak',
      'REVOKE ALL ON FUNCTION public.get_challenge_streak'
    );
    expect(streak).toContain('v_cursor::text = ANY(v_state.frozen_dates)');
    expect(streak).toContain('v_honored_frozen_dates := v_honored_frozen_dates + 1');
    expect(streak).toContain('ELSIF NOT v_used_new_freeze');
    expect(streak).toContain('v_used_new_freeze := true');
    expect(streak.match(/freezes_available = freezes_available - 1/g)).toHaveLength(1);
    expect(streak).toContain("'streakStartedOn', v_started_on");
    expect(streak).toContain("'streakEndedOn', v_ended_on");
    expect(streak).toContain('v_days[1] NOT IN (v_today, v_today - 1)');
  });

  it('earns freezes once per stable streak run instead of comparing against a lifetime total', () => {
    const streak = section(
      'CREATE OR REPLACE FUNCTION public.get_challenge_streak',
      'REVOKE ALL ON FUNCTION public.get_challenge_streak'
    );
    expect(migration).toContain('current_streak_run_id uuid');
    expect(migration).toContain('CREATE TABLE public.daily_challenge_freeze_entitlements');
    expect(migration).toContain('PRIMARY KEY (user_id, streak_run_id, entitlement_day)');
    expect(migration).toContain('WITH RECURSIVE completed_days AS (');
    expect(migration).toContain('BETWEEN s.current_streak_started_on');
    expect(migration).toContain('LEAST(s.freezes_earned, s.current_streak_length / 7)');
    expect(migration).toContain("md5('daily-mission-legacy-freezes:'");
    expect(migration).toContain("date '0001-01-01'");
    expect(migration).toContain('legacy_accounted');
    expect(streak).toContain('ON CONFLICT DO NOTHING');
    expect(streak).toContain('v_state.current_streak_run_id');
    expect(streak).toContain('v_run_id := gen_random_uuid()');
    expect(streak).not.toContain('v_entitlements - v_state.freezes_earned');
    expect(streak.indexOf('INSERT INTO public.daily_challenge_freeze_entitlements')).toBeLessThan(
      streak.indexOf('freezes_earned = freezes_earned + v_new_entitlements')
    );
  });

  it('allows a second day-seven entitlement after a genuinely disconnected break', () => {
    const streak = section(
      'CREATE OR REPLACE FUNCTION public.get_challenge_streak',
      'REVOKE ALL ON FUNCTION public.get_challenge_streak'
    );
    expect(streak).toContain('v_state.current_streak_ended_on >= v_started_on - 1');
    expect(streak).toContain('ELSE\n    v_run_id := gen_random_uuid()');
    expect(migration).toContain('PRIMARY KEY (user_id, streak_run_id, entitlement_day)');
    expect(streak).not.toContain('v_state.freezes_earned, 0');
  });

  it('can cross two already-recorded frozen gaps in one authoritative run', () => {
    const streak = section(
      'CREATE OR REPLACE FUNCTION public.get_challenge_streak',
      'REVOKE ALL ON FUNCTION public.get_challenge_streak'
    );
    const recordedGap = section(
      'ELSIF v_cursor::text = ANY(v_state.frozen_dates)',
      'ELSIF NOT v_used_new_freeze'
    );
    expect(recordedGap).not.toContain('v_used_new_freeze');
    expect(recordedGap).toContain('v_cursor := v_cursor - 1');
    expect(streak).toContain("'honoredFrozenDates', v_honored_frozen_dates");
  });

  it('keys milestone awards to the stable run and authoritative start date, including morning-after reads', () => {
    const award = section(
      'CREATE OR REPLACE FUNCTION public.fn_award_daily_mission_milestones',
      'REVOKE ALL ON FUNCTION public.fn_award_daily_mission_milestones'
    );
    expect(migration).toContain('PRIMARY KEY (user_id, streak_run_id, milestone_days)');
    expect(award).toContain("v_run_id := NULLIF(v_streak_receipt ->> 'streakRunId', '')::uuid");
    expect(award).toContain(
      "v_started := NULLIF(v_streak_receipt ->> 'streakStartedOn', '')::date"
    );
    expect(award).toContain("v_ended := NULLIF(v_streak_receipt ->> 'streakEndedOn', '')::date");
    expect(award).toContain('SELECT p_user_id, v_run_id, v_started, days, reward_diamonds');
    expect(award).not.toContain("(now() AT TIME ZONE 'utc')::date - (v_streak - 1)");
  });

  it('keeps yesterday-ending milestone claims on the older authoritative start date', () => {
    const streak = section(
      'CREATE OR REPLACE FUNCTION public.get_challenge_streak',
      'REVOKE ALL ON FUNCTION public.get_challenge_streak'
    );
    const award = section(
      'CREATE OR REPLACE FUNCTION public.fn_award_daily_mission_milestones',
      'REVOKE ALL ON FUNCTION public.fn_award_daily_mission_milestones'
    );
    expect(streak).toContain('v_days[1] NOT IN (v_today, v_today - 1)');
    expect(streak).toContain('v_ended_on := v_days[1]');
    expect(award).toContain(
      "v_started := NULLIF(v_streak_receipt ->> 'streakStartedOn', '')::date"
    );
  });

  it('uses a new run identity for post-break milestone eligibility', () => {
    const streak = section(
      'CREATE OR REPLACE FUNCTION public.get_challenge_streak',
      'REVOKE ALL ON FUNCTION public.get_challenge_streak'
    );
    const award = section(
      'CREATE OR REPLACE FUNCTION public.fn_award_daily_mission_milestones',
      'REVOKE ALL ON FUNCTION public.fn_award_daily_mission_milestones'
    );
    expect(streak).toContain('v_run_id := gen_random_uuid()');
    expect(award).toContain('user_id,\n      streak_run_id,');
    expect(migration).toContain('PRIMARY KEY (user_id, streak_run_id, milestone_days)');
  });

  it('wires exact mixed threshold values from the engine through trigger, outbox, and recorder', () => {
    expect(engineProjection).toContain(
      "values: Partial<Record<'big_pots' | 'strong_hands', number[]>>"
    );
    expect(engineProjection).toContain('big_pots: wonPotGrossValues');
    expect(engineProjection).toContain('strong_hands: [strongestWinningHand]');

    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS threshold_values jsonb NOT NULL DEFAULT '{}'::jsonb"
    );
    expect(migration).toContain("COALESCE(event -> 'values', '{}'::jsonb)");
    expect(migration).toContain('r.threshold_values,');
    expect(migration).toContain(
      'public.enqueue_daily_challenge_event(\n  uuid, text, jsonb, jsonb, jsonb, timestamptz'
    );
    expect(migration).toContain(
      'public.record_daily_challenge_event(\n  uuid, text, jsonb, jsonb, jsonb, timestamptz'
    );

    const exactRecorder = section(
      'CREATE FUNCTION public.record_daily_challenge_event(\n  p_user_id uuid,\n  p_event_key text,\n  p_amounts jsonb,\n  p_magnitudes jsonb,\n  p_values jsonb',
      'REVOKE ALL ON FUNCTION public.record_daily_challenge_event(\n  uuid, text, jsonb, jsonb, jsonb, timestamptz'
    );
    expect(exactRecorder).toContain("item.key NOT IN ('big_pots', 'strong_hands')");
    expect(exactRecorder).toContain('jsonb_array_elements(');
    expect(exactRecorder).toContain(
      'jsonb_array_length(item.value) <> (p_amounts ->> item.key)::integer'
    );
    expect(exactRecorder).toContain(
      'Daily Missions exact values must match their scalar candidate count'
    );
    expect(exactRecorder).toContain('candidate.value::text::numeric >= u.threshold_snapshot');
    expect(exactRecorder).toContain('WHEN p_values ? u.challenge_type_snapshot');
    expect(exactRecorder).toContain('p_magnitudes -> u.challenge_type_snapshot');
  });

  it('lets trusted pg_cron drain every opt-in in bounded batches at 00:02 UTC', () => {
    const enqueue = section(
      'CREATE OR REPLACE FUNCTION public.enqueue_daily_mission_reset_notifications',
      'REVOKE ALL ON FUNCTION public.enqueue_daily_mission_reset_notifications'
    );
    const drain = section(
      'CREATE OR REPLACE FUNCTION public.fn_drain_daily_mission_reset_notifications',
      'REVOKE ALL ON FUNCTION public.fn_drain_daily_mission_reset_notifications'
    );
    expect(enqueue).toContain('IF NOT public.fn_caller_is_engine() THEN');
    expect(enqueue).not.toContain("auth.role() <> 'service_role'");
    expect(drain).toContain('p_batch_size NOT BETWEEN 1 AND 5000');
    expect(drain).toContain('p_max_batches NOT BETWEEN 1 AND 100');
    expect(drain).toContain('pg_try_advisory_xact_lock(');
    expect(drain).toContain('EXIT WHEN v_batch >= p_max_batches');
    expect(migration).toContain("'daily-missions-reset-alerts-0002-utc'");
    expect(migration).toContain("'2 0 * * *'");
    expect(migration).toContain(
      "fn_drain_daily_mission_reset_notifications(((now() AT TIME ZONE 'UTC')::date), 5000, 100)"
    );
    expect(migration).toContain('AND active');
  });

  it('keeps new ledgers private and recoverable during reserved-account cleanup', () => {
    for (const table of [
      'daily_challenge_reroll_receipts',
      'daily_challenge_freeze_entitlements',
    ]) {
      const createAt = migration.indexOf(`CREATE TABLE public.${table}`);
      const rlsAt = migration.indexOf(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(createAt).toBeGreaterThanOrEqual(0);
      expect(rlsAt).toBeGreaterThan(createAt);
      expect(migration.slice(createAt, rlsAt)).toContain(
        'REFERENCES public.profiles(id) ON DELETE CASCADE'
      );
      expect(migration).toContain(`REVOKE ALL ON TABLE public.${table}`);
    }
    expect(migration).toContain("AND confrelid = 'public.profiles'::regclass");
    expect(migration).toContain("AND confdeltype = 'c'");
  });
});
