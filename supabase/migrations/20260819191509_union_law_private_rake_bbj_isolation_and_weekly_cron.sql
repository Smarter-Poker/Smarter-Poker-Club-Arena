-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819191509 "union_law_private_rake_bbj_isolation_and_weekly_cron"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7d2b87400b8f56fc6185f88ec67ab862 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- UNION LAW HARDENING (2026-08-19)
-- Law: when a club is in the union, all non-private cash games and tournaments
-- run FROM the union. Rake and BBJ are held by the union (rake treasury pays
-- 90% back to clubs weekly, keeps 10%). Clubs MAY run private games, but
-- private rake/BBJ must NEVER touch union numbers.
--
-- This migration closes the remaining private-game leaks and schedules the
-- weekly close:
--   1. atomic_distribute_rake: route by the GAME's union stamp (tables /
--      tournaments), not the club's membership. Private game => club treasury.
--   2. record_tournament_buyin_rake: same rule for tournament fees.
--   3. fn_resolve_bbj_pool: private table BBJ goes to the CLUB pool, never the
--      union pool (revives the retired club pool at zero if needed).
--   4. get_union_rake_for_period: union reporting counts only union-stamped
--      games.
--   5. cron: weekly self-healing union close (Mondays 00:10 UTC).
--   6. platform_policies: codify the law.
-- ============================================================================

