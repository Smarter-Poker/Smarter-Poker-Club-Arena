BEGIN;
DO $$ BEGIN IF to_regclass('public.tournament_schedules') IS NOT NULL THEN RAISE EXCEPTION 'unexpected existing schedules';END IF;END $$;
CREATE TABLE public.tournament_schedules("id" uuid DEFAULT gen_random_uuid() NOT NULL,"union_id" uuid,"club_id" uuid NOT NULL,"name" text NOT NULL,"description" text,"active" boolean DEFAULT true NOT NULL,"days_of_week" integer[] NOT NULL,"start_times_utc" text[] DEFAULT '{}'::text[] NOT NULL,"interval_minutes" integer,"config" jsonb NOT NULL,"created_by" uuid,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"updated_at" timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE public.tournament_schedules ADD CONSTRAINT "tournament_schedules_pkey" PRIMARY KEY (id);
CREATE INDEX idx_tournament_schedules_active_club ON public.tournament_schedules USING btree (active, club_id);
ALTER TABLE public.tournament_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tsched_read" ON public.tournament_schedules AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "tsched_service_all" ON public.tournament_schedules AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE public.tournament_schedules FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT ALL ON TABLE public.tournament_schedules TO postgres;
GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.tournament_schedules TO anon;
GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.tournament_schedules TO authenticated;
GRANT ALL ON TABLE public.tournament_schedules TO service_role;
DO $$ BEGIN IF to_regprocedure('public.fn_can_manage_tournament_schedule(uuid,uuid,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'unexpected existing authority';END IF;END $$;
CREATE OR REPLACE FUNCTION public.fn_can_manage_tournament_schedule(p_union_id uuid, p_club_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  IF p_union_id IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM public.unions u
                    WHERE u.id = p_union_id AND u.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM public.union_admins ua
                    WHERE ua.union_id = p_union_id AND ua.user_id = p_user_id);
  END IF;
  RETURN public.is_club_admin(p_club_id, p_user_id);
END; $function$
;
REVOKE ALL ON FUNCTION public.fn_can_manage_tournament_schedule(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_can_manage_tournament_schedule(uuid,uuid,uuid) TO postgres,authenticated,service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_can_manage_tournament_schedule(uuid,uuid,uuid)'::regprocedure AND md5(prosrc)='4292f481dcae8027303786ce30932e45' AND md5(pg_get_functiondef(oid))='8615be02f04279934a416c5536c37607' AND proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'authority capture mismatch';END IF;END $$;
DO $$ BEGIN IF to_regprocedure('public.fn_create_tournament(uuid,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'unexpected existing authority';END IF;END $$;
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
REVOKE ALL ON FUNCTION public.fn_create_tournament(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_create_tournament(uuid,jsonb) TO postgres,authenticated,service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_create_tournament(uuid,jsonb)'::regprocedure AND md5(prosrc)='876158c293c3fe31d6857ba00ee33938' AND md5(pg_get_functiondef(oid))='86a1343bcd76a0a6a7a9178a4bd047e3' AND proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'authority capture mismatch';END IF;END $$;
DO $$ BEGIN IF to_regprocedure('public.fn_upsert_tournament_schedule(jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'unexpected existing authority';END IF;END $$;
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
    SELECT * INTO v_existing FROM public.tournament_schedules WHERE id = v_id;
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

  IF v_id IS NULL THEN
    IF NOT public.fn_can_manage_tournament_schedule(v_union_id, v_club_id, v_uid) THEN
      RETURN jsonb_build_object('error', 'not_authorised');
    END IF;
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
REVOKE ALL ON FUNCTION public.fn_upsert_tournament_schedule(jsonb) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_upsert_tournament_schedule(jsonb) TO postgres,authenticated,service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_upsert_tournament_schedule(jsonb)'::regprocedure AND md5(prosrc)='dbe541b0a3c6bcf381b40d4cd765dfbd' AND md5(pg_get_functiondef(oid))='0480dfb41a9e126b060ca5ebce296c29' AND proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'authority capture mismatch';END IF;END $$;
DO $$ BEGIN IF to_regprocedure('public.fn_club_scope_ids(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'unexpected existing scope authority';END IF;END $$;
CREATE OR REPLACE FUNCTION public.fn_club_scope_ids(p_club_id uuid)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN coalesce((SELECT is_union FROM public.clubs WHERE id = p_club_id), false)
      THEN (
        SELECT array_agg(DISTINCT x)
        FROM (
          SELECT p_club_id AS x
          UNION SELECT id      FROM public.clubs       WHERE union_id = p_club_id
          UNION SELECT club_id FROM public.union_clubs WHERE union_id = p_club_id
        ) s
        WHERE x IS NOT NULL
      )
    ELSE ARRAY[p_club_id]
  END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_club_scope_ids(uuid) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_club_scope_ids(uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.fn_club_scope_ids(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_club_scope_ids(uuid) TO "service_role";
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_club_scope_ids(uuid)'::regprocedure AND md5(prosrc)='9fc3bbf5ebbf941e06141b3a65584ef4' AND md5(pg_get_functiondef(oid))='be6fa7f8c21cddebf68d4e23099b977f') THEN RAISE EXCEPTION 'scope authority mismatch';END IF;END $$;
COMMIT;
