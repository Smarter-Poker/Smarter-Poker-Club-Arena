-- =============================================================================
-- the_club_promo_wallet_the_bbj_has_been_funding_all_along
-- Applied to production via Supabase MCP 2026-09-02.
--
-- Dan, 2026-09-02, verbatim: "NONE OF THE CHIPS FROM THE BBJ RAKE ARE GOING
-- INTO THE PROMO WALLET, GET TO THE ROOT CAUSE OF WHY THATS NOT HAPPENING AND
-- FIX IT PLEASE. THIS NEEDS TO BE STANDARD AND HARD WIRED INTO EVERY CLUB,
-- OLD AND NEW."
--
-- They ARE going in. Measured on Deep Stack Society at 22:25 UTC:
--   bbj_contributions: 14,341 hands, 4,928.83 dropped,
--     main 2,464.52 / backup 1,233.18 / promo 1,231.13   (50/25/25, correct)
--   bbj_pools:        main_balance 3,438.53 (1,000 seed + accrual),
--                     backup_balance 1,219.26, promo_balance 14.78
--   clubs.promo_balance: 1,220.19  <- the promo slice, swept and banked
--
-- fn_sweep_bbj_promo has been running all along (684 club sweeps, 29,962.67;
-- 4,848 union sweeps, 57,806.50). The slice lands in clubs.promo_balance for a
-- standalone club and union_wallets.promo_wallet for a club in a union.
--
-- The bug is that NOTHING COULD READ THE CLUB ONE. fn_club_money_panel returns
-- club_treasury, club_pool, club_rake_treasury, the BBJ pool and - for union
-- staff - union_promo, but never clubs.promo_balance. So DynamicWallet had
-- nothing to put in a club Promo Wallet row and fell back to the VIEWER'S own
-- agents.promo_wallet_balance, which is 0.00 for an owner who is not an agent:
-- 1,220.19 of real club money, banked correctly and invisible on every surface.
--
-- This adds club_promo_wallet to the panel, beside club_treasury and at the
-- same sensitivity. Club-scoped by the wallet separation law: a club inside a
-- union banks its promo slice in the UNION wallet, so this reads 0 there and
-- union_promo continues to carry the union figure for union staff.
--
-- Every other line of the body is byte-identical to production as read back
-- on 2026-09-02.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_club_money_panel(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_union_id uuid; v_club record;
  v_is_member boolean := false; v_is_club_staff boolean := false; v_is_union_staff boolean := false;
  v_scope text; v_pool record; v_w record;
  v_week_start timestamptz := date_trunc('week', now());
  v_club_rake numeric := 0; v_rate numeric := 0.90;
  v_clubs_wallet numeric; v_union_week numeric; v_out jsonb;
  v_spin_idle numeric := 0; v_spin_deployed numeric := 0;
  v_bbj jsonb;
BEGIN
  IF v_uid IS NULL OR p_club_id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'no_auth');
  END IF;

  SELECT id, name, union_id, COALESCE(chip_treasury,0) AS chip_treasury,
         COALESCE(chip_pool,0) AS chip_pool, COALESCE(promo_balance,0) AS promo_balance,
         owner_id
    INTO v_club FROM clubs WHERE id = p_club_id;
  IF v_club.id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'club_not_found');
  END IF;
  v_union_id := v_club.union_id;

  -- The jackpot, resolved BEFORE the membership gate. Union-first, exactly as
  -- the engine banks it: a club inside a union contributes to the UNION pool.
  SELECT bp.id, COALESCE(bp.main_balance,0) main_balance,
         COALESCE(bp.backup_balance,0) backup_balance,
         COALESCE(bp.promo_balance,0) promo_balance,
         bp.union_id IS NOT NULL AS is_union_pool
    INTO v_pool FROM bbj_pools bp
   WHERE bp.status = 'active'
     AND ((v_union_id IS NOT NULL AND bp.union_id = v_union_id)
       OR (v_union_id IS NULL  AND bp.club_id = p_club_id))
   ORDER BY (bp.union_id IS NOT NULL) DESC LIMIT 1;

  v_bbj := jsonb_build_object(
    'pool_id', v_pool.id, 'is_union_pool', COALESCE(v_pool.is_union_pool, false),
    'main', round(COALESCE(v_pool.main_balance,0), 2),
    'backup', round(COALESCE(v_pool.backup_balance,0), 2),
    'promo_in_pool', round(COALESCE(v_pool.promo_balance,0), 2));

  SELECT EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = p_club_id AND cm.user_id = v_uid)
    INTO v_is_member;
  v_is_club_staff := (v_club.owner_id = v_uid)
    OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = p_club_id AND cm.user_id = v_uid
                 AND lower(COALESCE(cm.role,'')) IN ('owner','co_owner','admin','manager'));

  IF v_union_id IS NOT NULL THEN
    v_is_union_staff := EXISTS (SELECT 1 FROM unions u WHERE u.id = v_union_id AND u.owner_id = v_uid)
      OR EXISTS (SELECT 1 FROM union_admins ua WHERE ua.union_id = v_union_id AND ua.user_id = v_uid);
  END IF;

  IF NOT (v_is_member OR v_is_club_staff OR v_is_union_staff) THEN
    -- Still a refusal in every respect the caller relies on: `scope` is absent,
    -- so club money renders "-" and never 0.00. Only the public jackpot rides
    -- along.
    RETURN jsonb_build_object('authorized', false, 'reason', 'not_a_member',
                              'bbj', v_bbj);
  END IF;

  v_scope := CASE WHEN v_is_union_staff THEN 'union'
                  WHEN v_is_club_staff  THEN 'club' ELSE 'member' END;

  v_out := jsonb_build_object(
    'authorized', true, 'scope', v_scope, 'club_id', p_club_id, 'club_name', v_club.name,
    'in_union', v_union_id IS NOT NULL, 'union_id', v_union_id,
    'club_treasury', round(v_club.chip_treasury, 2), 'club_pool', round(v_club.chip_pool, 2),
    /* THE CLUB'S PROMO WALLET (Dan, 2026-09-02): "NONE OF THE CHIPS FROM THE
       BBJ RAKE ARE GOING INTO THE PROMO WALLET." They were. Every hand's BBJ
       drop splits 50/25/25 main/backup/promo (bbj_record_contribution), and
       fn_sweep_bbj_promo moves the promo slice out of the pool into
       clubs.promo_balance for a standalone club - 1,220.19 of it in Deep
       Stack Society alone. This panel never returned that column, so no
       surface could show it and the club's Promo Wallet row fell back to the
       VIEWER'S OWN agents.promo_wallet_balance, which reads 0.00 for an owner
       who is not an agent. Club money, at exactly the sensitivity of
       club_treasury beside it, and club-scoped: a club inside a union banks
       its promo slice in the UNION wallet, so this is honestly 0 there and
       'union_promo' below carries the union's figure for union staff. */
    'club_promo_wallet', round(COALESCE(v_club.promo_balance, 0), 2),
    'bbj', v_bbj,
    'week_start', v_week_start, 'next_close_at', v_week_start + interval '7 days');

  IF v_union_id IS NULL THEN
    IF v_is_club_staff THEN
      SELECT round(COALESCE(w.period_rake_collected, 0), 2) INTO v_club_rake
        FROM club_wallets w WHERE w.club_id = p_club_id;
      IF FOUND THEN
        v_out := v_out || jsonb_build_object('club_rake_treasury', v_club_rake);
      END IF;
    END IF;
    RETURN v_out;
  END IF;

  IF v_is_club_staff OR v_is_union_staff THEN
    SELECT COALESCE(
             (SELECT w.rake_total FROM union_rake_weekly w
               WHERE w.union_id = v_union_id AND w.club_id = p_club_id
                 AND w.week_start = v_week_start::date),
             (SELECT COALESCE(SUM(t.amount), 0) FROM union_wallet_transactions t
               WHERE t.union_id = v_union_id AND t.club_id = p_club_id
                 AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
                 AND t.created_at >= v_week_start),
             0) INTO v_club_rake;
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
           round(COALESCE(promo_wallet,0),2) promo_wallet,
           round(COALESCE(spin_reserve_wallet,0),2) spin_reserve_wallet
      INTO v_w FROM union_wallets WHERE union_id = v_union_id;

    SELECT COALESCE(SUM(COALESCE(c.chip_treasury,0)), 0) INTO v_clubs_wallet
      FROM clubs c WHERE c.union_id = v_union_id AND c.id <> v_union_id;

    SELECT COALESCE(
             (SELECT SUM(w.rake_total) FROM union_rake_weekly w
               WHERE w.union_id = v_union_id AND w.week_start = v_week_start::date),
             (SELECT COALESCE(SUM(t.amount), 0) FROM union_wallet_transactions t
               WHERE t.union_id = v_union_id AND t.wallet = 'rake_wallet'
                 AND t.direction = 'credit' AND t.tx_type = 'rake' AND t.created_at >= v_week_start),
             0) INTO v_union_week;

    v_spin_idle := COALESCE(v_w.spin_reserve_wallet, 0);
    SELECT COALESCE(SUM(COALESCE(sp.balance, 0)), 0) INTO v_spin_deployed
      FROM spin_bonus_pools sp
     WHERE sp.is_active
       AND (sp.club_id = v_union_id
            OR sp.club_id IN (SELECT uc.club_id FROM union_clubs uc WHERE uc.union_id = v_union_id));

    v_out := v_out || jsonb_build_object(
      'union_bank', COALESCE(v_w.chip_balance, 0),
      'rake_treasury', COALESCE(v_w.rake_wallet, 0),
      'union_promo', COALESCE(v_w.promo_wallet, 0),
      'union_spin_treasury', round(v_spin_idle + v_spin_deployed, 2),
      'union_spin_idle', round(v_spin_idle, 2),
      'union_spin_deployed', round(v_spin_deployed, 2),
      'clubs_wallet', round(v_clubs_wallet, 2),
      'union_rake_this_week', round(v_union_week, 2),
      'projected_clubs_share', trunc(v_union_week * 0.90 * 100) / 100,
      'projected_union_share', round(v_union_week - trunc(v_union_week * 0.90 * 100) / 100, 2));
  END IF;

  RETURN v_out;
END
$function$;