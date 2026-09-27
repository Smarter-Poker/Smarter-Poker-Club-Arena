-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815162717 "promo_economy_bbj_funded_union_held"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3541136334b8ad54a92ba3b90e96ded8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- PROMO CHIP ECONOMY (binding, set by Dan 2026-08-15)
-- ═══════════════════════════════════════════════════════════════════════════
--  * ALL promo chips derive from the BBJ. Nothing may mint promo from nothing.
--  * Promo is HELD in the UNION wallet and distributed by the union to its
--    clubs, or directly to agents.
--  * A club with NO union receives its promo directly into the club promo wallet.
--
-- VERIFIED BBJ RAKE SCHEDULE (public.bbj_stakes_tiers, live):
--   tier        blinds            rake%  cap(bb)  bbj_fee(bb)  payout%  loser/winner/table
--   nano        0.05/0.1-0.1/0.2   5.00   10.00      0.60        15.00   7.50/3.75/3.75
--   micro       0.2/0.4-0.4/0.8    7.00    8.00      0.40        25.00  12.50/6.25/6.25
--   small       0.5/1-1.5/3       10.00    5.00      0.25        40.00  20.00/10.00/10.00
--   mid         2/4-4/8            8.00    3.00      0.12        55.00  27.50/13.75/13.75
--   high        5/10-20/40         5.00    2.00      0.06        70.00  35.00/17.50/17.50
--   nosebleeds  25/50+             3.00    1.00      0.03        85.00  42.50/21.25/21.25
-- CONTRIBUTION SPLIT (add_bbj_contribution): 50% main / 25% backup / 25% PROMO.
-- The 25% promo slice is the ONLY source of promo chips.
--
-- CANONICAL COLUMNS (the ones already carrying value / used by live functions):
--   unions.promo_wallet          union promo wallet
--   clubs.promo_balance          club promo wallet
--   club_members.promo_balance   agent AND player promo (an agent is a member)
--   bbj_pools.promo_balance      accrual point, swept upward by fn_sweep_bbj_promo
-- DUPLICATES, all zero across every row, deprecated (kept, not dropped):
--   unions.promo_fund_balance, agents.promo_balance, agents.promo_wallet_balance

COMMENT ON COLUMN public.unions.promo_fund_balance IS
  'DEPRECATED 2026-08-15. Use unions.promo_wallet. Zero on every row.';
COMMENT ON COLUMN public.agents.promo_balance IS
  'DEPRECATED 2026-08-15. Agent promo lives on club_members.promo_balance. Zero on every row.';
COMMENT ON COLUMN public.agents.promo_wallet_balance IS
  'DEPRECATED 2026-08-15. Agent promo lives on club_members.promo_balance. Zero on every row.';
COMMENT ON COLUMN public.unions.promo_wallet IS
  'CANONICAL union promo wallet. Funded ONLY by fn_sweep_bbj_promo (BBJ 25% promo slice).';
COMMENT ON COLUMN public.clubs.promo_balance IS
  'CANONICAL club promo wallet. Funded by fn_sweep_bbj_promo (unionless clubs) or fn_union_distribute_promo.';

-- ── 1. SWEEP: BBJ promo slice -> union wallet, or club wallet if no union ────
CREATE OR REPLACE FUNCTION public.fn_sweep_bbj_promo(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_promo    numeric;
  v_pool_id  uuid;
  v_union_id uuid;
  v_dest     text;
  v_after    numeric;
BEGIN
  SELECT id, COALESCE(promo_balance, 0) INTO v_pool_id, v_promo
    FROM bbj_pools WHERE club_id = p_club_id FOR UPDATE;

  IF v_pool_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no bbj pool for club');
  END IF;
  IF v_promo <= 0 THEN
    RETURN jsonb_build_object('success', true, 'swept', 0, 'note', 'nothing to sweep');
  END IF;

  SELECT union_id INTO v_union_id FROM clubs WHERE id = p_club_id;

  -- Drain the accrual point first so a concurrent sweep cannot double-credit.
  UPDATE bbj_pools SET promo_balance = 0, updated_at = NOW() WHERE id = v_pool_id;

  IF v_union_id IS NOT NULL THEN
    UPDATE unions
       SET promo_wallet = COALESCE(promo_wallet, 0) + v_promo, updated_at = NOW()
     WHERE id = v_union_id
    RETURNING promo_wallet INTO v_after;
    v_dest := 'union';
    IF v_after IS NULL THEN
      RAISE EXCEPTION 'club % references missing union %', p_club_id, v_union_id;
    END IF;
  ELSE
    UPDATE clubs
       SET promo_balance = COALESCE(promo_balance, 0) + v_promo, updated_at = NOW()
     WHERE id = p_club_id
    RETURNING promo_balance INTO v_after;
    v_dest := 'club';
  END IF;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, NULL, NULL, v_promo,
    'bbj_promo_sweep',
    format('BBJ promo slice swept to %s wallet', v_dest),
    v_after, NOW()
  );

  RETURN jsonb_build_object('success', true, 'swept', v_promo,
                            'destination', v_dest, 'balance_after', v_after);
