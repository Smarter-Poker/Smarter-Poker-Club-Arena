-- 20260924063656_multi_day_stage_view_and_operator_doors.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  MULTI-DAY TOURNAMENTS, RELEASE R5 (CLIENT HALF): THE READ AND THE DOORS
--  Design: docs/handoffs/club-arena-product-completion/MULTI-DAY-DESIGN.md
--  sections 3, 4 (client read path), 7 and 11.
-- ===========================================================================
--
-- THREE BROWSER RPCs, granted to `authenticated` only:
--
--   fn_tournament_stage_view(tournament)
--       The design's ca_tournament_stage_view. Read-only. Returns the public
--       day schedule (every stage, its state, its start and the plan's IANA
--       zone), the current stage, the next start, and for THE CALLER ONLY
--       their own bag (chips and bounty head) and, once the next day is
--       running, their own live seat. About other players it returns exactly
--       one thing: the post-bag chip leaders, top 10, by display name and
--       stack. No user id, horse flag, club or seat of anybody else. Horses
--       are read through the same rows as humans, with no is_horse branch
--       anywhere (CLAUDE.md 10.5).
--
--   fn_operator_seal_stage_plan(tournament, plan)
--   fn_operator_reschedule_stage(tournament, stage_no, new_start_utc,
--                                expected_generation, reason)
--       The operator doors. Each proves an authenticated caller with a live
--       session (fn_caller_session_is_live, the same door every browser money
--       path uses), refuses unless
--       fn_capability_available('tournament.multi_day.single_flight'), then
--       asks fn_can_create_games(<the event's club>, auth.uid()) - the
--       authority fn_create_tournament uses - and only then delegates to the
--       service-role RPC of 20260924043239. Validation, locking, idempotent
--       replay and the receipt all stay in that one RPC; the door adds no
--       second copy of any rule.
--
-- TIMES are ISO 8601 in UTC with a Z whatever the session's TimeZone, and the
-- plan's IANA zone travels beside them, so the client prints the start in the
-- zone the operator chose ("Day 2 Starts Sat 12:00 PM CDT").
--
-- VISIBILITY. The view answers only for an event the caller could read
-- through the tournaments SELECT policy (poker_arena_tournament_access:
-- a platform event, or fn_poker_can_read_games on its union or club). Any
-- other id answers tournament_not_found, the same as an id that does not
-- exist.
--
-- NO CAPABILITY GATE ON THE READ, deliberately: a running event is never
-- stranded by a capability being withdrawn (design section 1), so a player
-- holding a bag can always read it. The client shows nothing multi-day unless
-- the capability is available AND this view reports a plan.
--
-- NOTHING IS WRITTEN HERE except through the two delegated RPCs. No table,
-- trigger, column or policy is added or changed.
--
-- ROLLBACK: DROP the three functions (the client hides every surface when the
-- view is absent, and the doors have no other caller).
--
-- @live-proof: (SELECT count(*) = 3 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND p.proname IN ('fn_tournament_stage_view','fn_operator_seal_stage_plan','fn_operator_reschedule_stage') AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE'))

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF to_regprocedure('public.fn_capability_available(text)') IS NULL
     OR to_regprocedure('public.fn_seal_tournament_stage_plan(uuid,jsonb)') IS NULL
     OR to_regprocedure('public.fn_reschedule_tournament_stage(uuid,integer,timestamptz,bigint,text)') IS NULL
     OR to_regprocedure('public.fn_can_create_games(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_caller_session_is_live()') IS NULL
     OR to_regprocedure('public.fn_poker_can_read_games(uuid)') IS NULL
     OR to_regclass('public.tournament_stage_plans') IS NULL
     OR to_regclass('public.tournament_stage_bags') IS NULL
     OR to_regclass('public.tournament_qualification_entitlements') IS NULL THEN
    RAISE EXCEPTION 'MULTI_DAY_VIEW_PREREQUISITES_MISSING (install 20260924025555 and 20260924043217..043239 first)'
      USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('public.fn_tournament_stage_view(uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_operator_seal_stage_plan(uuid,jsonb)') IS NOT NULL
     OR to_regprocedure('public.fn_operator_reschedule_stage(uuid,integer,timestamptz,bigint,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'MULTI_DAY_VIEW_NAME_TAKEN' USING ERRCODE = '42723';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. THE STAGE VIEW.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_tournament_stage_view(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET statement_timeout = '10s'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_t public.tournaments%ROWTYPE;
  v_plan public.tournament_stage_plans%ROWTYPE;
  v_stages jsonb;
  v_current integer;
  v_current_state text;
  v_next jsonb;
  v_bag_stage integer;
  v_my_bag jsonb;
  v_my_seat jsonb;
  v_leaders jsonb;
  v_bagged_players integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'session_revoked');
  END IF;
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id;
  -- The same visibility as the tournaments SELECT policy; an event the caller
  -- could not read answers exactly like one that does not exist.
  IF NOT FOUND
     OR NOT ((v_t.club_id IS NULL AND v_t.union_id IS NULL)
             OR COALESCE(public.fn_poker_can_read_games(COALESCE(v_t.union_id, v_t.club_id)), false)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  SELECT * INTO v_plan FROM public.tournament_stage_plans WHERE tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
      'status', v_t.status, 'plan', NULL);
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'stage_no', s.stage_no,
           'day_no', s.day_no,
           'end_after_level', s.end_after_level,
           'scheduled_start_utc', to_char(s.scheduled_start_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'schedule_generation', s.schedule_generation,
           'state', s.state) ORDER BY s.stage_no)
    INTO v_stages
    FROM public.tournament_stages s
   WHERE s.tournament_id = p_tournament_id;

  -- Where the event is: the latest stage that has played (running, ending or
  -- bagged); before the launch, stage 1.
  SELECT s.stage_no, s.state INTO v_current, v_current_state
    FROM public.tournament_stages s
   WHERE s.tournament_id = p_tournament_id
     AND s.state IN ('running', 'day_ending', 'bagged')
   ORDER BY s.stage_no DESC
   LIMIT 1;
  IF v_current IS NULL THEN
    SELECT s.stage_no, s.state INTO v_current, v_current_state
      FROM public.tournament_stages s
     WHERE s.tournament_id = p_tournament_id
     ORDER BY s.stage_no
     LIMIT 1;
  END IF;

  SELECT jsonb_build_object(
           'stage_no', s.stage_no,
           'day_no', s.day_no,
           'scheduled_start_utc', to_char(s.scheduled_start_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'time_zone', v_plan.time_zone,
           'schedule_generation', s.schedule_generation,
           'state', s.state)
    INTO v_next
    FROM public.tournament_stages s
   WHERE s.tournament_id = p_tournament_id
     AND s.stage_no > v_current
     AND s.state IN ('planned', 'scheduled', 'resuming')
     AND s.scheduled_start_utc IS NOT NULL
   ORDER BY s.stage_no
   LIMIT 1;

  -- The most recent bag, if any.
  SELECT max(b.stage_no) INTO v_bag_stage
    FROM public.tournament_stage_bags b
   WHERE b.tournament_id = p_tournament_id;

  IF v_bag_stage IS NOT NULL THEN
    -- The caller's own bag and nobody else's.
    SELECT jsonb_build_object(
             'stage_no', b.stage_no,
             'day_no', b.stage_no,
             'stack', b.stack,
             'bounty_head', b.bounty_head)
      INTO v_my_bag
      FROM public.tournament_stage_bags b
     WHERE b.tournament_id = p_tournament_id
       AND b.stage_no = v_bag_stage
       AND b.user_id = v_uid;

    SELECT count(*) INTO v_bagged_players
      FROM public.tournament_stage_bags b
     WHERE b.tournament_id = p_tournament_id AND b.stage_no = v_bag_stage;

    -- Post-bag chip leaders: display name and stack only.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'rank', l.rank, 'display_name', l.display_name, 'stack', l.stack) ORDER BY l.rank), '[]'::jsonb)
      INTO v_leaders
      FROM (
        SELECT row_number() OVER (ORDER BY b.stack DESC, COALESCE(NULLIF(btrim(p.username), ''), 'Player'), b.id) AS rank,
               COALESCE(NULLIF(btrim(p.username), ''), 'Player') AS display_name,
               b.stack
          FROM public.tournament_stage_bags b
          LEFT JOIN public.tournament_players p ON p.id = b.registration_id
         WHERE b.tournament_id = p_tournament_id AND b.stage_no = v_bag_stage
         ORDER BY b.stack DESC, COALESCE(NULLIF(btrim(p.username), ''), 'Player'), b.id
         LIMIT 10) l;
  END IF;

  -- The caller's seat for the stage now running, once their entitlement for
  -- it has been seated: the chair they actually hold now.
  IF v_t.status = 'RUNNING' AND v_current_state IN ('running', 'day_ending') AND EXISTS (
       SELECT 1 FROM public.tournament_qualification_entitlements e
        WHERE e.tournament_id = p_tournament_id
          AND e.user_id = v_uid
          AND e.target_stage_no = v_current
          AND e.state = 'consumed') THEN
    SELECT jsonb_build_object(
             'stage_no', v_current,
             'day_no', v_current,
             'table_id', s.table_id,
             'table_name', tb.name,
             'seat_number', s.seat_number)
      INTO v_my_seat
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id = s.table_id
     WHERE tb.tournament_id = p_tournament_id
       AND s.user_id = v_uid
       AND s.left_at IS NULL
     ORDER BY s.joined_at DESC NULLS LAST
     LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'tournament_id', p_tournament_id,
    'status', v_t.status,
    'plan', jsonb_build_object(
      'rule_version', v_plan.rule_version,
      'time_zone', v_plan.time_zone,
      'stage_count', v_plan.stage_count),
    'stages', COALESCE(v_stages, '[]'::jsonb),
    'current_stage', jsonb_build_object('stage_no', v_current, 'day_no', v_current, 'state', v_current_state),
    'next_start', v_next,
    'bag', CASE WHEN v_bag_stage IS NULL THEN NULL
                ELSE jsonb_build_object('stage_no', v_bag_stage, 'day_no', v_bag_stage,
                                        'players', v_bagged_players) END,
    'my_bag', v_my_bag,
    'my_seat', v_my_seat,
    'chip_leaders', COALESCE(v_leaders, '[]'::jsonb));
