-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_settle_accounting_commission_advance(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='e91c40770c8de772df2a25bbce016ef5' AND md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_advance(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='2c3f36a8920d70b225c887c1287a567b' AND md5(pg_get_functiondef('public.fn_union_settlement_cascade_due()'::regprocedure))='4e48f73890bd1b928653327f3a0a388b' AND to_regprocedure('public.fn_accounting_close_windows_advance_due()') IS NOT NULL)
-- 20261015181721_a_close_proving_loop_stops_on_the_statement_clock.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A CLOSE PROVING LOOP STOPS ON THE STATEMENT'S OWN CLOCK (2026-10-15)
--
-- WHAT HAPPENED, READ FROM ROWS:
--
-- The original week (union fade0000, 2026-10-05 -> 2026-10-12) reached stage
-- 'prepared' at 17:30 UTC and began proving round 2's 84 two-hour windows
-- (accounting_close_partials kind 'round2_union_window', about 13 to 15 s
-- each). Six were proved by the 17:30, 17:35 and 17:40 visits. The 18:05
-- visit was cancelled by job 272's 240 s statement timeout
-- (weekly_accounting_scheduler_visits.last_outcome 'statement_timeout',
-- financial_alerts 'A weekly accounting scope did not finish its scheduler
-- visit') and kept nothing.
--
-- Why: job 272 is one 240 s statement. Before the union attempt it selects
-- the scopes and visits the standalone club scope (2a1132b9, a completed
-- week): that visit ended at 17:40:20 in the 17:40 tick (20 s in) but at
-- 18:06:42 in the 18:05 tick (102 s in, under I/O load). The attempt then
-- prepares the book (cash refusals, P&L close quality, week clubs: about 50
-- to 75 s). fn_settle_accounting_commission_advance then proves windows until
-- 120 s after the ATTEMPT began (the attempt's deadline minus its 3-minute
-- budget). It never asks how much of the STATEMENT is left, so an attempt that
-- begins 100 s into the tick keeps starting windows until about 220 s, and the
-- window it is inside at 240 s is cancelled, rolling back every window that
-- attempt proved. fn_settle_accounting_rakeback_advance (round 3's windows
-- and its plan) has the same rule.
--
-- fn_accounting_union_earned_plan_advance already had this defect and was
-- fixed in 20261015b (installed as 20261015101400): its loops stop a minute
-- before the statement's own timeout. The two round advances were left on the
-- attempt-only clock.
--
-- The same tick shows the second half of the cause. From 18:10 to 18:35 the
-- union attempt began 69 s and more into the tick and its preparation took
-- up to 150 s, so each visit reached the windows at about 225 s and proved
-- exactly one (18:13:57, 18:23:45, 18:28:54) or was cancelled (18:15, 18:30):
-- 3 windows in 25 minutes, 75 left, while the week's P&L certificates expire
-- 12 hours after they were proved (pnl_touched at 00:38, pnl_boundary at
-- 01:11, pnl_flows at 02:37 UTC). Each window is a read of the week's own
-- sources and needs nothing from the preparation that every attempt repeats
-- in front of it: the attempt that pays round 2 reads the partials
-- (fn_settle_accounting_commission_combine) the same way whoever proved them,
-- under the same 12-hour freshness.
--
-- THE FIX, part 1, in the two functions that start the work: each computes, once,
-- the instant one minute before the statement would be cancelled
-- (statement_timestamp() + statement_timeout - 60 s; never when the
-- statement has no timeout) and starts no window, and no round-3 plan, after
-- it. An attempt that reaches the loop too late commits as a 'prepared' step
-- with what it has (the caller, fn_accounting_close_windows_pending, already
-- ends the attempt whenever a round's windows are pending), instead of being
-- cancelled and rolled back. The 120 s and 60 s attempt rules are unchanged,
-- the windows and plan they prove are byte for byte the same, and an attempt
-- with time left is unchanged.
--
-- THE FIX, part 2: fn_union_settlement_cascade_due (job 272's entry) first
-- asks fn_accounting_close_windows_advance_due, which proves the round-2
-- windows of every book in stage 'prepared' with no round-2 receipt, through
-- fn_settle_accounting_commission_advance itself, from the top of the tick
-- until a minute before the statement ends (about 12 windows a tick instead
-- of 0 or 1). When it proved a window the tick visits no scope, as a tick
-- that is sealing inventory does; when it proved none (no such book, every
-- window fresh, or outside a chunked tick, a freeze, the hourly break or a
-- held scheduler lock) the tick is exactly as before. The engine's own call
-- (service_role, not chunked) is unchanged.
--
-- Nothing here pays, clears or rewrites a row: partials are the close's own
-- cache, and the money rounds are untouched.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. Each
-- live text must hash to today's measured md5, each anchor must occur exactly
-- once, and each result must hash to the postimage derived read-only on
-- production with replace() (2026-10-15: e91c40770c8de772df2a25bbce016ef5,
-- 2c3f36a8920d70b225c887c1287a567b and 4e48f73890bd1b928653327f3a0a388b). Owner, SECURITY DEFINER, volatility, proconfig and grants
-- must not move. It installs only while the weekly scheduler is idle.
--
-- Regression: scripts/ci/test-a-close-proving-loop-stops-on-the-statement-clock.py
-- (native PostgreSQL), run by
-- .github/workflows/a-close-proving-loop-stops-on-the-statement-clock.yml.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
DO $guard$BEGIN
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'close_clock_override_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'close_clock_scheduler_running';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015181721') THEN RAISE EXCEPTION 'close_clock_history_replay';END IF;
 IF to_regprocedure('public.fn_accounting_close_windows_advance_due()') IS NOT NULL THEN RAISE EXCEPTION 'close_clock_advance_already_present';END IF;
END $guard$;

CREATE FUNCTION pg_temp.ca_close_clock_subst(p_sig text, p_before text, p_after text,
                                             p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[]; v_vol "char";
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, p.provolatile
    INTO v_acl, v_owner, v_secdef, v_cfg, v_vol
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg
                    AND p.provolatile = v_vol) THEN
    RAISE EXCEPTION '%: owner, security, volatility, settings or grants moved', p_sig;
  END IF;
END $h$;

-- Round 2: the commission windows.
SELECT pg_temp.ca_close_clock_subst(
  'public.fn_settle_accounting_commission_advance(text,uuid,timestamp with time zone,timestamp with time zone)',
  '962cc58063d067043734b56a829a78aa', 'e91c40770c8de772df2a25bbce016ef5',
  ARRAY[$o1$DECLARE w record; r record; sc record; began timestamptz; proved boolean:=false; v_kind text:='round2_'||p_scope_kind||'_window';
$o1$,
        $o2$'8 minutes')::interval;
 DELETE FROM public.accounting_close_partials$o2$,
        $o3$  IF proved AND clock_timestamp()>began+interval '120 seconds' THEN RETURN false; END IF;
$o3$],
  ARRAY[$n1$DECLARE w record; r record; sc record; began timestamptz; proved boolean:=false; v_kind text:='round2_'||p_scope_kind||'_window';
 stop_at timestamptz;
$n1$,
        $n2$'8 minutes')::interval;
 -- THE STATEMENT'S OWN CLOCK (20261015181721): job 272 visits other scopes
 -- and prepares the book before this loop, so an attempt can reach it late
 -- in its 240 s statement. A window is never started less than a minute
 -- before the statement would be cancelled, which would roll back every
 -- window this attempt proved; the attempt commits what it has instead.
 stop_at:='infinity';
 IF current_setting('statement_timeout') NOT IN ('0','0ms') THEN
  stop_at:=statement_timestamp()+current_setting('statement_timeout')::interval-interval '60 seconds';
 END IF;
 DELETE FROM public.accounting_close_partials$n2$,
        $n3$  IF clock_timestamp()>stop_at OR (proved AND clock_timestamp()>began+interval '120 seconds') THEN RETURN false; END IF;
$n3$]
);

-- Round 3: the rakeback windows and the plan.
SELECT pg_temp.ca_close_clock_subst(
  'public.fn_settle_accounting_rakeback_advance(text,uuid,timestamp with time zone,timestamp with time zone)',
  '53dadff0fe6ec7e39415e8b8d4b6a99b', '2c3f36a8920d70b225c887c1287a567b',
  ARRAY[$o1$DECLARE w record; sc record; began timestamptz; proved boolean:=false; v_kind text:='round3_'||p_scope_kind||'_window';
$o1$,
        $o2$'8 minutes')::interval;
 FOR w IN SELECT$o2$,
        $o3$  IF proved AND clock_timestamp()>began+interval '120 seconds' THEN RETURN true; END IF;
$o3$,
        $o4$clock_timestamp()-interval '12 hours') THEN
  PERFORM public.fn_settle_accounting_rakeback_plan($o4$],
  ARRAY[$n1$DECLARE w record; sc record; began timestamptz; proved boolean:=false; v_kind text:='round3_'||p_scope_kind||'_window';
 stop_at timestamptz;
$n1$,
        $n2$'8 minutes')::interval;
 -- THE STATEMENT'S OWN CLOCK (20261015181721): job 272 visits other scopes
 -- and prepares the book before this loop, so an attempt can reach it late
 -- in its 240 s statement. A window is never started less than a minute
 -- before the statement would be cancelled, which would roll back every
 -- window this attempt proved; the attempt commits what it has instead.
 stop_at:='infinity';
 IF current_setting('statement_timeout') NOT IN ('0','0ms') THEN
  stop_at:=statement_timestamp()+current_setting('statement_timeout')::interval-interval '60 seconds';
 END IF;
 FOR w IN SELECT$n2$,
        $n3$  IF clock_timestamp()>stop_at OR (proved AND clock_timestamp()>began+interval '120 seconds') THEN RETURN true; END IF;
$n3$,
        $n4$clock_timestamp()-interval '12 hours') THEN
  -- The plan, too, starts only with a minute of the statement left.
  IF clock_timestamp()>stop_at THEN RETURN true; END IF;
  PERFORM public.fn_settle_accounting_rakeback_plan($n4$]
);

