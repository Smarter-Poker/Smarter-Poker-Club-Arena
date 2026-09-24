-- 20260924043239_multi_day_stage_transitions_are_lease_fenced.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  MULTI-DAY TOURNAMENTS, RELEASE R5 (DATABASE HALF): THE STAGE RPCs
--  Design: docs/handoffs/club-arena-product-completion/MULTI-DAY-DESIGN.md
--  section 5.
-- ===========================================================================
--
-- SEVEN SERVICE-ROLE RPCs, each one transaction, each idempotent on its own
-- durable receipt, each refusing with {"ok":false,"reason":...} unless
-- fn_capability_available('tournament.multi_day.single_flight') is true:
--
--   fn_seal_tournament_stage_plan(tournament, plan)
--   fn_begin_stage_end(tournament, lease_generation, stage_no, ended_level)
--   fn_bag_tournament_stage(tournament, lease_generation, stage_no, watermarks)
--   fn_reschedule_tournament_stage(tournament, stage_no, new_start_utc,
--                                  expected_generation, reason)
--   fn_begin_stage_resume(tournament, stage_no, resume_id, schedule_generation,
--                         lease_generation, first_level)
--   fn_seat_stage_entitlement(tournament, resume_id, lease_generation,
--                             entitlement_id, table_id, seat_number)
--   fn_complete_stage_resume(tournament, resume_id, lease_generation)
--
-- FENCING. Every RPC that the engine calls while it owns the event proves the
-- exact protocol-2 lease generation with a fresh heartbeat (FOR KEY SHARE on
-- the lease row, the lock check-lease-lock-strength.mjs requires), then takes
-- the tournament's rolling settlement lane T(id) exclusively
-- (fn_ca_lock_settlement_lane_for_tournament), then the tournament row
-- FOR UPDATE, the same order as fn_publish_tournament_blind_level
-- (20260913200859). The bag and the resume begin also take the maintenance
-- admission barrier (advisory 530090/1 shared) and refuse inside the freeze.
--
-- CUSTODY, NOT MONEY. The bag moves each live stack from its seat to one bag
-- row (seat stack -> 0, left_at stamped, mirror set to the bag), writes one
-- entitlement per bag, closes the tables and sets BAGGED. The resume seats
-- each entitlement exactly once with exactly its stack and sets RUNNING. Both
-- assert conservation before commit: the chips on the felt before the bag
-- equal the bags, the entitlements and the roster mirror; the chips on the
-- felt after the resume equal the entitlements. No escrow, obligation, rake,
-- ledger, wallet, payout or guarantee row is read for settlement or written.
--
-- WHAT THE BAG PROVES FIRST (the provenance watermark). No hand is in flight
-- on any of the event's tables (hand_state_snapshots.is_complete = false); the
-- engine's per-table watermark equals the last accepted hand in
-- hand_atomic_commits for every open table, and covers exactly the open
-- tables; every live seat equals its player's stack in the last accepted hand
-- that dealt them (stack_result.written); the live seats and the 'playing'
-- roster are the same people; nobody is still merely 'registered'.
--
-- UNREACHABLE UNTIL R6: the capability is 'planned' in the registry
-- (20260924025555), and trg_tournaments_refuse_unbuilt_multi_day is untouched.
--
-- ROLLBACK: DROP the eight functions (none has a caller before the engine
-- release of R5).
--
-- @live-proof: (SELECT count(*) = 7 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND p.proname IN ('fn_seal_tournament_stage_plan','fn_begin_stage_end','fn_bag_tournament_stage','fn_reschedule_tournament_stage','fn_begin_stage_resume','fn_seat_stage_entitlement','fn_complete_stage_resume') AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF to_regprocedure('public.fn_capability_available(text)') IS NULL
     OR to_regprocedure('public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_platform_frozen()') IS NULL
     OR to_regprocedure('public.fn_entry_purchases_frozen()') IS NULL
     OR to_regclass('public.hand_atomic_commits') IS NULL
     OR to_regclass('public.hand_state_snapshots') IS NULL
     OR to_regclass('public.engine_tournament_leases') IS NULL
     OR to_regclass('public.tournament_stage_resume_receipts') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
                     WHERE t.tgname = 'trg_tournaments_bagged_status_door' AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'MULTI_DAY_RPC_PREREQUISITES_MISSING' USING ERRCODE = '55000';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 0. THE LEASE PROOF (private helper).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_multi_day_lease_is_current(p_tournament_id uuid, p_lease_generation uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  PERFORM 1
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
     AND l.protocol_version = 2
     AND l.lease_generation = p_lease_generation
     AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
     FOR KEY SHARE;
  RETURN FOUND;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 1. SEAL A PLAN.
-- plan = {"time_zone":"America/Chicago","stages":[
--          {"stage_no":1,"end_after_level":12},
--          {"stage_no":2,"scheduled_start_utc":"2026-10-03T17:00:00Z"}]}
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_seal_tournament_stage_plan(p_tournament_id uuid, p_plan jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET statement_timeout = '30s'
AS $fn$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_existing public.tournament_stage_plans%ROWTYPE;
  v_zone text;
  v_stages jsonb;
  v_stage jsonb;
  v_n integer;
  v_i integer;
  v_end integer;
  v_prev_end integer := 0;
  v_start timestamptz;
  v_prev_start timestamptz;
  v_entry_levels integer;
  v_hash text;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.fn_capability_available('tournament.multi_day.single_flight') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'capability_unavailable');
  END IF;
  IF p_tournament_id IS NULL OR p_plan IS NULL OR jsonb_typeof(p_plan) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  v_hash := md5(p_plan::text);
  SELECT * INTO v_existing FROM public.tournament_stage_plans WHERE tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_existing.plan_hash = v_hash THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'tournament_id', p_tournament_id,
        'plan_hash', v_hash, 'stage_count', v_existing.stage_count);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'plan_already_sealed', 'plan_hash', v_existing.plan_hash);
  END IF;

  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_plannable', 'status', v_t.status);
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players p WHERE p.tournament_id = p_tournament_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'players_registered');
  END IF;
  IF upper(COALESCE(v_t.tournament_type, '')) <> 'MTT'
     OR lower(COALESCE(v_t.variant, '')) IN ('spin', 'sng') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'format_not_multi_day');
  END IF;

  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_plan) k) IS DISTINCT FROM ARRAY['stages', 'time_zone'] THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'plan_shape_invalid');
  END IF;
  v_zone := p_plan ->> 'time_zone';
  IF v_zone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name = v_zone) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'time_zone_unknown');
  END IF;
  v_stages := p_plan -> 'stages';
  IF jsonb_typeof(v_stages) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'plan_shape_invalid');
  END IF;
  v_n := jsonb_array_length(v_stages);
  IF v_n NOT BETWEEN 2 AND 14 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stage_count_out_of_range');
  END IF;

  v_prev_start := v_t.start_time;
  FOR v_i IN 0 .. v_n - 1 LOOP
    v_stage := v_stages -> v_i;
    IF jsonb_typeof(v_stage) IS DISTINCT FROM 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_stage) k
                   WHERE k NOT IN ('stage_no', 'end_after_level', 'scheduled_start_utc'))
       OR jsonb_typeof(v_stage -> 'stage_no') IS DISTINCT FROM 'number'
       OR (v_stage ->> 'stage_no')::numeric <> v_i + 1 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'plan_shape_invalid', 'stage_index', v_i);
    END IF;
    IF v_i < v_n - 1 THEN
      IF jsonb_typeof(v_stage -> 'end_after_level') IS DISTINCT FROM 'number'
         OR (v_stage ->> 'end_after_level')::numeric <> trunc((v_stage ->> 'end_after_level')::numeric)
         OR (v_stage ->> 'end_after_level')::numeric <= v_prev_end
         OR (v_stage ->> 'end_after_level')::numeric > 1000 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'stage_end_level_invalid', 'stage_no', v_i + 1);
      END IF;
      v_end := (v_stage ->> 'end_after_level')::integer;
      v_prev_end := v_end;
    ELSIF v_stage ? 'end_after_level' AND jsonb_typeof(v_stage -> 'end_after_level') <> 'null' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'stage_end_level_invalid', 'stage_no', v_i + 1);
    END IF;
    IF v_i = 0 THEN
      IF v_stage ? 'scheduled_start_utc' AND jsonb_typeof(v_stage -> 'scheduled_start_utc') <> 'null' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'stage_start_invalid', 'stage_no', 1);
      END IF;
    ELSE
      IF jsonb_typeof(v_stage -> 'scheduled_start_utc') IS DISTINCT FROM 'string' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'stage_start_invalid', 'stage_no', v_i + 1);
      END IF;
      BEGIN
        v_start := (v_stage ->> 'scheduled_start_utc')::timestamptz;
      EXCEPTION WHEN others THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'stage_start_invalid', 'stage_no', v_i + 1);
      END;
      IF v_start <= clock_timestamp() OR (v_prev_start IS NOT NULL AND v_start <= v_prev_start) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'stage_start_invalid', 'stage_no', v_i + 1);
      END IF;
      v_prev_start := v_start;
    END IF;
  END LOOP;

  -- No entry, rebuy or add-on window may cross a bag.
  v_entry_levels := GREATEST(COALESCE(v_t.late_reg_levels, 0), COALESCE(v_t.rebuy_levels, 0),
                             COALESCE(v_t.addon_levels, 0));
  IF (v_stages -> 0 ->> 'end_after_level')::integer <= v_entry_levels THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'entry_window_crosses_day_end',
      'entry_levels', v_entry_levels);
  END IF;

  PERFORM set_config('app.multi_day_stage_writer', p_tournament_id::text, true);
  INSERT INTO public.tournament_stage_plans
    (tournament_id, capability_id, rule_version, time_zone, stage_count, plan, plan_hash)
  VALUES (p_tournament_id, 'tournament.multi_day.single_flight', 'multi-day-v1', v_zone, v_n, p_plan, v_hash);
  FOR v_i IN 0 .. v_n - 1 LOOP
    v_stage := v_stages -> v_i;
    INSERT INTO public.tournament_stages
      (tournament_id, stage_no, kind, day_no, end_after_level, scheduled_start_utc)
    VALUES (p_tournament_id, v_i + 1, 'day', v_i + 1,
            CASE WHEN v_i < v_n - 1 THEN (v_stage ->> 'end_after_level')::integer END,
            CASE WHEN v_i > 0 THEN (v_stage ->> 'scheduled_start_utc')::timestamptz END);
    v_rows := v_rows || jsonb_build_object('stage_no', v_i + 1,
      'end_after_level', CASE WHEN v_i < v_n - 1 THEN (v_stage ->> 'end_after_level')::integer END,
      'scheduled_start_utc', CASE WHEN v_i > 0 THEN (v_stage ->> 'scheduled_start_utc')::timestamptz END);
  END LOOP;
  INSERT INTO public.tournament_stage_transitions
    (tournament_id, stage_no, kind, idempotency_key, facts)
  VALUES (p_tournament_id, 1, 'seal', 'seal:' || p_tournament_id::text,
          jsonb_build_object('plan_hash', v_hash, 'stage_count', v_n, 'time_zone', v_zone));
  PERFORM set_config('app.multi_day_stage_writer', '', true);

  RETURN jsonb_build_object('ok', true, 'replay', false, 'tournament_id', p_tournament_id,
    'plan_hash', v_hash, 'stage_count', v_n, 'time_zone', v_zone, 'stages', v_rows);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 2. DAY-END INTENT. Called when the clock of the stage's last level expires,
