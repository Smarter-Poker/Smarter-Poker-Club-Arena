-- Weekly accounting follows the actual daily maintenance freeze.
-- The hourly platform freeze was retired October 20. These seven stale
-- minute-of-hour predicates still stop the weekly close for 15 minutes/hour.
-- Remove only those predicates from the two functions on the due-close path.
-- Preserve fn_platform_frozen, authorization, scheduler locks, statement and
-- scope budgets, chronological ordering, receipts, and all payment checks.
-- Exact preimages prevent changing an independently advanced owner.
-- Rollback: restore the exact functions captured in weekly-close-hour-guard.
-- @live-proof: (SELECT count(*)=2 AND bool_and(position('extract(minute' in lower(prosrc))=0 AND position('fn_platform_frozen' in prosrc)>0) FROM pg_proc WHERE oid IN('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure,'public.fn_accounting_close_windows_advance_due()'::regprocedure))
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $change$
DECLARE d record; original text; candidate text; before_meta jsonb; after_meta jsonb;
BEGIN
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'weekly_hour_guard_install_frozen'; END IF;
 FOR d IN SELECT * FROM (VALUES
 ('public.fn_process_weekly_accounting_scope(uuid,uuid)','e5065fedd05b476e16bf9a0393f8bc05',6),
 ('public.fn_accounting_close_windows_advance_due()','d7fd54f6876c3b9316cfaafeb10f7761',1)
 ) x(signature,hash,guards) LOOP
  SELECT pg_get_functiondef(oid),jsonb_build_array(proowner,proacl,prosecdef,provolatile,proconfig,proparallel,proisstrict)
  INTO original,before_meta FROM pg_proc WHERE oid=d.signature::regprocedure;
  IF md5(original)<>d.hash THEN RAISE EXCEPTION 'weekly_hour_guard_preimage_changed: %',d.signature; END IF;
  IF (length(lower(original))-length(replace(lower(original),'extract(minute','')))/length('extract(minute')<>d.guards
  THEN RAISE EXCEPTION 'weekly_hour_guard_shape_changed: %',d.signature; END IF;
  candidate:=replace(original,' OR extract(minute FROM v_now) >= 45','');
  candidate:=replace(candidate,'OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen()','OR public.fn_platform_frozen()');
  candidate:=replace(candidate,E'  OR extract(minute FROM clock_timestamp())>=45\n','');
  IF position('extract(minute' in lower(candidate))>0 OR position('fn_platform_frozen' in candidate)=0
  THEN RAISE EXCEPTION 'weekly_hour_guard_replacement_incomplete'; END IF;
  EXECUTE candidate;
  SELECT jsonb_build_array(proowner,proacl,prosecdef,provolatile,proconfig,proparallel,proisstrict) INTO after_meta FROM pg_proc WHERE oid=d.signature::regprocedure;
  IF before_meta IS DISTINCT FROM after_meta OR pg_get_functiondef(d.signature::regprocedure) IS DISTINCT FROM candidate
  THEN RAISE EXCEPTION 'weekly_hour_guard_postimage_changed'; END IF;
 END LOOP;
END $change$;
COMMIT;
