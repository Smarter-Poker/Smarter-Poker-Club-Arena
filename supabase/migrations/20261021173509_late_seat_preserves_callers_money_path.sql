-- A late satellite target chair must not replace its caller's settlement authority.
-- The original seat creator SET LOCAL escaped into the surrounding satellite
-- transaction, so its later six-chip remainder was correctly refused by R3.
-- Scope that existing setting to the function: PostgreSQL restores it on every
-- successful return and exception. No body, payout, enforcement or wallet changes.
-- @live-proof: md5(pg_get_functiondef('public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure))='38717f81d87884c40d1b29238d55c37e'
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure)) IS DISTINCT FROM '4f1800b2cd9bbf61cf926130eb8f03db'
 THEN RAISE EXCEPTION 'late_seat_context_source_changed' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure
  AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres}') THEN
 RAISE EXCEPTION 'late_seat_context_metadata_changed' USING ERRCODE='55000'; END IF;
END $guard$;
ALTER FUNCTION public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)
 SET app.money_path TO 'fn_seat_late_registrant';
COMMIT;
