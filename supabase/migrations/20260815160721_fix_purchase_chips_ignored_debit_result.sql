-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815160721 "fix_purchase_chips_ignored_debit_result"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 78800a16ca0a08c802f8692975da14fe of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- fn_purchase_chips: stop crediting chips when the diamond debit FAILED
-- ═══════════════════════════════════════════════════════════════════════════
-- The old body was:
--     IF p_diamonds_cost > 0 THEN PERFORM deduct_diamonds(p_user_id, p_diamonds_cost); END IF;
--     PERFORM credit_player_wallet(p_user_id, p_amount);
-- `deduct_diamonds` reports failure by RETURNING {success:false,...}; it does not
-- raise. PERFORM discards that value, so a user with insufficient diamonds was
-- charged nothing and still received the chips -- free chips on every failed
-- debit. The function was unreachable (service_role only, and the one client
-- caller passed non-existent parameter names), so this never fired in
-- production, but it would have the moment the button was "fixed".
--
-- Now: the debit result is captured and the purchase aborts unless it succeeded.
-- Return type changes void -> jsonb, so DROP + CREATE is required.
-- Verified no caller exists in either repo before dropping.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_purchase_chips(uuid, numeric, integer);
--   CREATE OR REPLACE FUNCTION public.fn_purchase_chips(p_user_id uuid, p_amount numeric, p_diamonds_cost integer DEFAULT 0)
--   RETURNS void LANGUAGE plpgsql SET search_path TO 'public','extensions' AS $$
--   BEGIN
--     IF p_diamonds_cost > 0 THEN PERFORM deduct_diamonds(p_user_id, p_diamonds_cost); END IF;
--     PERFORM credit_player_wallet(p_user_id, p_amount);
--     INSERT INTO wallet_transactions (user_id, wallet_type, amount, type, category, description, created_at)
--     VALUES (p_user_id, 'PLAYER', p_amount, 'credit', 'purchase', 'Chip purchase', NOW());
--   END; $$;

DROP FUNCTION IF EXISTS public.fn_purchase_chips(uuid, numeric, integer);

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

  -- Charge FIRST and verify the charge actually happened. p_reference_id makes
  -- the debit idempotent, so a retried request cannot double-charge.
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
    p_user_id, 'PLAYER', p_amount, 'credit', 'purchase',
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

-- Service role only: the amount and price must be decided by a trusted server
-- route (see /api/club-arena/purchase-chips), never by the caller.
REVOKE EXECUTE ON FUNCTION public.fn_purchase_chips(uuid, numeric, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_purchase_chips(uuid, numeric, integer, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_purchase_chips(uuid, numeric, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_purchase_chips(uuid, numeric, integer, text) TO service_role;