--    INSTEAD of publishing the next level. Accepted hands still finish.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_begin_stage_end(
  p_tournament_id uuid, p_lease_generation uuid, p_stage_no integer, p_ended_level integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET statement_timeout = '30s'
AS $fn$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_stage public.tournament_stages%ROWTYPE;
  v_receipt public.tournament_stage_transitions%ROWTYPE;
  v_key text;
BEGIN
  IF NOT public.fn_capability_available('tournament.multi_day.single_flight') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'capability_unavailable');
  END IF;
  IF p_tournament_id IS NULL OR p_lease_generation IS NULL OR p_stage_no IS NULL OR p_ended_level IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF NOT public.fn_multi_day_lease_is_current(p_tournament_id, p_lease_generation) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lease_lost');
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id, NULL);
  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  SELECT * INTO v_stage FROM public.tournament_stages
   WHERE tournament_id = p_tournament_id AND stage_no = p_stage_no FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stage_not_found');
  END IF;

  v_key := 'day_end:' || p_tournament_id::text || ':' || p_stage_no::text;
  SELECT * INTO v_receipt FROM public.tournament_stage_transitions WHERE idempotency_key = v_key;
  IF FOUND THEN
    IF (v_receipt.facts ->> 'ended_level')::integer = p_ended_level THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'day_end_id', v_receipt.id,
        'stage_no', p_stage_no, 'ended_level', p_ended_level, 'stage_state', v_stage.state);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'day_end_already_recorded',
      'ended_level', (v_receipt.facts ->> 'ended_level')::integer);
  END IF;

  IF v_t.status IS DISTINCT FROM 'RUNNING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_running', 'status', v_t.status);
  END IF;
  IF v_stage.end_after_level IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'final_stage_has_no_day_end');
  END IF;
  IF NOT ((p_stage_no = 1 AND v_stage.state IN ('planned', 'running'))
          OR (p_stage_no > 1 AND v_stage.state = 'running')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stage_not_running', 'stage_state', v_stage.state);
  END IF;
  IF p_ended_level IS DISTINCT FROM v_stage.end_after_level
     OR v_t.current_level IS DISTINCT FROM v_stage.end_after_level THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'level_mismatch',
      'current_level', v_t.current_level, 'end_after_level', v_stage.end_after_level);
  END IF;

  PERFORM set_config('app.multi_day_stage_writer', p_tournament_id::text, true);
  INSERT INTO public.tournament_stage_transitions
    (tournament_id, stage_no, kind, idempotency_key, lease_generation, facts)
  VALUES (p_tournament_id, p_stage_no, 'day_end', v_key, p_lease_generation,
          jsonb_build_object('ended_level', p_ended_level, 'blind_level_state', v_t.blind_level_state,
                             'level_started_at', v_t.level_started_at, 'on_break', COALESCE(v_t.on_break, false)))
  RETURNING * INTO v_receipt;
  UPDATE public.tournament_stages
     SET state = 'day_ending', state_changed_at = clock_timestamp()
   WHERE tournament_id = p_tournament_id AND stage_no = p_stage_no;
  PERFORM set_config('app.multi_day_stage_writer', '', true);

  RETURN jsonb_build_object('ok', true, 'replay', false, 'day_end_id', v_receipt.id,
    'stage_no', p_stage_no, 'ended_level', p_ended_level, 'stage_state', 'day_ending');
