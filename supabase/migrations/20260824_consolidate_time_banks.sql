-- Drop the old insert loop
CREATE OR REPLACE FUNCTION fn_purchase_time_banks(p_quantity INT)
RETURNS jsonb AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_diamonds INT;
  v_unit_cost INT := 2; -- 2 diamonds per use
  v_total_cost INT;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;
  
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid quantity');
  END IF;

  v_total_cost := p_quantity * v_unit_cost;

  SELECT diamonds INTO v_diamonds
  FROM profiles WHERE id = v_caller FOR UPDATE;
  
  IF v_diamonds < v_total_cost THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient diamonds');
  END IF;

  UPDATE profiles SET diamonds = diamonds - v_total_cost WHERE id = v_caller;

  INSERT INTO diamond_transactions (user_id, amount, reason)
  VALUES (v_caller, -v_total_cost, 'purchase_time_bank');

  -- fn_time_bank_allowance and fn_consume_time_bank both use SUM(uses_remaining)
  -- and process rows gracefully. Inserting a single row avoids PostgREST 
  -- row-limit truncation in loadEntitlements on the client.
  INSERT INTO feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at)
  VALUES (v_caller, 'time_bank_seconds', v_total_cost, 'per_use', p_quantity, NULL);

  RETURN jsonb_build_object('success', true, 'diamonds_remaining', v_diamonds - v_total_cost);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Consolidate existing rows to fix bloated tables preventing UI from loading uses
DO $$
DECLARE
  v_user_id uuid;
  v_total_uses int;
BEGIN
  FOR v_user_id IN (
    SELECT DISTINCT user_id FROM feature_purchases WHERE feature = 'time_bank_seconds'
  ) LOOP
    SELECT COALESCE(SUM(uses_remaining), 0) INTO v_total_uses
    FROM feature_purchases
    WHERE user_id = v_user_id AND feature = 'time_bank_seconds' AND (expires_at IS NULL OR expires_at > now());
    
    DELETE FROM feature_purchases
    WHERE user_id = v_user_id AND feature = 'time_bank_seconds';
    
    IF v_total_uses > 0 THEN
      INSERT INTO feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at)
      VALUES (v_user_id, 'time_bank_seconds', v_total_uses * 2, 'per_use', v_total_uses, NULL);
    END IF;
  END LOOP;
END;
$$;
