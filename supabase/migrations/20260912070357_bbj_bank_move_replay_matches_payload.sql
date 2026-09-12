SET LOCAL lock_timeout = '1000ms';
SET LOCAL statement_timeout = '15000ms';
-- SCRATCH PROPOSAL ONLY: root must assign migration ownership and execution lane.
-- Run in the migration runner's transaction, under exclusive function-DDL ownership.
-- No business function is invoked. Existing object ownership/ACL must be preserved.
DO $install$
DECLARE
  v_oid oid;
  v_definition text;
  v_owner text;
  v_acl aclitem[];
  v_config text[];
  v_security boolean;
  v_before constant text := $before$CREATE OR REPLACE FUNCTION public.fn_bbj_move_between_banks(p_pool_id uuid, p_from_bank text, p_to_bank text, p_amount numeric, p_reason text, p_op_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_amt numeric := round(COALESCE(p_amount, 0), 2);
  v_pool public.bbj_pools%ROWTYPE; v_have numeric; v_prior public.ca_bbj_bucket_moves%ROWTYPE;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_bbj_move_between_banks is service only' USING ERRCODE = '42501';
  END IF;
  IF p_from_bank NOT IN ('main', 'backup', 'promo') OR p_to_bank NOT IN ('main', 'backup', 'promo') OR p_from_bank = p_to_bank THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'banks_must_be_two_of_main_backup_promo');
  END IF;
  IF v_amt <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive');
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 OR COALESCE(btrim(p_op_id), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'a_bank_move_needs_a_reason_and_an_op_id');
  END IF;
  SELECT * INTO v_pool FROM public.bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_not_found');
  END IF;
  SELECT * INTO v_prior FROM public.ca_bbj_bucket_moves WHERE op_id = p_op_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'move_id', v_prior.id, 'amount', v_prior.amount);
  END IF;
  v_have := CASE p_from_bank WHEN 'main' THEN v_pool.main_balance WHEN 'backup' THEN v_pool.backup_balance ELSE v_pool.promo_balance END;
  v_have := v_have-public.fn_bbj_parked_reserve(p_pool_id,p_from_bank);
  IF COALESCE(v_have, 0) < v_amt THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'source_bank_cannot_cover_it', 'available', COALESCE(v_have, 0), 'requested', v_amt);
  END IF;
  -- Declared as bbj_pool -> bbj_pool: the chips change bank, not account. The
  -- autoledger writes one leg per bucket column with its label, which is what
  -- the per-bank reconcile reads.
  PERFORM public.fn_ca_declare_ledger('adjustment', 'bbj_pool', p_pool_id, NULL, NULL, NULL);
  UPDATE public.bbj_pools
     SET main_balance   = main_balance   + CASE WHEN p_to_bank = 'main'   THEN v_amt ELSE 0 END - CASE WHEN p_from_bank = 'main'   THEN v_amt ELSE 0 END,
         backup_balance = backup_balance + CASE WHEN p_to_bank = 'backup' THEN v_amt ELSE 0 END - CASE WHEN p_from_bank = 'backup' THEN v_amt ELSE 0 END,
         promo_balance  = promo_balance  + CASE WHEN p_to_bank = 'promo'  THEN v_amt ELSE 0 END - CASE WHEN p_from_bank = 'promo'  THEN v_amt ELSE 0 END,
         updated_at = now()
   WHERE id = p_pool_id;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  INSERT INTO public.ca_bbj_bucket_moves (pool_id, from_bank, to_bank, amount, reason, op_id, performed_by)
  VALUES (p_pool_id, p_from_bank, p_to_bank, v_amt, btrim(p_reason), p_op_id, auth.uid())
  RETURNING * INTO v_prior;
  RETURN jsonb_build_object('ok', true, 'replayed', false, 'move_id', v_prior.id, 'amount', v_amt,
                            'from_bank', p_from_bank, 'to_bank', p_to_bank);
