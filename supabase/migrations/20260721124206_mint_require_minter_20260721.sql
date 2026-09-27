-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721124206 "mint_require_minter_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 79aa7c074a8602f6b75963ba60dea42d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.mint_club_chips(
  p_club_id uuid,
  p_amount numeric,
  p_minted_by uuid DEFAULT NULL::uuid,
  p_diamonds_cost numeric DEFAULT 0,
  p_notes text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_pool_before numeric;
  v_pool_after numeric;
  v_club_name text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  IF p_minted_by IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'minter identity required');
  END IF;

  SELECT COALESCE(chip_pool, 0), name INTO v_pool_before, v_club_name
  FROM clubs WHERE id = p_club_id FOR UPDATE;

  IF v_club_name IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM clubs c
    WHERE c.id = p_club_id
      AND (
        c.owner_id = p_minted_by
        OR EXISTS (
          SELECT 1 FROM club_memberships cm
          WHERE cm.club_id = p_club_id
            AND cm.user_id = p_minted_by
            AND cm.role IN ('owner', 'co_owner', 'admin')
        )
        OR EXISTS (
          SELECT 1 FROM unions u
          WHERE u.id = c.union_id AND u.owner_id = p_minted_by
        )
      )
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to mint for this club');
  END IF;

  UPDATE clubs
  SET chip_pool = COALESCE(chip_pool, 0) + p_amount,
      updated_at = NOW()
  WHERE id = p_club_id;
  v_pool_after := v_pool_before + p_amount;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_minted_by, NULL, p_amount,
    'mint',
    COALESCE(p_notes, CASE WHEN p_diamonds_cost > 0
      THEN 'Mint: ' || p_amount::text || ' chips (' || p_diamonds_cost::text || ' diamonds)'
      ELSE 'Mint: ' || p_amount::text || ' chips'
    END),
    v_pool_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'pool_before', v_pool_before,
    'pool_after', v_pool_after,
    'club_name', v_club_name
  );
END;
$function$;

DO $$
DECLARE r jsonb;
BEGIN
  SELECT mint_club_chips(gen_random_uuid(), 100, NULL) INTO r;
  IF (r->>'error') <> 'minter identity required' THEN
    RAISE EXCEPTION 'null-minter guard not active: %', r;
  END IF;
END $$;
