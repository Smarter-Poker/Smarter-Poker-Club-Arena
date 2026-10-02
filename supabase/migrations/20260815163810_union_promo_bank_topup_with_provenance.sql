-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815163810 "union_promo_bank_topup_with_provenance"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7914d2d5bcf8e26387dd81d9a62cf3a6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Union owners may top the promo wallet up from their OWN main bank.
-- ═══════════════════════════════════════════════════════════════════════════
-- Clarification from Dan (2026-08-15): a union owner CAN add chips to the promo
-- wallet from their main bank; it just has to be tracked and accounted for. The
-- BBJ remains the MAIN source.
--
-- This is a TRANSFER, not a mint: chips move unions.chip_balance ->
-- unions.promo_wallet, so the union's total holding is unchanged and no new
-- chips enter the economy. Minting promo from nothing stays forbidden
-- (mint_club_promo remains inert).
--
-- PROVENANCE: two lifetime counters make the split auditable at a glance, and
-- every movement still writes a chip_transactions row
-- ('bbj_promo_sweep' vs 'promo_bank_topup').

ALTER TABLE public.unions
  ADD COLUMN IF NOT EXISTS promo_funded_from_bbj  numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS promo_funded_from_bank numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.unions.promo_funded_from_bbj IS
  'Lifetime promo chips received from the BBJ 25% slice via fn_sweep_bbj_promo. The main source.';
COMMENT ON COLUMN public.unions.promo_funded_from_bank IS
  'Lifetime promo chips moved in from unions.chip_balance by the owner via fn_union_fund_promo_from_bank. A transfer, never a mint.';

-- ── Owner tops promo wallet up from the union main bank ─────────────────────
CREATE OR REPLACE FUNCTION public.fn_union_fund_promo_from_bank(
  p_union_id uuid,
  p_amount numeric,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_actor        uuid;
  v_bank_before  numeric;
  v_promo_before numeric;
BEGIN
  v_actor := auth.uid();

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  -- Union owner only (service_role callers have authorized upstream).
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM unions WHERE id = p_union_id AND owner_id = v_actor
    ) THEN
      RETURN jsonb_build_object('success', false,
        'error', 'only the union owner may fund the promo wallet');
    END IF;
  END IF;

  SELECT COALESCE(chip_balance, 0), COALESCE(promo_wallet, 0)
    INTO v_bank_before, v_promo_before
    FROM unions WHERE id = p_union_id FOR UPDATE;

  IF v_bank_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union not found');
  END IF;

  IF v_bank_before < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient union bank balance',
                              'bank_balance', v_bank_before, 'requested', p_amount);
  END IF;

  -- Conserving move: bank -> promo, plus the provenance counter.
  UPDATE unions
     SET chip_balance           = chip_balance - p_amount,
         promo_wallet           = COALESCE(promo_wallet, 0) + p_amount,
         promo_funded_from_bank = COALESCE(promo_funded_from_bank, 0) + p_amount,
         updated_at             = NOW()
   WHERE id = p_union_id;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), NULL, v_actor, NULL, p_amount,
    'promo_bank_topup',
    COALESCE(p_note, 'Union owner funded promo wallet from main bank'),
    v_promo_before + p_amount, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'bank_after', v_bank_before - p_amount,
    'promo_after', v_promo_before + p_amount
  );
END;
$function$;

-- ── Sweep now records BBJ provenance too ────────────────────────────────────
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

  UPDATE bbj_pools SET promo_balance = 0, updated_at = NOW() WHERE id = v_pool_id;

  IF v_union_id IS NOT NULL THEN
    UPDATE unions
       SET promo_wallet          = COALESCE(promo_wallet, 0) + v_promo,
           promo_funded_from_bbj = COALESCE(promo_funded_from_bbj, 0) + v_promo,
           updated_at            = NOW()
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

REVOKE EXECUTE ON FUNCTION public.fn_union_fund_promo_from_bank(uuid, numeric, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_union_fund_promo_from_bank(uuid, numeric, text) TO authenticated, service_role;
