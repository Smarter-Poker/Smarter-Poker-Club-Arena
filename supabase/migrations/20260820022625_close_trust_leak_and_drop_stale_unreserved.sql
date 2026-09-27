-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820022625 "close_trust_leak_and_drop_stale_unreserved"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d1d2ca3d7c51df35da924bbaf6f040a3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Follow-up audit of my OWN change (rake_lands_only_in_rake_treasury_not_union_bank).
-- Separating the two accounts left two things behind that no longer make sense.
--
-- ── 1. fn_union_move_rake_to_chips_atomic is now a TRUST LEAK ──────────────
--
-- It moves rake_wallet -> chip_balance. Under the old nested model that merely
-- "converted" held rake into spendable form. Now that the treasury holds money
-- in trust for the clubs, this lets a union admin move the clubs' 90% into the
-- union's own bank BEFORE the weekly close, and then spend it via
-- fn_union_send_to_club_atomic / fn_union_fund_bbj_pool, both of which draw on
-- chip_balance. The close would then hit 'insufficient_treasury' and pay nobody.
--
-- It is reachable in production: World Hub route pages/api/club-arena/
-- union-wallet.js exposes action 'move_rake_to_chips', called by
-- UnionApiService.moveRakeToChips.
--
-- There is no longer any legitimate use for it: the weekly close moves the
-- union's retained share into the bank by itself, which is the only rake the
-- union is entitled to. It now refuses.
--
-- ── 2. union_bank_unreserved is meaningless (and negative) ─────────────────
--
-- fn_club_money_panel computed chip_balance - rake_wallet to tell the UI how
-- much of the bank was NOT earmarked. With the accounts separated that reads
-- 120,895.24 - 512,858.09 = -391,962.85: a nonsense figure. Every chip in the
-- bank is now unreserved by definition, so the key is removed rather than left
-- to mislead a future consumer.