END
$fn$;

-- ---------------------------------------------------------------------------
-- 3. THE BAG. watermarks = [{"table_id":"...","last_hand_number":1000123|null}, ...]
--    covering exactly the event's open tables.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_bag_tournament_stage(
  p_tournament_id uuid, p_lease_generation uuid, p_stage_no integer, p_watermarks jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET statement_timeout = '30s'
AS $fn$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_stage public.tournament_stages%ROWTYPE;
  v_next public.tournament_stages%ROWTYPE;
  v_plan public.tournament_stage_plans%ROWTYPE;
  v_receipt public.tournament_stage_transitions%ROWTYPE;
  v_key text;
  v_tables uuid[];
  v_supplied_count integer;
  v_bad jsonb;
  v_players integer;
  v_seats integer;
  v_total numeric;
  v_bounty numeric;
  v_break jsonb;
  v_facts jsonb;
  v_rows integer;
BEGIN
  IF NOT public.fn_capability_available('tournament.multi_day.single_flight') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'capability_unavailable');
  END IF;
  IF p_tournament_id IS NULL OR p_lease_generation IS NULL OR p_stage_no IS NULL
     OR p_watermarks IS NULL OR jsonb_typeof(p_watermarks) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  -- A lost response is answered from the receipt, even after the lease went.
  v_key := 'bag:' || p_tournament_id::text || ':' || p_stage_no::text;
  SELECT * INTO v_receipt FROM public.tournament_stage_transitions WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN v_receipt.facts || jsonb_build_object('ok', true, 'replay', true, 'bag_id', v_receipt.id);
  END IF;

  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;
  IF NOT public.fn_multi_day_lease_is_current(p_tournament_id, p_lease_generation) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lease_lost');
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id, NULL);
  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  -- Re-read under the row lock: a concurrent bag may have committed first.
  SELECT * INTO v_receipt FROM public.tournament_stage_transitions WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN v_receipt.facts || jsonb_build_object('ok', true, 'replay', true, 'bag_id', v_receipt.id);
  END IF;
  IF v_t.status IS DISTINCT FROM 'RUNNING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_running', 'status', v_t.status);
  END IF;
  SELECT * INTO v_plan FROM public.tournament_stage_plans WHERE tournament_id = p_tournament_id;
  SELECT * INTO v_stage FROM public.tournament_stages
   WHERE tournament_id = p_tournament_id AND stage_no = p_stage_no FOR UPDATE;
  IF NOT FOUND OR v_stage.state IS DISTINCT FROM 'day_ending' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stage_not_day_ending', 'stage_state', v_stage.state);
  END IF;
  SELECT * INTO v_next FROM public.tournament_stages
   WHERE tournament_id = p_tournament_id AND stage_no = p_stage_no + 1 FOR UPDATE;
  IF NOT FOUND OR v_next.state IS DISTINCT FROM 'planned' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'next_stage_not_planned');
  END IF;

  -- Parent, roster, tables, seats: the lock order of terminal settlement.
  PERFORM 1 FROM public.tournament_players p
   WHERE p.tournament_id = p_tournament_id ORDER BY p.id FOR UPDATE;
  SELECT COALESCE(array_agg(x.id ORDER BY x.id), '{}') INTO v_tables
    FROM (SELECT tb.id FROM public.tables tb
           WHERE tb.tournament_id = p_tournament_id
             AND NOT COALESCE(tb.is_deleted, false)
             AND lower(COALESCE(tb.status::text, '')) NOT IN ('closed','deleted','completed','cancelled','finished')
           ORDER BY tb.id FOR UPDATE) x;
  PERFORM 1 FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL
   ORDER BY s.id FOR UPDATE OF s;

  -- (a) no cards in the air anywhere in the event.
  IF EXISTS (SELECT 1 FROM public.hand_state_snapshots h JOIN public.tables tb ON tb.id = h.table_id
              WHERE tb.tournament_id = p_tournament_id AND NOT h.is_complete) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hand_in_flight');
  END IF;

  -- (b) the watermark: exactly the open tables, each at its last accepted hand.
  SELECT count(*) INTO v_supplied_count FROM jsonb_array_elements(p_watermarks);
  IF v_supplied_count <> cardinality(v_tables)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_watermarks) e
                 WHERE jsonb_typeof(e) <> 'object'
                    OR NOT (e ? 'table_id') OR NOT (e ? 'last_hand_number')
                    OR jsonb_typeof(e -> 'last_hand_number') NOT IN ('number', 'null'))
     OR (SELECT count(DISTINCT e ->> 'table_id') FROM jsonb_array_elements(p_watermarks) e) <> cardinality(v_tables)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_watermarks) e
                 WHERE NOT ((e ->> 'table_id') = ANY (SELECT unnest(v_tables)::text))) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'watermark_tables_mismatch', 'open_tables', to_jsonb(v_tables));
  END IF;
  SELECT jsonb_agg(jsonb_build_object('table_id', w.table_id, 'supplied', w.supplied, 'accepted', w.accepted))
    INTO v_bad
    FROM (SELECT (e ->> 'table_id')::uuid AS table_id,
                 CASE WHEN jsonb_typeof(e -> 'last_hand_number') = 'null' THEN NULL
                      ELSE (e ->> 'last_hand_number')::numeric END AS supplied,
                 (SELECT max(c.hand_number) FROM public.hand_atomic_commits c
                   WHERE c.table_id = (e ->> 'table_id')::uuid) AS accepted
            FROM jsonb_array_elements(p_watermarks) e) w
   WHERE w.supplied IS DISTINCT FROM w.accepted;
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'watermark_mismatch', 'tables', v_bad);
  END IF;

  -- (c) the live seats and the playing roster are the same people.
  IF EXISTS (SELECT 1 FROM public.tournament_players p
              WHERE p.tournament_id = p_tournament_id AND p.status::text = 'registered') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unseated_registrant');
  END IF;
  SELECT count(*) INTO v_players FROM public.tournament_players p
   WHERE p.tournament_id = p_tournament_id AND p.status::text = 'playing';
  SELECT count(*), COALESCE(sum(s.stack), 0) INTO v_seats, v_total
    FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL;
  IF v_players <> v_seats
     OR EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
                 WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL
                   AND (NOT (s.table_id = ANY (v_tables))
                        OR NOT EXISTS (SELECT 1 FROM public.tournament_players p
                                        WHERE p.tournament_id = p_tournament_id AND p.user_id = s.user_id
                                          AND p.status::text = 'playing')))
     OR (SELECT count(DISTINCT s.user_id) FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL) <> v_seats THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'roster_seat_mismatch', 'playing', v_players, 'live_seats', v_seats);
  END IF;
  IF v_seats < 2 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'field_decided', 'live_seats', v_seats);
  END IF;
  IF EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
              WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL
                AND (s.stack IS NULL OR s.stack <= 0 OR s.stack <> trunc(s.stack))) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stack_invalid');
  END IF;

  -- (d) every stack equals the last accepted hand that dealt its player.
  SELECT jsonb_agg(jsonb_build_object('user_id', s.user_id, 'felt', s.stack, 'accepted', w.written,
                                      'hand_number', w.hand_number))
    INTO v_bad
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
    CROSS JOIN LATERAL (
      SELECT (c.stack_result -> 'written' ->> s.user_id::text)::numeric AS written, c.hand_number
        FROM public.hand_atomic_commits c JOIN public.tables tc ON tc.id = c.table_id
       WHERE tc.tournament_id = p_tournament_id
         AND c.stack_result -> 'written' ? s.user_id::text
       ORDER BY c.hand_number DESC LIMIT 1) w
   WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL
     AND w.written IS DISTINCT FROM s.stack;
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'felt_differs_from_accepted_hand', 'seats', v_bad);
  END IF;

  SELECT COALESCE(sum(COALESCE(p.current_bounty, 0)), 0) INTO v_bounty
    FROM public.tournament_players p
   WHERE p.tournament_id = p_tournament_id AND p.status::text = 'playing';
  v_break := jsonb_build_object('on_break', COALESCE(v_t.on_break, false),
    'break_started_at', v_t.break_started_at, 'break_ends_at', v_t.break_ends_at,
    'addon_period_ends_at', v_t.addon_period_ends_at);

  -- ---- write: every stack moves seat -> bag exactly once ----
  PERFORM set_config('app.multi_day_stage_writer', p_tournament_id::text, true);
  PERFORM set_config('app.multi_day_stage_custody', p_tournament_id::text, true);

  v_facts := jsonb_build_object('stage_no', p_stage_no, 'next_stage_no', p_stage_no + 1,
    'players', v_seats, 'total_chips', v_total, 'bounty_total', v_bounty,
    'level_index', v_t.current_level, 'next_level_index', v_t.current_level + 1,
    'next_stage_start_utc', v_next.scheduled_start_utc, 'time_zone', v_plan.time_zone,
    'tables_closed', cardinality(v_tables), 'watermarks', p_watermarks,
    'lease_generation', p_lease_generation);
  INSERT INTO public.tournament_stage_transitions
    (tournament_id, stage_no, kind, idempotency_key, lease_generation, facts)
  VALUES (p_tournament_id, p_stage_no, 'bag', v_key, p_lease_generation, v_facts)
  RETURNING * INTO v_receipt;

  INSERT INTO public.tournament_stage_clock_snapshots
    (tournament_id, stage_no, bag_id, rule_version, level_index, small_blind, big_blind, ante,
     blind_level_state, remaining_level_ms, next_level_index, break_state, next_stage_no,
     next_stage_start_utc, next_stage_zone)
  VALUES (p_tournament_id, p_stage_no, v_receipt.id, v_plan.rule_version, v_t.current_level,
          (v_t.blind_level_state ->> 'small_blind')::numeric, (v_t.blind_level_state ->> 'big_blind')::numeric,
          (v_t.blind_level_state ->> 'ante')::numeric, v_t.blind_level_state,
          0, v_t.current_level + 1, v_break, p_stage_no + 1, v_next.scheduled_start_utc, v_plan.time_zone);

  INSERT INTO public.tournament_stage_bag_watermarks
    (tournament_id, stage_no, table_id, bag_id, last_hand_number, last_hand_id, seat_count, seat_stack_sum)
  SELECT p_tournament_id, p_stage_no, tb.id, v_receipt.id, c.hand_number, c.hand_id,
         (SELECT count(*) FROM public.table_seats s WHERE s.table_id = tb.id AND s.left_at IS NULL),
         (SELECT COALESCE(sum(s.stack), 0) FROM public.table_seats s WHERE s.table_id = tb.id AND s.left_at IS NULL)
    FROM unnest(v_tables) AS tb(id)
    LEFT JOIN LATERAL (SELECT c2.hand_number, c2.hand_id FROM public.hand_atomic_commits c2
                        WHERE c2.table_id = tb.id ORDER BY c2.hand_number DESC LIMIT 1) c ON true;

  INSERT INTO public.tournament_stage_bags
    (tournament_id, stage_no, bag_id, registration_id, user_id, stack, bounty_head,
     source_table_id, source_seat_id, source_seat_number, seat_club_id, seat_horse_id, watermark_hand_number)
  SELECT p_tournament_id, p_stage_no, v_receipt.id, p.id, p.user_id, s.stack, COALESCE(p.current_bounty, 0),
         s.table_id, s.id, s.seat_number, s.club_id, s.horse_id,
         (SELECT max(c.hand_number) FROM public.hand_atomic_commits c JOIN public.tables tc ON tc.id = c.table_id
           WHERE tc.tournament_id = p_tournament_id AND c.stack_result -> 'written' ? s.user_id::text)
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
    JOIN public.tournament_players p ON p.tournament_id = p_tournament_id AND p.user_id = s.user_id
   WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL;

  INSERT INTO public.tournament_qualification_entitlements
    (tournament_id, user_id, source_stage_no, source_registration_id, source_bag_row_id,
     stack, bounty_head, target_stage_no)
  SELECT b.tournament_id, b.user_id, b.stage_no, b.registration_id, b.id, b.stack, b.bounty_head, b.stage_no + 1
    FROM public.tournament_stage_bags b
   WHERE b.bag_id = v_receipt.id;

  UPDATE public.tournament_players p
     SET chips = b.stack::integer, table_id = NULL, seat_number = NULL
    FROM public.tournament_stage_bags b
   WHERE b.bag_id = v_receipt.id AND p.id = b.registration_id;

  UPDATE public.table_seats s
     SET stack = 0, left_at = clock_timestamp()
    FROM public.tournament_stage_bags b
   WHERE b.bag_id = v_receipt.id AND s.id = b.source_seat_id AND s.left_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_seats THEN
    RAISE EXCEPTION 'MULTI_DAY_BAG_SEAT_COUNT_CHANGED: % vacated, % expected', v_rows, v_seats USING ERRCODE = '40001';
  END IF;

  UPDATE public.tables tb
     SET status = 'closed', current_players = 0, updated_at = now()
   WHERE tb.id = ANY (v_tables);

  PERFORM set_config('app.atomic_stage_bag', p_tournament_id::text || ':' || v_receipt.id::text, true);
  UPDATE public.tournaments
     SET status = 'BAGGED',
         on_break = false,
         break_started_at = CASE WHEN COALESCE(v_t.on_break, false) THEN NULL ELSE break_started_at END,
         break_ends_at = CASE WHEN COALESCE(v_t.on_break, false) THEN NULL ELSE break_ends_at END
   WHERE id = p_tournament_id;
  PERFORM set_config('app.atomic_stage_bag', '', true);

  UPDATE public.tournament_stages
     SET state = 'bagged', state_changed_at = clock_timestamp()
   WHERE tournament_id = p_tournament_id AND stage_no = p_stage_no;
  UPDATE public.tournament_stages
     SET state = 'scheduled', state_changed_at = clock_timestamp()
   WHERE tournament_id = p_tournament_id AND stage_no = p_stage_no + 1;

  -- ---- conservation, before commit ----
  IF (SELECT count(*) FROM public.tournament_stage_bags WHERE bag_id = v_receipt.id) <> v_seats
     OR (SELECT COALESCE(sum(stack), 0) FROM public.tournament_stage_bags WHERE bag_id = v_receipt.id) <> v_total
     OR (SELECT COALESCE(sum(e.stack), 0) FROM public.tournament_qualification_entitlements e
          JOIN public.tournament_stage_bags b ON b.id = e.source_bag_row_id WHERE b.bag_id = v_receipt.id) <> v_total
     OR (SELECT COALESCE(sum(p.chips), 0) FROM public.tournament_players p
          WHERE p.tournament_id = p_tournament_id AND p.status::text = 'playing') <> v_total
     OR EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
                 WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL)
     OR (SELECT status FROM public.tournaments WHERE id = p_tournament_id) IS DISTINCT FROM 'BAGGED' THEN
    RAISE EXCEPTION 'MULTI_DAY_BAG_CONSERVATION_FAILED' USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('app.multi_day_stage_custody', '', true);
  PERFORM set_config('app.multi_day_stage_writer', '', true);
  RETURN v_facts || jsonb_build_object('ok', true, 'replay', false, 'bag_id', v_receipt.id);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 4. RESCHEDULE. Only while scheduled and unclaimed; each move bumps the
