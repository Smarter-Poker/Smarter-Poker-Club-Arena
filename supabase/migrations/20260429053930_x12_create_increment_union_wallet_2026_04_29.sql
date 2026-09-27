-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429053930 "x12_create_increment_union_wallet_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f32fdf0ba4b5ecef0b7373ceb73e5403 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 10 — increment_union_wallet RPC
-- Production data: 1 union with 2 member clubs, 1 union_wallet row.
-- Without this RPC every rake-collection event from union clubs silently
-- 404s — caller in server/src/services/supabase.ts logs error but does NOT
-- transactionally back out, so rake gets recorded in club_wallets while
-- union_wallets stays unchanged → settlement chain divergence.
-- Atomic increment eliminates the read-then-write race that the legacy
-- code path had (FIX-232 in caller comment).

CREATE OR REPLACE FUNCTION public.increment_union_wallet(
  p_union_id uuid, p_amount numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_new_chip numeric;
  v_new_rake numeric;
BEGIN
  IF p_union_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_union_id required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'zero_amount');
  END IF;

  -- Upsert (in case the union_wallets row was never seeded).
  INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
       VALUES (p_union_id, p_amount, p_amount, p_amount)
  ON CONFLICT (union_id) DO UPDATE SET
       chip_balance         = public.union_wallets.chip_balance + p_amount,
       rake_wallet          = public.union_wallets.rake_wallet + p_amount,
       total_rake_collected = COALESCE(public.union_wallets.total_rake_collected, 0) + p_amount,
       updated_at           = NOW()
  RETURNING chip_balance, rake_wallet INTO v_new_chip, v_new_rake;

  RETURN jsonb_build_object(
    'success', true,
    'union_id', p_union_id,
    'amount', p_amount,
    'new_chip_balance', v_new_chip,
    'new_rake_wallet',  v_new_rake
  );
END $function$;

REVOKE EXECUTE ON FUNCTION public.increment_union_wallet(uuid, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_union_wallet(uuid, numeric) TO service_role;
