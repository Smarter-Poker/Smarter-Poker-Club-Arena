-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260822194810 "spin_reserve_wallet_fund_op_stamp_one_row"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e40c366ba01291a629741c7b410f0f18 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Corrects the stamping step of spin_reserve_wallet_fund_op.
--
-- The first apply stamped BOTH ledger rows the inner function writes (the
-- debit out of the source wallet and the credit into the reserve) with the
-- same op id. uq_union_wallet_tx_op is unique on (union_id, tx_type,
-- period_id), so the second row collided with the first inside the same
-- statement: every genuine fund tripped its own replay guard, rolled itself
-- back and returned duplicate:true. Caught by the behavioural check before any
-- caller existed - nothing had ever invoked this function.
--
-- The op id is claimed by exactly ONE row now: the credit into the reserve,
-- which is the movement being made idempotent. The matching debit is part of
-- the same transaction and rolls back with it, so it needs no claim of its own.
--
-- The row to stamp is identified by excluding every unstamped row that existed
-- before the call, rather than by "the most recent one" - the reserve wallet
-- may accumulate unstamped rows from operator SQL that this function must
-- never adopt.

CREATE OR REPLACE FUNCTION public.fn_spin_reserve_wallet_fund_op(
  p_union_id   uuid,
  p_amount     numeric,
  p_from_wallet text,
  p_note       text,
  p_op_id      uuid,
  p_created_by uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_res     jsonb;
  v_before  uuid[];
  v_target  uuid;
  v_stamped int;
BEGIN
  IF p_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'op_id_required');
  END IF;

  IF p_from_wallet IS NULL OR p_from_wallet NOT IN ('promo_wallet', 'rake_wallet', 'chip_balance') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'source_wallet_required',
      'allowed', jsonb_build_array('promo_wallet', 'rake_wallet', 'chip_balance'));
  END IF;

  BEGIN
    SELECT COALESCE(array_agg(id), '{}'::uuid[]) INTO v_before
      FROM public.union_wallet_transactions
     WHERE union_id = p_union_id
       AND tx_type  = 'spin_reserve_wallet_fund'
       AND wallet   = 'spin_reserve_wallet'
       AND period_id IS NULL;

    v_res := public.fn_spin_reserve_wallet_fund(p_union_id, p_amount, p_from_wallet, p_note);

    -- A business refusal moved nothing and claims no op id, so it is returned
    -- as-is and may be retried.
    IF COALESCE((v_res ->> 'ok')::boolean, false) IS NOT TRUE THEN
      RETURN v_res;
    END IF;

    SELECT id INTO v_target
      FROM public.union_wallet_transactions
     WHERE union_id  = p_union_id
       AND tx_type   = 'spin_reserve_wallet_fund'
       AND wallet    = 'spin_reserve_wallet'
       AND direction = 'credit'
       AND period_id IS NULL
       AND NOT (id = ANY (v_before))
     ORDER BY created_at DESC, id DESC
     LIMIT 1;

    IF v_target IS NULL THEN
      RAISE EXCEPTION 'spin reserve fund wrote no credit row for op %', p_op_id;
    END IF;

    UPDATE public.union_wallet_transactions t
       SET period_id  = p_op_id,
           created_by = COALESCE(p_created_by, t.created_by)
     WHERE t.id = v_target;
    GET DIAGNOSTICS v_stamped = ROW_COUNT;

    RETURN v_res || jsonb_build_object('op_id', p_op_id, 'ledger_rows', v_stamped);
  EXCEPTION
    WHEN unique_violation THEN
      -- Everything above, credit and debit included, rolls back to the start
      -- of this block. The original operation still stands.
      RETURN jsonb_build_object('ok', false, 'duplicate', true,
        'reason', 'already_processed', 'op_id', p_op_id);
  END;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_spin_reserve_wallet_fund_op(uuid, numeric, text, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_spin_reserve_wallet_fund_op(uuid, numeric, text, text, uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_reserve_wallet_fund_op(uuid, numeric, text, text, uuid, uuid) TO service_role;
