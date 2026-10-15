-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))='009938740934b24744b35496477d02a1' AND to_regprocedure('public.fn_accounting_window_advance_due()') IS NOT NULL)
-- 20261015182133_a_proving_week_advances_on_its_own_tick.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Installs after 20261015173123 (a calculating week advances on its own
-- tick): its postimage of fn_process_weekly_accounting_scope is this file's
-- preimage, and the guard refuses anything else.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Once the original week (union fade0000, 2026-10-05 -> 2026-10-12) left
-- 'calculating' at 17:30 UTC on 2026-10-15 it sat in stage 'prepared':
-- round 2's 84 commission windows have to be proved
-- (fn_accounting_close_windows_pending -> fn_settle_accounting_commission_advance)
-- before the attempt that pays the round. From 17:33 to 18:13 the week
-- proved 7 of 84 windows, one per tick.
--
-- Measured on production at 18:18 UTC: one window
-- (fn_settle_accounting_commission_window, 42,432 sources) takes 11.7 s and
-- resolving the book's scope 5.3 s. The windows were never the slow part.
-- The commission advance stops starting windows 120 s after the attempt
-- began, and by the time a union attempt reaches its windows the tick has
-- already spent 60 to 90 s on the scheduler eligibility scan and the
-- standalone club's visit and about 50 s on the attempt's preparation. So
-- every tick proved exactly its first window and stopped. 77 windows at one
-- per five-minute tick (three ticks an hour fall in the :45 to :00 quiet
-- period) is over eight hours, and round 3 has the same 84 windows behind
-- it, while the P&L flow windows that preparation reads expire 12 hours after
-- they were proved: the week would expire faster than it advanced.
--
-- The root fix is the same as for a calculating week, in the same place:
-- while a weekly close is in stage 'prepared' (its preparation succeeded and
-- only window proofs stand between it and payment), a chunked tick spends
-- its statement budget proving that book's windows
-- (fn_accounting_window_advance_due, which calls the platform's own
-- fn_accounting_close_windows_pending with job 272's chunked settings) and
-- visits no scope. It never starts a step with less than 75 s of the
-- statement left, and the windows inside a step stop being started 70 s
-- before the statement ends, so every window it starts commits. When no
-- window or round-3 plan is left to prove, the advance finds nothing and the
-- next tick visits the book, which pays.
--
-- Nothing else moves: no money, receipt, round or certificate is written
-- here. The only rows written are the window proofs
-- (accounting_close_partials), exactly as an attempt writes them, and the
-- rounds re-verify them before they pay.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public;
DO $guard$BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.sub',true),'') IS NOT NULL THEN RAISE EXCEPTION 'window_advance_operator_refused' USING ERRCODE='42501';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'window_advance_override_refused';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'window_advance_freeze_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'window_advance_reader_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015182133') THEN RAISE EXCEPTION 'window_advance_history_replay';END IF;
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015173123') THEN RAISE EXCEPTION 'window_advance_requires_split_advance';END IF;
 IF to_regprocedure('public.fn_accounting_window_advance_due()') IS NOT NULL THEN RAISE EXCEPTION 'window_advance_already_present';END IF;
 IF md5(pg_get_functiondef('public.fn_accounting_close_windows_pending(uuid,uuid,timestamptz,timestamptz)'::regprocedure))<>'536acae0c83352aa3cecf4bd95082f6d' THEN RAISE EXCEPTION 'window_advance_pending_changed';END IF;
END $guard$;

