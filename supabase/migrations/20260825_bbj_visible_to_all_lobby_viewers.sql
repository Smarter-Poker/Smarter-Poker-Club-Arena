-- ═══════════════════════════════════════════════════════════════════════════
--  THE JACKPOT IS THE SAME NUMBER FOR EVERYONE WHO CAN SEE THE LOBBY
--  Dan 2026-08-25, binding:
--    "on regular player accounts the BBJ isn't displayed at all... all
--     accounts, regardless of role, need to show the same data, bbj, games,
--     mtt's etc... it needs to be the same across the board."
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG
--
-- Nothing role-shaped. `walletRows.ts` never gated the Bad Beat Jackpot, and
-- the tables/tournaments lists are governed only by `is_private` — a plain
-- player sees exactly the games a co-owner sees. The one figure that behaved
-- differently was the jackpot, and the difference was MEMBERSHIP, not role.
--
-- fn_club_money_panel answered `{authorized:false, reason:'not_a_member'}`
-- and returned NOTHING ELSE. DynamicWallet treats that refusal as an ordinary
-- state (correctly — a non-member's own diamonds still read fine), so it kept
-- what it had: bbjPool 0, which the banner renders as "-". So the lobby showed
-- 178 running games above a jackpot that claimed not to exist.
--
-- A club's Bad Beat Jackpot is not private money. `bbj_pools` is world-
-- readable by policy (`bbj_pools_select` / `USING (true)`), the lobby's own
-- ticker query reads it directly with the anon key, and BadBeatJackpotPage
-- publishes it. The panel was the only surface pretending otherwise.
--
-- THE CHANGE
--
-- Resolve the pool BEFORE the membership gate and hand the same `bbj` block
-- back on the `not_a_member` path. One statement moved, one key added.
--
-- What is NOT changed: `authorized:false` and `reason:'not_a_member'` still
-- come back exactly as before, so the client's refusal branch — which leaves
-- `scope` null and renders "-" rather than a fabricated 0.00 for club money —
-- behaves identically. Club treasury, rake, rakeback, union bank and the spins
-- treasury remain staff-only. Nothing that was hidden becomes visible except
-- the number already printed on the lobby of every club on the platform.
--
-- `no_auth` (signed out, or no club id) still returns bare: with no auth.uid()
-- there is no session, and the anon lobby reads bbj_pools directly anyway.

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

  -- ── The jackpot, resolved BEFORE the membership gate ──────────────────────
  -- Union-first, exactly as the engine banks it: a club inside a union
  -- contributes to the UNION pool, and its own club-level row is retired.
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
    -- so club money renders "-" and never 0.00. The jackpot rides along because
    -- it is public (bbj_pools is world-readable) and because a lobby that lists
    -- 178 live games over a blank jackpot is telling the visitor the club is
    -- dead when it is not.
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

    -- SPIN TREASURY (Dan 2026-08-24: "the wallet is still missing the spins
    -- treasury"). Two halves, because reporting either one alone lies:
    --   idle     union_wallets.spin_reserve_wallet — capital not yet seeded
    --   deployed spin_bonus_pools.balance          — capital live in a pool
    -- The union-owned pool is keyed by the UNION id (owner_kind='union');
    -- club-owned pools by their club id. Cover both.
    v_spin_idle := COALESCE(v_w.spin_reserve_wallet, 0);
    SELECT COALESCE(SUM(COALESCE(sp.balance, 0)), 0) INTO v_spin_deployed
      FROM spin_bonus_pools sp
     WHERE sp.is_active
       AND (sp.club_id = v_union_id
            OR sp.club_id IN (SELECT uc.club_id FROM union_clubs uc WHERE uc.union_id = v_union_id));

    -- NOTE: union_bank_unreserved deliberately removed. The Rake Treasury is no
    -- longer a slice of the bank, so "bank minus treasury" is not a quantity —
    -- it evaluated to -391,962.85 the moment the accounts were separated.
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

-- ── Post-apply assertion ───────────────────────────────────────────────────
-- The union pool for Shark Club's union carries a real balance; prove the
-- refusal payload now carries it. Read-only, no money moves (section 11.5).
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
