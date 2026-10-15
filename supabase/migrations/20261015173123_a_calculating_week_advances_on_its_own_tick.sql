-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))='a497381284a4f68b573cbf08ce1929e3' AND to_regprocedure('public.fn_accounting_split_advance_due()') IS NOT NULL)
-- 20261015173123_a_calculating_week_advances_on_its_own_tick.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The original week (union fade0000, 2026-10-05 -> 2026-10-12) sat in stage
-- 'calculating' from 15:26 to 17:13 UTC on 2026-10-15. Its two clubs'
-- split recomputes (fn_rakeback_recompute_split) need 1 players part, 28
-- tournament-gate parts, 84 count parts and one check and one write part per
-- player page each: well over a hundred parts per club-week.
--
-- Measured on job 272's own ticks (pg_locks sampled every 0.5 s, 16:25 and
-- 16:30 UTC): before the union attempt reaches the split, the tick spends
-- 60 to 90 s on the scheduler's eligibility scan and the standalone club's
-- visit (100 of 115 one-second samples were IO:DataFileRead), and the
-- attempt's preparation then spends about 50 s more (cash refusals 11 s, P&L
-- close quality 28 s, week clubs 9 s, all measured warm). A cold part takes
-- 20 to 60 s. So each tick had room for at most one part, and when that part
-- ran past the 240 s statement timeout the whole attempt rolled back with it:
-- the 16:10, 16:15 and 16:19 visits all ended
-- weekly_scope_statement_budget_exhausted and kept nothing. From 15:26 to
-- 16:30 the week gained 2 parts. Parts expire 12 hours after the oldest one,
-- so the week could never finish.
--
-- The same parts, advanced on their own (the split called directly with job
-- 272's chunked settings, no scan and no preparation in front of it), took
-- 18 and 13 calls of about 80 s, and both club-weeks finished 'ready'
-- (written 303 and 392; request rows 34ad55c6 and 7e405939). The calculation
-- itself was never the slow part; the fixed cost in front of every part was.
--
-- The root fix is in the tick: while any closed club-week is part way
-- through its split recompute, a chunked tick spends its statement budget
-- advancing those parts (fn_accounting_split_advance_due) and visits no
-- scope, exactly as a tick that is still sealing the week's inventory visits
-- no scope. Each club-week gets at most the split's own 90 s, and no part is
-- started with less than 90 s of the statement left (75 s held back for the
-- longest part measured plus the commit), so a tick that advances parts
-- always commits them. Once the last part lands the split records its request
-- row and removes its parts exactly as it does inside an attempt, the advance
-- finds nothing, and the next tick visits the book, whose preparation reuses
-- the recorded receipt.
--
-- A club-week that finishes 'blocked' here is reported the way an attempt
-- that hit it would have been: one open critical financial_alerts row per
-- club-week (source union_accounting_scheduler).
--
-- Nothing else moves: no money, certificate, part value, cutoff or floor is
-- written here, and fn_rakeback_recompute_split itself is unchanged.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public;
DO $guard$BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.sub',true),'') IS NOT NULL THEN RAISE EXCEPTION 'split_advance_operator_refused' USING ERRCODE='42501';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'split_advance_override_refused';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'split_advance_freeze_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'split_advance_reader_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015173123') THEN RAISE EXCEPTION 'split_advance_history_replay';END IF;
 IF to_regprocedure('public.fn_accounting_split_advance_due()') IS NOT NULL THEN RAISE EXCEPTION 'split_advance_already_present';END IF;
 IF md5(pg_get_functiondef('public.fn_rakeback_recompute_split(uuid,date,date)'::regprocedure))<>'6b2a9c08ba56ea9f65b31a1cc80c3351' THEN RAISE EXCEPTION 'split_advance_split_changed';END IF;
END $guard$;

