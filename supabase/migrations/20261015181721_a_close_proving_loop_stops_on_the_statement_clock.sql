-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_settle_accounting_commission_advance(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='e91c40770c8de772df2a25bbce016ef5' AND md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_advance(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='2c3f36a8920d70b225c887c1287a567b')
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
-- THE FIX, in the two functions that start the work: each computes, once,
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
-- Nothing here pays, clears or rewrites a row: partials are the close's own
-- cache, and the money rounds are untouched.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. Each
-- live text must hash to today's measured md5, each anchor must occur exactly
-- once, and each result must hash to the postimage derived read-only on
-- production with replace() (2026-10-15: e91c40770c8de772df2a25bbce016ef5 and
-- 2c3f36a8920d70b225c887c1287a567b). Owner, SECURITY DEFINER, volatility, proconfig and grants
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

COMMIT;
