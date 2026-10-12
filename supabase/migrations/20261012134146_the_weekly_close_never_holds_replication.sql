-- 20261012134146_the_weekly_close_never_holds_replication.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE WEEKLY CLOSE NEVER HOLDS REPLICATION. Full account:
-- docs/changelog/2026-10-12-the-weekly-close-never-holds-replication.md.
--
-- WHAT BROKE. Supabase Realtime shuts its replication connection down when the
-- slot lags more than 50% of max_slot_wal_keep_size (3 GB, so 1.5 GB). The
-- slot's restart point cannot pass the first WAL record of the oldest open
-- transaction, and this database writes ~240-280 MB of WAL a minute (measured
-- 2026-10-12 13:15-13:20 UTC: 1,151 MB behind a 4 min 44 s old job 272
-- transaction). Any transaction that writes and stays open for ~5.3 minutes
-- takes DB broadcasts down for every player.
--
-- Job 272 (union-weekly-rakeback-close) gave itself up to 60 minutes:
-- statement_timeout 3600 s and a 50 minute scope budget whenever the week's
-- inventory checkpoint was unsealed or a recent tick timed out, 720 s and
-- 9 minutes otherwise. Measured from cron.job_run_details and the realtime log:
--   2026-10-12: ticks of 13:47, 16:49, 15:23, 17:17 and 24:22 minutes (09:10,
--     09:27, 10:10, 10:29, 11:15 UTC), each on the 3600 s budget because the
--     seal kept failing (54000 after ~10 minutes, fixed in 20261012113248) and
--     then visiting a scope in the same transaction. ReplicationSlotLagTooHigh
--     at 09:19:48, 09:39:56, 10:19:20, 11:23:45.
--   2026-10-06: ordinary 720 s ticks of 5:26, 5:45 and 12:00 minutes;
--     ReplicationSlotLagTooHigh at 16:33:21, 18:25:26, 19:35:41, each 5.3 to
--     8.3 minutes into one of them.
-- Ordinary ticks run 3 to 5 minutes because every attempt re-proves the P&L
-- steps that found a problem (the week 2026-10-05..12 has 31 invalid original
-- flows: fn_union_pnl_original_flow_evidence 76 s over 814,510 rows, plus the
-- closing boundary and the counts, ~175 s measured) before it reaches the
-- earned plan's two-hour windows (3.9 s each), so each tick proved ONE window.
--
-- WHAT CHANGES (no rate, payee, amount, rounding, routing, receipt, idempotency
-- key or refusal changes; the money rounds are untouched):
--  1. Job 272 sets statement_timeout 240 s and a 3 minute scope budget, always.
--     There is no larger fallback. 240 s is ~1.0-1.1 GB of WAL at the measured
--     rate, under the 1.5 GB cutoff.
--  2. fn_union_pnl_evidence_report proves the earned plan's two-hour windows
--     right after the opening boundary, before any step that can be re-proved,
--     and keeps a step that found a problem (boundaries, flows, touched
--     registrations, club rows) for ONE HOUR as '<kind>_problem'. A kept
--     problem is never certified and never pays; the report states the same
--     issues from the same value. Each attempt therefore proves at most one
--     long step, and the next continues.
--  3. fn_process_weekly_accounting_scope seals inside the bounded chunked tick
--     (it used to wait for the large budget), a failed seal ends a chunked
--     tick instead of going on to a scope in the same transaction, and a seal
--     or scope step that does not fit the tick raises a critical alert: there
--     is no larger budget to retry it with, so it is a step to split.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure))='929cc88e98cd027e821f871f8adbe935' AND md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))='01288c36118e1e26e7673fc71f155bf6' AND (SELECT md5(command)='b8be947fc591eeac63d2c194932fac66' AND schedule='*/5 * * * *' AND active FROM cron.job WHERE jobid=272) AND to_regprocedure('public.fn_accounting_close_problem(text,uuid,timestamptz,timestamptz)') IS NOT NULL)

BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. A step that found a problem is kept, for one hour, under its own kind.
ALTER TABLE public.accounting_close_certificates
  DROP CONSTRAINT accounting_close_certificates_kind_check,
  ADD CONSTRAINT accounting_close_certificates_kind_check CHECK (kind IN (
    'earned_plan','pnl_boundary','pnl_flows','pnl_touched','pnl_clubs',
    'pnl_boundary_problem','pnl_flows_problem','pnl_touched_problem','pnl_clubs_problem'));

