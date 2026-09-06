import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260906111916_daily_missions_serialized_replay_streak_and_reset_safety.sql'
  ),
  'utf8'
);
const rerollPriceMigration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260906141022_daily_mission_rerolls_cost_one_diamond.sql'
  ),
  'utf8'
);
const engineProjection = readFileSync(
  resolve(__dirname, '../server/src/engine/dailyMissionEvents.ts'),
  'utf8'
);
const productionE2E = readFileSync(
  resolve(__dirname, './e2e/production-daily-missions.spec.ts'),
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
  it('ships every schema and verification change in one transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration.indexOf('BEGIN;')).toBeLessThan(migration.indexOf('DO $verify$'));
    expect(migration.indexOf('DO $verify$')).toBeLessThan(migration.indexOf('COMMIT;'));
  });

  it('prelocks the full tournament event pipeline before downstream DDL', () => {
    const tournamentLock = 'LOCK TABLE public.tournament_players\n  IN ACCESS EXCLUSIVE MODE;';
    const outboxLock =
      'LOCK TABLE public.daily_challenge_event_outbox\n  IN ACCESS EXCLUSIVE MODE;';
    const progressLock =
      'LOCK TABLE public.daily_challenge_progress_events\n  IN ACCESS EXCLUSIVE MODE;';
    const firstProgressAlter = 'ALTER TABLE public.daily_challenge_progress_events';
    const firstOutboxAlter = 'ALTER TABLE public.daily_challenge_event_outbox';
    const firstTournamentDdl = 'DROP TRIGGER IF EXISTS trg_daily_missions_tournament_registered';
    const prune = section(
      'CREATE OR REPLACE FUNCTION public.fn_prune_daily_mission_operations(',
      'REVOKE ALL ON FUNCTION public.fn_prune_daily_mission_operations(integer)'
    );
    const pruneOutboxDelete = 'DELETE FROM public.daily_challenge_event_outbox';
    const pruneProgressDelete = 'DELETE FROM public.daily_challenge_progress_events';

    expect(migration).toContain(tournamentLock);
    expect(migration).toContain(outboxLock);
    expect(migration).toContain(progressLock);
    expect(migration.indexOf(tournamentLock)).toBeLessThan(migration.indexOf(outboxLock));
    expect(migration.indexOf(outboxLock)).toBeLessThan(migration.indexOf(progressLock));
    expect(migration.indexOf(progressLock)).toBeLessThan(migration.indexOf(firstProgressAlter));
    expect(migration.indexOf(progressLock)).toBeLessThan(migration.indexOf(firstOutboxAlter));
    expect(migration.indexOf(progressLock)).toBeLessThan(migration.indexOf(firstTournamentDdl));
    expect(prune).toContain(pruneOutboxDelete);
    expect(prune).toContain(pruneProgressDelete);
    expect(prune.indexOf(pruneOutboxDelete)).toBeLessThan(prune.indexOf(pruneProgressDelete));
  });

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

  it('uses one captured server timestamp for dashboard keys and syncedAt', () => {
    const dashboardV3 = section(
      'CREATE OR REPLACE FUNCTION public.get_daily_challenge_dashboard_v3()',
      'REVOKE ALL ON FUNCTION public.get_daily_challenge_dashboard_v3()'
    );
    expect(dashboardV3).toContain('v_now timestamptz := transaction_timestamp()');
    expect(dashboardV3).not.toContain('clock_timestamp()');
    expect(dashboardV3).toContain(
      "v_daily_key := to_char((v_now AT TIME ZONE 'utc')::date, 'YYYY-MM-DD')"
    );
    expect(dashboardV3).toContain("v_monthly_key := 'M' || to_char(v_now AT TIME ZONE 'utc'");
    expect(dashboardV3).toContain("'syncedAt', to_char(\n      v_now AT TIME ZONE 'utc'");
  });

  it('parses only canonical historical dates and excludes future completions from a streak', () => {
    const parser = section(
      'CREATE FUNCTION public.fn_parse_daily_mission_date',
      'REVOKE ALL ON FUNCTION public.fn_parse_daily_mission_date'
    );
    const streak = section(
      'CREATE OR REPLACE FUNCTION public.get_challenge_streak',
      'REVOKE ALL ON FUNCTION public.get_challenge_streak'
    );
    expect(parser).toContain("p_value !~ '^\\d{4}-\\d{2}-\\d{2}$'");
    expect(parser).toContain('WHEN datetime_field_overflow OR invalid_datetime_format');
    expect(parser).toContain("to_char(v_date, 'YYYY-MM-DD') IS DISTINCT FROM p_value");
    expect(migration).toContain('public.fn_parse_daily_mission_date(challenge.assigned_date)');
    expect(migration).toContain('public.fn_parse_daily_mission_date(frozen.frozen_text)');
    expect(streak).toContain('parsed.completed_on <= v_today');
    expect(migration).toContain("public.fn_parse_daily_mission_date('2026-02-31') IS NOT NULL");
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

  it('publishes the production one-Diamond price without rewriting settled history', () => {
    expect(rerollPriceMigration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rerollPriceMigration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(rerollPriceMigration).toContain('REROLL_COST constant integer := 1;');
    expect(rerollPriceMigration).toContain('p_cost integer DEFAULT 1');
    expect(rerollPriceMigration).toContain('CHECK (cost IN (1, 10))');
    expect(rerollPriceMigration).toContain("'diamondsSpent', REROLL_COST");

    const receiptLookup = rerollPriceMigration.indexOf(
      'FROM public.daily_challenge_reroll_receipts'
    );
    const currentPriceGuard = rerollPriceMigration.indexOf(
      'IF p_cost IS DISTINCT FROM REROLL_COST'
    );
    expect(receiptLookup).toBeGreaterThanOrEqual(0);
    expect(currentPriceGuard).toBeGreaterThan(receiptLookup);
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

  it('maps exact and proven plus-one legacy milestone receipts onto one current-run guard', () => {
    const mapping = section(
      '-- Milestones are unique by stable run identity.',
      'CREATE INDEX IF NOT EXISTS daily_challenge_milestone_claims_started_idx'
    );
    expect(mapping).toContain('state.current_streak_started_on = claims.streak_started_on');
    expect(mapping).toContain('claims.streak_started_on = state.current_streak_started_on + 1');
    expect(mapping).toContain('claims.milestone_days <= state.current_streak_length');
    expect(mapping).toContain("(claims.claimed_at AT TIME ZONE 'utc')::date");
    expect(mapping).toContain('BETWEEN state.current_streak_started_on');
    expect(mapping).toContain('row_number() OVER (');
    expect(mapping).toContain('WHERE receipt_order = 1');
    expect(mapping).toContain(
      "md5(\n  claims.user_id::text || ':' || claims.streak_started_on::text\n)::uuid"
    );
    expect(migration).toContain(
      'A legacy exact/+1 milestone receipt lacks one current-run replay guard'
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

  it('binds Claim All and streak-freeze replays to explicit normalized request inputs', () => {
    const claim = section(
      'CREATE FUNCTION public.claim_daily_challenges(',
      'REVOKE ALL ON FUNCTION public.claim_daily_challenges(uuid, uuid[], uuid)'
    );
    const freeze = section(
      'CREATE FUNCTION public.buy_streak_freeze(\n  p_user_id uuid,\n  p_cost integer,\n  p_request_id uuid\n)',
      'REVOKE ALL ON FUNCTION public.buy_streak_freeze(uuid, integer, uuid)'
    );
    const legacyFreeze = section(
      'CREATE FUNCTION public.buy_streak_freeze(\n  p_user_id uuid,\n  p_cost integer\n)',
      'REVOKE ALL ON FUNCTION public.buy_streak_freeze(uuid, integer)'
    );

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS challenge_row_ids uuid[]');
    expect(migration).toContain('daily_challenge_claim_batches_bound_ids_valid');
    expect(claim).toContain('SELECT array_agg(id ORDER BY id)');
    expect(claim).toContain('SELECT challenge_row_ids INTO v_bound_ids');
    expect(claim).toContain('FOR UPDATE');
    expect(claim).toContain('Claim request id is already bound to another challenge set');
    expect(claim).toContain('Claim request receipt did not preserve its challenge binding');
    expect(freeze).toContain('IF p_request_id IS NULL THEN');
    expect(freeze).not.toContain('p_request_id uuid DEFAULT');
    expect(legacyFreeze).toContain('a streak freeze request id is required; refresh and try again');
    expect(legacyFreeze).not.toContain('buy_streak_freeze_serialized_body');
  });

  it('wires exact mixed threshold values from the engine through trigger, outbox, and recorder', () => {
    expect(engineProjection).toContain(
      "values: Partial<Record<'big_pots' | 'strong_hands', number[]>>"
    );
    expect(engineProjection).toContain('big_pots: wonPotGrossValues');
    expect(engineProjection).toContain('strong_hands: [strongestWinningHand]');
    expect(productionE2E).toContain('big_pots: Array.from({ length: 2_500 }, () => 1_000_000_000)');
    expect(productionE2E).toContain('strong_hands: Array.from({ length: 2_500 }, () => 10)');

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

  it('immutably binds pending and processed event keys to their canonical payload', () => {
    const legacyRecorder = section(
      'CREATE FUNCTION public.record_daily_challenge_event(\n  p_user_id uuid,\n  p_event_key text,\n  p_amounts jsonb,\n  p_magnitudes jsonb DEFAULT',
      'REVOKE ALL ON FUNCTION public.record_daily_challenge_event(\n  uuid, text, jsonb, jsonb, timestamptz'
    );
    const exactRecorder = section(
      'CREATE FUNCTION public.record_daily_challenge_event(\n  p_user_id uuid,\n  p_event_key text,\n  p_amounts jsonb,\n  p_magnitudes jsonb,\n  p_values jsonb',
      'REVOKE ALL ON FUNCTION public.record_daily_challenge_event(\n  uuid, text, jsonb, jsonb, jsonb, timestamptz'
    );
    const legacyOutbox = section(
      'CREATE OR REPLACE FUNCTION public.enqueue_daily_challenge_event(\n  p_user_id uuid,\n  p_event_key text,\n  p_amounts jsonb,\n  p_magnitudes jsonb,\n  p_occurred_at timestamptz',
      'REVOKE ALL ON FUNCTION public.enqueue_daily_challenge_event(\n  uuid, text, jsonb, jsonb, timestamptz'
    );
    const exactOutbox = section(
      'CREATE FUNCTION public.enqueue_daily_challenge_event(\n  p_user_id uuid,\n  p_event_key text,\n  p_amounts jsonb,\n  p_magnitudes jsonb,\n  p_values jsonb',
      'REVOKE ALL ON FUNCTION public.enqueue_daily_challenge_event(\n  uuid, text, jsonb, jsonb, jsonb, timestamptz'
    );

    for (const body of [legacyRecorder, exactRecorder]) {
      expect(body).toContain('daily_challenge_progress_events');
      expect(body).toContain('v_event.amounts IS DISTINCT FROM p_amounts');
      expect(body).toContain('v_event.magnitudes IS DISTINCT FROM p_magnitudes');
      expect(body).toContain('v_event.threshold_values IS DISTINCT FROM');
      expect(body).toContain('v_event.occurred_at IS DISTINCT FROM p_occurred_at');
      expect(body).toContain('event key is already bound to another payload');
    }

    for (const body of [legacyOutbox, exactOutbox]) {
      expect(body.indexOf('fn_lock_daily_mission_user')).toBeLessThan(
        body.indexOf('INSERT INTO public.daily_challenge_event_outbox')
      );
      expect(body).toContain('SELECT * INTO STRICT v_event');
      expect(body).toContain('daily_challenge_progress_events');
      expect(body).toContain('v_receipt.amounts IS DISTINCT FROM v_event.amounts');
      expect(body).toContain('event key is already bound to another payload');
    }
  });

  it('uses deterministic multi-player locks and one globally serialized outbox drain', () => {
    const handTrigger = section(
      'CREATE OR REPLACE FUNCTION public.fn_enqueue_hand_daily_missions()',
      'REVOKE ALL ON FUNCTION public.fn_enqueue_hand_daily_missions()'
    );
    const friendshipTrigger = section(
      'CREATE OR REPLACE FUNCTION public.fn_daily_missions_friend_accepted()',
      'REVOKE ALL ON FUNCTION public.fn_daily_missions_friend_accepted()'
    );
    const insertedTournamentTrigger = section(
      'CREATE OR REPLACE FUNCTION public.fn_daily_missions_tournament_registered_inserted()',
      'CREATE OR REPLACE FUNCTION public.fn_daily_missions_tournament_registered_updated()'
    );
    const updatedTournamentTrigger = section(
      'CREATE OR REPLACE FUNCTION public.fn_daily_missions_tournament_registered_updated()',
      'REVOKE ALL ON FUNCTION public.fn_daily_missions_tournament_registered_inserted()'
    );
    const tournamentTriggerWiring = section(
      'DROP TRIGGER IF EXISTS trg_daily_missions_tournament_registered',
      'CREATE OR REPLACE FUNCTION public.fn_drain_daily_challenge_event_outbox'
    );
    const drain = section(
      'CREATE OR REPLACE FUNCTION public.fn_drain_daily_challenge_event_outbox',
      'REVOKE ALL ON FUNCTION public.fn_drain_daily_challenge_event_outbox'
    );

    expect(handTrigger).toContain("ORDER BY value ->> 'user_id', value::text");
    expect(friendshipTrigger).toContain('ELSIF NEW.user_id < NEW.friend_id THEN');
    expect(friendshipTrigger).toContain('fn_lock_daily_mission_user(NEW.user_id)');
    expect(friendshipTrigger).toContain('fn_lock_daily_mission_user(NEW.friend_id)');
    expect(insertedTournamentTrigger).toContain('FROM inserted_rows inserted');
    expect(insertedTournamentTrigger).toContain('ORDER BY inserted.user_id');
    expect(insertedTournamentTrigger).toContain(
      'ORDER BY inserted.user_id, inserted.tournament_id, inserted.id'
    );
    expect(insertedTournamentTrigger).toContain('inserted.status::text IN');
    expect(insertedTournamentTrigger.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      insertedTournamentTrigger.indexOf('enqueue_daily_challenge_event')
    );
    expect(updatedTournamentTrigger).toContain(
      'JOIN previous_rows previous ON previous.id = updated.id'
    );
    expect(updatedTournamentTrigger).toContain('ORDER BY updated.user_id');
    expect(updatedTournamentTrigger).toContain(
      'ORDER BY updated.user_id, updated.tournament_id, updated.id'
    );
    expect(updatedTournamentTrigger).toContain('previous.status::text NOT IN');
    expect(updatedTournamentTrigger.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      updatedTournamentTrigger.indexOf('enqueue_daily_challenge_event')
    );
    expect(tournamentTriggerWiring).toContain('REFERENCING NEW TABLE AS inserted_rows');
    expect(tournamentTriggerWiring).toContain(
      'REFERENCING OLD TABLE AS previous_rows NEW TABLE AS updated_rows'
    );
    expect(tournamentTriggerWiring.match(/FOR EACH STATEMENT/g)).toHaveLength(2);
    expect(tournamentTriggerWiring).not.toContain('FOR EACH ROW');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_daily_missions_tournament_registered()'
    );
    expect(drain).toContain('p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000');
    expect(drain).toContain("hashtextextended('daily-missions-event-outbox-drain', 0)");
    expect(drain).toContain('ORDER BY user_id, created_at, event_key');
    expect(drain.indexOf('fn_lock_daily_mission_user')).toBeLessThan(
      drain.indexOf('UPDATE public.daily_challenge_event_outbox')
    );
    expect(drain).not.toContain('FOR UPDATE SKIP LOCKED');
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
    expect(enqueue).toContain('IF p_cycle_date IS NULL THEN');
    expect(enqueue).toContain('p_limit IS NULL OR p_limit < 1 OR p_limit > 5000');
    expect(enqueue).toContain('ORDER BY p.user_id');
    expect(drain).toContain('IF p_cycle_date IS NULL THEN');
    expect(drain).toContain('p_batch_size IS NULL OR');
    expect(drain).toContain('p_max_batches IS NULL OR');
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
