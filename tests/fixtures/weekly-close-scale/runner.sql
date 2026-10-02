-- Runs the weekly close stages this change touches, each in its own
-- subtransaction, and records what each returned or raised. Round 2 is run
-- twice so the paid-scope replay is compared as well.
CREATE TABLE IF NOT EXISTS public.wcs_out(ord int,step text,ok boolean,result jsonb,sqlstate text,message text);
CREATE OR REPLACE FUNCTION public.wcs_step(p_ord int,p_step text,p_sql text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; st text; msg text;
BEGIN
 BEGIN
  EXECUTE p_sql INTO r;
  INSERT INTO public.wcs_out VALUES(p_ord,p_step,true,r,NULL,NULL);
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st=RETURNED_SQLSTATE,msg=MESSAGE_TEXT;
  INSERT INTO public.wcs_out VALUES(p_ord,p_step,false,NULL,st,msg);
 END;
END $$;
CREATE OR REPLACE FUNCTION public.wcs_run(p_kind text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE sid uuid:=CASE WHEN p_kind='union' THEN wcs_u('union') ELSE wcs_u('club') END;
 w text:=quote_literal(sid)||'::uuid,''2026-08-31 07:00+00''::timestamptz,''2026-09-07 07:00+00''::timestamptz';
BEGIN
 PERFORM public.wcs_step(1,'round2','SELECT public.fn_settle_accounting_commission_stage('||quote_literal(p_kind)||','||w||')');
 PERFORM public.wcs_step(2,'round2_replay','SELECT public.fn_settle_accounting_commission_stage('||quote_literal(p_kind)||','||w||')');
 PERFORM public.wcs_step(3,'round3','SELECT public.fn_settle_accounting_rakeback_stage('||quote_literal(p_kind)||','||w||')');
 PERFORM public.wcs_step(4,'round3_replay','SELECT public.fn_settle_accounting_rakeback_stage('||quote_literal(p_kind)||','||w||')');
 PERFORM public.wcs_step(5,'assert_cash','SELECT to_jsonb(public.fn_assert_cash_commission_period('||CASE WHEN p_kind='union' THEN quote_literal(sid)||'::uuid,NULL' ELSE 'NULL,'||quote_literal(sid)||'::uuid' END||',''2026-08-31 07:00+00'',''2026-09-07 07:00+00'')::text)');
 PERFORM public.wcs_step(6,'statement','SELECT public.fn_club_weekly_accounting_summary('||quote_literal(wcs_u('sp'))||'::uuid)');
END $$;
-- Row ids the stages generate are drawn from one sequence restarted per
-- scenario, so both runs of a scenario name their rows identically.
CREATE SEQUENCE IF NOT EXISTS public.wcs_seq;
CREATE OR REPLACE FUNCTION public.wcs_next_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT md5('wcsid:'||nextval('public.wcs_seq'))::uuid $$;
ALTER TABLE public.chip_ledger ALTER COLUMN id SET DEFAULT public.wcs_next_uuid();
ALTER TABLE public.wallet_transactions ALTER COLUMN id SET DEFAULT public.wcs_next_uuid();
ALTER TABLE public.rakeback_period_payouts ALTER COLUMN id SET DEFAULT public.wcs_next_uuid();
ALTER TABLE public.settlement_invoices ALTER COLUMN id SET DEFAULT public.wcs_next_uuid();
ALTER TABLE public.social_messages ALTER COLUMN id SET DEFAULT public.wcs_next_uuid();
ALTER TABLE public.notifications ALTER COLUMN id SET DEFAULT public.wcs_next_uuid();
ALTER TABLE public.agent_commission_settlements ALTER COLUMN id SET DEFAULT public.wcs_next_uuid();
ALTER TABLE public.agent_commissions ALTER COLUMN id SET DEFAULT public.wcs_next_uuid();
