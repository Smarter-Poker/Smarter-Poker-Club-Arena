-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416014559 "bug_025_mint_club_chips_real_impl"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0d944bf8ebd8afa45c845c602611e450 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 025 C: mint_club_chips was a silent-success stub. Two client call sites used
-- mismatched param names (p_chips vs p_amount, p_diamonds vs p_minted_by), so the
-- PostgREST call would have 404'd anyway -- but the stub masked that. Unifying the
-- signature and writing real mint logic.
DROP FUNCTION IF EXISTS public.mint_club_chips(uuid, numeric, uuid);

CREATE OR REPLACE FUNCTION public.mint_club_chips(
  p_club_id uuid,
  p_amount numeric,
  p_minted_by uuid DEFAULT NULL,
  p_diamonds_cost numeric DEFAULT 0,
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
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

  -- Lock + read club
  SELECT COALESCE(chip_pool, 0), name INTO v_pool_before, v_club_name
  FROM clubs WHERE id = p_club_id FOR UPDATE;

  IF v_club_name IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;

  -- If p_minted_by provided, validate authorization (owner/union_owner/admin)
  IF p_minted_by IS NOT NULL THEN
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
  END IF;

  -- Credit club chip pool
  UPDATE clubs
  SET chip_pool = COALESCE(chip_pool, 0) + p_amount,
      updated_at = NOW()
  WHERE id = p_club_id;
  v_pool_after := v_pool_before + p_amount;

  -- Audit log
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

GRANT EXECUTE ON FUNCTION public.mint_club_chips(uuid, numeric, uuid, numeric, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.mint_club_chips IS
'BUG 025: real implementation replacing silent-success stub. Unified signature (p_club_id, p_amount, p_minted_by?, p_diamonds_cost?, p_notes?) accepts both admin-mint and union-mint call patterns. Atomically credits clubs.chip_pool and writes chip_transactions mint row.';

