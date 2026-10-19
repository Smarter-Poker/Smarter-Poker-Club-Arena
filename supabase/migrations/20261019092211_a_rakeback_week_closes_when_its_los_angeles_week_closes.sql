-- 20261019092211_a_rakeback_week_closes_when_its_los_angeles_week_closes.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A rakeback week is a Los Angeles week. The live calculator
-- (fn_calculate_cash_rakeback_periods) reads it as
-- [period_start, period_end + 1) AT TIME ZONE 'America/Los_Angeles', and the
-- weekly settlement floor sits on that boundary (2026-09-21T07:00Z). Three
-- gates still decided "this week is over" at the UTC midnight after
-- period_end, 7 hours (PDT) or 8 hours (PST) before the week actually ends:
--
--   fn_ca_legacy_period_maturity        BEFORE UPDATE OF status ON
--                                       rakeback_periods: refuses 'paid' on an
--                                       open week;
--   fn_ca_legacy_round3_wallet_receipt  BEFORE INSERT ON wallet_transactions:
--                                       refuses a rakeback credit for an open
--                                       week;
--   fn_close_settlement_period          the retired per-period payer (no
--                                       caller; postgres only): its maturity
--                                       refusal and the matures_at it reports.
--
-- So from Monday 00:00 UTC until the Los Angeles week rolled over, all three
-- let an unfinished week be marked paid. Measured 2026-10-19: 420 periods of
-- the week of 2026-09-07 were paid 2026-09-14 00:29-06:27 UTC, inside that
-- window (that week, and the week of 2026-09-14, were later settled by the
-- owner's 2026-09-26 decisions; no period has been paid inside the window
-- since the 2026-09-21 settlement floor). The scheduled payer runs at Monday
-- 04:00 America/Chicago, after the Los Angeles close, so it is unaffected.
--
-- The fix moves only the closing instant, to the calculator's own expression.
-- Los Angeles midnight is always later than UTC midnight on the same date, so
-- every gate becomes strictly stricter: it can refuse an early payment, never
-- admit one. Refusal text, error codes, rake bases (fn_close_settlement_period
-- keeps its documented UTC-day basis), owners, SECURITY, configuration and
-- grants are unchanged and asserted. No row is written. Exact preimages are
-- required, so a definition changed since 2026-10-19 refuses the whole
-- transaction. Native proof: scripts/ci/test-rakeback-week-closes-in-los-angeles.py.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_legacy_period_maturity()'::regprocedure))='c47a76d289ba6c37a6411f447948c61b' AND md5(pg_get_functiondef('public.fn_ca_legacy_round3_wallet_receipt()'::regprocedure))='633c22d5e80a33097315dd3835f28784' AND md5(pg_get_functiondef('public.fn_close_settlement_period(uuid)'::regprocedure))='4940b5cf6ecc6f6d04d67309daccd216')

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
    OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN
   RAISE EXCEPTION 'rakeback_week_close_operator_refused';
 END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL
    OR public.fn_platform_frozen() IS DISTINCT FROM false
    OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN
   RAISE EXCEPTION 'rakeback_week_close_freeze_or_override_refused';
 END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261019092211') THEN
   RAISE EXCEPTION 'rakeback_week_close_migration_replay_refused';
 END IF;
END $guard$;
CREATE FUNCTION pg_temp.rakeback_week_close_patch(sig regprocedure, pre text, post text,
                                                  old text[], new text[], expected integer[])
RETURNS void LANGUAGE plpgsql AS $body$
DECLARE before text:=pg_get_functiondef(sig); after text; security_before jsonb; k integer;
BEGIN
 IF md5(before)<>pre THEN RAISE EXCEPTION 'rakeback_week_close_preimage_refused: %',sig; END IF;
 SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl)
   INTO security_before FROM pg_proc WHERE oid=sig;
 IF cardinality(old) IS DISTINCT FROM cardinality(new)
    OR cardinality(old) IS DISTINCT FROM cardinality(expected) THEN
   RAISE EXCEPTION 'rakeback_week_close_patch_shape_refused';
 END IF;
 after:=before;
 FOR k IN 1..cardinality(old) LOOP
   IF (length(after)-length(replace(after,old[k],'')))/length(old[k])<>expected[k] THEN
     RAISE EXCEPTION 'rakeback_week_close_anchor_refused: %/%',sig,k;
   END IF;
   after:=replace(after,old[k],new[k]);
 END LOOP;
 IF md5(after)<>post THEN RAISE EXCEPTION 'rakeback_week_close_derived_postimage_refused: %',sig; END IF;
 EXECUTE after;
 IF md5(pg_get_functiondef(sig))<>post OR
    (SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl)
       FROM pg_proc WHERE oid=sig) IS DISTINCT FROM security_before THEN
   RAISE EXCEPTION 'rakeback_week_close_postimage_or_security_refused: %',sig;
 END IF;
END $body$;
SELECT pg_temp.rakeback_week_close_patch(
 'public.fn_ca_legacy_period_maturity()'::regprocedure,
 '58507b44f4896debdd7b4237c9588719','c47a76d289ba6c37a6411f447948c61b',
 ARRAY[$a$(NEW.period_end+1)::timestamp AT TIME ZONE 'UTC'$a$],
 ARRAY[$b$(NEW.period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles'$b$],ARRAY[1]);
SELECT pg_temp.rakeback_week_close_patch(
 'public.fn_ca_legacy_round3_wallet_receipt()'::regprocedure,
 'f05849a487f106564c8e52250be3ab45','633c22d5e80a33097315dd3835f28784',
 ARRAY[$a$(v_period.period_end+1)::timestamp AT TIME ZONE 'UTC'$a$],
 ARRAY[$b$(v_period.period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles'$b$],ARRAY[1]);
SELECT pg_temp.rakeback_week_close_patch(
 'public.fn_close_settlement_period(uuid)'::regprocedure,
 '3fbefd5632532831f0cd9a2eaf272ae3','4940b5cf6ecc6f6d04d67309daccd216',
 ARRAY[$a$(v_period.period_end+1)::timestamp AT TIME ZONE 'UTC'$a$],
 ARRAY[$b$(v_period.period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles'$b$],ARRAY[2]);
COMMIT;