CREATE OR REPLACE FUNCTION public.fn_union_move_rake_to_chips_atomic(
  p_union_id uuid, p_amount numeric, p_op_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL, p_created_by uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  RETURN jsonb_build_object(
    'success', false,
    'error', 'retired_rake_is_held_in_trust',
    'detail', 'The Rake Treasury holds the member clubsّ rake until the weekly '
           || 'close, which returns 90% to the clubs and moves the union''s '
           || 'retained share into the Union Bank automatically. Moving rake '
           || 'into the bank by hand would spend money that belongs to the clubs.'
  );
END $$;

REVOKE ALL ON FUNCTION public.fn_union_move_rake_to_chips_atomic(uuid, numeric, uuid, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_move_rake_to_chips_atomic(uuid, numeric, uuid, text, uuid) TO service_role;

-- Drop the stale key from the wallet panel payload.
CREATE OR REPLACE FUNCTION public.fn_club_money_panel(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_union_id uuid; v_club record;
  v_is_member boolean := false; v_is_club_staff boolean := false; v_is_union_staff boolean := false;
  v_scope text; v_pool record; v_w record;
  v_week_start timestamptz := date_trunc('week', now());
  v_club_rake numeric := 0; v_rate numeric := 0.90;
  v_clubs_wallet numeric; v_union_week numeric; v_out jsonb;
BEGIN
  IF v_uid IS NULL OR p_club_id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'no_auth');
  END IF;

  SELECT id, name, union_id, COALESCE(chip_treasury,0) AS chip_treasury,
         COALESCE(chip_pool,0) AS chip_pool, owner_id
    INTO v_club FROM clubs WHERE id = p_club_id;
  IF v_club.id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'club_not_found');
  END IF;
  v_union_id := v_club.union_id;

  SELECT EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = p_club_id AND cm.user_id = v_uid)
    INTO v_is_member;
  v_is_club_staff := (v_club.owner_id = v_uid)
    OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = p_club_id AND cm.user_id = v_uid
                 AND lower(COALESCE(cm.role,'')) IN ('owner','admin','manager'));

  IF v_union_id IS NOT NULL THEN
    v_is_union_staff := EXISTS (SELECT 1 FROM unions u WHERE u.id = v_union_id AND u.owner_id = v_uid)
      OR EXISTS (SELECT 1 FROM union_admins ua WHERE ua.union_id = v_union_id AND ua.user_id = v_uid);
  END IF;

  IF NOT (v_is_member OR v_is_club_staff OR v_is_union_staff) THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'not_a_member');
  END IF;

  v_scope := CASE WHEN v_is_union_staff THEN 'union'
                  WHEN v_is_club_staff  THEN 'club' ELSE 'member' END;

  SELECT bp.id, COALESCE(bp.main_balance,0) main_balance,
         COALESCE(bp.backup_balance,0) backup_balance,
         COALESCE(bp.promo_balance,0) promo_balance,
         bp.union_id IS NOT NULL AS is_union_pool
    INTO v_pool FROM bbj_pools bp
   WHERE bp.status = 'active'
     AND ((v_union_id IS NOT NULL AND bp.union_id = v_union_id)
       OR (v_union_id IS NULL  AND bp.club_id = p_club_id))
   ORDER BY (bp.union_id IS NOT NULL) DESC LIMIT 1;

  v_out := jsonb_build_object(
    'authorized', true, 'scope', v_scope, 'club_id', p_club_id, 'club_name', v_club.name,
    'in_union', v_union_id IS NOT NULL, 'union_id', v_union_id,
    'club_treasury', round(v_club.chip_treasury, 2), 'club_pool', round(v_club.chip_pool, 2),
    'bbj', jsonb_build_object(
      'pool_id', v_pool.id, 'is_union_pool', COALESCE(v_pool.is_union_pool, false),
      'main', round(COALESCE(v_pool.main_balance,0), 2),
      'backup', round(COALESCE(v_pool.backup_balance,0), 2),
      'promo_in_pool', round(COALESCE(v_pool.promo_balance,0), 2)),
    'week_start', v_week_start, 'next_close_at', v_week_start + interval '7 days');

  IF v_union_id IS NULL THEN RETURN v_out; END IF;

  IF v_is_club_staff OR v_is_union_staff THEN
    SELECT COALESCE(SUM(t.amount), 0) INTO v_club_rake
      FROM union_wallet_transactions t
     WHERE t.union_id = v_union_id AND t.club_id = p_club_id
       AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
       AND t.created_at >= v_week_start;
    SELECT COALESCE(uc.club_commission_rate, 0.90) INTO v_rate
      FROM union_clubs uc WHERE uc.union_id = v_union_id AND uc.club_id = p_club_id;
    v_out := v_out || jsonb_build_object(
      'club_rake_this_week', round(v_club_rake, 2),
      'club_rakeback_rate', COALESCE(v_rate, 0.90),
      'club_projected_rakeback', trunc(v_club_rake * COALESCE(v_rate, 0.90) * 100) / 100);
  END IF;

  IF v_is_union_staff THEN
    SELECT round(COALESCE(chip_balance,0),2) chip_balance,
           round(COALESCE(rake_wallet,0),2) rake_wallet,
           round(COALESCE(promo_wallet,0),2) promo_wallet
      INTO v_w FROM union_wallets WHERE union_id = v_union_id;

    SELECT COALESCE(SUM(COALESCE(c.chip_treasury,0)), 0) INTO v_clubs_wallet
      FROM clubs c WHERE c.union_id = v_union_id AND c.id <> v_union_id;

    SELECT COALESCE(SUM(t.amount), 0) INTO v_union_week
      FROM union_wallet_transactions t
     WHERE t.union_id = v_union_id AND t.wallet = 'rake_wallet'
       AND t.direction = 'credit' AND t.tx_type = 'rake' AND t.created_at >= v_week_start;

    -- NOTE: union_bank_unreserved deliberately removed. The Rake Treasury is no
    -- longer a slice of the bank, so "bank minus treasury" is not a quantity —
    -- it evaluated to -391,962.85 the moment the accounts were separated.
    v_out := v_out || jsonb_build_object(
      'union_bank', COALESCE(v_w.chip_balance, 0),
      'rake_treasury', COALESCE(v_w.rake_wallet, 0),
      'union_promo', COALESCE(v_w.promo_wallet, 0),
      'clubs_wallet', round(v_clubs_wallet, 2),
      'union_rake_this_week', round(v_union_week, 2),
      'projected_clubs_share', trunc(v_union_week * 0.90 * 100) / 100,
      'projected_union_share', round(v_union_week - trunc(v_union_week * 0.90 * 100) / 100, 2));
  END IF;

  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION public.fn_club_money_panel(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_money_panel(uuid) TO authenticated, service_role;