--    schedule generation, so a timer or wake armed for the old start is stale
--    and fn_begin_stage_resume refuses it.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_reschedule_tournament_stage(
  p_tournament_id uuid, p_stage_no integer, p_new_start_utc timestamptz,
  p_expected_generation bigint, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET statement_timeout = '30s'
AS $fn$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_stage public.tournament_stages%ROWTYPE;
  v_following timestamptz;
  v_key text;
  v_receipt public.tournament_stage_transitions%ROWTYPE;
BEGIN
  IF NOT public.fn_capability_available('tournament.multi_day.single_flight') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'capability_unavailable');
  END IF;
  IF p_tournament_id IS NULL OR p_stage_no IS NULL OR p_new_start_utc IS NULL
     OR p_expected_generation IS NULL OR p_reason IS NULL
     OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;
  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  SELECT * INTO v_stage FROM public.tournament_stages
   WHERE tournament_id = p_tournament_id AND stage_no = p_stage_no FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stage_not_found');
  END IF;

  v_key := 'reschedule:' || p_tournament_id::text || ':' || p_stage_no::text || ':'
           || (p_expected_generation + 1)::text;
  SELECT * INTO v_receipt FROM public.tournament_stage_transitions WHERE idempotency_key = v_key;
  IF FOUND THEN
    IF (v_receipt.facts ->> 'scheduled_start_utc')::timestamptz = p_new_start_utc THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'stage_no', p_stage_no,
        'schedule_generation', p_expected_generation + 1, 'scheduled_start_utc', p_new_start_utc);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'schedule_generation_stale',
      'schedule_generation', v_stage.schedule_generation, 'scheduled_start_utc', v_stage.scheduled_start_utc);
  END IF;

  IF v_t.status IS DISTINCT FROM 'BAGGED' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_bagged', 'status', v_t.status);
  END IF;
  IF v_stage.state IS DISTINCT FROM 'scheduled' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stage_not_scheduled', 'stage_state', v_stage.state);
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_stage_resume_receipts r
              WHERE r.tournament_id = p_tournament_id AND r.stage_no = p_stage_no) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'resume_already_claimed');
  END IF;
  IF v_stage.schedule_generation <> p_expected_generation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'schedule_generation_stale',
      'schedule_generation', v_stage.schedule_generation, 'scheduled_start_utc', v_stage.scheduled_start_utc);
  END IF;
  IF p_new_start_utc <= clock_timestamp() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'start_not_in_future');
  END IF;
  SELECT s.scheduled_start_utc INTO v_following FROM public.tournament_stages s
   WHERE s.tournament_id = p_tournament_id AND s.stage_no = p_stage_no + 1;
  IF v_following IS NOT NULL AND p_new_start_utc >= v_following THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'start_not_before_next_stage');
  END IF;

  PERFORM set_config('app.multi_day_stage_writer', p_tournament_id::text, true);
  UPDATE public.tournament_stages
     SET scheduled_start_utc = p_new_start_utc,
         schedule_generation = schedule_generation + 1,
         state_changed_at = clock_timestamp()
   WHERE tournament_id = p_tournament_id AND stage_no = p_stage_no;
  INSERT INTO public.tournament_stage_transitions
    (tournament_id, stage_no, kind, idempotency_key, schedule_generation, facts)
  VALUES (p_tournament_id, p_stage_no, 'reschedule', v_key, p_expected_generation + 1,
          jsonb_build_object('scheduled_start_utc', p_new_start_utc,
                             'previous_start_utc', v_stage.scheduled_start_utc,
                             'reason', btrim(p_reason)));
  PERFORM set_config('app.multi_day_stage_writer', '', true);

  RETURN jsonb_build_object('ok', true, 'replay', false, 'stage_no', p_stage_no,
    'schedule_generation', p_expected_generation + 1, 'scheduled_start_utc', p_new_start_utc,
    'previous_start_utc', v_stage.scheduled_start_utc);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 5. RESUME BEGIN. first_level = {"index":13,"small_blind":400,"big_blind":800,
--    "ante":800,"duration_ms":1200000}, the level the next stage opens with.
--    Tables created after this inherit it (fn_tournament_table_inherits_
--    committed_blinds reads blind_level_state).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_begin_stage_resume(
  p_tournament_id uuid, p_stage_no integer, p_resume_id uuid, p_schedule_generation bigint,
  p_lease_generation uuid, p_first_level jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET statement_timeout = '30s'
AS $fn$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_stage public.tournament_stages%ROWTYPE;
  v_previous public.tournament_stages%ROWTYPE;
  v_snapshot public.tournament_stage_clock_snapshots%ROWTYPE;
  v_receipt public.tournament_stage_resume_receipts%ROWTYPE;
  v_count integer;
  v_total numeric;
  v_level jsonb;
BEGIN
  IF NOT public.fn_capability_available('tournament.multi_day.single_flight') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'capability_unavailable');
  END IF;
  IF p_tournament_id IS NULL OR p_stage_no IS NULL OR p_resume_id IS NULL
     OR p_schedule_generation IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;
  IF NOT public.fn_multi_day_lease_is_current(p_tournament_id, p_lease_generation) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lease_lost');
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id, NULL);
  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  SELECT * INTO v_receipt FROM public.tournament_stage_resume_receipts
   WHERE tournament_id = p_tournament_id AND stage_no = p_stage_no FOR UPDATE;
  IF FOUND THEN
    IF v_receipt.completed_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'completed', true,
        'resume_id', v_receipt.resume_id, 'stage_no', p_stage_no, 'status', v_t.status);
    END IF;
    -- One resume per stage. A successor manager adopts the incomplete one.
    IF v_receipt.lease_generation IS DISTINCT FROM p_lease_generation THEN
      PERFORM set_config('app.multi_day_stage_writer', p_tournament_id::text, true);
      UPDATE public.tournament_stage_resume_receipts
         SET lease_generation = p_lease_generation
       WHERE tournament_id = p_tournament_id AND stage_no = p_stage_no;
      PERFORM set_config('app.multi_day_stage_writer', '', true);
    END IF;
    RETURN jsonb_build_object('ok', true, 'replay', true, 'completed', false,
      'adopted', v_receipt.lease_generation IS DISTINCT FROM p_lease_generation,
      'resume_id', v_receipt.resume_id, 'stage_no', p_stage_no, 'first_level', v_receipt.first_level);
  END IF;

  IF v_t.status IS DISTINCT FROM 'BAGGED' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_bagged', 'status', v_t.status);
  END IF;
  SELECT * INTO v_stage FROM public.tournament_stages
   WHERE tournament_id = p_tournament_id AND stage_no = p_stage_no FOR UPDATE;
  IF NOT FOUND OR v_stage.state IS DISTINCT FROM 'scheduled' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stage_not_scheduled', 'stage_state', v_stage.state);
  END IF;
  IF v_stage.schedule_generation <> p_schedule_generation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'schedule_generation_stale',
      'schedule_generation', v_stage.schedule_generation, 'scheduled_start_utc', v_stage.scheduled_start_utc);
  END IF;
  IF clock_timestamp() < v_stage.scheduled_start_utc THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_due', 'scheduled_start_utc', v_stage.scheduled_start_utc);
  END IF;
  SELECT * INTO v_previous FROM public.tournament_stages
   WHERE tournament_id = p_tournament_id AND stage_no = p_stage_no - 1;
  SELECT * INTO v_snapshot FROM public.tournament_stage_clock_snapshots
   WHERE tournament_id = p_tournament_id AND stage_no = p_stage_no - 1;
  IF v_previous.state IS DISTINCT FROM 'bagged' OR v_snapshot.bag_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'previous_stage_not_bagged');
  END IF;

  IF p_first_level IS NULL OR jsonb_typeof(p_first_level) <> 'object'
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_first_level) k)
        IS DISTINCT FROM ARRAY['ante', 'big_blind', 'duration_ms', 'index', 'small_blind']
     OR EXISTS (SELECT 1 FROM jsonb_each(p_first_level) e WHERE jsonb_typeof(e.value) <> 'number')
     OR (p_first_level ->> 'index')::numeric IS DISTINCT FROM v_snapshot.next_level_index
     OR (p_first_level ->> 'small_blind')::numeric < 0
     OR (p_first_level ->> 'big_blind')::numeric <= 0
     OR (p_first_level ->> 'big_blind')::numeric > 10000000
     OR (p_first_level ->> 'small_blind')::numeric > (p_first_level ->> 'big_blind')::numeric
     OR (p_first_level ->> 'ante')::numeric < 0
     OR (p_first_level ->> 'ante')::numeric > 10000000
     OR (p_first_level ->> 'duration_ms')::numeric NOT BETWEEN 60000 AND 86400000
     OR (p_first_level ->> 'duration_ms')::numeric <> trunc((p_first_level ->> 'duration_ms')::numeric) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'first_level_invalid',
      'expected_index', v_snapshot.next_level_index);
  END IF;

  SELECT count(*), COALESCE(sum(e.stack), 0) INTO v_count, v_total
    FROM public.tournament_qualification_entitlements e
   WHERE e.tournament_id = p_tournament_id AND e.target_stage_no = p_stage_no AND e.state = 'active';
  v_level := jsonb_build_object('index', (p_first_level ->> 'index')::integer,
    'small_blind', (p_first_level ->> 'small_blind')::numeric,
    'big_blind', (p_first_level ->> 'big_blind')::numeric,
    'ante', (p_first_level ->> 'ante')::numeric);

  PERFORM set_config('app.multi_day_stage_writer', p_tournament_id::text, true);
  INSERT INTO public.tournament_stage_resume_receipts
    (tournament_id, stage_no, resume_id, lease_generation, schedule_generation, first_level)
  VALUES (p_tournament_id, p_stage_no, p_resume_id, p_lease_generation, p_schedule_generation, p_first_level);
  INSERT INTO public.tournament_stage_transitions
    (tournament_id, stage_no, kind, idempotency_key, lease_generation, schedule_generation, facts)
  VALUES (p_tournament_id, p_stage_no, 'resume_begin',
          'resume_begin:' || p_tournament_id::text || ':' || p_stage_no::text,
          p_lease_generation, p_schedule_generation,
          jsonb_build_object('resume_id', p_resume_id, 'first_level', p_first_level,
                             'entitlements', v_count, 'total_chips', v_total,
                             'overdue_ms', floor(extract(epoch FROM clock_timestamp() - v_stage.scheduled_start_utc) * 1000)));
  UPDATE public.tournament_stages
     SET state = 'resuming', state_changed_at = clock_timestamp()
   WHERE tournament_id = p_tournament_id AND stage_no = p_stage_no;
  UPDATE public.tournaments
     SET current_level = (p_first_level ->> 'index')::integer,
         blind_level_state = v_level
   WHERE id = p_tournament_id;
  PERFORM set_config('app.multi_day_stage_writer', '', true);

  RETURN jsonb_build_object('ok', true, 'replay', false, 'completed', false, 'adopted', false,
    'resume_id', p_resume_id, 'stage_no', p_stage_no, 'first_level', p_first_level,
    'entitlements', v_count, 'total_chips', v_total);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 6. SEAT ONCE. One entitlement, one chair, exactly its stack. The seat keeps
