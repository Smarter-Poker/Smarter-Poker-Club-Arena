-- The four owner-facing admission doors, captured EXACTLY as installed.
--
-- Source: production project kuklfnapbkmacvwxktbh, read with
--   SELECT pg_get_functiondef('<signature>'::regprocedure)
-- through the Supabase MCP execute_sql tool on 2026-09-24 (UTC), read-only.
-- Nothing in this repository defines these live bodies verbatim (the review
-- door was never committed, and the tournament and schedule doors carry
-- production-only amendments), so the harness loads this capture.
--
-- live md5(pg_get_functiondef) on 2026-09-24, re-proved by the runner after
-- loading (a transcription error fails the run):
--   fn_review_join_request(uuid,uuid,boolean)                                  0ad8e6df115201015d969e0db78e3ff5
--   fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean) fec049e3a50544b66d88dab7ff535ae2
--   fn_create_tournament(uuid,jsonb)                                           4c5c8783d1f6f534fdaf5cefbb460d62
--   fn_upsert_tournament_schedule(jsonb)                                       b8dd7cc8e0996889a936affdc732b664
-- live ACL of each: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.fn_review_join_request(p_club_id uuid, p_user_id uuid, p_approve boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_found boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT is_club_admin(p_club_id, v_uid) THEN
    RAISE EXCEPTION 'Not authorized to review join requests for this club';
  END IF;

  IF p_approve THEN
    UPDATE club_members
      SET status = 'active'
      WHERE club_id = p_club_id AND user_id = p_user_id AND status = 'pending';
    GET DIAGNOSTICS v_found = ROW_COUNT;
  ELSE
    DELETE FROM club_members
      WHERE club_id = p_club_id AND user_id = p_user_id AND status = 'pending';
    GET DIAGNOSTICS v_found = ROW_COUNT;
  END IF;

  IF NOT v_found THEN
    RETURN jsonb_build_object('success', false, 'error', 'No pending request found');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cash_game_create(p_club_id uuid, p_template text, p_variant text, p_sb numeric, p_bb numeric, p_handedness integer DEFAULT NULL::integer, p_overrides jsonb DEFAULT '{}'::jsonb, p_name text DEFAULT NULL::text, p_must_move boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_cash_game_create requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'CLUB_REQUIRED';
  END IF;
  IF NOT public.fn_can_create_games(p_club_id, v_uid) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: this club is managed by its union';
  END IF;

  RETURN public.fn_cash_game_create_impl_20260905(
    p_club_id, p_template, p_variant, p_sb, p_bb, p_handedness,
    p_overrides, p_name, p_must_move
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_create_tournament(p_club_id uuid, p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_res jsonb;
  v_pct smallint;
  v_id  uuid;
  v_saved_pct smallint;
  v_mystery jsonb;
  v_persisted jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','not_authenticated');
  END IF;
  IF NOT public.fn_can_create_games(p_club_id,v_uid) THEN
    RETURN jsonb_build_object('success',false,'error','not_authorised');
  END IF;

  -- Only new authored MTTs are constrained here. Stored/funded ladders and
  -- the scheduled spawner do not pass this request boundary.
  IF COALESCE(p_config->>'type','') NOT IN ('sng','spin') AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof(p_config->'blindStructure')='array' THEN p_config->'blindStructure'
      ELSE '[]'::jsonb END) AS level_row
    WHERE level_row->'isBreak'='true'::jsonb
  ) THEN
    RETURN jsonb_build_object('success',false,'error','custom_level_breaks_not_supported');
  END IF;

  -- Preserve the existing 10% fallback for absent or invalid input. Only
  -- input decoding is recoverable: a failed contract write must roll back
  -- the delegated create in the same database transaction.
  BEGIN
    v_pct := CASE WHEN (p_config->>'payoutPercent')::int IN (10,15,20)
                  THEN (p_config->>'payoutPercent')::smallint ELSE 10 END;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    v_pct := 10;
  END;

  IF p_config->>'type'='mystery_bounty' THEN
    v_mystery:=public.fn_mystery_bounty_creation_document(p_config);
  END IF;

  v_res := public.fn_create_tournament_governed_legacy(p_club_id,p_config);
  IF v_res->'success' = 'false'::jsonb THEN
    RETURN v_res;
  END IF;
  IF v_res->'success' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Tournament creation returned an unconfirmed receipt';
  END IF;

  -- The governed creator returns tournament_id. A missing, malformed or
  -- cross-club receipt cannot be accepted as a successful creation.
  v_id := NULLIF(v_res->>'tournament_id','')::uuid;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Tournament creation returned no tournament_id';
  END IF;
  UPDATE public.tournaments SET payout_percent = v_pct
   WHERE id = v_id AND club_id = p_club_id
   RETURNING payout_percent INTO v_saved_pct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament creation receipt does not identify its club event';
  END IF;

  IF v_saved_pct IS DISTINCT FROM v_pct THEN
    RAISE EXCEPTION 'Tournament payout depth was not persisted';
  END IF;

  IF v_mystery IS NOT NULL THEN
    UPDATE public.tournaments
       SET mystery_bounty_profile=v_mystery->>'mystery_bounty_profile',
           mystery_bounty_activation=v_mystery->>'mystery_bounty_activation',
           mystery_bounty_activation_value=(v_mystery->>'mystery_bounty_activation_value')::numeric,
           mystery_bounty_pool_percent=(v_mystery->>'mystery_bounty_pool_percent')::numeric,
           mystery_bounty_regular_pool_percent=(v_mystery->>'mystery_bounty_regular_pool_percent')::numeric,
           mystery_bounty_top_percent=(v_mystery->>'mystery_bounty_top_percent')::numeric
     WHERE id=v_id AND club_id=p_club_id AND is_mystery_bounty;
    IF NOT FOUND THEN RAISE EXCEPTION 'Mystery creation receipt does not identify its club event'; END IF;
    -- Read after all triggers, rather than trusting an UPDATE's pre-AFTER image.
    SELECT jsonb_build_object('mystery_bounty_profile',t.mystery_bounty_profile,
       'mystery_bounty_activation',t.mystery_bounty_activation,
       'mystery_bounty_activation_value',t.mystery_bounty_activation_value,
       'mystery_bounty_pool_percent',t.mystery_bounty_pool_percent,
       'mystery_bounty_regular_pool_percent',t.mystery_bounty_regular_pool_percent,
       'mystery_bounty_top_percent',t.mystery_bounty_top_percent)
      INTO v_persisted FROM public.tournaments t WHERE t.id=v_id AND t.club_id=p_club_id AND t.is_mystery_bounty;
    IF v_persisted IS DISTINCT FROM v_mystery THEN
      RAISE EXCEPTION 'Mystery bounty creation terms were not persisted';
    END IF;
    v_res:=v_res||jsonb_build_object('mystery_config',v_persisted);
  END IF;

  RETURN v_res;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_upsert_tournament_schedule(p_schedule jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_id        uuid;
  v_union_id  uuid;
  v_club_id   uuid;
  v_name      text;
  v_days      integer[];
  v_times     text[];
  v_interval  integer;
  v_config    jsonb;
  v_active    boolean;
  v_d         integer;
  v_tm        text;
  v_existing  record;
  v_config_changed boolean := true;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'not_authenticated');
  END IF;
  IF p_schedule IS NULL OR jsonb_typeof(p_schedule) <> 'object' THEN
    RETURN jsonb_build_object('error', 'schedule_must_be_object');
  END IF;

  v_id       := NULLIF(p_schedule->>'id', '')::uuid;
  v_union_id := NULLIF(p_schedule->>'unionId', '')::uuid;
  v_club_id  := NULLIF(p_schedule->>'clubId', '')::uuid;
  v_name     := NULLIF(trim(p_schedule->>'name'), '');
  v_interval := NULLIF(p_schedule->>'intervalMinutes', '')::integer;
  v_config   := p_schedule->'config';
  v_active   := COALESCE((p_schedule->>'active')::boolean, true);

  SELECT COALESCE(array_agg(value::integer), '{}')
    INTO v_days FROM jsonb_array_elements_text(COALESCE(p_schedule->'daysOfWeek', '[]'::jsonb));
  SELECT COALESCE(array_agg(value), '{}')
    INTO v_times FROM jsonb_array_elements_text(COALESCE(p_schedule->'startTimesUtc', '[]'::jsonb));

  IF v_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.tournament_schedules WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'schedule_not_found');
    END IF;
    IF NOT public.fn_can_manage_tournament_schedule(v_existing.union_id, v_existing.club_id, v_uid) THEN
      RETURN jsonb_build_object('error', 'not_authorised');
    END IF;
    v_union_id := COALESCE(v_union_id, v_existing.union_id);
    v_club_id  := COALESCE(v_club_id,  v_existing.club_id);
    v_name     := COALESCE(v_name,     v_existing.name);
    v_config   := COALESCE(v_config,   v_existing.config);
    v_config_changed := v_config IS DISTINCT FROM v_existing.config;
    IF p_schedule->'daysOfWeek' IS NULL THEN v_days := v_existing.days_of_week; END IF;
    IF p_schedule->'startTimesUtc' IS NULL THEN v_times := v_existing.start_times_utc; END IF;
    IF p_schedule->'intervalMinutes' IS NULL THEN v_interval := v_existing.interval_minutes; END IF;
  END IF;

  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('error', 'club_id_required');
  END IF;
  IF v_name IS NULL THEN
    RETURN jsonb_build_object('error', 'name_required');
  END IF;
  IF v_config IS NULL OR jsonb_typeof(v_config) <> 'object' THEN
    RETURN jsonb_build_object('error', 'config_must_be_object');
  END IF;
  IF array_length(v_days, 1) IS NULL THEN
    RETURN jsonb_build_object('error', 'days_of_week_required');
  END IF;
  FOREACH v_d IN ARRAY v_days LOOP
    IF v_d < 0 OR v_d > 6 THEN
      RETURN jsonb_build_object('error', 'days_of_week_out_of_range', 'detail', v_d);
    END IF;
  END LOOP;
  FOREACH v_tm IN ARRAY v_times LOOP
    IF v_tm !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RETURN jsonb_build_object('error', 'start_time_format_invalid', 'detail', v_tm);
    END IF;
  END LOOP;
  IF array_length(v_times, 1) IS NULL AND v_interval IS NULL THEN
    RETURN jsonb_build_object('error', 'start_times_or_interval_required');
  END IF;
  IF v_interval IS NOT NULL AND (v_interval < 5 OR v_interval > 1440) THEN
    RETURN jsonb_build_object('error', 'interval_minutes_out_of_range');
  END IF;

  IF v_id IS NULL AND NOT public.fn_can_manage_tournament_schedule(v_union_id, v_club_id, v_uid) THEN
    RETURN jsonb_build_object('error', 'not_authorised');
  END IF;
  -- Lock/read comparison preserves unchanged accepted schedules, including
  -- enable/disable and metadata edits, without authoring another ignored break.
  IF v_config_changed AND (
    lower(COALESCE(v_config->>'type','mtt')) NOT IN ('sng','spin')
    -- The scheduled writer promotes target-linked fixed labels to satellites.
    -- Only its recognized target keys participate; unrelated type aliases do not.
    OR public.fn_ca_is_new_mtt(jsonb_build_object(
      'satellite_target_id',v_config->'satellite_target_id',
      'satelliteTargetId',v_config->'satelliteTargetId',
      'satellite_target',v_config->'satellite_target',
      'satelliteTarget',v_config->'satelliteTarget'))
  ) AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof(v_config->'blindStructure')='array' THEN v_config->'blindStructure'
      ELSE '[]'::jsonb END) AS level_row
    WHERE level_row->'isBreak'='true'::jsonb
  ) THEN
    RETURN jsonb_build_object('error','custom_level_breaks_not_supported');
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.tournament_schedules
      (union_id, club_id, name, description, active, days_of_week,
       start_times_utc, interval_minutes, config, created_by)
    VALUES
      (v_union_id, v_club_id, v_name, p_schedule->>'description', v_active, v_days,
       v_times, v_interval, v_config, v_uid)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.tournament_schedules
       SET union_id         = v_union_id,
           club_id          = v_club_id,
           name             = v_name,
           description      = COALESCE(p_schedule->>'description', description),
           active           = v_active,
           days_of_week     = v_days,
           start_times_utc  = v_times,
           interval_minutes = v_interval,
           config           = v_config,
           updated_at       = now()
     WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'schedule_id', v_id);
END; $function$;

REVOKE ALL ON FUNCTION public.fn_review_join_request(uuid,uuid,boolean), public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean),
  public.fn_create_tournament(uuid,jsonb), public.fn_upsert_tournament_schedule(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_review_join_request(uuid,uuid,boolean), public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean),
  public.fn_create_tournament(uuid,jsonb), public.fn_upsert_tournament_schedule(jsonb) TO authenticated, service_role;