-- 1. atomic_distribute_rake ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(p_table_id uuid, p_club_id uuid, p_hand_id uuid, p_hand_number integer, p_rake numeric, p_bbj numeric DEFAULT 0, p_pot numeric DEFAULT NULL::numeric, p_num_players integer DEFAULT NULL::integer, p_contributions jsonb DEFAULT NULL::jsonb, p_tournament_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(applied boolean, already_processed boolean, recovered boolean, rake_record_id uuid, club_net_credit numeric, spendable_route text, spendable_amount numeric, union_id_out uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union_id     uuid;
  v_g_union      uuid;
  v_is_private   boolean := false;
  v_club_name    text;
  v_bbj          numeric := COALESCE(p_bbj, 0);
  v_rr_id        uuid;
  v_first_claim  boolean := false;
  v_recovered    boolean := false;
  v_leg_key      uuid;
  v_n            integer;
  v_cw_after     numeric;
  v_union_rake   numeric;
  v_route        text;
BEGIN
  IF p_club_id IS NULL OR p_rake IS NULL OR p_rake <= 0 THEN
    RETURN QUERY SELECT false, false, false, NULL::uuid, 0::numeric,
                        NULL::text, 0::numeric, NULL::uuid;
    RETURN;
  END IF;

  SELECT c.name INTO v_club_name FROM public.clubs c WHERE c.id = p_club_id;

  -- UNION LAW: route by the GAME's union stamp, not club membership.
  -- Private club games are never union-visible: their rake stays in the club.
  IF p_table_id IS NOT NULL THEN
    SELECT COALESCE(t.is_private, false), t.union_id
      INTO v_is_private, v_g_union
      FROM public.tables t WHERE t.id = p_table_id;
  END IF;
  IF p_tournament_id IS NOT NULL AND NOT v_is_private AND v_g_union IS NULL THEN
    SELECT COALESCE(tr.is_private, false), tr.union_id
      INTO v_is_private, v_g_union
      FROM public.tournaments tr WHERE tr.id = p_tournament_id;
  END IF;

  IF v_is_private THEN
    v_union_id := NULL;
  ELSE
    v_union_id := v_g_union;
    IF v_union_id IS NULL THEN
      -- Non-private and unstamped (legacy caller): the law says a union
      -- club's non-private game belongs to the union.
      SELECT c.union_id INTO v_union_id FROM public.clubs c WHERE c.id = p_club_id;
    END IF;
  END IF;

  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution, pot_size,
    num_players, player_contributions, is_tournament, tournament_id, source, metadata
  ) VALUES (
    p_hand_id, p_table_id, p_club_id, p_rake, v_bbj, p_pot,
    p_num_players, p_contributions, (p_tournament_id IS NOT NULL), p_tournament_id,
    'atomic_distribute_rake',
    jsonb_build_object('hand_number', p_hand_number, 'is_private', v_is_private)
  )
  ON CONFLICT (hand_id) WHERE hand_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_rr_id;

  IF v_rr_id IS NOT NULL THEN
    v_first_claim := true;
  ELSE
    SELECT id INTO v_rr_id FROM public.rake_records
      WHERE hand_id = p_hand_id ORDER BY created_at LIMIT 1;
  END IF;

  v_leg_key := COALESCE(p_hand_id, gen_random_uuid());

  INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
  VALUES (v_leg_key, 'club_accumulator', p_club_id, v_union_id, p_rake)
  ON CONFLICT (leg_key, leg) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    UPDATE public.club_wallets
       SET period_rake_collected     = period_rake_collected     + p_rake,
           period_bbj_contribution   = period_bbj_contribution   + v_bbj,
           lifetime_rake_collected   = lifetime_rake_collected   + p_rake,
           lifetime_bbj_contribution = lifetime_bbj_contribution + v_bbj,
           chip_balance              = chip_balance + p_rake,
           updated_at                = NOW()
     WHERE club_id = p_club_id
     RETURNING chip_balance INTO v_cw_after;

    IF v_cw_after IS NULL THEN
      INSERT INTO public.club_wallets (
        club_id, chip_balance, period_rake_collected, period_bbj_contribution,
        lifetime_rake_collected, lifetime_bbj_contribution
      ) VALUES (
        p_club_id, p_rake, p_rake, v_bbj, p_rake, v_bbj
      )
      ON CONFLICT (club_id) DO UPDATE SET
        period_rake_collected     = club_wallets.period_rake_collected     + EXCLUDED.period_rake_collected,
        period_bbj_contribution   = club_wallets.period_bbj_contribution   + EXCLUDED.period_bbj_contribution,
        lifetime_rake_collected   = club_wallets.lifetime_rake_collected   + EXCLUDED.lifetime_rake_collected,
        lifetime_bbj_contribution = club_wallets.lifetime_bbj_contribution + EXCLUDED.lifetime_bbj_contribution,
        chip_balance              = club_wallets.chip_balance              + EXCLUDED.chip_balance,
        updated_at                = NOW()
      RETURNING chip_balance INTO v_cw_after;
    END IF;

    INSERT INTO public.club_wallet_transactions (
      club_id, type, amount, balance_after, related_id, reason
    ) VALUES (
      p_club_id, 'rake_in', p_rake, v_cw_after, p_hand_id,
      'Rake collected (hand ' || COALESCE('#' || p_hand_number::text, 'unknown') ||
        ', BBJ contribution ' || v_bbj::text || ' banked to pool separately)'
    );

    IF NOT v_first_claim THEN v_recovered := true; END IF;
  END IF;

  IF v_union_id IS NOT NULL THEN
    v_route := 'union_rake_wallet';
    INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
    VALUES (v_leg_key, 'union_rake', p_club_id, v_union_id, p_rake)
    ON CONFLICT (leg_key, leg) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
           VALUES (v_union_id, p_rake, p_rake, p_rake)
      ON CONFLICT (union_id) DO UPDATE SET
           chip_balance         = public.union_wallets.chip_balance + p_rake,
           rake_wallet          = public.union_wallets.rake_wallet + p_rake,
           total_rake_collected = COALESCE(public.union_wallets.total_rake_collected, 0) + p_rake,
           updated_at           = NOW()
      RETURNING rake_wallet INTO v_union_rake;

      INSERT INTO public.union_wallet_transactions (
        union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes
      ) VALUES (
        v_union_id, p_club_id, p_rake, 'rake', 'rake_wallet', 'credit', v_union_rake,
        'Cash game rake: hand #' || COALESCE(p_hand_number::text, '?') ||
          ' (' || COALESCE(v_club_name, 'club') || ')'
      );

      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  ELSE
    v_route := 'club_chip_treasury';
    INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
    VALUES (v_leg_key, 'chip_treasury', p_club_id, NULL, p_rake)
    ON CONFLICT (leg_key, leg) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      UPDATE public.clubs
         SET chip_treasury = COALESCE(chip_treasury, 0) + p_rake,
             total_rake    = COALESCE(total_rake, 0) + p_rake,
             updated_at    = NOW()
       WHERE id = p_club_id;

      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_first_claim, (NOT v_first_claim), v_recovered, v_rr_id,
                      p_rake, v_route, p_rake, v_union_id;
END;
$function$;

-- 2. record_tournament_buyin_rake ---------------------------------------------
CREATE OR REPLACE FUNCTION public.record_tournament_buyin_rake(p_tournament_id uuid DEFAULT NULL::uuid, p_amount numeric DEFAULT 0, p_player_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club_id uuid;
  v_union_id uuid;
  v_is_private boolean := false;
  v_rake_id uuid;
  v_union_rake numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_tournament_id IS NULL THEN RETURN; END IF;

  -- UNION LAW: route by the tournament's own union stamp. Private tournaments
  -- never touch union numbers.
  SELECT t.club_id, COALESCE(t.is_private, false), t.union_id
    INTO v_club_id, v_is_private, v_union_id
    FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF v_club_id IS NULL THEN RETURN; END IF;

  IF v_is_private THEN
    v_union_id := NULL;
  ELSIF v_union_id IS NULL THEN
    SELECT union_id INTO v_union_id FROM public.clubs WHERE id = v_club_id;
  END IF;

  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution, pot_size,
    num_players, player_contributions, is_tournament, tournament_id, source, metadata
  ) VALUES (
    NULL, NULL, v_club_id, p_amount, 0, 0, 1,
    jsonb_build_object(p_player_id::text, p_amount), TRUE, p_tournament_id, 'tournament_buyin',
    jsonb_build_object('is_private', v_is_private)
  ) RETURNING id INTO v_rake_id;

  IF v_union_id IS NOT NULL THEN
    INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
         VALUES (v_union_id, p_amount, p_amount, p_amount)
    ON CONFLICT (union_id) DO UPDATE SET
         chip_balance         = public.union_wallets.chip_balance + p_amount,
         rake_wallet          = public.union_wallets.rake_wallet + p_amount,
         total_rake_collected = COALESCE(public.union_wallets.total_rake_collected, 0) + p_amount,
         updated_at           = NOW()
    RETURNING rake_wallet INTO v_union_rake;

    INSERT INTO public.union_wallet_transactions (
      union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes
    ) VALUES (
      v_union_id, v_club_id, p_amount, 'rake', 'rake_wallet', 'credit', v_union_rake,
      'Tournament buy-in rake (tournament ' || p_tournament_id::text || ')'
    );

    UPDATE public.club_wallets
       SET period_rake_collected   = COALESCE(period_rake_collected, 0) + p_amount,
           lifetime_rake_collected = COALESCE(lifetime_rake_collected, 0) + p_amount,
           updated_at = NOW()
     WHERE club_id = v_club_id;
  ELSE
    UPDATE public.club_wallets
       SET period_rake_collected   = COALESCE(period_rake_collected, 0) + p_amount,
           lifetime_rake_collected = COALESCE(lifetime_rake_collected, 0) + p_amount,
           chip_balance            = chip_balance + p_amount,
           updated_at = NOW()
     WHERE club_id = v_club_id;

    INSERT INTO public.club_wallet_transactions
      (club_id, type, amount, balance_after, related_id, reason)
    SELECT v_club_id, 'rake_in', p_amount, chip_balance, v_rake_id,
           'Tournament buy-in rake (tournament ' || p_tournament_id::text || ')'
      FROM public.club_wallets WHERE club_id = v_club_id;
  END IF;

  UPDATE public.clubs SET total_rake = COALESCE(total_rake,0) + p_amount, updated_at = NOW()
   WHERE id = v_club_id;
  UPDATE public.tournaments SET total_rake = COALESCE(total_rake,0) + p_amount, updated_at = NOW()
   WHERE id = p_tournament_id;
END;
$function$;

-- 3. fn_resolve_bbj_pool --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_resolve_bbj_pool(p_table_id uuid, p_club_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid; v_union uuid; v_pool uuid; v_private boolean := false;
BEGIN
  SELECT t.club_id, t.union_id, COALESCE(t.is_private, false)
    INTO v_club, v_union, v_private
    FROM public.tables t WHERE t.id = p_table_id;
  v_club := COALESCE(v_club, p_club_id);

  -- UNION LAW: a private club game's BBJ never touches the union pool.
  IF v_private THEN
    v_union := NULL;
  ELSIF v_union IS NULL AND v_club IS NOT NULL THEN
    SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = v_club;
  END IF;

  IF v_union IS NOT NULL THEN
    SELECT id INTO v_pool FROM public.bbj_pools
     WHERE club_id IS NULL AND union_id = v_union AND status = 'active';
    IF v_pool IS NULL THEN
      INSERT INTO public.bbj_pools (club_id, union_id, pool_amount, main_balance, backup_balance, promo_balance, hands_contributed, status)
      VALUES (NULL, v_union, 0, 0, 0, 0, 0, 'active')
      ON CONFLICT DO NOTHING;
      SELECT id INTO v_pool FROM public.bbj_pools
       WHERE club_id IS NULL AND union_id = v_union AND status = 'active';
    END IF;
  ELSIF v_club IS NOT NULL THEN
    SELECT id INTO v_pool FROM public.bbj_pools
     WHERE club_id = v_club AND status = 'active' ORDER BY created_at LIMIT 1;
    IF v_pool IS NULL THEN
      INSERT INTO public.bbj_pools (club_id, pool_amount, main_balance, backup_balance, promo_balance, hands_contributed, status)
      VALUES (v_club, 0, 0, 0, 0, 0, 'active')
      ON CONFLICT DO NOTHING;
      SELECT id INTO v_pool FROM public.bbj_pools
       WHERE club_id = v_club AND status = 'active' ORDER BY created_at LIMIT 1;
    END IF;
    IF v_pool IS NULL THEN
      -- Club pool exists but was retired when its balance was swept to the
      -- union. Revive it (at its current zero balance) for private-game BBJ.
      UPDATE public.bbj_pools SET status = 'active', updated_at = now()
       WHERE club_id = v_club
      RETURNING id INTO v_pool;
    END IF;
  ELSE
    RAISE EXCEPTION 'BBJ contribution with no resolvable club or union (table %)', p_table_id;
  END IF;

  RETURN v_pool;
END;
$function$;

-- 4. get_union_rake_for_period: union numbers = union-stamped games only -------
CREATE OR REPLACE FUNCTION public.get_union_rake_for_period(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(club_id uuid, club_name text, rake_amount numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  RETURN QUERY
  SELECT c.id, c.name, COALESCE(SUM(rr.rake_amount), 0)
    FROM clubs c
    LEFT JOIN rake_records rr
      ON rr.club_id = c.id
     AND rr.created_at >= p_start AND rr.created_at < p_end
     AND (
           (rr.table_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM tables t
               WHERE t.id = rr.table_id AND t.union_id = p_union_id))
        OR (rr.tournament_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM tournaments tr
               WHERE tr.id = rr.tournament_id AND tr.union_id = p_union_id))
         )
   WHERE c.union_id = p_union_id
   GROUP BY c.id, c.name;
END;
$function$;

-- 5. Weekly union close cron (self-healing; idempotent per period) --------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'union-weekly-rakeback-close') THEN
    PERFORM cron.unschedule('union-weekly-rakeback-close');
  END IF;
  PERFORM cron.schedule(
    'union-weekly-rakeback-close',
    '10 0 * * 1',
    'SELECT public.fn_union_weekly_rakeback_close_all();'
  );
END $$;

-- 6. Codify the law -------------------------------------------------------------
INSERT INTO public.platform_policies (key, value, description) VALUES
  ('union.game_hosting', 'union_only',
   'LAW: when a club belongs to a union, every non-private cash game and tournament runs FROM the union (union-stamped via triggers on tables/tournaments). Club-hosted union-visible games are not permitted.'),
  ('union.chip_custody', 'union_passes_down',
   'LAW: all chips originate from the union and are passed down to clubs (fn_union_send_chips_to_club / fn_union_send_to_club_atomic). Clubs square up with the union weekly.'),
  ('union.rake_split.club_share', '0.90',
   'LAW: union holds all rake from union games in the rake treasury (union_wallets.rake_wallet), then returns 90% to each club at the weekly close (union_clubs.club_commission_rate) and retains 10%.'),
  ('union.bbj_custody', 'union',
   'LAW: all BBJ rake from union games is held by the union BBJ pool. Club BBJ pools exist only for private club games.'),
  ('union.settlement.cadence', 'weekly',
   'LAW: player/agent wins and losses are tracked individually; clubs square up with the union weekly (fn_union_weekly_rakeback_close_all, cron union-weekly-rakeback-close, Mondays 00:10 UTC).'),
  ('union.private_club_games', 'allowed_off_books',
   'LAW: clubs may run private cash games and tournaments (is_private = true). These never appear on the union: no union stamp, rake stays in the club treasury, BBJ stays in the club pool, excluded from all union numbers.')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at = now();