--    the club and horse identity it was bagged with (entry-time attribution is
--    never re-derived); the time bank starts fresh as for any new occupant.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_seat_stage_entitlement(
  p_tournament_id uuid, p_resume_id uuid, p_lease_generation uuid, p_entitlement_id uuid,
  p_table_id uuid, p_seat_number integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET statement_timeout = '30s'
AS $fn$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_receipt public.tournament_stage_resume_receipts%ROWTYPE;
  v_ent public.tournament_qualification_entitlements%ROWTYPE;
  v_bag public.tournament_stage_bags%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_table public.tables%ROWTYPE;
  v_destination public.table_seats%ROWTYPE;
  v_seat_id uuid;
  v_live_total numeric;
  v_entitled_total numeric;
  v_now timestamptz;
BEGIN
  IF NOT public.fn_capability_available('tournament.multi_day.single_flight') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'capability_unavailable');
  END IF;
  IF p_tournament_id IS NULL OR p_resume_id IS NULL OR p_lease_generation IS NULL
     OR p_entitlement_id IS NULL OR p_table_id IS NULL
     OR p_seat_number IS NULL OR p_seat_number NOT BETWEEN 1 AND 10 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;
  IF NOT public.fn_multi_day_lease_is_current(p_tournament_id, p_lease_generation) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lease_lost');
  END IF;
  -- T(id) exclusive is also the proof a0_tournament_live_seat_root_guard asks for.
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id, NULL);
  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  SELECT * INTO v_receipt FROM public.tournament_stage_resume_receipts
   WHERE tournament_id = p_tournament_id AND resume_id = p_resume_id FOR UPDATE;
  IF NOT FOUND OR v_receipt.lease_generation IS DISTINCT FROM p_lease_generation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'resume_receipt_mismatch');
  END IF;
  SELECT * INTO v_ent FROM public.tournament_qualification_entitlements
   WHERE id = p_entitlement_id AND tournament_id = p_tournament_id
     AND target_stage_no = v_receipt.stage_no
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'entitlement_not_found');
  END IF;
  IF v_ent.state = 'consumed' THEN
    IF v_ent.consumed_by_resume_id = p_resume_id AND v_ent.consumed_table_id = p_table_id
       AND v_ent.consumed_seat_number = p_seat_number
       AND EXISTS (SELECT 1 FROM public.table_seats s
                    WHERE s.id = v_ent.consumed_seat_id AND s.user_id = v_ent.user_id) THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'entitlement_id', v_ent.id,
        'user_id', v_ent.user_id, 'table_id', p_table_id, 'seat_id', v_ent.consumed_seat_id,
        'seat_number', p_seat_number, 'stack', v_ent.stack);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'entitlement_already_consumed',
      'table_id', v_ent.consumed_table_id, 'seat_number', v_ent.consumed_seat_number);
  END IF;
  IF v_receipt.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'resume_already_complete');
  END IF;
  IF v_t.status IS DISTINCT FROM 'BAGGED' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_bagged', 'status', v_t.status);
  END IF;

  SELECT * INTO v_player FROM public.tournament_players
   WHERE id = v_ent.source_registration_id AND tournament_id = p_tournament_id FOR UPDATE;
  IF NOT FOUND OR v_player.user_id IS DISTINCT FROM v_ent.user_id
     OR v_player.status::text <> 'playing'
     OR v_player.chips::numeric IS DISTINCT FROM v_ent.stack
     OR COALESCE(v_player.current_bounty, 0) IS DISTINCT FROM v_ent.bounty_head THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'roster_differs_from_bag');
  END IF;
  SELECT * INTO v_table FROM public.tables WHERE id = p_table_id FOR UPDATE;
  IF NOT FOUND OR v_table.tournament_id IS DISTINCT FROM p_tournament_id
     OR lower(COALESCE(v_table.status::text, '')) NOT IN ('waiting', 'running', 'active')
     OR COALESCE(v_table.is_deleted, false)
     OR p_seat_number > LEAST(10, COALESCE(NULLIF(v_table.max_players, 0), 10)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_assignable');
  END IF;
  PERFORM 1 FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id AND s.user_id = v_ent.user_id AND s.left_at IS NULL
   FOR UPDATE OF s;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'player_already_seated');
  END IF;
  SELECT * INTO v_destination FROM public.table_seats
   WHERE table_id = p_table_id AND seat_number = p_seat_number FOR UPDATE;
  IF FOUND AND v_destination.left_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
  END IF;

  SELECT COALESCE(sum(s.stack), 0) INTO v_live_total
    FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL;
  SELECT COALESCE(sum(e.stack), 0) INTO v_entitled_total
    FROM public.tournament_qualification_entitlements e
   WHERE e.tournament_id = p_tournament_id AND e.target_stage_no = v_receipt.stage_no;
  IF v_live_total + v_ent.stack > v_entitled_total THEN
    RAISE EXCEPTION 'MULTI_DAY_SEAT_WOULD_MINT: live % + % exceeds entitled %',
      v_live_total, v_ent.stack, v_entitled_total USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_bag FROM public.tournament_stage_bags WHERE id = v_ent.source_bag_row_id;

  PERFORM set_config('app.multi_day_stage_writer', p_tournament_id::text, true);
  PERFORM set_config('app.multi_day_stage_custody', p_tournament_id::text, true);
  PERFORM set_config('app.atomic_stage_resume', p_tournament_id::text || ':' || p_resume_id::text, true);
  v_now := clock_timestamp();
  IF v_destination.id IS NULL THEN
    INSERT INTO public.table_seats(
      table_id, user_id, player_id, member_id, seat_number, stack, status,
      joined_at, left_at, is_sitting_out, is_away, leave_pending,
      scheduled_leave_hands, horse_id, auto_rebuy, time_bank_remaining,
      time_bank_uses_remaining, club_id, sit_out_at, entry_hold, entry_post_agreed)
    VALUES (
      p_table_id, v_ent.user_id, NULL, NULL, p_seat_number, v_ent.stack, 'active',
      v_now, NULL, false, false, false, NULL, v_bag.seat_horse_id, false, 30, 4,
      v_bag.seat_club_id, NULL, NULL, false)
    RETURNING id INTO v_seat_id;
  ELSE
    UPDATE public.table_seats s
       SET user_id = v_ent.user_id, player_id = NULL, member_id = NULL, stack = v_ent.stack,
           status = 'active', joined_at = v_now, left_at = NULL,
           is_sitting_out = false, is_away = false, leave_pending = false,
           sit_out_at = NULL, scheduled_leave_hands = NULL,
           horse_id = v_bag.seat_horse_id, entry_hold = NULL, entry_post_agreed = false,
           auto_rebuy = false, time_bank_remaining = 30, time_bank_uses_remaining = 4,
           club_id = v_bag.seat_club_id
     WHERE s.id = v_destination.id AND s.left_at IS NOT NULL
    RETURNING id INTO v_seat_id;
    IF v_seat_id IS NULL THEN
      RAISE EXCEPTION 'vacated tournament seat changed during stage seating' USING ERRCODE = '40001';
    END IF;
  END IF;

  UPDATE public.tournament_players
     SET table_id = p_table_id, seat_number = p_seat_number
   WHERE id = v_player.id;
  UPDATE public.tournament_qualification_entitlements
     SET state = 'consumed', consumed_by_resume_id = p_resume_id, consumed_seat_id = v_seat_id,
         consumed_table_id = p_table_id, consumed_seat_number = p_seat_number, consumed_at = v_now
   WHERE id = v_ent.id;
  UPDATE public.tables tb
     SET current_players = (SELECT count(*) FROM public.table_seats s
                             WHERE s.table_id = p_table_id AND s.left_at IS NULL),
         updated_at = now()
   WHERE tb.id = p_table_id;

  PERFORM set_config('app.atomic_stage_resume', '', true);
  PERFORM set_config('app.multi_day_stage_custody', '', true);
  PERFORM set_config('app.multi_day_stage_writer', '', true);
  RETURN jsonb_build_object('ok', true, 'replay', false, 'entitlement_id', v_ent.id,
    'user_id', v_ent.user_id, 'table_id', p_table_id, 'seat_id', v_seat_id,
    'seat_number', p_seat_number, 'stack', v_ent.stack);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 7. RESUME COMPLETE. Every entitlement seated with exactly its stack, then
