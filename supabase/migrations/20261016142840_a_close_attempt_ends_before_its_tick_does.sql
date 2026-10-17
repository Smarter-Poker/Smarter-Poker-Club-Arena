-- 20261016142749_a_close_attempt_ends_before_its_tick_does.sql
--
-- Reserved as 20261016142749 by scripts/new-migration.mjs; renamed to the
-- version the Supabase MCP recorded when it was applied (20261016142840).
--
-- A CLOSE ATTEMPT ENDS BEFORE ITS TICK DOES (2026-10-16)
--
-- What happened. Job 272 runs each tick under a 240 s statement_timeout (the
-- Realtime replication bound, 20261012134146). Inside a tick it may visit a
-- standalone club scope first and the union scope after it. Each visit calls
-- fn_weekly_accounting_attempt_begin, which set the attempt's deadline to
-- clock_timestamp() + the scope budget (3 minutes) - measured from when the
-- visit STARTS, not from the tick. A union visit that began two minutes into
-- the tick (2026-10-16 14:07 and 14:12) therefore believed it had until 5:07,
-- the bounded steps it runs (the split recompute's 90 second rule, the P&L
-- warm stop) never stopped in time, and the statement was cancelled at 4:00:
-- the whole attempt rolled back, its parts with it, and the next tick began
-- from the same place (financial_alerts weekly_scope_statement_budget_exhausted,
-- 14:05 and 14:10 UTC). The three advance functions already measured their
-- budgets from the statement's own end; the attempt did not.
--
-- The fix. The attempt's deadline is the earlier of its scope budget and 60
-- seconds before the statement's own timeout. A visit that starts late still
-- does at least one kept step (each bounded step already guarantees one per
-- attempt) and then commits it, instead of being cancelled with nothing kept.
-- With no statement_timeout (0), the deadline is unchanged.
--
-- @live-proof: (SELECT strpos(pg_get_functiondef('public.fn_weekly_accounting_attempt_begin(boolean)'::regprocedure), 'statement_timestamp()') > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_weekly_accounting_attempt_begin(boolean)'::regprocedure))
     <> 'bdbe82fff199127130d2f9320236974c' THEN
    RAISE EXCEPTION 'Unexpected preimage of fn_weekly_accounting_attempt_begin';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_weekly_accounting_attempt_begin(p_memo boolean)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
 v_deadline timestamptz := clock_timestamp()+COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 v_timeout interval := NULLIF(current_setting('statement_timeout'),'0')::interval;
BEGIN
 -- One close attempt of one book: its deadline, and (for a union) the
 -- earned-plan memo, both transaction-local and cleared by attempt_end.
 -- A CLOSE ATTEMPT ENDS BEFORE ITS TICK DOES (20261016142749): never later
 -- than 60 seconds before this statement's own timeout, so a visit that
 -- starts late keeps a step instead of being cancelled with none.
 IF v_timeout IS NOT NULL THEN
  v_deadline:=LEAST(v_deadline,statement_timestamp()+v_timeout-interval '60 seconds');
 END IF;
 PERFORM set_config('app.weekly_accounting_scope_deadline',v_deadline::text,true);
 PERFORM set_config('app.accounting_close_memo',CASE WHEN p_memo THEN 'on' ELSE '' END,true);
 PERFORM set_config('app.accounting_earned_plan_memo','',true);
 PERFORM set_config('app.union_pnl_evidence_memo','',true);
 PERFORM set_config('app.accounting_cash_refusal_memo','',true);
 PERFORM set_config('app.accounting_close_certified','',true);
END $function$;

COMMIT;
