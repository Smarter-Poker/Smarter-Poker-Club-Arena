-- Rehearsal fixture for 20261001001000_a_cash_batch_never_waits_for_a_commission_key (rolled back by rehearse.sh).
-- Single-session only: no item is processed, no key is held by anyone else.
SET LOCAL lock_timeout = '2s';
DO $fx$
DECLARE v jsonb;
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_credit_agent_commissions_batch') <> 'd4572f3e1efd9c85a0025cc2906c6fae'
     OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_retry_cash_accounting_sources') <> '3788581d5e8f1953663b8929b4688d0a' THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: not the measured text';
  END IF;
  IF position('EXIT WHEN NOT pg_try_advisory_xact_lock(hashtextextended(''agent-commission:''' IN
       pg_get_functiondef('public.fn_credit_agent_commissions_batch(jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: the batch does not try its keys';
  END IF;
  IF position('pg_advisory_xact_lock(hashtextextended(''agent-commission:''' IN
       pg_get_functiondef('public.trg_agent_commission_rollup_insert()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: the trigger no longer takes the key per item';
  END IF;
  v := public.fn_credit_agent_commissions_batch('{}'::jsonb);
  IF v->>'error' IS DISTINCT FROM 'p_items must be a jsonb array of at most 2000 items' THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: the batch refusal changed: %', v;
  END IF;
  v := public.fn_credit_agent_commissions_batch('[]'::jsonb);
  IF (v->>'ok')::int <> 0 OR jsonb_array_length(v->'receipts') <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: an empty batch did something: %', v;
  END IF;
  BEGIN
    PERFORM public.fn_retry_cash_accounting_sources(0);
    RAISE EXCEPTION 'REHEARSAL FAILED: the retry accepted a zero limit';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  RAISE EXCEPTION 'REHEARSAL OK: the cash batch and retry try their commission keys and never wait for one outside an item; refusals unchanged; nothing opened';
END $fx$;