--    BAGGED -> RUNNING with the stage's first level starting now.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_complete_stage_resume(
  p_tournament_id uuid, p_resume_id uuid, p_lease_generation uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET statement_timeout = '30s'
AS $fn$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_receipt public.tournament_stage_resume_receipts%ROWTYPE;
  v_done public.tournament_stage_transitions%ROWTYPE;
  v_count integer;
  v_total numeric;
  v_unseated integer;
  v_facts jsonb;
  v_started timestamptz;
BEGIN
  IF NOT public.fn_capability_available('tournament.multi_day.single_flight') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'capability_unavailable');
  END IF;
  IF p_tournament_id IS NULL OR p_resume_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;
  SELECT * INTO v_receipt FROM public.tournament_stage_resume_receipts
   WHERE tournament_id = p_tournament_id AND resume_id = p_resume_id;
  IF FOUND AND v_receipt.completed_at IS NOT NULL THEN
    SELECT * INTO v_done FROM public.tournament_stage_transitions
     WHERE idempotency_key = 'resume_complete:' || p_tournament_id::text || ':' || v_receipt.stage_no::text;
    RETURN v_done.facts || jsonb_build_object('ok', true, 'replay', true);
  END IF;

  IF NOT public.fn_multi_day_lease_is_current(p_tournament_id, p_lease_generation) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lease_lost');
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id, NULL);
  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  SELECT * INTO v_receipt FROM public.tournament_stage_resume_receipts
   WHERE tournament_id = p_tournament_id AND resume_id = p_resume_id FOR UPDATE;
  IF NOT FOUND OR v_receipt.lease_generation IS DISTINCT FROM p_lease_generation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'resume_receipt_mismatch');
  END IF;
  IF v_receipt.completed_at IS NOT NULL THEN
    SELECT * INTO v_done FROM public.tournament_stage_transitions
     WHERE idempotency_key = 'resume_complete:' || p_tournament_id::text || ':' || v_receipt.stage_no::text;
    RETURN v_done.facts || jsonb_build_object('ok', true, 'replay', true);
  END IF;
  IF v_t.status IS DISTINCT FROM 'BAGGED' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_bagged', 'status', v_t.status);
  END IF;
  IF (SELECT s.state FROM public.tournament_stages s
       WHERE s.tournament_id = p_tournament_id AND s.stage_no = v_receipt.stage_no FOR UPDATE)
     IS DISTINCT FROM 'resuming' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stage_not_resuming');
  END IF;

  SELECT count(*), COALESCE(sum(e.stack), 0), count(*) FILTER (WHERE e.state <> 'consumed')
    INTO v_count, v_total, v_unseated
    FROM public.tournament_qualification_entitlements e
   WHERE e.tournament_id = p_tournament_id AND e.target_stage_no = v_receipt.stage_no;
  IF v_unseated > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unseated_entitlements', 'unseated', v_unseated);
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_qualification_entitlements e
               LEFT JOIN public.table_seats s ON s.id = e.consumed_seat_id
               LEFT JOIN public.tournament_players p ON p.id = e.source_registration_id
              WHERE e.tournament_id = p_tournament_id AND e.target_stage_no = v_receipt.stage_no
                AND (s.id IS NULL OR s.left_at IS NOT NULL OR s.user_id IS DISTINCT FROM e.user_id
                     OR s.stack IS DISTINCT FROM e.stack OR s.table_id IS DISTINCT FROM e.consumed_table_id
                     OR p.status::text IS DISTINCT FROM 'playing' OR p.chips::numeric IS DISTINCT FROM e.stack
                     OR COALESCE(p.current_bounty, 0) IS DISTINCT FROM e.bounty_head
                     OR p.table_id IS DISTINCT FROM s.table_id OR p.seat_number IS DISTINCT FROM s.seat_number))
     OR (SELECT count(*) FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL) <> v_count
     OR (SELECT COALESCE(sum(s.stack), 0) FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL) <> v_total
     OR (SELECT COALESCE(sum(p.chips), 0) FROM public.tournament_players p
          WHERE p.tournament_id = p_tournament_id AND p.status::text = 'playing') <> v_total THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seats_differ_from_entitlements');
  END IF;

  v_started := clock_timestamp();
  v_facts := jsonb_build_object('resume_id', p_resume_id, 'stage_no', v_receipt.stage_no,
    'status', 'RUNNING', 'players', v_count, 'total_chips', v_total,
    'current_level', (v_receipt.first_level ->> 'index')::integer,
    'level_started_at', v_started, 'level_duration_ms', (v_receipt.first_level ->> 'duration_ms')::bigint);

  -- Status first: both doors admit BAGGED -> RUNNING only while this receipt
  -- is still incomplete. The stage's first level starts now (its full
  -- duration remains), so the engine's derived clock needs no stored offset.
  PERFORM set_config('app.atomic_stage_resume', p_tournament_id::text || ':' || p_resume_id::text, true);
  UPDATE public.tournaments
     SET status = 'RUNNING', level_started_at = v_started, on_break = false
   WHERE id = p_tournament_id;
  PERFORM set_config('app.atomic_stage_resume', '', true);
  IF (SELECT status FROM public.tournaments WHERE id = p_tournament_id) IS DISTINCT FROM 'RUNNING' THEN
    RAISE EXCEPTION 'MULTI_DAY_RESUME_STATUS_NOT_ACKNOWLEDGED' USING ERRCODE = '40001';
  END IF;

  PERFORM set_config('app.multi_day_stage_writer', p_tournament_id::text, true);
  UPDATE public.tournament_stage_resume_receipts
     SET completed_at = v_started
   WHERE tournament_id = p_tournament_id AND stage_no = v_receipt.stage_no;
  INSERT INTO public.tournament_stage_transitions
    (tournament_id, stage_no, kind, idempotency_key, lease_generation, facts)
  VALUES (p_tournament_id, v_receipt.stage_no, 'resume_complete',
          'resume_complete:' || p_tournament_id::text || ':' || v_receipt.stage_no::text,
          p_lease_generation, v_facts);
  UPDATE public.tournament_stages
     SET state = 'running', state_changed_at = v_started
   WHERE tournament_id = p_tournament_id AND stage_no = v_receipt.stage_no;
  UPDATE public.tournament_stages
     SET state = 'closed', state_changed_at = v_started
   WHERE tournament_id = p_tournament_id AND stage_no = v_receipt.stage_no - 1;
  PERFORM set_config('app.multi_day_stage_writer', '', true);
  RETURN v_facts || jsonb_build_object('ok', true, 'replay', false);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 8. WHO MAY CALL. The engine (service_role) only. An operator reschedule