END;
$function$;

-- ── 2. UNION -> club or agent distribution ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_union_distribute_promo(
  p_union_id uuid,
  p_target_kind text,          -- 'club' | 'agent'
  p_target_id uuid,            -- clubs.id, or the agent's user_id
  p_amount numeric,
  p_agent_club_id uuid DEFAULT NULL,   -- required when p_target_kind = 'agent'
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_actor  uuid;
  v_before numeric;
  v_after  numeric;
  v_club   uuid;
BEGIN
  v_actor := auth.uid();
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;
  IF p_target_kind NOT IN ('club', 'agent') THEN
    RETURN jsonb_build_object('success', false, 'error', 'target must be club or agent');
  END IF;

  -- Only the union owner (or a trusted service_role caller) may distribute.
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM unions WHERE id = p_union_id AND owner_id = v_actor
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'only the union owner may distribute promo');
    END IF;
  END IF;

  SELECT COALESCE(promo_wallet, 0) INTO v_before
    FROM unions WHERE id = p_union_id FOR UPDATE;
  IF v_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union not found');
  END IF;
  IF v_before < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient union promo balance',
                              'balance', v_before, 'requested', p_amount);
  END IF;

  IF p_target_kind = 'club' THEN
    -- The club must belong to this union.
    IF NOT EXISTS (SELECT 1 FROM clubs WHERE id = p_target_id AND union_id = p_union_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'club is not in this union');
    END IF;
    v_club := p_target_id;

    UPDATE clubs SET promo_balance = COALESCE(promo_balance, 0) + p_amount, updated_at = NOW()
     WHERE id = p_target_id
    RETURNING promo_balance INTO v_after;
  ELSE
    IF p_agent_club_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'p_agent_club_id required for agent target');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM clubs WHERE id = p_agent_club_id AND union_id = p_union_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'agent club is not in this union');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM club_members
       WHERE club_id = p_agent_club_id AND user_id = p_target_id
         AND role IN ('agent','super_agent','sub_agent','owner','co_owner','admin')
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'target is not an agent in that club');
    END IF;
    v_club := p_agent_club_id;

    UPDATE club_members
       SET promo_balance = COALESCE(promo_balance, 0) + p_amount, updated_at = NOW()
     WHERE club_id = p_agent_club_id AND user_id = p_target_id
    RETURNING promo_balance INTO v_after;
  END IF;

  UPDATE unions SET promo_wallet = promo_wallet - p_amount, updated_at = NOW()
   WHERE id = p_union_id;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_club, NULL,
    CASE WHEN p_target_kind = 'agent' THEN p_target_id ELSE NULL END,
    p_amount,
    'promo_union_to_' || p_target_kind,
    COALESCE(p_note, format('Union promo distribution to %s', p_target_kind)),
    v_after, NOW()
  );

  RETURN jsonb_build_object('success', true, 'amount', p_amount,
                            'target_kind', p_target_kind,
                            'union_balance_after', v_before - p_amount,
                            'target_balance_after', v_after);
END;
$function$;

-- ── 3. Close the from-nothing promo mint ────────────────────────────────────
-- mint_club_promo credited clubs.promo_balance out of thin air, which breaks the
-- rule that ALL promo derives from the BBJ. It is now inert and self-documenting.
CREATE OR REPLACE FUNCTION public.mint_club_promo(
  p_club_id uuid,
  p_amount numeric,
  p_type text DEFAULT 'bonus'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  RETURN jsonb_build_object(
    'success', false,
    'error', 'promo chips cannot be minted; all promo derives from the BBJ. '
             'Use fn_sweep_bbj_promo(club) then fn_union_distribute_promo(...).'
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_sweep_bbj_promo(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_sweep_bbj_promo(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.fn_union_distribute_promo(uuid, text, uuid, numeric, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_union_distribute_promo(uuid, text, uuid, numeric, uuid, text) TO authenticated, service_role;
