-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815191553 "promo_canonical_union_wallets_correction"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 692e3a63209faf8d830b1361af818a3c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- CORRECTION: union money lives in public.union_wallets, not unions.*
-- ═══════════════════════════════════════════════════════════════════════════
-- The promo work landed on unions.promo_wallet / unions.chip_balance. Those are
-- the STALE duplicates. Live data proves union_wallets is canonical:
--     unions.chip_balance        = 0.00
--     union_wallets.chip_balance = 989,097.78   <-- the real union bank
-- and /api/club-arena/union-wallet get_balances reads union_wallets.
--
-- Consequences being fixed here:
--  1. fn_sweep_bbj_promo_all credited unions.promo_wallet, so the 26,422.58 it
--     swept was invisible to the union wallet UI. Migrated below.
--  2. fn_union_fund_promo_from_bank debited unions.chip_balance (0), so an owner
--     top-up would ALWAYS have failed "insufficient union bank balance".
--  3. fn_union_distribute_promo spent from unions.promo_wallet.
-- All three now read and write union_wallets. The lifetime provenance counters
-- stay on `unions` (they are counters, not balances).

-- ── 0. Migrate the already-swept promo onto the canonical table ─────────────
INSERT INTO union_wallets (union_id, promo_wallet)
SELECT u.id, COALESCE(u.promo_wallet, 0)
  FROM unions u
 WHERE COALESCE(u.promo_wallet, 0) > 0
ON CONFLICT (union_id) DO UPDATE
  SET promo_wallet = COALESCE(union_wallets.promo_wallet, 0) + EXCLUDED.promo_wallet;

UPDATE unions SET promo_wallet = 0 WHERE COALESCE(promo_wallet, 0) > 0;

COMMENT ON COLUMN public.unions.promo_wallet IS
  'DEPRECATED 2026-08-15. Union promo lives on union_wallets.promo_wallet. Kept at 0.';
COMMENT ON COLUMN public.unions.chip_balance IS
  'DEPRECATED 2026-08-15. Union bank lives on union_wallets.chip_balance.';

-- ── 1. Sweep -> union_wallets.promo_wallet ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sweep_bbj_promo_all()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  r record; v_promo numeric; v_union_id uuid; v_after numeric;
  v_swept numeric := 0; v_pools int := 0; v_to_union int := 0; v_to_club int := 0; v_err int := 0;
BEGIN
  FOR r IN SELECT id, club_id, union_id FROM bbj_pools
            WHERE COALESCE(promo_balance,0) > 0 ORDER BY id
  LOOP
    BEGIN
      SELECT COALESCE(promo_balance,0) INTO v_promo FROM bbj_pools WHERE id=r.id FOR UPDATE;
      IF v_promo <= 0 THEN CONTINUE; END IF;

      v_union_id := r.union_id;
      IF v_union_id IS NULL AND r.club_id IS NOT NULL THEN
        SELECT union_id INTO v_union_id FROM clubs WHERE id = r.club_id;
      END IF;

      UPDATE bbj_pools SET promo_balance = 0, updated_at = NOW() WHERE id = r.id;

      IF v_union_id IS NOT NULL THEN
        INSERT INTO union_wallets (union_id, promo_wallet) VALUES (v_union_id, v_promo)
        ON CONFLICT (union_id) DO UPDATE
          SET promo_wallet = COALESCE(union_wallets.promo_wallet,0) + EXCLUDED.promo_wallet
        RETURNING promo_wallet INTO v_after;

        IF v_after IS NULL THEN
          UPDATE bbj_pools SET promo_balance = v_promo WHERE id = r.id;
          v_err := v_err + 1; CONTINUE;
        END IF;

        UPDATE unions SET promo_funded_from_bbj = COALESCE(promo_funded_from_bbj,0) + v_promo,
                          updated_at = NOW()
         WHERE id = v_union_id;

        INSERT INTO union_wallet_transactions
          (id, union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes, created_at)
        VALUES (gen_random_uuid(), v_union_id, 'promo_wallet', 'credit', v_promo, v_after,
                'bbj_promo_sweep', r.club_id,
                'BBJ promo slice (25% of contribution) swept from pool', NOW());
        v_to_union := v_to_union + 1;

      ELSIF r.club_id IS NOT NULL THEN
        UPDATE clubs SET promo_balance = COALESCE(promo_balance,0) + v_promo, updated_at = NOW()
         WHERE id = r.club_id RETURNING promo_balance INTO v_after;
        IF v_after IS NULL THEN
          UPDATE bbj_pools SET promo_balance = v_promo WHERE id = r.id;
          v_err := v_err + 1; CONTINUE;
        END IF;
        INSERT INTO chip_transactions (id, club_id, from_user_id, to_user_id, amount,
                                       transaction_type, notes, balance_after, created_at)
        VALUES (gen_random_uuid(), r.club_id, NULL, NULL, v_promo, 'bbj_promo_sweep',
                'BBJ promo slice swept to club promo wallet (club has no union)', v_after, NOW());
        v_to_club := v_to_club + 1;
      ELSE
        UPDATE bbj_pools SET promo_balance = v_promo WHERE id = r.id;
        v_err := v_err + 1; CONTINUE;
      END IF;

      v_swept := v_swept + v_promo; v_pools := v_pools + 1;
    EXCEPTION WHEN OTHERS THEN v_err := v_err + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'pools_swept', v_pools, 'total_swept', v_swept,
                            'to_union', v_to_union, 'to_club', v_to_club, 'errors', v_err);
