-- ===========================================================================
-- TOURNAMENT SCHEDULES (2026-08-22)
--
-- Recurring-schedule data model for MTTs (PokerStars-style repeating events).
-- A schedule row describes WHEN tournaments should exist; the engine's
-- spawner reads active schedules and creates tournaments rows from `config`
-- (same key shapes as fn_create_tournament's p_config), recording each spawn
-- in tournament_schedule_spawns under a unique spawn_key so a crashed or
-- double-running spawner can never create the same instance twice.
--
-- Two scheduling modes, mutually compatible:
--   - days_of_week + start_times_utc: fixed weekly grid ('HH24:MI', UTC)
--   - interval_minutes: keep one live instance, respawn N minutes after the
--     previous instance completes
--
-- Writes go through fn_upsert_tournament_schedule / fn_delete_tournament_schedule
-- (SECURITY DEFINER, union-owner / union-admin / club-admin gated). RLS allows
-- authenticated read only; the tables accept no direct authenticated writes.
--
-- Idempotent: re-runnable end to end.
-- ===========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.tournament_schedules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  union_id         uuid,
  club_id          uuid NOT NULL,
  name             text NOT NULL,
  description      text,
  active           boolean NOT NULL DEFAULT true,
  days_of_week     integer[] NOT NULL,           -- 0=Sunday .. 6=Saturday, UTC
  start_times_utc  text[] NOT NULL DEFAULT '{}', -- 'HH24:MI'
  interval_minutes integer,                      -- alternative to start_times
  config           jsonb NOT NULL,               -- fn_create_tournament p_config shape
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tournament_schedule_spawns (
  id            bigserial PRIMARY KEY,
  schedule_id   uuid NOT NULL REFERENCES public.tournament_schedules(id) ON DELETE CASCADE,
  spawn_key     text NOT NULL UNIQUE,
  tournament_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tournament_schedules_active_club
  ON public.tournament_schedules (active, club_id);
CREATE INDEX IF NOT EXISTS idx_tournament_schedule_spawns_schedule
  ON public.tournament_schedule_spawns (schedule_id);

ALTER TABLE public.tournament_schedules       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_schedule_spawns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tsched_read ON public.tournament_schedules;
CREATE POLICY tsched_read ON public.tournament_schedules
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS tsched_service_all ON public.tournament_schedules;
CREATE POLICY tsched_service_all ON public.tournament_schedules
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS tspawn_read ON public.tournament_schedule_spawns;
CREATE POLICY tspawn_read ON public.tournament_schedule_spawns
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS tspawn_service_all ON public.tournament_schedule_spawns;
CREATE POLICY tspawn_service_all ON public.tournament_schedule_spawns
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Authorization helper: union owner OR union_admin of the union, or (when the
-- schedule has no union) club owner/admin. Mirrors fn_create_tournament's
-- is_club_admin gating style.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_can_manage_tournament_schedule(
  p_union_id uuid, p_club_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
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
END; $function$;

REVOKE ALL ON FUNCTION public.fn_can_manage_tournament_schedule(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_can_manage_tournament_schedule(uuid, uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- fn_upsert_tournament_schedule(p_schedule jsonb)
--
-- p_schedule keys: id (optional, update when present), unionId, clubId,
-- name, description, active, daysOfWeek (int[] 0-6), startTimesUtc
-- (text[] 'HH24:MI'), intervalMinutes, config (object).
-- Returns {ok, schedule_id} or {error}.
-- ---------------------------------------------------------------------------
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
    -- UPDATE path: authorization is checked against the STORED row, so a
    -- caller cannot move someone else's schedule into their own club.
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
    -- INSERT path: authorization against the TARGET union/club.
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
END; $function$;

REVOKE ALL ON FUNCTION public.fn_upsert_tournament_schedule(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_upsert_tournament_schedule(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_upsert_tournament_schedule(jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- fn_delete_tournament_schedule: soft delete (active=false), never a hard
-- DELETE - spawn history must survive for audit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_delete_tournament_schedule(p_schedule_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_s   record;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'not_authenticated');
  END IF;
  SELECT * INTO v_s FROM public.tournament_schedules WHERE id = p_schedule_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'schedule_not_found');
  END IF;
  IF NOT public.fn_can_manage_tournament_schedule(v_s.union_id, v_s.club_id, v_uid) THEN
    RETURN jsonb_build_object('error', 'not_authorised');
  END IF;
  UPDATE public.tournament_schedules
     SET active = false, updated_at = now()
   WHERE id = p_schedule_id;
  RETURN jsonb_build_object('ok', true, 'schedule_id', p_schedule_id);
END; $function$;

REVOKE ALL ON FUNCTION public.fn_delete_tournament_schedule(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_delete_tournament_schedule(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_delete_tournament_schedule(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Post-apply assertions
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.tournament_schedules') IS NULL THEN
    RAISE EXCEPTION 'tournament_schedules was not created';
  END IF;
  IF to_regclass('public.tournament_schedule_spawns') IS NULL THEN
    RAISE EXCEPTION 'tournament_schedule_spawns was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_upsert_tournament_schedule') THEN
    RAISE EXCEPTION 'fn_upsert_tournament_schedule missing after apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_delete_tournament_schedule') THEN
    RAISE EXCEPTION 'fn_delete_tournament_schedule missing after apply';
  END IF;
END $$;

COMMIT;