--    door for the club console is R5 client work and will wrap
--    fn_reschedule_tournament_stage with its own auth.uid() authorization.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_multi_day_lease_is_current(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_seal_tournament_stage_plan(uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_begin_stage_end(uuid,uuid,integer,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_bag_tournament_stage(uuid,uuid,integer,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_reschedule_tournament_stage(uuid,integer,timestamptz,bigint,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_begin_stage_resume(uuid,integer,uuid,bigint,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_seat_stage_entitlement(uuid,uuid,uuid,uuid,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_complete_stage_resume(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_seal_tournament_stage_plan(uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_begin_stage_end(uuid,uuid,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_bag_tournament_stage(uuid,uuid,integer,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_reschedule_tournament_stage(uuid,integer,timestamptz,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_begin_stage_resume(uuid,integer,uuid,bigint,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_seat_stage_entitlement(uuid,uuid,uuid,uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_complete_stage_resume(uuid,uuid,uuid) TO service_role;

DO $post$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.fn_seal_tournament_stage_plan(uuid,jsonb)',
    'public.fn_begin_stage_end(uuid,uuid,integer,integer)',
    'public.fn_bag_tournament_stage(uuid,uuid,integer,jsonb)',
    'public.fn_reschedule_tournament_stage(uuid,integer,timestamptz,bigint,text)',
    'public.fn_begin_stage_resume(uuid,integer,uuid,bigint,uuid,jsonb)',
    'public.fn_seat_stage_entitlement(uuid,uuid,uuid,uuid,uuid,integer)',
    'public.fn_complete_stage_resume(uuid,uuid,uuid)'] LOOP
    IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE')
       OR has_function_privilege('authenticated', v_sig, 'EXECUTE')
       OR has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'MULTI_DAY_RPC_GRANTS_NOT_AS_DECLARED: %', v_sig USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF has_function_privilege('service_role', 'public.fn_multi_day_lease_is_current(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'MULTI_DAY_RPC_GRANTS_NOT_AS_DECLARED: lease helper' USING ERRCODE = '42501';
  END IF;
  -- Unreachable until R6: the capability is not available at install.
  IF public.fn_capability_available('tournament.multi_day.single_flight') THEN
    RAISE EXCEPTION 'MULTI_DAY_CAPABILITY_ALREADY_AVAILABLE: install R5 before the capability moves'
      USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
