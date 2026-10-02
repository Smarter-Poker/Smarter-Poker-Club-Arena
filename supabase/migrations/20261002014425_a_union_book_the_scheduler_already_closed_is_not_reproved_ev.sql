-- A union book the scheduler already closed is not re-proved every tick.
--
-- Midway's book 2026-09-21..28 closed at 2026-10-01 23:51Z. Cron job 272's
-- next tick (00:40Z, nothing due) then ran 20 minutes: the union stays
-- eligible from its settlement floor, and fn_process_weekly_accounting_scope
-- walks the floor week, proves its posted receipts (cheap) and then calls
-- fn_union_pnl_close_quality, which recomputes the whole week's P&L evidence
-- (about 18 minutes of reads) only to decide to skip a book that is already
-- paid. Every idle tick paid that again.
--
-- The close itself refuses to post without that same evidence being ready
-- (fn_prepare_accounting_week), and only a successful close writes the run
-- row as status 'complete'. So for a book whose run row is 'complete' (and
-- whose posted receipts, rounds, invoices and routed runs this same check
-- still proves), the evidence was already certified when it was paid; the
-- recomputation is skipped. A book without a complete run row is checked
-- exactly as before. The head-of-line rule is unchanged.
--
-- Also recorded here, so the repository matches production: cron job 272
-- (union-weekly-rakeback-close) runs at minute 40 with a 6600 s statement
-- timeout and a 100 minute scope budget. The union close measured about 68
-- minutes end to end on 2026-10-01; starting at :40 puts its money rounds
-- after the :55 maintenance break instead of inside it.
--
-- The CASE is parenthesised: PL/pgSQL reads an IF condition up to the first
-- bare THEN, so an unparenthesised CASE WHEN ... THEN ends the condition early
-- (the first install attempt, 2026-10-02 02:07Z, was refused with 42601 and
-- rolled back; nothing was applied).
--
-- @live-proof: position('A BOOK THIS SCHEDULER ALREADY CLOSED' in pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $mig$
DECLARE s regprocedure:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 d text;
 x text:=$n$        AND public.fn_union_pnl_close_quality(v_union.id,v_from,v_end)->>'status'='ready' THEN
        v_from:=v_end; CONTINUE;$n$;
 y text:=$n$        -- A BOOK THIS SCHEDULER ALREADY CLOSED (20261002) is not re-proved:
        -- its evidence was certified before it was paid, and only that close
        -- writes status 'complete'. Anything else is checked as before.
        AND (CASE WHEN EXISTS(SELECT 1 FROM public.union_accounting_runs q
                    WHERE q.union_id=v_union.id AND q.period_start=v_from AND q.period_end=v_end
                      AND q.status='complete')
             THEN true
             ELSE public.fn_union_pnl_close_quality(v_union.id,v_from,v_end)->>'status'='ready' END) THEN
        v_from:=v_end; CONTINUE;$n$;
 j bigint;
BEGIN
 d:=pg_get_functiondef(s);
 IF md5(d)<>'36424fcc7345881172d24a1d3d2bf910' THEN RAISE EXCEPTION 'scope preimage %',md5(d); END IF;
 IF (length(d)-length(replace(d,x,'')))/length(x)<>1 THEN RAISE EXCEPTION 'scope needle count'; END IF;
 EXECUTE replace(d,x,y);
 IF position('A BOOK THIS SCHEDULER ALREADY CLOSED' in pg_get_functiondef(s))=0 THEN
  RAISE EXCEPTION 'scope postimage check failed';
 END IF;
 IF to_regnamespace('cron') IS NOT NULL THEN
  SELECT jobid INTO j FROM cron.job WHERE jobname='union-weekly-rakeback-close';
  IF j IS NULL THEN RAISE EXCEPTION 'cron job union-weekly-rakeback-close missing' USING ERRCODE='55000'; END IF;
  PERFORM cron.alter_job(j, schedule:='40 * * * *',
   command:='SET statement_timeout=''6600s''; SET app.weekly_accounting_attempt_budget=''1''; SET app.weekly_accounting_scope_budget=''100 minutes''; SELECT public.fn_union_settlement_cascade_due();',
   active:=true);
 END IF;
END
$mig$;
COMMIT;
