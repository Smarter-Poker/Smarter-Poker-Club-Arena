-- 20261030001305_owner_holds_new_tournament_starts_while_running_events_finis.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Owner order in incident chat 01a1898d-4213-7181-b275-42fbf08b57db:
-- "finish all current tournaments but do not start any new ones".
-- The tournament-only admission hold preserves existing play and settlement.
-- No cancellation, refund, engine restart, cash hold, timer or repair loop.
-- Existing BEFORE admission and atomic launch/Spin doors consume these guards.
-- An emergency installation during this active outage requires byte-exact
-- recording through protected delivery immediately afterward (PUBLISHING.md).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
-- Atomic catalog/control publication affects subsequent admission checks.
-- An admission already executing before publication may finish as current work.
-- Do not request an exclusive global floor lane: unrelated live writes use it.
DO $pins$
BEGIN
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_ca_launch_tournament_start_refused(uuid)'::regprocedure)) IS DISTINCT FROM '9a3ec0770bec502595db50bd519a5a5c'
 OR md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_ca_launch_tournament_admission_guard()'::regprocedure)) IS DISTINCT FROM 'e22999904c02728a392d446d92ea7d15'
 OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass AND tgname='zzzzzzzz_launch_tournament_admission' AND tgenabled='O' AND NOT tgisinternal
  AND pg_get_triggerdef(oid)='CREATE TRIGGER zzzzzzzz_launch_tournament_admission BEFORE INSERT OR UPDATE OF club_id, union_id, status, started_at, spin_multiplier ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_launch_tournament_admission_guard()') THEN
  RAISE EXCEPTION 'TOURNAMENT_START_HOLD_BASELINE_CHANGED' USING ERRCODE='55000';
 END IF;
END $pins$;
CREATE TABLE public.ca_tournament_start_hold (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 operation_id uuid NOT NULL UNIQUE,
 blocked boolean NOT NULL,
 reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
 requested_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
ALTER TABLE public.ca_tournament_start_hold ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_tournament_start_hold FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.ca_tournament_start_hold TO service_role;
INSERT INTO public.ca_tournament_start_hold(singleton,operation_id,blocked,reason)
VALUES(true,'01a1898d-4213-7181-b275-42fbf08b57db',true,
 'Owner instruction: finish all current tournaments but do not start any new ones. Repeated production tournament freezes on October 29, 2026.');
CREATE FUNCTION public.fn_ca_new_tournament_starts_blocked()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $function$
DECLARE paused boolean;
BEGIN
 SELECT blocked INTO paused FROM public.ca_tournament_start_hold WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'TOURNAMENT_START_CONTROL_UNKNOWN' USING ERRCODE='58000'; END IF;
 RETURN paused;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_new_tournament_starts_blocked() FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_launch_tournament_start_refused(p_tournament uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $function$
DECLARE t record;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 PERFORM pg_advisory_xact_lock_shared(530093);
 -- Started-at, live status, launch, Spin and hand evidence keep recovery and settlement open.
 IF public.fn_ca_launch_tournament_has_started(p_tournament) IS NOT TRUE THEN
  IF public.fn_ca_new_tournament_starts_blocked() THEN RETURN true; END IF;
 END IF;
 SELECT club_id,union_id INTO t FROM public.tournaments WHERE id=p_tournament;
 IF NOT FOUND THEN RETURN false; END IF;
 RETURN public.fn_ca_launch_tournament_held(t.club_id,t.union_id)
  AND public.fn_ca_launch_tournament_has_started(p_tournament) IS NOT TRUE;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_tournament_start_refused(uuid) FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_launch_tournament_admission_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $function$
BEGIN
 IF TG_OP='INSERT' THEN
  -- Covers direct RUNNING inserts and every scheduled/recurring creator.
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  IF public.fn_ca_new_tournament_starts_blocked() THEN
   RAISE EXCEPTION 'TOURNAMENT_STARTS_PAUSED: tournament creation' USING ERRCODE='55006';
  END IF;
  IF public.fn_ca_launch_tournament_held(NEW.club_id,NEW.union_id) THEN RAISE EXCEPTION 'OPERATOR_FLOOR_PARKED: tournament creation' USING ERRCODE='55006'; END IF;
 ELSIF (NEW.club_id,NEW.union_id) IS DISTINCT FROM (OLD.club_id,OLD.union_id)
  AND public.fn_ca_launch_tournament_held(NEW.club_id,NEW.union_id) THEN
  RAISE EXCEPTION 'OPERATOR_FLOOR_PARKED: tournament scope admission' USING ERRCODE='55006';
 ELSIF ((OLD.started_at IS NULL AND NEW.started_at IS NOT NULL)
  OR (upper(COALESCE(NEW.status,'')) IN('RUNNING','BREAK','COMPLETING','COMPLETED') AND upper(COALESCE(OLD.status,'')) NOT IN('RUNNING','BREAK','COMPLETING','COMPLETED'))
  OR (COALESCE(OLD.spin_multiplier,0)<=0 AND COALESCE(NEW.spin_multiplier,0)>0))
  AND public.fn_ca_launch_tournament_start_refused(OLD.id) THEN
  RAISE EXCEPTION 'OPERATOR_FLOOR_PARKED: tournament start' USING ERRCODE='55006';
 END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_tournament_admission_guard() FROM PUBLIC, anon, authenticated, service_role;
DO $bounded$
BEGIN
 IF clock_timestamp()-transaction_timestamp() >= interval '8 seconds' THEN
  RAISE EXCEPTION 'TOURNAMENT_START_HOLD_INSTALL_BUDGET_EXCEEDED';
 END IF;
END $bounded$;
COMMIT;