END;
$function$
$before$;
  v_candidate constant text := $candidate$CREATE OR REPLACE FUNCTION public.fn_bbj_move_between_banks(p_pool_id uuid, p_from_bank text, p_to_bank text, p_amount numeric, p_reason text, p_op_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_amt numeric := round(COALESCE(p_amount, 0), 2);
  v_pool public.bbj_pools%ROWTYPE; v_have numeric; v_prior public.ca_bbj_bucket_moves%ROWTYPE;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_bbj_move_between_banks is service only' USING ERRCODE = '42501';
  END IF;
  IF p_from_bank NOT IN ('main', 'backup', 'promo') OR p_to_bank NOT IN ('main', 'backup', 'promo') OR p_from_bank = p_to_bank THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'banks_must_be_two_of_main_backup_promo');
  END IF;
  IF v_amt <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive');
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 OR COALESCE(btrim(p_op_id), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'a_bank_move_needs_a_reason_and_an_op_id');
  END IF;
  SELECT * INTO v_pool FROM public.bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_not_found');
  END IF;
  SELECT * INTO v_prior FROM public.ca_bbj_bucket_moves WHERE op_id = p_op_id;
  IF FOUND THEN
    IF v_prior.pool_id IS DISTINCT FROM p_pool_id
       OR v_prior.from_bank IS DISTINCT FROM p_from_bank
       OR v_prior.to_bank IS DISTINCT FROM p_to_bank
       OR v_prior.amount IS DISTINCT FROM v_amt THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'op_id_payload_mismatch');
    END IF;
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'move_id', v_prior.id, 'amount', v_prior.amount);
  END IF;
  v_have := CASE p_from_bank WHEN 'main' THEN v_pool.main_balance WHEN 'backup' THEN v_pool.backup_balance ELSE v_pool.promo_balance END;
  v_have := v_have-public.fn_bbj_parked_reserve(p_pool_id,p_from_bank);
  IF COALESCE(v_have, 0) < v_amt THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'source_bank_cannot_cover_it', 'available', COALESCE(v_have, 0), 'requested', v_amt);
  END IF;
  -- Declared as bbj_pool -> bbj_pool: the chips change bank, not account. The
  -- autoledger writes one leg per bucket column with its label, which is what
  -- the per-bank reconcile reads.
  PERFORM public.fn_ca_declare_ledger('adjustment', 'bbj_pool', p_pool_id, NULL, NULL, NULL);
  UPDATE public.bbj_pools
     SET main_balance   = main_balance   + CASE WHEN p_to_bank = 'main'   THEN v_amt ELSE 0 END - CASE WHEN p_from_bank = 'main'   THEN v_amt ELSE 0 END,
         backup_balance = backup_balance + CASE WHEN p_to_bank = 'backup' THEN v_amt ELSE 0 END - CASE WHEN p_from_bank = 'backup' THEN v_amt ELSE 0 END,
         promo_balance  = promo_balance  + CASE WHEN p_to_bank = 'promo'  THEN v_amt ELSE 0 END - CASE WHEN p_from_bank = 'promo'  THEN v_amt ELSE 0 END,
         updated_at = now()
   WHERE id = p_pool_id;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  INSERT INTO public.ca_bbj_bucket_moves (pool_id, from_bank, to_bank, amount, reason, op_id, performed_by)
  VALUES (p_pool_id, p_from_bank, p_to_bank, v_amt, btrim(p_reason), p_op_id, auth.uid())
  RETURNING * INTO v_prior;
  RETURN jsonb_build_object('ok', true, 'replayed', false, 'move_id', v_prior.id, 'amount', v_amt,
                            'from_bank', p_from_bank, 'to_bank', p_to_bank);
END;
$function$
$candidate$;
BEGIN
  -- Cooperating installers serialize here; this does not fence arbitrary DDL.
  PERFORM pg_advisory_xact_lock(hashtextextended('FWP02:public.fn_bbj_move_between_banks(uuid,text,text,numeric,text,text)', 0));
  v_oid := to_regprocedure('public.fn_bbj_move_between_banks(uuid,text,text,numeric,text,text)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'FWP02 drift: expected existing function';
  END IF;
  SELECT pg_get_functiondef(p.oid), pg_get_userbyid(p.proowner), p.proacl, p.proconfig, p.prosecdef
    INTO v_definition, v_owner, v_acl, v_config, v_security
    FROM pg_proc p WHERE p.oid = v_oid;
  IF v_owner IS DISTINCT FROM 'postgres'
     OR v_acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'::aclitem[]
     OR v_config IS DISTINCT FROM ARRAY['search_path=public']::text[]
     OR v_security IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FWP02 drift: owner/ACL/settings/security differ';
  END IF;
  IF v_definition IS NOT DISTINCT FROM v_candidate THEN
    RETURN; -- Exact already-installed candidate: no replacement or ACL change.
  END IF;
  IF v_definition IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'FWP02 drift: function definition differs';
  END IF;
  EXECUTE v_candidate;
  IF to_regprocedure('public.fn_bbj_move_between_banks(uuid,text,text,numeric,text,text)')::oid IS DISTINCT FROM v_oid THEN
    RAISE EXCEPTION 'FWP02 postcondition: function identity changed';
  END IF;
  SELECT pg_get_functiondef(p.oid), pg_get_userbyid(p.proowner), p.proacl, p.proconfig, p.prosecdef
    INTO v_definition, v_owner, v_acl, v_config, v_security
    FROM pg_proc p WHERE p.oid = v_oid;
  IF v_definition IS DISTINCT FROM v_candidate
     OR v_owner IS DISTINCT FROM 'postgres'
     OR v_acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'::aclitem[]
     OR v_config IS DISTINCT FROM ARRAY['search_path=public']::text[]
     OR v_security IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FWP02 postcondition: replacement or metadata differs';
  END IF;
END;
$install$;