END;
$function$;

-- ── 2. Owner bank top-up on union_wallets ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_union_fund_promo_from_bank(
  p_union_id uuid, p_amount numeric, p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_actor uuid; v_bank numeric; v_promo numeric;
BEGIN
  v_actor := auth.uid();
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  IF COALESCE(auth.role(),'') <> 'service_role' THEN
    IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM unions WHERE id=p_union_id AND owner_id=v_actor) THEN
      RETURN jsonb_build_object('success', false, 'error', 'only the union owner may fund the promo wallet');
    END IF;
  END IF;

  SELECT COALESCE(chip_balance,0), COALESCE(promo_wallet,0) INTO v_bank, v_promo
    FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_bank IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union wallet not found');
  END IF;
  IF v_bank < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient union bank balance',
                              'bank_balance', v_bank, 'requested', p_amount);
  END IF;

  UPDATE union_wallets
     SET chip_balance = chip_balance - p_amount,
         promo_wallet = COALESCE(promo_wallet,0) + p_amount
   WHERE union_id = p_union_id;

  UPDATE unions SET promo_funded_from_bank = COALESCE(promo_funded_from_bank,0) + p_amount,
                    updated_at = NOW()
   WHERE id = p_union_id;

  INSERT INTO union_wallet_transactions
    (id, union_id, wallet, direction, amount, balance_after, tx_type, notes, created_by, created_at)
  VALUES
    (gen_random_uuid(), p_union_id, 'chip_balance', 'debit',  p_amount, v_bank - p_amount,
     'promo_bank_topup', COALESCE(p_note,'Owner funded promo wallet from main bank'), v_actor, NOW()),
    (gen_random_uuid(), p_union_id, 'promo_wallet', 'credit', p_amount, v_promo + p_amount,
     'promo_bank_topup', COALESCE(p_note,'Owner funded promo wallet from main bank'), v_actor, NOW());

  RETURN jsonb_build_object('success', true, 'amount', p_amount,
                            'bank_after', v_bank - p_amount, 'promo_after', v_promo + p_amount);
END;
$function$;

-- ── 3. Union distribution spends from union_wallets ────────────────────────
CREATE OR REPLACE FUNCTION public.fn_union_distribute_promo(
  p_union_id uuid, p_target_kind text, p_target_id uuid, p_amount numeric,
  p_agent_club_id uuid DEFAULT NULL, p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_actor uuid; v_before numeric; v_after numeric; v_club uuid;
BEGIN
  v_actor := auth.uid();
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;
  IF p_target_kind NOT IN ('club','agent') THEN
    RETURN jsonb_build_object('success', false, 'error', 'target must be club or agent');
  END IF;

  IF COALESCE(auth.role(),'') <> 'service_role' THEN
    IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM unions WHERE id=p_union_id AND owner_id=v_actor) THEN
      RETURN jsonb_build_object('success', false, 'error', 'only the union owner may distribute promo');
    END IF;
  END IF;

  SELECT COALESCE(promo_wallet,0) INTO v_before
    FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union wallet not found');
  END IF;
  IF v_before < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient union promo balance',
                              'balance', v_before, 'requested', p_amount);
  END IF;

  IF p_target_kind = 'club' THEN
    IF NOT EXISTS (SELECT 1 FROM clubs WHERE id=p_target_id AND union_id=p_union_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'club is not in this union');
    END IF;
    v_club := p_target_id;
    UPDATE clubs SET promo_balance = COALESCE(promo_balance,0) + p_amount, updated_at = NOW()
     WHERE id = p_target_id RETURNING promo_balance INTO v_after;
  ELSE
    IF p_agent_club_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'p_agent_club_id required for agent target');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM clubs WHERE id=p_agent_club_id AND union_id=p_union_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'agent club is not in this union');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM club_members WHERE club_id=p_agent_club_id AND user_id=p_target_id
                     AND role IN ('agent','super_agent','sub_agent','owner','co_owner','admin')) THEN
      RETURN jsonb_build_object('success', false, 'error', 'target is not an agent in that club');
    END IF;
    v_club := p_agent_club_id;
    UPDATE club_members SET promo_balance = COALESCE(promo_balance,0) + p_amount, updated_at = NOW()
     WHERE club_id = p_agent_club_id AND user_id = p_target_id RETURNING promo_balance INTO v_after;
  END IF;

  UPDATE union_wallets SET promo_wallet = promo_wallet - p_amount WHERE union_id = p_union_id;

  INSERT INTO union_wallet_transactions
    (id, union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes, created_by, created_at)
  VALUES (gen_random_uuid(), p_union_id, 'promo_wallet', 'debit', p_amount, v_before - p_amount,
          'promo_union_to_' || p_target_kind, v_club,
          COALESCE(p_note, format('Union promo distribution to %s', p_target_kind)), v_actor, NOW());

  RETURN jsonb_build_object('success', true, 'amount', p_amount, 'target_kind', p_target_kind,
                            'union_balance_after', v_before - p_amount, 'target_balance_after', v_after);
END;
$function$;
