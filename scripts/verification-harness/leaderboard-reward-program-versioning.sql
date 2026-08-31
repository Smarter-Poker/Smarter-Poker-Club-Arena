-- Production-safe behavior probe for Phase 2 leaderboard reward programs.
-- Run only after both 2026083123599* migrations are applied. Every test write is
-- enclosed in this transaction and the file always ends in ROLLBACK.

BEGIN;

DO $probe$
DECLARE
  v_club_id uuid;
  v_union_id uuid;
  v_owner_id uuid;
  v_expected integer;
  v_operation_id uuid := gen_random_uuid();
  v_second_operation_id uuid := gen_random_uuid();
  v_first jsonb;
  v_second jsonb;
  v_retry jsonb;
  v_current_plan jsonb;
  v_next_plan jsonb;
  v_weekly_start date;
  v_weekly_next date;
  v_monthly_next date;
  v_rejected boolean;
BEGIN
  SELECT club.id, union_row.id, union_row.owner_id
    INTO v_club_id, v_union_id, v_owner_id
    FROM public.clubs club
    JOIN public.unions union_row ON union_row.id = club.union_id
   WHERE union_row.owner_id IS NOT NULL
   ORDER BY club.created_at
   LIMIT 1;
  IF v_club_id IS NULL THEN RAISE EXCEPTION 'FAIL: no union-funded owner fixture'; END IF;

  SELECT COALESCE(max(program.version), 0) INTO v_expected
    FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = v_club_id;
  PERFORM set_config('request.jwt.claim.sub', v_owner_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  SELECT bounds.start_date, bounds.end_date INTO v_weekly_start, v_weekly_next
    FROM public.fn_leaderboard_period_window('weekly', 0) bounds;
  SELECT bounds.end_date INTO v_monthly_next
    FROM public.fn_leaderboard_period_window('monthly', 0) bounds;

  v_first := public.fn_save_leaderboard_reward_setup(
    v_club_id, true, 'profit',
    '[{"rank":1,"amount":50},{"rank":2,"amount":30},{"rank":3,"amount":20}]'::jsonb,
    '[{"rank":1,"amount":200}]'::jsonb,
    'balanced', v_expected, v_operation_id
  );
  IF (v_first ->> 'program_version')::integer <> v_expected + 1
     OR v_first ->> 'funding_owner_type' <> 'union'
     OR (v_first ->> 'union_id')::uuid <> v_union_id
     OR (v_first ->> 'weekly_effective_from')::date <> v_weekly_next
     OR (v_first ->> 'monthly_effective_from')::date <> v_monthly_next THEN
    RAISE EXCEPTION 'FAIL: publication/version/authority/activation contract';
  END IF;

  v_retry := public.fn_save_leaderboard_reward_setup(
    v_club_id, true, 'profit',
    '[{"rank":1,"amount":50},{"rank":2,"amount":30},{"rank":3,"amount":20}]'::jsonb,
    '[{"rank":1,"amount":200}]'::jsonb,
    'balanced', v_expected, v_operation_id
  );
  IF (v_retry ->> 'program_version')::integer <> (v_first ->> 'program_version')::integer
     OR (SELECT count(*) FROM public.leaderboard_reward_program_versions
          WHERE club_id = v_club_id AND operation_id = v_operation_id) <> 1 THEN
    RAISE EXCEPTION 'FAIL: publication retry was not idempotent';
  END IF;

  v_current_plan := public.fn_get_leaderboard_reward_plan(v_club_id, 'weekly', v_weekly_start);
  v_next_plan := public.fn_get_leaderboard_reward_plan(v_club_id, 'weekly', v_weekly_next);
  IF COALESCE((v_current_plan ->> 'program_version')::integer, 0) <> v_expected
     OR (v_next_plan ->> 'program_version')::integer <> v_expected + 1 THEN
    RAISE EXCEPTION 'FAIL: a new publication rewrote an active period';
  END IF;

  v_second := public.fn_save_leaderboard_reward_setup(
    v_club_id, true, 'roi',
    '[{"rank":1,"amount":75}]'::jsonb,
    '[{"rank":1,"amount":250}]'::jsonb,
    'top_heavy', v_expected + 1, v_second_operation_id
  );
  v_retry := public.fn_save_leaderboard_reward_setup(
    v_club_id, true, 'profit',
    '[{"rank":1,"amount":50},{"rank":2,"amount":30},{"rank":3,"amount":20}]'::jsonb,
    '[{"rank":1,"amount":200}]'::jsonb,
    'balanced', v_expected, v_operation_id
  );
  IF (v_second ->> 'program_version')::integer <> v_expected + 2
     OR (v_retry ->> 'program_version')::integer <> v_expected + 1
     OR v_retry ->> 'payout_metric' <> 'profit'
     OR v_retry ->> 'suggestion_key' <> 'balanced' THEN
    RAISE EXCEPTION 'FAIL: an old retry did not return its exact published version';
  END IF;

  v_rejected := false;
  BEGIN
    PERFORM public.fn_get_leaderboard_reward_plan(
      v_club_id, 'weekly', v_weekly_start + 1
    );
  EXCEPTION WHEN invalid_parameter_value THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'FAIL: non-canonical period start was accepted'; END IF;

  v_rejected := false;
  BEGIN
    PERFORM public.fn_save_leaderboard_reward_setup(
      v_club_id, true, 'profit', '[{"rank":1,"amount":1}]'::jsonb,
      '[]'::jsonb, 'custom', v_expected, gen_random_uuid()
    );
  EXCEPTION WHEN serialization_failure THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'FAIL: stale version was accepted'; END IF;

  v_rejected := false;
  BEGIN
    UPDATE public.leaderboard_reward_program_versions SET payout_metric = 'roi'
     WHERE club_id = v_club_id AND version = v_expected + 1;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'FAIL: published row was mutable'; END IF;

  PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  v_rejected := false;
  BEGIN
    PERFORM public.fn_save_leaderboard_reward_setup(
      v_club_id, false, 'profit', '[]'::jsonb, '[]'::jsonb,
      'balanced', v_expected + 2, gen_random_uuid()
    );
  EXCEPTION WHEN insufficient_privilege THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'FAIL: unauthorized publication was accepted'; END IF;

  RAISE NOTICE 'PASS: version, exact retry, canonical boundary, immutability and authority contracts';
END;
$probe$;

ROLLBACK;
