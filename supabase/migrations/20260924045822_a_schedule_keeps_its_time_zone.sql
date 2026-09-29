-- 20260924045822_a_schedule_keeps_its_time_zone.sql
--
-- A RECURRING SCHEDULE KEEPS ITS TIME ZONE.
--
-- tournament_schedules stored only a UTC weekday and 'HH:MM'. A club owner in
-- Chicago who ticks "Repeats Weekly" on an 8:00 PM event had it saved as
-- 01:00 UTC on the next weekday, so after the November change the event ran
-- at 7:00 PM local time, and after the March change at 8:00 PM again: the
-- event moved one local hour twice a year.
--
-- THE MODEL. One additive, nullable column, time_zone (an IANA zone name):
--   * NULL  - days_of_week and start_times_utc are UTC. This is the original
--             contract and every existing row keeps it: no row is re-timed,
--             no key or spawn history changes. The house programme, the
--             Diamond Spins and the maintenance schedules are not touched.
--   * set   - days_of_week and start_times_utc are the WALL-CLOCK weekday and
--             time in that zone. The engine
--             (server/src/services/scheduleWallClock.ts) converts each
--             occurrence to UTC for its own local date, so the event stays at
--             8:00 PM local all year. The column name start_times_utc is kept
--             so no reader breaks; the column comment states the rule.
--
-- DAYLIGHT-SAVING AMBIGUITY, defined once (engine rule, pinned by the shared
-- case table scripts/ci/fixtures/schedule-time-zone/cases.json):
--   the start is the EARLIEST instant at which the zone's wall clock reads at
--   or after the scheduled local time on that date. So a time inside the
--   spring-forward gap runs at the first valid instant after it (02:30 in
--   Chicago runs at 03:00 CDT), and a time inside the fall-back overlap runs
--   ONCE, at its first occurrence (01:30 runs at 01:30 CDT, never again at
--   01:30 CST). The spawn key of a zoned row is
--   `<schedule id>:<local date>:<local HH>:<MM>`, unique per local calendar
--   date, so the overlap day cannot claim two starts.
--
-- WRITES. fn_upsert_tournament_schedule learns one optional key, timeZone.
-- Absent on an update keeps the stored zone (so the enable/disable toggle,
-- which sends only {id, active}, never re-times a row); null clears it; a
-- name PostgreSQL does not know is refused as time_zone_unknown. The body is
-- otherwise the definition 20260924033701 installs, byte for byte, so every
-- creation-rule refusal it added (fn_tournament_config_refusal on a changed
-- configuration) still holds.
--
-- DEPENDENCY. Install AFTER 20260924033701
-- (tournament_creation_refuses_what_the_client_refuses, its own pull request).
-- Without its validator this migration refuses as
-- SCHEDULE_TIME_ZONE_REQUIRES_20260924033701 and changes nothing.
--
-- PREIMAGE. The pinned preimage md5s below are 20260924033701's own asserted
-- postimage (pg_get_functiondef f56ec7122c5a2cc2b72f5b6f13aeefbb), reproduced
-- on a native cluster from the repository bodies. The owner must confirm the
-- live md5(prosrc) and md5(pg_get_functiondef) of
-- fn_upsert_tournament_schedule(jsonb) before applying; a mismatch refuses
-- the whole migration atomically.
--
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tournament_schedules' AND column_name = 'time_zone' AND data_type = 'text' AND is_nullable = 'YES'))
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.tournament_schedules'::regclass AND conname = 'tournament_schedules_time_zone_known' AND convalidated))
-- @live-proof: (SELECT md5(p.prosrc) = 'c9a308e1ab8117e00cbb19868be87a6b' AND md5(pg_get_functiondef(p.oid)) = '358f8137847a8a4a5a3f68ff387d2dc2' FROM pg_proc p WHERE p.oid = to_regprocedure('public.fn_upsert_tournament_schedule(jsonb)'))

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $pre$
BEGIN
  IF to_regprocedure('public.fn_tournament_config_refusal(jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'SCHEDULE_TIME_ZONE_REQUIRES_20260924033701: fn_tournament_config_refusal(jsonb,text) is not installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = to_regprocedure('public.fn_upsert_tournament_schedule(jsonb)')
      AND md5(p.prosrc) = 'a9a78b0e15acf966d9b1e24c8236b022'
      AND md5(pg_get_functiondef(p.oid)) = 'f56ec7122c5a2cc2b72f5b6f13aeefbb'
      AND pg_get_userbyid(p.proowner) = 'postgres'
      AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
      AND p.proconfig = ARRAY['search_path=public']::text[]
  ) THEN
    RAISE EXCEPTION 'SCHEDULE_TIME_ZONE_PREIMAGE_DRIFT: fn_upsert_tournament_schedule(jsonb)';
  END IF;
  IF to_regprocedure('public.fn_schedule_time_zone_is_known(text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                 WHERE a.attrelid = 'public.tournament_schedules'::regclass
                   AND a.attname = 'time_zone' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'SCHEDULE_TIME_ZONE_SUCCESSOR_PRESENT';
  END IF;
END $pre$;

-- A zone is known when PostgreSQL's tz database has it AND it is a plain
-- IANA Area/Location name (or UTC/GMT). The name filter keeps out the
-- abbreviations and POSIX strings AT TIME ZONE would also accept ('CST',
-- 'UTC+3' - the latter with the sign inverted), which the engine's ICU would
-- read differently or not at all.
CREATE FUNCTION public.fn_schedule_time_zone_is_known(p_zone text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT p_zone IS NULL
      OR ((p_zone IN ('UTC', 'GMT')
           OR p_zone ~ '^[A-Z][A-Za-z]+/[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)?$')
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names n WHERE n.name = p_zone))
$function$;

REVOKE ALL ON FUNCTION public.fn_schedule_time_zone_is_known(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_schedule_time_zone_is_known(text) TO service_role;

ALTER TABLE public.tournament_schedules
  ADD COLUMN time_zone text,
  ADD CONSTRAINT tournament_schedules_time_zone_known
    CHECK (public.fn_schedule_time_zone_is_known(time_zone));

COMMENT ON COLUMN public.tournament_schedules.time_zone IS
  'IANA zone. NULL: days_of_week and start_times_utc are UTC. Set: they are the wall-clock weekday and HH:MM in this zone; each occurrence is converted to UTC for its own local date (gap: first valid instant after; overlap: first occurrence only).';

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
  v_zone      text;
  v_d         integer;
  v_tm        text;
  v_existing  record;
  v_config_changed boolean := true;
  v_refusal   text;
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
  -- IANA zone of the wall-clock days/times; absent or null = UTC.
  v_zone     := NULLIF(trim(p_schedule->>'timeZone'), '');

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
    IF NOT (p_schedule ? 'timeZone') THEN v_zone := v_existing.time_zone; END IF;
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
  IF NOT public.fn_schedule_time_zone_is_known(v_zone) THEN
    RETURN jsonb_build_object('error', 'time_zone_unknown', 'detail', v_zone);
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

  -- The creation rules, checked when the configuration is written rather than
  -- first discovered by the spawner (20260924033701).
  IF v_config_changed THEN
    v_refusal := public.fn_tournament_config_refusal(v_config,'schedule');
    IF v_refusal IS NOT NULL THEN
      RETURN jsonb_build_object('error',v_refusal);
    END IF;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.tournament_schedules
      (union_id, club_id, name, description, active, days_of_week,
       start_times_utc, interval_minutes, config, created_by, time_zone)
    VALUES
      (v_union_id, v_club_id, v_name, p_schedule->>'description', v_active, v_days,
       v_times, v_interval, v_config, v_uid, v_zone)
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
           time_zone        = v_zone,
           updated_at       = now()
     WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'schedule_id', v_id);
END; $function$
;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = to_regprocedure('public.fn_upsert_tournament_schedule(jsonb)')
      AND md5(p.prosrc) = 'c9a308e1ab8117e00cbb19868be87a6b'
      AND md5(pg_get_functiondef(p.oid)) = '358f8137847a8a4a5a3f68ff387d2dc2'
      AND pg_get_userbyid(p.proowner) = 'postgres'
      AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
      AND p.proconfig = ARRAY['search_path=public']::text[]
  ) THEN
    RAISE EXCEPTION 'SCHEDULE_TIME_ZONE_POSTIMAGE_DRIFT: fn_upsert_tournament_schedule(jsonb)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = to_regprocedure('public.fn_schedule_time_zone_is_known(text)')
      AND NOT p.prosecdef AND p.provolatile = 's'
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'SCHEDULE_TIME_ZONE_VALIDATOR_DRIFT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.tournament_schedules'::regclass AND a.attname = 'time_zone'
      AND a.atttypid = 'text'::regtype AND NOT a.attnotnull AND NOT a.atthasdef)
     OR EXISTS (SELECT 1 FROM public.tournament_schedules WHERE time_zone IS NOT NULL) THEN
    RAISE EXCEPTION 'SCHEDULE_TIME_ZONE_COLUMN_DRIFT: every existing schedule must stay UTC';
  END IF;
  IF NOT public.fn_schedule_time_zone_is_known('America/Chicago')
     OR NOT public.fn_schedule_time_zone_is_known('Europe/London')
     OR public.fn_schedule_time_zone_is_known('CST')
     OR public.fn_schedule_time_zone_is_known('UTC+3') THEN
    RAISE EXCEPTION 'SCHEDULE_TIME_ZONE_VALIDATOR_WRONG';
  END IF;
END $post$;

COMMIT;