CREATE FUNCTION public.fn_accounting_close_problem(p_kind text, p_union_id uuid, p_start timestamptz, p_end timestamptz)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $f$
 SELECT c.value FROM public.accounting_close_certificates c
  WHERE COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
    AND current_setting('app.accounting_close_memo',true)='on'
    AND c.kind=p_kind||'_problem' AND c.union_id=p_union_id AND c.period_start=p_start AND c.period_end=p_end
    AND c.certified_at>=p_end AND c.certified_at>clock_timestamp()-interval '1 hour'
$f$;
REVOKE ALL ON FUNCTION public.fn_accounting_close_problem(text,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_close_problem(text,uuid,timestamptz,timestamptz) TO service_role;
COMMENT ON FUNCTION public.fn_accounting_close_problem(text,uuid,timestamptz,timestamptz) IS
  'Weekly close that never holds replication (20261012): the kept value of a union P&L step that found a problem, inside a chunked union close attempt only, for one hour after it was proved. Never certified, never pays: the report states its issues exactly as a fresh proof would. NULL everywhere else.';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'WEEKLY_CLOSE_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $mig$
DECLARE
 s regprocedure; d text;
 before_job cron.job%ROWTYPE; after_job jsonb; command_after text;
BEGIN
 -- 2. The union P&L evidence report: windows first, problems kept for an hour.
 s:='public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'ac28cf989d8d145aa0cfb2232fbf4041' THEN RAISE EXCEPTION 'evidence report preimage %',md5(d) USING ERRCODE='55000'; END IF;
 d:=pg_temp.ca_swap_once(d,$a$ -- steps. A step that found a problem is never kept: it is proved again.
$a$,$r$ -- steps. A step that found a problem is kept for ONE HOUR (20261012), as
 -- '<kind>_problem' (fn_accounting_close_problem): it is never certified and
 -- never pays, its issues are reported exactly as before, and an attempt
 -- re-proves it once that hour has passed. Re-proving every problem step on
 -- every attempt is what held job 272's transactions for 3 to 5 minutes.
$r$,'report problem comment');
 d:=pg_temp.ca_swap_once(d,$a$ IF public.fn_accounting_union_earned_plan_advance(p_union_id,p_start,p_end) IS FALSE THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
$a$,$r$ -- (THE WINDOWS GO FIRST, 20261012: the plan's windows are proved above,
 -- right after the opening boundary, before any step that can be re-proved.)
$r$,'report advance moved out');
 d:=pg_temp.ca_swap_once(d,$a$ v_open:=public.fn_accounting_close_certificate('pnl_boundary',p_union_id,p_start,p_start);
 IF v_open IS NULL THEN
  v_open:=public.fn_union_pnl_boundary(p_union_id,p_start);
  IF v_open->>'status'='ready' THEN PERFORM public.fn_accounting_close_certify('pnl_boundary',p_union_id,p_start,p_start,v_open); END IF;
 END IF;
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
$a$,$r$ v_open:=COALESCE(public.fn_accounting_close_certificate('pnl_boundary',p_union_id,p_start,p_start),
  public.fn_accounting_close_problem('pnl_boundary',p_union_id,p_start,p_start));
 IF v_open IS NULL THEN
  v_open:=public.fn_union_pnl_boundary(p_union_id,p_start);
  IF v_open->>'status'='ready' THEN PERFORM public.fn_accounting_close_certify('pnl_boundary',p_union_id,p_start,p_start,v_open);
  ELSE PERFORM public.fn_accounting_close_certify('pnl_boundary_problem',p_union_id,p_start,p_start,v_open); END IF;
 END IF;
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
 -- THE WINDOWS GO FIRST (20261012): the plan's two-hour windows (seconds each)
 -- are proved before the steps below, so an attempt that would otherwise
 -- spend its budget re-reading the boundaries and flows proves windows
 -- instead. Outside a chunked close the advance is NULL and nothing changes.
 IF public.fn_accounting_union_earned_plan_advance(p_union_id,p_start,p_end) IS FALSE THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
$r$,'report opening boundary');
 d:=pg_temp.ca_swap_once(d,$a$ v_close:=public.fn_accounting_close_certificate('pnl_boundary',p_union_id,p_end,p_end);
 IF v_close IS NULL THEN
  v_close:=public.fn_union_pnl_boundary(p_union_id,p_end);
  IF v_close->>'status'='ready' THEN PERFORM public.fn_accounting_close_certify('pnl_boundary',p_union_id,p_end,p_end,v_close); END IF;
 END IF;
$a$,$r$ v_close:=COALESCE(public.fn_accounting_close_certificate('pnl_boundary',p_union_id,p_end,p_end),
  public.fn_accounting_close_problem('pnl_boundary',p_union_id,p_end,p_end));
 IF v_close IS NULL THEN
  v_close:=public.fn_union_pnl_boundary(p_union_id,p_end);
  IF v_close->>'status'='ready' THEN PERFORM public.fn_accounting_close_certify('pnl_boundary',p_union_id,p_end,p_end,v_close);
  ELSE PERFORM public.fn_accounting_close_certify('pnl_boundary_problem',p_union_id,p_end,p_end,v_close); END IF;
 END IF;
$r$,'report closing boundary');
 d:=pg_temp.ca_swap_once(d,$a$ v_cert:=public.fn_accounting_close_certificate('pnl_flows',p_union_id,p_start,p_end);
$a$,$r$ v_cert:=COALESCE(public.fn_accounting_close_certificate('pnl_flows',p_union_id,p_start,p_end),
  public.fn_accounting_close_problem('pnl_flows',p_union_id,p_start,p_end));
$r$,'report flows read');
 d:=pg_temp.ca_swap_once(d,$a$  IF v_bad=0 THEN PERFORM public.fn_accounting_close_certify('pnl_flows',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows)); END IF;
$a$,$r$  IF v_bad=0 THEN PERFORM public.fn_accounting_close_certify('pnl_flows',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows));
  ELSE PERFORM public.fn_accounting_close_certify('pnl_flows_problem',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows)); END IF;