CREATE FUNCTION public.fn_accounting_split_advance_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- A CALCULATING WEEK ADVANCES ON ITS OWN TICK (20261015173123). Inside a
-- chunked close tick (job 272), advance every closed club-week that is part
-- way through its split recompute, oldest first, and report whether any was
-- advanced. Each club-week gets at most the split's own 90 s and is started
-- only while 90 s of the statement remain, so the parts it writes commit.
-- Outside a chunked tick with a bounded statement it does nothing.
DECLARE w record; r jsonb; done jsonb:='[]'::jsonb; advanced boolean:=false;
 stmt_end timestamptz; remaining interval;
 budget interval:=COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 saved_deadline text:=COALESCE(current_setting('app.weekly_accounting_scope_deadline',true),'');
 saved_did text:=COALESCE(current_setting('app.accounting_split_did',true),'');
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('statement_timeout') IN ('0','0ms') THEN
  RETURN jsonb_build_object('advanced',false,'club_weeks','[]'::jsonb);
 END IF;
 stmt_end:=statement_timestamp()+current_setting('statement_timeout')::interval;
 FOR w IN SELECT p.club_id,p.period_start,p.period_end FROM public.accounting_recompute_split_parts p
   WHERE p.kind='players' ORDER BY p.computed_at,p.club_id,p.period_start LOOP
  remaining:=LEAST(interval '90 seconds',stmt_end-interval '75 seconds'-clock_timestamp());
  EXIT WHEN remaining<interval '15 seconds';
  -- The split stops once it has done a part and 90 s have passed since the
  -- attempt began (deadline - budget): begin it so that point is `remaining`
  -- from now.
  PERFORM set_config('app.weekly_accounting_scope_deadline',(clock_timestamp()+remaining-interval '90 seconds'+budget)::text,true);
  PERFORM set_config('app.accounting_split_did','',true);
  r:=public.fn_rakeback_recompute_split(w.club_id,w.period_start,w.period_end);
  CONTINUE WHEN r IS NULL;
  advanced:=true;
  done:=done||jsonb_build_array(jsonb_build_object('club_id',w.club_id,'period_start',w.period_start,
   'period_end',w.period_end,'status',r->>'status','stage',r->>'stage','reason',r->>'reason'));
  IF r->>'status' NOT IN ('in_progress','ready') AND NOT EXISTS(SELECT 1 FROM public.financial_alerts a
    WHERE a.source='union_accounting_scheduler' AND a.message='A weekly club calculation finished blocked'
     AND a.resolved IS NOT TRUE AND a.context->>'club_id'=w.club_id::text
     AND a.context->>'period_start'=w.period_start::text) THEN
   INSERT INTO public.financial_alerts(source,severity,message,context)
   VALUES('union_accounting_scheduler','critical','A weekly club calculation finished blocked',
    jsonb_build_object('club_id',w.club_id,'period_start',w.period_start,'period_end',w.period_end,'result',r));
  END IF;
 END LOOP;
 PERFORM set_config('app.weekly_accounting_scope_deadline',saved_deadline,true);
 PERFORM set_config('app.accounting_split_did',saved_did,true);
 RETURN jsonb_build_object('advanced',advanced,'club_weeks',done);
END
$function$;
REVOKE ALL ON FUNCTION public.fn_accounting_split_advance_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_split_advance_due() TO service_role;

DO $install$
DECLARE
 sig constant regprocedure:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 def text:=pg_get_functiondef(sig);
 o text:=$anchor$    v_saved_budget:=current_setting('app.weekly_accounting_attempt_budget',true);
$anchor$;
 n text:=$anchor$    -- A CALCULATING WEEK ADVANCES ON ITS OWN TICK (20261015173123): while a
    -- closed club-week is part way through its split recompute, a chunked
    -- tick spends its budget on those parts and visits no scope, as a tick
    -- still sealing the week's inventory does.
    IF v_chunked THEN
      v_seal:=public.fn_accounting_split_advance_due();
      IF v_seal->>'advanced'='true' THEN
        RETURN jsonb_build_object('success',true,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
          'observed_at',clock_timestamp(),'detail','[]'::jsonb,'split_advance',v_seal);
      END IF;
    END IF;
    v_saved_budget:=current_setting('app.weekly_accounting_attempt_budget',true);
$anchor$;
 before text;
BEGIN
 IF md5(def)<>'e6960e3960fde66c11578438692c57b1' THEN RAISE EXCEPTION 'split_advance_preimage_refused';END IF;
 IF (length(def)-length(replace(def,o,'')))/length(o)<>1 THEN RAISE EXCEPTION 'split_advance_anchor_refused';END IF;
 SELECT string_agg(concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')),';') INTO before FROM pg_proc p WHERE p.oid=sig;
 EXECUTE replace(def,o,n);
 IF md5(pg_get_functiondef(sig))<>'a497381284a4f68b573cbf08ce1929e3' THEN RAISE EXCEPTION 'split_advance_postimage_refused';END IF;
 IF (SELECT string_agg(concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')),';') FROM pg_proc p WHERE p.oid=sig) IS DISTINCT FROM before THEN RAISE EXCEPTION 'split_advance_security_refused';END IF;
END $install$;

COMMIT;
