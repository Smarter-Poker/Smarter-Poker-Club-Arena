-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_union_earned_plan_advance(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='42d6add347b1b942aa79c95d0ec169c7')
-- 20261015021138_proving_earned_plan_windows_is_a_whole_attempt.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The original week (union fade0000, 2026-10-05 -> 2026-10-12) stopped making
-- progress at attempt 75 (2026-10-15 01:26 UTC). Every scheduler visit after it
-- (01:30, 01:35, 01:40, 02:05) was killed by job 272's 240 s statement timeout
-- (weekly_scope_statement_budget_exhausted), and a killed attempt rolls back
-- everything it proved, so the next visit did exactly the same work again.
--
-- Read from rows: 76 of the week's 84 earned-plan windows were fresh, and every
-- earlier attempt had proved windows for about 120 s and then stopped cleanly
-- (fn_accounting_union_earned_plan_advance returns false once it has proved one
-- and 120 s have passed). The last 8 windows (about 11 s each, measured) fit
-- inside that 120 s, so the advance ran off the end of its loop and returned
-- TRUE. fn_union_pnl_evidence_report then went straight on, in the same attempt,
-- to the closing boundary, which had to be re-proved for the new original
-- inventory generation (raw inventory alone measured at 29 s). Windows plus the
-- closing boundary plus the attempt's preparation do not fit in 240 s, so the
-- attempt that finishes the windows is the one that can never commit.
--
-- The root fix is in the advance, where the wrong answer was produced: an
-- attempt that proved any window has done its step and returns false (the
-- report answers 'warming', the attempt commits as a certifying chunk), exactly
-- as it already did when it ran out of time mid-loop. The next attempt finds
-- every window fresh, proves none, and continues to the boundary with the whole
-- budget. An attempt that proved nothing is unchanged byte for byte.
--
-- Nothing else moves: no certificate, partial, cache, cutoff, floor or money is
-- written here.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public;
DO $guard$BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.sub',true),'') IS NOT NULL THEN RAISE EXCEPTION 'earned_plan_window_step_operator_refused' USING ERRCODE='42501';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'earned_plan_window_step_override_refused';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'earned_plan_window_step_freeze_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'earned_plan_window_step_reader_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015021138') THEN RAISE EXCEPTION 'earned_plan_window_step_history_replay';END IF;
END $guard$;

DO $install$
DECLARE
 sig constant regprocedure:='public.fn_accounting_union_earned_plan_advance(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure;
 def text:=pg_get_functiondef(sig);
 o text:=$anchor$  proved:=true;
 END LOOP;
 RETURN true;
END $function$$anchor$;
 n text:=$anchor$  proved:=true;
 END LOOP;
 -- PROVING WINDOWS IS A WHOLE ATTEMPT (20261015): an attempt that proved a
 -- window ends here, even when it proved the last one, so the closing boundary
 -- and every later step start the next attempt with the whole budget.
 IF proved THEN RETURN false; END IF;
 RETURN true;
END $function$$anchor$;
 before text;
BEGIN
 IF md5(def)<>'b2013d3a482981080cfc7b135aa20dcd' THEN RAISE EXCEPTION 'earned_plan_window_step_preimage_refused';END IF;
 IF (length(def)-length(replace(def,o,'')))/length(o)<>1 THEN RAISE EXCEPTION 'earned_plan_window_step_anchor_refused';END IF;
 SELECT string_agg(concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')),';') INTO before FROM pg_proc p WHERE p.oid=sig;
 EXECUTE replace(def,o,n);
 IF md5(pg_get_functiondef(sig))<>'42d6add347b1b942aa79c95d0ec169c7' THEN RAISE EXCEPTION 'earned_plan_window_step_postimage_refused';END IF;
 IF (SELECT string_agg(concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')),';') FROM pg_proc p WHERE p.oid=sig) IS DISTINCT FROM before THEN RAISE EXCEPTION 'earned_plan_window_step_security_refused';END IF;
END $install$;

COMMIT;
