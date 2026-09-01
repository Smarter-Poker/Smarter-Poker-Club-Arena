-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826032902; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- THE JACKPOT IS THE SAME NUMBER FOR EVERYONE WHO CAN SEE THE LOBBY
-- Dan 2026-08-25, binding: "all accounts, regardless of role, need to show the
-- same data, bbj, games, mtt's etc." The difference was MEMBERSHIP, not role:
-- fn_club_money_panel refused non-members with a payload carrying nothing, so
-- DynamicWallet's banner rendered "-" over a lobby listing 178 live games.
-- bbj_pools is world-readable by policy and the lobby ticker reads it directly
-- with the anon key; the panel was the only surface pretending otherwise.
-- Resolve the pool BEFORE the membership gate and return it on refusal too.
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
         COALESCE(chip_pool,0) AS chip_pool, owner_id
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
                 AND lower(COALESCE(cm.role,'')) IN ('owner','admin','manager'));

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

DO $$
DECLARE v_main numeric;
BEGIN
  SELECT round(COALESCE(bp.main_balance, 0), 2) INTO v_main
    FROM bbj_pools bp
   WHERE bp.status = 'active' AND bp.union_id = 'fade0000-0000-0000-0000-000000000001';
  IF v_main IS NULL OR v_main <= 0 THEN
    RAISE EXCEPTION 'Expected an active union BBJ pool with a positive balance; got %', v_main;
  END IF;
END $$;
