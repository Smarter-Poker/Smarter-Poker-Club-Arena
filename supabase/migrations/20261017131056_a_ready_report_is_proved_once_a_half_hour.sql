-- 20261017131056_a_ready_report_is_proved_once_a_half_hour
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-17 13:10:56 UTC.
--
-- A READY REPORT IS PROVED ONCE A HALF HOUR, NOT ONCE A TICK (2026-10-17)
--
-- The 2026-10-05 Midway union close (fade0000) paid round 1 at 2026-10-16
-- 21:15 and nothing since: rounds 2 (club to agents), 3 (agents to players)
-- and 4 (invoices) are unpaid. Measured read-only on 2026-10-17 (job 272,
-- cron.job_run_details and the functions it runs):
--   * In 24 h, 104 ticks hit the 240 s statement timeout and 4 more raised
--     weekly_scope_time_budget_exhausted at the deadline just before
--     fn_union_settlement_cascade, at 3m10s-3m19s against a 3m00s deadline.
--     The only progress came from certificate re-proofs and hand-run attempts.
--   * With every P&L certificate fresh, preparation still re-reads what no
--     certificate covers, on every attempt and usually cold (shared_buffers is
--     16 GB against a database of several hundred GB). The report's
--     award-owner check alone is >60 s cold (201,753 credits, 1.82M
--     buffers). The fn_cash_source_refusals_for_period check is 29 s cold.
--     The per-club freshness checks are 14-17 s. Round 2 is then left about
--     60 s it cannot use.
--   * The chunked close already hands a report proved earlier IN THE SAME
--     attempt to every later caller, through app.union_pnl_evidence_memo.
--     That memo dies with the attempt, so the next attempt proved it again.
--
-- WHAT CHANGES. No rate, payee, amount, rounding, routing, receipt,
-- idempotency key, refusal or certificate changes; no sealed source moves (the
-- original inventory matcher reads neither function touched here):
--   1. accounting_close_report_receipts keeps, per union and closed week, the
--      last READY report (report_version 1, status ready, basis_certified,
--      no issues: exactly fn_union_pnl_close_quality's test), with the
--      original inventory generation it was proved under.
--   2. fn_process_weekly_accounting_scope, inside a chunked union attempt
--      only, seeds the report's own memo from that receipt when it is under 30
--      minutes old and of the current generation, before preparation; every
--      reader of the report in the attempt then gets it at once. An attempt
--      that proved the report itself (no seed) keeps it, after preparation
--      and OUTSIDE the money block, so it survives that attempt's deadline.
--      A seeded attempt never refreshes the receipt, so the report is proved
--      again at least every 30 minutes, under the 12-hour certificates it
--      rests on. Money rounds still re-verify their own certificates.
--
-- Verified on native Postgres: keep then seed restores the memo under the
-- report's exact key; a different generation, an unchunked session, a receipt
-- over 30 minutes old and a warming report are all refused.
--
-- GUARDS: refuses in the break window; the scope function substitution pins
-- the live preimage (6bd020f0..., the postimage of 20261017121500) and the
-- postimage (9d5ede8a..., derived read-only on production with replace()), each
-- anchor exactly once; owner, SECURITY DEFINER, configuration and ACL are
-- proven unchanged; the readback must be the exact postimage.
--
-- NO SCHEDULER LOCK. A tick already running keeps the body it started with;
-- only the new body calls the two new helpers, and they commit in this same
-- transaction. So the install neither waits on job 272 nor fails when a tick
-- holds union-accounting-scheduler.
-- @live-proof: md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)) = '9d5ede8aa77afecfb993e305a755175a'
-- @live-proof: to_regclass('public.accounting_close_report_receipts') IS NOT NULL

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'READY_REPORT_RECEIPT_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
  IF md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))
       NOT IN ('6bd020f058339c34e51a88717cf4fbd6', '9d5ede8aa77afecfb993e305a755175a') THEN
    RAISE EXCEPTION 'READY_REPORT_RECEIPT_REFUSED: unexpected weekly scope body';
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.accounting_close_report_receipts (
  union_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  generation text NOT NULL,
  report jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (union_id, period_start, period_end)
);
ALTER TABLE public.accounting_close_report_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.accounting_close_report_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.accounting_close_report_receipts TO service_role;
COMMENT ON TABLE public.accounting_close_report_receipts IS
  'One ready union P&L evidence report per closed week, kept by the chunked weekly close for 30 minutes so the next attempt does not prove it again (20261017131056).';