$r$,'report flows keep');
 d:=pg_temp.ca_swap_once(d,$a$ v_cert:=public.fn_accounting_close_certificate('pnl_touched',p_union_id,p_start,p_end);
$a$,$r$ v_cert:=COALESCE(public.fn_accounting_close_certificate('pnl_touched',p_union_id,p_start,p_end),
  public.fn_accounting_close_problem('pnl_touched',p_union_id,p_start,p_end));
$r$,'report touched read');
 d:=pg_temp.ca_swap_once(d,$a$  IF v_bad=0 THEN PERFORM public.fn_accounting_close_certify('pnl_touched',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad)); END IF;
$a$,$r$  IF v_bad=0 THEN PERFORM public.fn_accounting_close_certify('pnl_touched',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad));
  ELSE PERFORM public.fn_accounting_close_certify('pnl_touched_problem',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad)); END IF;
$r$,'report touched keep');
 d:=pg_temp.ca_swap_once(d,$a$ v_cert:=public.fn_accounting_close_certificate('pnl_clubs',p_union_id,p_start,p_end);
$a$,$r$ v_cert:=COALESCE(public.fn_accounting_close_certificate('pnl_clubs',p_union_id,p_start,p_end),
  public.fn_accounting_close_problem('pnl_clubs',p_union_id,p_start,p_end));
$r$,'report clubs read');
 d:=pg_temp.ca_swap_once(d,$a$    'cash_reconciled',v_cash_reconciled,'rows',v_rows,'cash_rake',v_cash_rake,'hands',v_hands,'accepted_rake',v_accepted_rake));
  END IF;
$a$,$r$    'cash_reconciled',v_cash_reconciled,'rows',v_rows,'cash_rake',v_cash_rake,'hands',v_hands,'accepted_rake',v_accepted_rake));
  ELSE
   PERFORM public.fn_accounting_close_certify('pnl_clubs_problem',p_union_id,p_start,p_end,jsonb_build_object('clubs',v_clubs,
    'cash_reconciled',v_cash_reconciled,'rows',v_rows,'cash_rake',v_cash_rake,'hands',v_hands,'accepted_rake',v_accepted_rake));
  END IF;