-- THE ROUND-2 WINDOWS ADVANCE ON THEIR OWN TICK. A book in stage 'prepared'
-- (its preparation succeeded and only its round-2 windows are missing) has
-- its windows proved here, at the top of job 272's tick, with the whole
-- statement, instead of after the tick's scope scan, the standalone club
-- visit and a repeat of the book's preparation (measured 2026-10-15: those
-- left a union attempt between 0 and 1 window per 240 s tick). The windows
-- are the very partials fn_settle_accounting_commission_advance writes, by
-- that function; the attempt that pays round 2 reads them the same way
-- as before. NULL (the tick goes on as before) outside a chunked
-- tick, under a freeze or the hourly break, while another tick holds the
-- scheduler, or when no window was proved.
CREATE FUNCTION public.fn_accounting_close_windows_advance_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE q record; done jsonb:='[]'::jsonb; advanced boolean:=false; stmt_stop timestamptz;
 n_windows bigint; n_before bigint; n_after bigint; v_msg text;
 budget interval:=COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 saved_deadline text:=COALESCE(current_setting('app.weekly_accounting_scope_deadline',true),'');
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('statement_timeout') IN ('0','0ms')
  OR public.fn_platform_frozen() IS DISTINCT FROM false
  OR extract(minute FROM clock_timestamp())>=45
  OR NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN
  RETURN NULL;
 END IF;
 -- No window starts less than a minute before the statement is cancelled.
 stmt_stop:=statement_timestamp()+current_setting('statement_timeout')::interval-interval '60 seconds';
 FOR q IN SELECT r.scope_kind,r.scope_id,r.period_start,r.period_end FROM public.union_accounting_runs r
   WHERE r.status='running' AND r.result->>'chunk_committed'='true' AND r.result->>'stage'='prepared'
    AND r.scope_kind IN ('union','club') AND r.scope_id IS NOT NULL AND r.period_end<=clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs s WHERE s.scope_kind=r.scope_kind
     AND s.scope_id=r.scope_id AND s.period_start=r.period_start AND s.period_end=r.period_end AND s.round_no=2)
   ORDER BY r.period_start,r.scope_kind,r.scope_id LOOP
  EXIT WHEN clock_timestamp()>stmt_stop;
  SELECT count(*),count(p.window_start) INTO n_windows,n_before
   FROM public.fn_accounting_close_windows(q.period_start,q.period_end) w
   LEFT JOIN public.accounting_close_partials p ON p.kind='round2_'||q.scope_kind||'_window' AND p.union_id=q.scope_id
    AND p.period_start=q.period_start AND p.period_end=q.period_end AND p.window_start=w.window_start AND p.window_end=w.window_end
    AND p.computed_at>=q.period_end AND p.computed_at>clock_timestamp()-interval '12 hours';
  CONTINUE WHEN n_windows=0 OR n_before=n_windows;
  -- The advance stops 120 s after its attempt began and a minute before the
  -- statement ends: begin it so both points are the statement's minute.
  PERFORM set_config('app.weekly_accounting_scope_deadline',(stmt_stop-interval '120 seconds'+budget)::text,true);
  BEGIN
   PERFORM public.fn_settle_accounting_commission_advance(q.scope_kind,q.scope_id,q.period_start,q.period_end);
  EXCEPTION WHEN OTHERS THEN
   -- A window this read cannot prove is left to the book's own attempt,
   -- which refuses it as it always has.
   GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT;
  END;
  SELECT count(p.window_start) INTO n_after
   FROM public.fn_accounting_close_windows(q.period_start,q.period_end) w
   JOIN public.accounting_close_partials p ON p.kind='round2_'||q.scope_kind||'_window' AND p.union_id=q.scope_id
    AND p.period_start=q.period_start AND p.period_end=q.period_end AND p.window_start=w.window_start AND p.window_end=w.window_end
    AND p.computed_at>=q.period_end AND p.computed_at>clock_timestamp()-interval '12 hours';
  advanced:=advanced OR n_after>n_before;
  done:=done||jsonb_build_array(jsonb_build_object('scope_kind',q.scope_kind,'scope_id',q.scope_id,
   'period_start',q.period_start,'period_end',q.period_end,'windows',n_windows,'fresh_before',n_before,
   'fresh_after',n_after,'error',v_msg));
  v_msg:=NULL;
 END LOOP;
 PERFORM set_config('app.weekly_accounting_scope_deadline',saved_deadline,true);
 IF NOT advanced THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('success',true,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
  'observed_at',clock_timestamp(),'detail','[]'::jsonb,'window_advance',done);
END
$function$;
REVOKE ALL ON FUNCTION public.fn_accounting_close_windows_advance_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_close_windows_advance_due() TO service_role;

-- Job 272's entry asks the advance first.
SELECT pg_temp.ca_close_clock_subst(
  'public.fn_union_settlement_cascade_due()',
  '719944c319cd935f5240326469d98f01', '4e48f73890bd1b928653327f3a0a388b',
  ARRAY[$o1$AS $function$
BEGIN
$o1$,
        $o2$ RETURN public.fn_process_weekly_accounting(NULL);
$o2$],
  ARRAY[$n1$AS $function$
DECLARE v_advance jsonb;
BEGIN
$n1$,
        $n2$ -- THE ROUND-2 WINDOWS ADVANCE ON THEIR OWN TICK (20261015181721): a book
 -- whose round-2 windows are all that is missing has them proved with the
 -- whole statement, and this tick visits no scope; otherwise as before.
 v_advance:=public.fn_accounting_close_windows_advance_due();
 IF v_advance IS NOT NULL THEN RETURN v_advance; END IF;
 RETURN public.fn_process_weekly_accounting(NULL);
$n2$]
);

COMMIT;