CREATE FUNCTION public.fn_accounting_window_advance_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- A PROVING WEEK ADVANCES ON ITS OWN TICK (20261015182133). Inside a chunked
-- close tick (job 272), prove the windows of every weekly close in stage
-- 'prepared', oldest first, through fn_accounting_close_windows_pending, and
-- report whether any was advanced. A step is started only while 75 s of the
-- statement remain, and the windows inside it stop being started 70 s before
-- the statement ends, so the proofs it writes commit. Outside a chunked tick
-- with a bounded statement it does nothing.
DECLARE r record; did boolean; calls int; advanced boolean:=false; done jsonb:='[]'::jsonb; stmt_end timestamptz;
 budget interval:=COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 saved_deadline text:=COALESCE(current_setting('app.weekly_accounting_scope_deadline',true),'');
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('statement_timeout') IN ('0','0ms') THEN
  RETURN jsonb_build_object('advanced',false,'books','[]'::jsonb);
 END IF;
 stmt_end:=statement_timestamp()+current_setting('statement_timeout')::interval;
 FOR r IN SELECT q.scope_kind,q.scope_id,q.period_start,q.period_end FROM public.union_accounting_runs q
   WHERE q.status='running' AND q.result->>'chunk_committed'='true' AND q.result->>'stage'='prepared'
    AND q.scope_kind IN ('union','club') AND q.scope_id IS NOT NULL AND q.period_end<=clock_timestamp()
   ORDER BY q.period_start,q.scope_kind DESC,q.scope_id LOOP
  calls:=0;
  LOOP
   EXIT WHEN stmt_end-clock_timestamp()<interval '75 seconds';
   -- The window advances stop starting windows once 120 s have passed since
   -- the attempt began (deadline - budget): put that point 70 s before the
   -- statement ends.
   PERFORM set_config('app.weekly_accounting_scope_deadline',(stmt_end-interval '190 seconds'+budget)::text,true);
   did:=public.fn_accounting_close_windows_pending(CASE WHEN r.scope_kind='union' THEN r.scope_id END,
    CASE WHEN r.scope_kind='club' THEN r.scope_id END,r.period_start,r.period_end);
   EXIT WHEN did IS DISTINCT FROM true;
   advanced:=true;
   calls:=calls+1;
  END LOOP;
  IF calls>0 THEN
   done:=done||jsonb_build_array(jsonb_build_object('scope_kind',r.scope_kind,'scope_id',r.scope_id,
    'period_start',r.period_start,'period_end',r.period_end,'steps',calls));
  END IF;
  EXIT WHEN stmt_end-clock_timestamp()<interval '75 seconds';
 END LOOP;
 PERFORM set_config('app.weekly_accounting_scope_deadline',saved_deadline,true);
 RETURN jsonb_build_object('advanced',advanced,'books',done);
END
$function$;
REVOKE ALL ON FUNCTION public.fn_accounting_window_advance_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_window_advance_due() TO service_role;

DO $install$
DECLARE
 sig constant regprocedure:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 def text:=pg_get_functiondef(sig);
 o text:=$anchor$    v_saved_budget:=current_setting('app.weekly_accounting_attempt_budget',true);
$anchor$;
 n text:=$anchor$    -- A PROVING WEEK ADVANCES ON ITS OWN TICK (20261015182133): while a
    -- weekly close is in stage 'prepared', a chunked tick spends its budget
    -- proving that book's windows and visits no scope.
    IF v_chunked THEN
      v_seal:=public.fn_accounting_window_advance_due();
      IF v_seal->>'advanced'='true' THEN
        RETURN jsonb_build_object('success',true,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
          'observed_at',clock_timestamp(),'detail','[]'::jsonb,'window_advance',v_seal);
      END IF;
    END IF;
    v_saved_budget:=current_setting('app.weekly_accounting_attempt_budget',true);
$anchor$;
 before text;
BEGIN
 IF md5(def)<>'a497381284a4f68b573cbf08ce1929e3' THEN RAISE EXCEPTION 'window_advance_preimage_refused';END IF;
 IF (length(def)-length(replace(def,o,'')))/length(o)<>1 THEN RAISE EXCEPTION 'window_advance_anchor_refused';END IF;
 SELECT string_agg(concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')),';') INTO before FROM pg_proc p WHERE p.oid=sig;
 EXECUTE replace(def,o,n);
 IF md5(pg_get_functiondef(sig))<>'009938740934b24744b35496477d02a1' THEN RAISE EXCEPTION 'window_advance_postimage_refused';END IF;
 IF (SELECT string_agg(concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')),';') FROM pg_proc p WHERE p.oid=sig) IS DISTINCT FROM before THEN RAISE EXCEPTION 'window_advance_security_refused';END IF;
END $install$;

COMMIT;