$r$,'report clubs keep');
 IF md5(d)<>'929cc88e98cd027e821f871f8adbe935' THEN RAISE EXCEPTION 'evidence report postimage %',md5(d) USING ERRCODE='55000'; END IF;
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'evidence report installed text differs' USING ERRCODE='55000'; END IF;

 -- 3. The scheduler: the seal runs in the bounded tick, a failed seal ends it,
 --    and a scope or seal step that does not fit the tick is a critical alert.
 s:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'3cb890191c1da58d621f108934d1116e' THEN RAISE EXCEPTION 'scheduler preimage %',md5(d) USING ERRCODE='55000'; END IF;
 d:=pg_temp.ca_swap_once(d,$a$    -- when this tick's budget can hold the seal.
    IF v_tick_budget_large AND to_regprocedure('public.fn_union_pnl_inventory_checkpoint_due()') IS NOT NULL
$a$,$r$    -- when this tick's budget can hold the seal. A chunked tick (job 272)
    -- seals six hours at a time within its own bounded statement (20261012):
    -- job 272 no longer has a larger budget to wait for.
    IF (v_tick_budget_large OR v_chunked) AND to_regprocedure('public.fn_union_pnl_inventory_checkpoint_due()') IS NOT NULL
$r$,'scope seal gate');
 d:=pg_temp.ca_swap_once(d,$a$          RETURN jsonb_build_object('success',false,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
            'observed_at',clock_timestamp(),'detail','[]'::jsonb,'error','inventory_checkpoint_seal_exceeded_the_tick_budget');
$a$,$r$          -- A SEAL STEP THAT DOES NOT FIT THE TICK IS LOUD (20261012): there is no
          -- larger budget to retry it with, so it is a step to split, not to wait on.
          IF v_chunked AND NOT EXISTS(SELECT 1 FROM public.financial_alerts a WHERE a.source='union_accounting_scheduler'
            AND a.message='A weekly inventory seal step did not fit the bounded close tick' AND NOT COALESCE(a.resolved,false)
            AND a.created_at>clock_timestamp()-interval '1 hour') THEN
            INSERT INTO public.financial_alerts(source,severity,message,context)
            VALUES('union_accounting_scheduler','critical','A weekly inventory seal step did not fit the bounded close tick',
              jsonb_build_object('statement_timeout',current_setting('statement_timeout')));
          END IF;
          RETURN jsonb_build_object('success',false,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
            'observed_at',clock_timestamp(),'detail','[]'::jsonb,'error','inventory_checkpoint_seal_exceeded_the_tick_budget');
$r$,'scope seal timeout alert');
 d:=pg_temp.ca_swap_once(d,$a$          VALUES('union_accounting_scheduler','critical','The weekly original inventory checkpoint could not be sealed',
            jsonb_build_object('error',v_msg,'sqlstate',v_state,'detail',v_detail));
      END;
$a$,$r$          VALUES('union_accounting_scheduler','critical','The weekly original inventory checkpoint could not be sealed',
            jsonb_build_object('error',v_msg,'sqlstate',v_state,'detail',v_detail));
          -- A FAILED SEAL ENDS A CHUNKED TICK (20261012): the 2026-10-12 seal
          -- failures ran ~10 minutes each and the tick then went on to visit a
          -- scope in the same transaction (13 to 24 minutes in all).
          IF v_chunked THEN
            RETURN jsonb_build_object('success',false,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
              'observed_at',clock_timestamp(),'detail','[]'::jsonb,'error','inventory_checkpoint_seal_failed');
          END IF;
      END;
$r$,'scope seal failure ends the tick');
 d:=pg_temp.ca_swap_once(d,$a$          AND (v_scope_outcome='error' OR v_tick_budget_large) THEN
$a$,$r$          AND (v_scope_outcome='error' OR v_tick_budget_large OR v_chunked) THEN
$r$,'scope visit timeout is loud');
 IF md5(d)<>'01288c36118e1e26e7673fc71f155bf6' THEN RAISE EXCEPTION 'scheduler postimage %',md5(d) USING ERRCODE='55000'; END IF;
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'scheduler installed text differs' USING ERRCODE='55000'; END IF;

 -- 4. Job 272: one bounded budget, never the 3600 s / 50 minute fallback.
 SELECT * INTO STRICT before_job FROM cron.job WHERE jobname='union-weekly-rakeback-close';
 IF before_job.jobid<>272 OR before_job.active IS DISTINCT FROM true OR before_job.schedule<>'*/5 * * * *'
   OR md5(before_job.command)<>'a532167f5019f181dd10e48102e40cfc' THEN
   RAISE EXCEPTION 'weekly close cron is not the pinned preimage' USING ERRCODE='55000';
 END IF;
 IF (length(before_job.command)-length(replace(before_job.command,$a$AS big) x; $a$,'')))/length($a$AS big) x; $a$)<>1 THEN
   RAISE EXCEPTION 'weekly close cron budget anchor count differs' USING ERRCODE='55000';
 END IF;
 command_after:=$r$SELECT set_config('statement_timeout','240s',false),set_config('app.weekly_accounting_attempt_budget','1',false),set_config('app.weekly_accounting_scope_budget','3 minutes',false),set_config('app.weekly_accounting_chunked','on',false); $r$||split_part(before_job.command,$a$AS big) x; $a$,2);
 IF md5(command_after)<>'b8be947fc591eeac63d2c194932fac66' THEN
   RAISE EXCEPTION 'weekly close cron postimage %',md5(command_after) USING ERRCODE='55000';
 END IF;
 PERFORM cron.alter_job(before_job.jobid,command:=command_after);
 SELECT to_jsonb(j) INTO STRICT after_job FROM cron.job j WHERE jobid=before_job.jobid;
 IF after_job IS DISTINCT FROM jsonb_set(to_jsonb(before_job),'{command}',to_jsonb(command_after)) THEN
   RAISE EXCEPTION 'weekly close cron changed beyond its command' USING ERRCODE='55000';
 END IF;
END
$mig$;

COMMIT;
