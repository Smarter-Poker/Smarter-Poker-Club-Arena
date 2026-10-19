-- PR #7427 (migration 20261019102410) postimage of fn_retry_cash_accounting_sources, md5(pg_get_functiondef)
-- 0ab1bf9282426f348c034785513724e0. Loaded by refresh-horizon.py to prove 20261019094914 installs
-- the same body whichever of the two migrations is installed first.
CREATE OR REPLACE FUNCTION public.fn_retry_cash_accounting_sources(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE w record;r jsonb;receipts jsonb:='[]';v_ok int:=0;v_blocked int:=0;v_failed int:=0;first_error text;v_parked bigint:=0;v_gate uuid;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>200 THEN RAISE EXCEPTION 'invalid_cash_retry_limit' USING ERRCODE='22023'; END IF;
 -- EVERY FREE CLUB COMMISSION KEY FIRST, IN CLUB ORDER, WITHOUT WAITING (2026-10-01),
 -- as fn_credit_agent_commissions_batch takes them: this retry is one transaction
 -- over many sources too, and a wait here would fail all of them at the role's
 -- lock_timeout. Read from the rows the loop below selects; the rest are taken
 -- item by item in the trigger.
 FOR v_gate IN SELECT DISTINCT a.club_id FROM public.rake_attributions a
   WHERE a.rake_record_id = ANY (ARRAY(SELECT s.rake_record_id FROM public.accounting_cash_source_work s
     WHERE s.status='blocked' AND s.next_attempt_at<=clock_timestamp()
     ORDER BY s.attempts,s.next_attempt_at,s.rake_record_id LIMIT p_limit))
     AND a.club_id IS NOT NULL ORDER BY a.club_id LOOP
  EXIT WHEN NOT pg_try_advisory_xact_lock(hashtextextended('agent-commission:'||v_gate::text,0));
 END LOOP;
 -- Do not lock work rows here: all callers acquire the original hand lock
 -- first. SKIP LOCKED on work would invert that order against direct callers.
 -- THE FEWEST REFUSALS GO FIRST (20261019102410). Oldest-due-first let a
 -- burst of sources still waiting on missing evidence hold every slot of
 -- every cycle while a source refused once by a lock waited a day behind it.
 FOR w IN SELECT rake_record_id FROM public.accounting_cash_source_work WHERE status='blocked'
  AND next_attempt_at<=clock_timestamp() ORDER BY attempts,next_attempt_at,rake_record_id LIMIT p_limit LOOP
  BEGIN
   r:=public.fn_process_cash_accounting_source(w.rake_record_id);receipts:=receipts||jsonb_build_array(r);
   IF r->>'status'='accrued' THEN v_ok:=v_ok+1; ELSE v_blocked:=v_blocked+1; END IF;
  EXCEPTION WHEN OTHERS THEN v_failed:=v_failed+1;first_error:=COALESCE(first_error,SQLERRM);END;
 END LOOP;
 SELECT count(*) INTO v_parked FROM public.accounting_cash_source_work
  WHERE status='blocked' AND next_attempt_at='infinity'::timestamptz;
 RETURN jsonb_build_object('receipt_version',3,'ok',v_ok,'blocked',v_blocked,'failed',v_failed+v_blocked,'terminal_parked',v_parked,
  'first_error',first_error,'receipts',receipts);
END $function$;
