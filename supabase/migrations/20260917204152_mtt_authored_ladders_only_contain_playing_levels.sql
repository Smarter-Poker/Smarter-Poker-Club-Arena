-- New MTT authoring cannot promise custom level breaks the engine skips.
-- The tournament manager owns synchronized :55 breaks and the explicit opt-out.
-- Only the two authenticated authoring RPCs change. Existing tournament ladders,
-- direct saved-schedule spawns, and unchanged accepted schedule configurations
-- remain untouched. No financial terms, clocks, global maintenance or format ABI
-- are changed. The stored schedule is locked before deciding config equality.
-- Captured production authority: 2026-09-17, retained authoring fixture catalog.
-- Both exact preimages/owners/ACL/config are checked before either replacement;
-- exact postimages and the same authority are checked before commit. Unknown
-- successors refuse atomically. The R46 governed creator is delegated unchanged.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $pre$ BEGIN
 -- Reuse the installed065 raw-target classifier; this is pure format identity,
 -- not unlimited-entry activation. Refuse an unknown implementation/authority.
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.oid=to_regprocedure('public.fn_ca_is_new_mtt(jsonb)')
     AND md5(p.prosrc)='ad9224540faf12ccd3eb103113d4cc30'
     AND md5(pg_get_functiondef(p.oid))='dff4202458ea4b5b940e78050e6de91c'
     AND pg_get_userbyid(p.proowner)='postgres'
     AND p.proacl::text='{postgres=X/postgres}'
     AND p.proconfig=ARRAY['search_path=pg_catalog, public']::text[]
 ) THEN RAISE EXCEPTION 'MTT_AUTHORING_TARGET_CLASSIFIER_DRIFT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.oid=to_regprocedure('public.fn_create_tournament(uuid,jsonb)')
     AND md5(p.prosrc)='876158c293c3fe31d6857ba00ee33938'
     AND md5(pg_get_functiondef(p.oid))='86a1343bcd76a0a6a7a9178a4bd047e3'
     AND pg_get_userbyid(p.proowner)='postgres'
     AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, extensions']::text[]
 ) THEN RAISE EXCEPTION 'MTT_AUTHORING_PREIMAGE_DRIFT: fn_create_tournament(uuid,jsonb)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.oid=to_regprocedure('public.fn_upsert_tournament_schedule(jsonb)')
     AND md5(p.prosrc)='dbe541b0a3c6bcf381b40d4cd765dfbd'
     AND md5(pg_get_functiondef(p.oid))='0480dfb41a9e126b060ca5ebce296c29'
     AND pg_get_userbyid(p.proowner)='postgres'
     AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public']::text[]
 ) THEN RAISE EXCEPTION 'MTT_AUTHORING_PREIMAGE_DRIFT: fn_upsert_tournament_schedule(jsonb)'; END IF;
END $pre$;
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
END $function$
;

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
END; $function$
;
DO $post$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.oid=to_regprocedure('public.fn_create_tournament(uuid,jsonb)')
     AND md5(p.prosrc)='c3bb11b6fe2e624a705baab889a56a60'
     AND md5(pg_get_functiondef(p.oid))='4c5c8783d1f6f534fdaf5cefbb460d62'
     AND pg_get_userbyid(p.proowner)='postgres'
     AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, extensions']::text[]
 ) THEN RAISE EXCEPTION 'MTT_AUTHORING_POSTIMAGE_DRIFT: fn_create_tournament(uuid,jsonb)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.oid=to_regprocedure('public.fn_upsert_tournament_schedule(jsonb)')
     AND md5(p.prosrc)='1ba7d70943cf1553a07cb7dc1a13d6e9'
     AND md5(pg_get_functiondef(p.oid))='b8dd7cc8e0996889a936affdc732b664'
     AND pg_get_userbyid(p.proowner)='postgres'
     AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public']::text[]
 ) THEN RAISE EXCEPTION 'MTT_AUTHORING_POSTIMAGE_DRIFT: fn_upsert_tournament_schedule(jsonb)'; END IF;
END $post$;
COMMIT;
