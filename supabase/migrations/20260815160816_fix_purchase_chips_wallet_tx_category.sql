-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815160816 "fix_purchase_chips_wallet_tx_category"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f9fa4bfc27a1b77a4901df3388ebbcdb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- fn_purchase_chips wrote wallet_transactions.category = 'purchase', which is not
-- in wallet_transactions_category_check -> every completed purchase would have
-- aborted with a 23514 constraint violation AFTER the diamonds were already
-- debited. (Present in the original body too; never fired only because the
-- function was unreachable.) 'deposit' is the allowed category for converting
-- diamonds into chip balance.
CREATE OR REPLACE FUNCTION public.fn_purchase_chips(
  p_user_id uuid,
  p_amount numeric,
  p_diamonds_cost integer DEFAULT 0,
  p_reference_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_debit jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'user required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'chip amount must be > 0');
  END IF;
  IF p_diamonds_cost IS NULL OR p_diamonds_cost < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid diamond cost');
  END IF;

  IF p_diamonds_cost > 0 THEN
    v_debit := deduct_diamonds(
      p_user_id, p_diamonds_cost, 'Chip package purchase',
      'purchase', 'chip_purchase', '{}'::jsonb, p_reference_id, 0
    );

    IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', COALESCE(v_debit->>'error', 'diamond debit failed'),
        'balance', v_debit->'balance'
      );
    END IF;
  END IF;

  PERFORM credit_player_wallet(p_user_id, p_amount);

  INSERT INTO wallet_transactions (
    user_id, wallet_type, amount, type, category, description, created_at
  ) VALUES (
    p_user_id, 'PLAYER', p_amount, 'credit', 'deposit',
    format('Chip purchase: %s chips for %s diamonds', p_amount, p_diamonds_cost), NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'chips_credited', p_amount,
    'diamonds_charged', p_diamonds_cost,
    'diamond_balance_after', v_debit->'balance',
    'idempotent', COALESCE((v_debit->>'idempotent')::boolean, false)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_purchase_chips(uuid, numeric, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_purchase_chips(uuid, numeric, integer, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_purchase_chips(uuid, numeric, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_purchase_chips(uuid, numeric, integer, text) TO service_role;