-- The report's own generation and memo key, exactly as fn_union_pnl_evidence_report
-- computes them (its v_generation and v_memo_key).
CREATE OR REPLACE FUNCTION public.fn_accounting_close_report_memo_key(p_union_id uuid, p_start timestamptz, p_end timestamptz, OUT generation text, OUT memo_key text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
BEGIN
 IF p_union_id='fade0000-0000-0000-0000-000000000001'::uuid AND p_end>='2026-10-12 07:00:00Z'::timestamptz THEN
  generation:=COALESCE(smarter_private.original_inventory_basis_generation(),'original-inventory-245:unqualified');
 END IF;
 memo_key:=CASE WHEN generation='original-inventory-245:unqualified' THEN NULL
   ELSE COALESCE(generation||'|','')||p_union_id::text||'|'||p_start::text||'|'||p_end::text END;
END $function$;

-- True only for a report the close may pay from: the same test
-- fn_union_pnl_close_quality applies.
CREATE OR REPLACE FUNCTION public.fn_accounting_close_report_is_ready(p_report jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
 SELECT jsonb_typeof(p_report)='object'
    AND p_report->'report_version'='1'::jsonb
    AND p_report->>'status'='ready'
    AND p_report->'basis_certified'='true'::jsonb
    AND p_report->'issues'='[]'::jsonb
$function$;

-- Hand this close attempt a report it proved ready in the last 30 minutes,
-- through the report's own memo. Only inside a chunked close attempt
-- (fn_weekly_accounting_attempt_begin(true) set the memo on).
CREATE OR REPLACE FUNCTION public.fn_accounting_close_report_seed(p_union_id uuid, p_start timestamptz, p_end timestamptz)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE k record; v_report jsonb;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('app.accounting_close_memo',true) IS DISTINCT FROM 'on' THEN
  RETURN false;
 END IF;
 SELECT * INTO k FROM public.fn_accounting_close_report_memo_key(p_union_id,p_start,p_end);
 IF k.memo_key IS NULL THEN RETURN false; END IF;
 SELECT r.report INTO v_report FROM public.accounting_close_report_receipts r
  WHERE r.union_id=p_union_id AND r.period_start=p_start AND r.period_end=p_end
    AND r.generation=COALESCE(k.generation,'')
    AND r.computed_at>=p_end
    AND r.computed_at>clock_timestamp()-interval '30 minutes';
 IF v_report IS NULL OR NOT public.fn_accounting_close_report_is_ready(v_report) THEN RETURN false; END IF;
 PERFORM set_config('app.union_pnl_evidence_memo',
   (COALESCE(NULLIF(current_setting('app.union_pnl_evidence_memo',true),'')::jsonb,'{}'::jsonb)
    ||jsonb_build_object(k.memo_key,v_report))::text,true);
 RETURN true;
END $function$;

-- Keep the report this attempt proved, when it is ready, for the next attempt.
CREATE OR REPLACE FUNCTION public.fn_accounting_close_report_keep(p_union_id uuid, p_start timestamptz, p_end timestamptz)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE k record; v_memo jsonb;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('app.accounting_close_memo',true) IS DISTINCT FROM 'on' THEN
  RETURN false;
 END IF;
 SELECT * INTO k FROM public.fn_accounting_close_report_memo_key(p_union_id,p_start,p_end);
 IF k.memo_key IS NULL THEN RETURN false; END IF;
 v_memo:=NULLIF(current_setting('app.union_pnl_evidence_memo',true),'')::jsonb;
 IF v_memo IS NULL OR NOT (v_memo ? k.memo_key) OR NOT public.fn_accounting_close_report_is_ready(v_memo->k.memo_key) THEN
  RETURN false;
 END IF;
 INSERT INTO public.accounting_close_report_receipts(union_id,period_start,period_end,generation,report,computed_at)
 VALUES (p_union_id,p_start,p_end,COALESCE(k.generation,''),v_memo->k.memo_key,clock_timestamp())
 ON CONFLICT (union_id,period_start,period_end) DO UPDATE
  SET generation=EXCLUDED.generation, report=EXCLUDED.report, computed_at=EXCLUDED.computed_at;
 RETURN true;
END $function$;

REVOKE ALL ON FUNCTION public.fn_accounting_close_report_memo_key(uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_accounting_close_report_is_ready(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_accounting_close_report_seed(uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_accounting_close_report_keep(uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_close_report_memo_key(uuid,timestamptz,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_accounting_close_report_is_ready(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_accounting_close_report_seed(uuid,timestamptz,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_accounting_close_report_keep(uuid,timestamptz,timestamptz) TO service_role;

DO $install$
DECLARE
  c_sig constant text := 'public.fn_process_weekly_accounting_scope(uuid,uuid)';
  c_old1 constant text := $o1$      PERFORM public.fn_weekly_accounting_attempt_begin(true);
      -- Keep a refused preparation request durable outside the wallet rollback.
      BEGIN
        v_preparation:=public.fn_prepare_accounting_week(v_union.id,NULL,v_from,v_end);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
        v_preparation:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
      END;
$o1$;
  c_new1 constant text := $n1$      PERFORM public.fn_weekly_accounting_attempt_begin(true);
      -- A READY REPORT IS PROVED ONCE A HALF HOUR, NOT ONCE A TICK (2026-10-17).
      -- With every P&L certificate fresh, an attempt still spent ~3 minutes of
      -- uncached report reads before the cascade, met the deadline before
      -- round 2, and was rolled back: 104 timeouts in a day and no money round
      -- for 13 hours. A report this close proved ready in the last 30 minutes,
      -- under the same original inventory generation, is handed to this
      -- attempt through the report's own memo; one it proves now is kept,
      -- outside the money block, for the next attempt.
      v_report_seeded := v_chunked AND public.fn_accounting_close_report_seed(v_union.id,v_from,v_end);
      -- Keep a refused preparation request durable outside the wallet rollback.
      BEGIN
        v_preparation:=public.fn_prepare_accounting_week(v_union.id,NULL,v_from,v_end);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
        v_preparation:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
      END;
      IF v_chunked AND NOT v_report_seeded THEN
        PERFORM public.fn_accounting_close_report_keep(v_union.id,v_from,v_end);
      END IF;
$n1$;
  c_old2 constant text := $o2$  v_now timestamptz := clock_timestamp();
  v_seal jsonb;
$o2$;
  c_new2 constant text := $n2$  v_now timestamptz := clock_timestamp();
  v_seal jsonb;
  v_report_seeded boolean := false;
$n2$;
  v_oid oid := to_regprocedure(c_sig);
  v_def text; v_new text;
  v_owner oid; v_secdef boolean; v_config text[]; v_acl text;
BEGIN
  IF current_user <> 'postgres' OR v_oid IS NULL THEN
    RAISE EXCEPTION 'ready report: owner/target mismatch';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) = '9d5ede8aa77afecfb993e305a755175a' THEN
    RETURN;
  END IF;
  IF md5(v_def) <> '6bd020f058339c34e51a88717cf4fbd6' THEN
    RAISE EXCEPTION 'ready report: unexpected live body %', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, c_old1, ''))) / length(c_old1) <> 1
     OR (length(v_def) - length(replace(v_def, c_old2, ''))) / length(c_old2) <> 1 THEN
    RAISE EXCEPTION 'ready report: an anchor is not exactly once';
  END IF;
  v_new := replace(replace(v_def, c_old1, c_new1), c_old2, c_new2);
  IF md5(v_new) <> '9d5ede8aa77afecfb993e305a755175a' THEN
    RAISE EXCEPTION 'ready report: computed postimage is %', md5(v_new);
  END IF;
  SELECT p.proowner, p.prosecdef, p.proconfig, p.proacl::text
    INTO v_owner, v_secdef, v_config, v_acl FROM pg_proc p WHERE p.oid = v_oid;
  EXECUTE v_new;
  IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION 'ready report: exact readback failed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
                   AND p.proowner = v_owner AND p.prosecdef = v_secdef
                   AND p.proconfig IS NOT DISTINCT FROM v_config
                   AND p.proacl::text IS NOT DISTINCT FROM v_acl) THEN
    RAISE EXCEPTION 'ready report: authority drift';
  END IF;
  IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ready report: the original inventory sources no longer match';
  END IF;
END
$install$;

COMMIT;
