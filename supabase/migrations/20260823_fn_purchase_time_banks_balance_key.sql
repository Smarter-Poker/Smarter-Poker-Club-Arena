-- Dan 2026-08-23: "Ensure that when you buy time banks, it actually deducts the
-- diamonds and adds the transaction inside your diamond wallet."
--
-- ROOT CAUSE, and it is one word.
--
-- The deduction and the ledger row were never broken. `deduct_diamonds` debits
-- `profiles.diamonds` and INSERTs into `diamond_transactions` inside one
-- transaction, and production has the proof: a single row, -2,500 diamonds,
-- description 'Time banks x500', 2026-08-23 19:36 UTC, with 500 matching
-- `feature_purchases` rows beside it.
--
-- What was broken is what the client was TOLD afterwards. `deduct_diamonds`
-- returns its post-charge balance under the key "balance":
--
--     RETURN jsonb_build_object('success', true, 'balance', v_new_balance, ...)
--
-- and `fn_purchase_time_banks` read `new_balance`, a key that function has
-- never returned. So `diamonds_remaining` was NULL on every successful
-- purchase, and TablePage's
--
--     const remaining = Number(result.diamonds_remaining);
--     if (Number.isFinite(remaining)) setDiamondBalance(remaining);
--
-- had nothing real to apply. The store sheet and the header both kept showing
-- the pre-purchase number, so the player watched themselves buy 500 time banks
-- while their diamond balance sat perfectly still. Indistinguishable, from the
-- player's side of the glass, from "it did not deduct".
--
-- Nothing else changes. Same pricing, same charge, same rows.
--
-- ROLLBACK: re-apply 20260821_fn_purchase_time_banks_bulk.sql, which carries
-- the previous (broken) body verbatim.

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
      p_description      := 'Time Banks x' || p_quantity,
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

  -- fn_time_bank_allowance counts uses_remaining across feature_purchases
  -- rows, so N banks means N units of allowance. One row per unit keeps that
  -- counter, and the engine's refreshTimeBankFromDb, working unchanged.
  FOR v_i IN 1..p_quantity LOOP
    INSERT INTO feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at)
    VALUES (v_caller, 'time_bank_seconds', v_unit_cost, 'per_use', 1, NULL);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'quantity', p_quantity,
    'unit_cost', v_unit_cost,
    'total_cost', v_total_cost,
    -- THE FIX: "balance" is the key deduct_diamonds actually returns.
    'diamonds_remaining', (v_deduct->>'balance')::integer);
END;
$$;

revoke all on function public.fn_purchase_time_banks(integer) from public;
grant execute on function public.fn_purchase_time_banks(integer) to authenticated;

-- Post-apply assertions.
--
-- These match the DEREFERENCE, not the bare word. The first version of this
-- migration asserted on the word alone and aborted its own apply, because
-- pg_get_functiondef returns the comments too and the comment above explains
-- the bug by name. An assertion that cannot tell code from prose is not
-- checking the thing it claims to check.
DO $assert$
BEGIN
  IF pg_get_functiondef('public.fn_purchase_time_banks(integer)'::regprocedure)
       LIKE '%->>''new_balance''%' THEN
    RAISE EXCEPTION 'fn_purchase_time_banks still dereferences the non-existent new_balance key';
  END IF;

  IF pg_get_functiondef('public.fn_purchase_time_banks(integer)'::regprocedure)
       NOT LIKE '%->>''balance''%' THEN
    RAISE EXCEPTION 'fn_purchase_time_banks does not read the balance key that deduct_diamonds returns';
  END IF;
END
$assert$;