END
$fn$;

-- ---------------------------------------------------------------------------
-- 2. THE OPERATOR DOORS.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_operator_seal_stage_plan(p_tournament_id uuid, p_plan jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET statement_timeout = '30s'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_capability_available('tournament.multi_day.single_flight') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'capability_unavailable');
  END IF;
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;
  SELECT t.club_id INTO v_club FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  IF v_club IS NULL OR NOT COALESCE(public.fn_can_create_games(v_club, v_uid), false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorised');
  END IF;
  RETURN public.fn_seal_tournament_stage_plan(p_tournament_id, p_plan);
END
$fn$;

CREATE FUNCTION public.fn_operator_reschedule_stage(
  p_tournament_id uuid, p_stage_no integer, p_new_start_utc timestamptz,
  p_expected_generation bigint, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET statement_timeout = '30s'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_capability_available('tournament.multi_day.single_flight') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'capability_unavailable');
  END IF;
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;
  SELECT t.club_id INTO v_club FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  IF v_club IS NULL OR NOT COALESCE(public.fn_can_create_games(v_club, v_uid), false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorised');
  END IF;
  RETURN public.fn_reschedule_tournament_stage(
    p_tournament_id, p_stage_no, p_new_start_utc, p_expected_generation, p_reason);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 3. WHO MAY CALL. Signed-in players and operators; never anon, and the
--    engine keeps calling the service-role RPCs directly.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_tournament_stage_view(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_operator_seal_stage_plan(uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_operator_reschedule_stage(uuid,integer,timestamptz,bigint,text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_tournament_stage_view(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_operator_seal_stage_plan(uuid,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_operator_reschedule_stage(uuid,integer,timestamptz,bigint,text) TO authenticated;

DO $post$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.fn_tournament_stage_view(uuid)',
    'public.fn_operator_seal_stage_plan(uuid,jsonb)',
    'public.fn_operator_reschedule_stage(uuid,integer,timestamptz,bigint,text)'] LOOP
    IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
       OR has_function_privilege('anon', v_sig, 'EXECUTE')
       OR has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'MULTI_DAY_DOOR_GRANTS_NOT_AS_DECLARED: %', v_sig USING ERRCODE = '42501';
    END IF;
  END LOOP;
  -- The service-role RPCs stay closed to browsers; only the doors open them.
  IF has_function_privilege('authenticated', 'public.fn_seal_tournament_stage_plan(uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_reschedule_tournament_stage(uuid,integer,timestamptz,bigint,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'MULTI_DAY_SERVICE_RPC_REACHABLE_FROM_A_BROWSER' USING ERRCODE = '42501';
  END IF;
END
$post$;

COMMIT;
