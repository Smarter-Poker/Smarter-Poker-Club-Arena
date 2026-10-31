-- Reserved by scripts/new-migration.mjs; four original Oct30 40P01 witnesses.
-- A welcome INSERT held Spin/schedule child KEY SHARE before its later club
-- guard, while reset/certification cleanup held that club FOR UPDATE and waited
-- for the child. Take the same club KEY SHARE first in the existing fence.
-- Retired-club checks, cleanup exclusive locks, admission and all money stay.
-- @live-proof: md5(pg_get_functiondef('public.fn_fence_welcome_package_schedule_spawn()'::regprocedure))='314e3c3585a9e31abc620e2e9f1d326e'
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
DO $before$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_fence_welcome_package_schedule_spawn()'::regprocedure
 AND md5(pg_get_functiondef(oid))='dcf50f2c3ad3e366ff919b4b84e31fb0' AND pg_get_userbyid(proowner)='postgres' AND prosecdef
 AND proconfig=ARRAY['search_path=public, pg_temp']::text[]
 AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
 RAISE EXCEPTION 'WELCOME_PARENT_ORDER_BEFORE_CHANGED'; END IF;
END $before$;
CREATE OR REPLACE FUNCTION public.fn_fence_welcome_package_schedule_spawn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_retired timestamptz; v_active boolean;
BEGIN
  -- Welcome cleanup owns the club before its child stores. Match that order
  -- before the schedule/Spin fences so a creator never holds a child while
  -- waiting for cleanup's parent lock. The retired-club guard still rechecks.
  IF NEW.club_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.club_welcome_package_receipts r WHERE r.club_id=NEW.club_id
  ) THEN
    PERFORM 1 FROM public.clubs c WHERE c.id=NEW.club_id FOR KEY SHARE;
  END IF;

  IF NEW.schedule_id IS NOT NULL THEN
    SELECT i.retired_at INTO v_retired FROM public.club_welcome_package_items i
     WHERE i.entity_kind='tournament_schedule' AND i.entity_id=NEW.schedule_id
     FOR KEY SHARE;
    IF FOUND THEN
      SELECT s.active INTO v_active FROM public.tournament_schedules s
       WHERE s.id=NEW.schedule_id FOR KEY SHARE;
      IF NOT FOUND OR v_retired IS NOT NULL OR v_active IS NOT TRUE THEN
        RAISE EXCEPTION 'WELCOME_PACKAGE_SCHEDULE_RETIRED' USING ERRCODE='55000';
      END IF;
    END IF;
  END IF;
  IF NEW.club_id IS NOT NULL
     AND upper(COALESCE(NEW.tournament_type::text,'')) IN('SPIN','SNG')
     AND EXISTS(SELECT 1 FROM public.club_welcome_package_receipts r WHERE r.club_id=NEW.club_id) THEN
    SELECT p.is_active INTO v_active FROM public.spin_bonus_pools p
     WHERE p.club_id=NEW.club_id FOR KEY SHARE;
    IF NOT FOUND OR v_active IS NOT TRUE THEN
      RAISE EXCEPTION 'WELCOME_PACKAGE_SPIN_BOARD_RETIRED' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
DO $after$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_fence_welcome_package_schedule_spawn()'::regprocedure
 AND md5(pg_get_functiondef(oid))='314e3c3585a9e31abc620e2e9f1d326e' AND pg_get_userbyid(proowner)='postgres' AND prosecdef
 AND proconfig=ARRAY['search_path=public, pg_temp']::text[]
 AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
 RAISE EXCEPTION 'WELCOME_PARENT_ORDER_AFTER_CHANGED'; END IF;
END $after$;
COMMIT;
