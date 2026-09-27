-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819224305 "fn_club_money_panel_for_wallet_widget"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6c37d398a4c0f4ffe956762e1d2dde5e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- WALLET PANEL AUDIT (2026-08-19) — one authoritative, permission-aware read
-- for the DynamicWallet widget.
--
-- WHY: the widget assembled its money rows from three direct table reads.
-- `union_wallets` is protected by RLS (union owner/admin only), so for a CLUB
-- owner inside a union every union row silently resolved to 0.00 — the panel
-- asserted "Union Bank 0.00 / Rake Treasury 0.00" as fact when the truth was
-- "you are not allowed to see this". It also read `clubs.chip_pool` (the
-- mint-and-distribute ledger of the ONE selected club) for the union variant's
-- "Clubs Wallet" row, which is not a union-level figure at all.
--
-- This returns everything the panel needs in ONE call, and — crucially — tells
-- the client WHICH scope it is allowed to render, so the UI can show "—"
-- (unknown) instead of inventing a zero.
--
--   scope 'union'  — union owner/admin: union bank, rake treasury, promo,
--                    clubs wallet (sum of member club treasuries)
--   scope 'club'   — club owner: this club's treasury/pool + this club's rake
--                    and projected rakeback (what the union owes THEM), but not
--                    the union's internal bank
--   scope 'member' — ordinary member: club/BBJ figures only
--   authorized=false — not a member of this club: nothing
--
-- BBJ is resolved with the same union-first rule the engine banks with, so the
-- widget can never show a stale club pool for a union club.

CREATE OR REPLACE FUNCTION public.fn_club_money_panel(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_union_id   uuid;
  v_club       record;
  v_is_member  boolean := false;
  v_is_club_staff boolean := false;
  v_is_union_staff boolean := false;
  v_scope      text;
  v_pool       record;
  v_w          record;
  v_week_start timestamptz := date_trunc('week', now());
  v_club_rake  numeric := 0;
  v_rate       numeric := 0.90;
  v_clubs_wallet numeric;
  v_union_week numeric;
  v_out        jsonb;
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

  SELECT EXISTS (SELECT 1 FROM club_members cm
                  WHERE cm.club_id = p_club_id AND cm.user_id = v_uid)
    INTO v_is_member;
  v_is_club_staff := (v_club.owner_id = v_uid)
    OR EXISTS (SELECT 1 FROM club_members cm
                WHERE cm.club_id = p_club_id AND cm.user_id = v_uid
                  AND lower(COALESCE(cm.role,'')) IN ('owner','admin','manager'));

  IF v_union_id IS NOT NULL THEN
    v_is_union_staff := EXISTS (SELECT 1 FROM unions u
                                 WHERE u.id = v_union_id AND u.owner_id = v_uid)
      OR EXISTS (SELECT 1 FROM union_admins ua
                  WHERE ua.union_id = v_union_id AND ua.user_id = v_uid);
  END IF;

  IF NOT (v_is_member OR v_is_club_staff OR v_is_union_staff) THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'not_a_member');
  END IF;

  v_scope := CASE WHEN v_is_union_staff THEN 'union'
                  WHEN v_is_club_staff  THEN 'club'
                  ELSE 'member' END;

  -- BBJ pool: union-first, exactly as the engine banks it.
  SELECT bp.id, COALESCE(bp.main_balance,0) main_balance,
         COALESCE(bp.backup_balance,0) backup_balance,
         COALESCE(bp.promo_balance,0) promo_balance,
         bp.union_id IS NOT NULL AS is_union_pool
    INTO v_pool
    FROM bbj_pools bp
   WHERE bp.status = 'active'
     AND ((v_union_id IS NOT NULL AND bp.union_id = v_union_id)
       OR (v_union_id IS NULL  AND bp.club_id = p_club_id))
   ORDER BY (bp.union_id IS NOT NULL) DESC
   LIMIT 1;

  v_out := jsonb_build_object(
    'authorized', true,
    'scope', v_scope,
    'club_id', p_club_id,
    'club_name', v_club.name,
    'in_union', v_union_id IS NOT NULL,
    'union_id', v_union_id,
    'club_treasury', round(v_club.chip_treasury, 2),
    'club_pool', round(v_club.chip_pool, 2),
    'bbj', jsonb_build_object(
      'pool_id', v_pool.id,
      'is_union_pool', COALESCE(v_pool.is_union_pool, false),
      'main', round(COALESCE(v_pool.main_balance,0), 2),
      'backup', round(COALESCE(v_pool.backup_balance,0), 2),
      'promo_in_pool', round(COALESCE(v_pool.promo_balance,0), 2)),
    'week_start', v_week_start,
    'next_close_at', v_week_start + interval '7 days');

  IF v_union_id IS NULL THEN
    RETURN v_out;  -- standalone club: no union rows exist to show
  END IF;

  -- This club's rake booked into the union treasury this week + what the
  -- Monday close will hand back to it. Club staff may always see their OWN
  -- figures; that is money owed to them.
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

  -- Union-internal figures are union staff only (mirrors union_wallets RLS).
  IF v_is_union_staff THEN
    SELECT round(COALESCE(chip_balance,0),2) chip_balance,
           round(COALESCE(rake_wallet,0),2) rake_wallet,
           round(COALESCE(promo_wallet,0),2) promo_wallet
      INTO v_w FROM union_wallets WHERE union_id = v_union_id;

    SELECT COALESCE(SUM(COALESCE(c.chip_treasury,0)), 0) INTO v_clubs_wallet
      FROM clubs c WHERE c.union_id = v_union_id AND c.id <> v_union_id;

    SELECT COALESCE(SUM(t.amount), 0) INTO v_union_week
      FROM union_wallet_transactions t
     WHERE t.union_id = v_union_id
       AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
       AND t.created_at >= v_week_start;

    v_out := v_out || jsonb_build_object(
      'union_bank', COALESCE(v_w.chip_balance, 0),
      'rake_treasury', COALESCE(v_w.rake_wallet, 0),
      'union_promo', COALESCE(v_w.promo_wallet, 0),
      -- The rake treasury is a SUB-ACCOUNT of the union bank, not a sibling
      -- pot. Give the client the un-earmarked remainder explicitly so the two
      -- can never be read as separate money that sums.
      'union_bank_unreserved', round(COALESCE(v_w.chip_balance,0) - COALESCE(v_w.rake_wallet,0), 2),
      'clubs_wallet', round(v_clubs_wallet, 2),
      'union_rake_this_week', round(v_union_week, 2),
      'projected_clubs_share', trunc(v_union_week * 0.90 * 100) / 100,
      'projected_union_share', round(v_union_week - trunc(v_union_week * 0.90 * 100) / 100, 2));
  END IF;

  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION public.fn_club_money_panel(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_money_panel(uuid) TO authenticated, service_role;
