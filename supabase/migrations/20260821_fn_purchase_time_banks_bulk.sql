-- Dan 2026-08-21 (bug list item 3): "when you click on time banks, when a user
-- is OUT it should pop up to buy more with diamonds, each time bank = 5
-- diamonds. Have defaults set of 1-10-25-100-500."
--
-- Two things were needed:
--   1. The price. `feature_pricing.time_bank_seconds` was 1 diamond; the owner
--      ruling is 5. Pricing stays server-side so the client can never name its
--      own price.
--   2. A BULK purchase. `fn_purchase_feature` buys exactly one unit per call,
--      so a 500-pack would have been 500 round trips and 500 separate diamond
--      charges — any one of which could fail halfway and leave the player
--      part-charged. This buys N in one transaction: one diamond deduction,
--      one feature_purchases row per unit so fn_time_bank_allowance's counter
--      keeps working unchanged.
--
-- Applied to production via Supabase MCP apply_migration on 2026-08-21.
--
-- ROLLBACK:
--   update feature_pricing set diamond_cost = 1 where feature = 'time_bank_seconds';
--   drop function if exists public.fn_purchase_time_banks(integer);

update feature_pricing set diamond_cost = 5 where feature = 'time_bank_seconds';

create or replace function public.fn_purchase_time_banks(p_quantity integer)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_unit_cost integer;
  v_total_cost integer;
  v_deduct jsonb;
  v_i integer;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required');
  END IF;

  -- Quantity is the ONLY thing the client gets to choose, and it is bounded.
  -- The presets are 1/10/25/100/500; 500 is the ceiling.
  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 500 THEN
    RETURN jsonb_build_object('success', false, 'error', 'quantity must be between 1 and 500');
  END IF;

  SELECT diamond_cost INTO v_unit_cost
    FROM feature_pricing WHERE feature = 'time_bank_seconds';
  IF v_unit_cost IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'time bank pricing not configured');
  END IF;

  v_total_cost := v_unit_cost * p_quantity;

  IF v_total_cost > 0 THEN
    v_deduct := deduct_diamonds(
      p_user_id          := v_caller,
      p_amount           := v_total_cost,
      p_description      := 'Time banks x' || p_quantity,
      p_transaction_type := 'feature_purchase',
      p_source           := 'feature_purchase',
      p_metadata         := jsonb_build_object(
                              'feature', 'time_bank_seconds',
                              'quantity', p_quantity,
                              'unit_cost', v_unit_cost),
      p_reference_id     := 'tbank_' || v_caller || '_' || p_quantity || '_'
                              || extract(epoch from clock_timestamp())::bigint::text
    );
    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', COALESCE(v_deduct->>'error', 'diamond charge failed'),
        'required', v_total_cost);
    END IF;
  END IF;

  FOR v_i IN 1..p_quantity LOOP
    INSERT INTO feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at)
    VALUES (v_caller, 'time_bank_seconds', v_unit_cost, 'per_use', 1, NULL);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'quantity', p_quantity,
    'unit_cost', v_unit_cost,
    'total_cost', v_total_cost,
    'diamonds_remaining', (v_deduct->>'new_balance'));
END;
$$;

revoke all on function public.fn_purchase_time_banks(integer) from public;
grant execute on function public.fn_purchase_time_banks(integer) to authenticated;
