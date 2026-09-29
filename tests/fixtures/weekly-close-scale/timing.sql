-- One book, each stage timed with its page touches (shared hit + read,
-- including everything the function reads through SPI), inside a rolled-back
-- transaction so both versions see the same book.
\pset tuples_only on
\pset format unaligned
BEGIN;
CREATE TEMP TABLE wcs_t(stage text,ms numeric,pages bigint) ON COMMIT DROP;
CREATE OR REPLACE FUNCTION pg_temp.wcs_time(p_stage text,p_sql text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t0 timestamptz:=clock_timestamp(); plan text; pages bigint:=0; m text[];
BEGIN
 FOR plan IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT TEXT) '||p_sql LOOP
  IF pages=0 AND plan ~ 'Buffers: shared' THEN
   m:=regexp_match(plan,'hit=(\d+)'); pages:=pages+COALESCE(m[1]::bigint,0);
   m:=regexp_match(plan,'read=(\d+)'); pages:=pages+COALESCE(m[1]::bigint,0);
  END IF;
 END LOOP;
 INSERT INTO wcs_t VALUES(p_stage,round(extract(epoch FROM clock_timestamp()-t0)*1000),pages);
END $$;
SELECT pg_temp.wcs_time('assert_cash',$q$SELECT public.fn_assert_cash_commission_period(NULL,wcs_u('club'),'2026-08-31 07:00+00','2026-09-07 07:00+00')$q$);
SELECT pg_temp.wcs_time('round2',$q$SELECT public.fn_settle_accounting_commission_stage('club',wcs_u('club'),'2026-08-31 07:00+00','2026-09-07 07:00+00')$q$);
SELECT pg_temp.wcs_time('round3',$q$SELECT public.fn_settle_accounting_rakeback_stage('club',wcs_u('club'),'2026-08-31 07:00+00','2026-09-07 07:00+00')$q$);
SELECT pg_temp.wcs_time('statement',$q$SELECT public.fn_club_weekly_accounting_summary(wcs_u('sp'))$q$);
SELECT 'TIMING '||:'tag'||' '||stage||' ms='||ms||' pages='||pages FROM wcs_t;
SELECT 'BOOK sources='||(SELECT count(*) FROM public.accounting_payable_earning_sources)||' commission_rows='||(SELECT count(*) FROM public.agent_commissions)||' deposits='||(SELECT count(*) FROM public.accounting_cash_bank_receipts);
ROLLBACK;
