-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820053429 "union_law_reapply_private_isolation_and_selftest"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 623d7926f1938b9f87490a245dbf3cfc of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- UNION LAW: RE-APPLY PRIVATE-GAME ISOLATION + PERMANENT SELF-TEST (2026-08-20)
-- A later settlement migration replaced atomic_distribute_rake and
-- record_tournament_buyin_rake, reverting the private-game routing (a union
-- club's PRIVATE game rake would flow into the union treasury again). This
-- migration re-applies the law ON TOP of the newer trust-held-treasury
-- versions, and installs a daily self-test that alerts if the law is ever
-- clobbered again.
-- ============================================================================

-- 1. atomic_distribute_rake: game-aware routing (keeps rake-treasury-in-trust)
CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(p_table_id uuid, p_club_id uuid, p_hand_id uuid, p_hand_number integer, p_rake numeric, p_bbj numeric DEFAULT 0, p_pot numeric DEFAULT NULL::numeric, p_num_players integer DEFAULT NULL::numeric::integer, p_contributions jsonb DEFAULT NULL::jsonb, p_tournament_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(applied boolean, already_processed boolean, recovered boolean, rake_record_id uuid, club_net_credit numeric, spendable_route text, spendable_amount numeric, union_id_out uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union_id uuid; v_g_union uuid; v_is_private boolean := false;
  v_club_name text; v_bbj numeric := COALESCE(p_bbj, 0);
  v_rr_id uuid; v_first_claim boolean := false; v_recovered boolean := false;
  v_leg_key uuid; v_n integer; v_cw_after numeric; v_union_rake numeric; v_route text;
BEGIN
  IF p_club_id IS NULL OR p_rake IS NULL OR p_rake <= 0 THEN
    RETURN QUERY SELECT false, false, false, NULL::uuid, 0::numeric, NULL::text, 0::numeric, NULL::uuid;
    RETURN;
  END IF;

  SELECT c.name INTO v_club_name FROM public.clubs c WHERE c.id = p_club_id;

  -- UNION LAW (Dan, re-applied 2026-08-20): route by the GAME's union stamp,
  -- not club membership. A private club game's rake NEVER touches the union.
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

  IF v_rr_id IS NOT NULL THEN v_first_claim := true;
  ELSE SELECT id INTO v_rr_id FROM public.rake_records WHERE hand_id = p_hand_id ORDER BY created_at LIMIT 1;
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
      ) VALUES (p_club_id, p_rake, p_rake, v_bbj, p_rake, v_bbj)
      ON CONFLICT (club_id) DO UPDATE SET
        period_rake_collected     = club_wallets.period_rake_collected     + EXCLUDED.period_rake_collected,
        period_bbj_contribution   = club_wallets.period_bbj_contribution   + EXCLUDED.period_bbj_contribution,
        lifetime_rake_collected   = club_wallets.lifetime_rake_collected   + EXCLUDED.lifetime_rake_collected,
        lifetime_bbj_contribution = club_wallets.lifetime_bbj_contribution + EXCLUDED.lifetime_bbj_contribution,
        chip_balance              = club_wallets.chip_balance              + EXCLUDED.chip_balance,
        updated_at                = NOW()
      RETURNING chip_balance INTO v_cw_after;
    END IF;

    INSERT INTO public.club_wallet_transactions (club_id, type, amount, balance_after, related_id, reason)
    VALUES (p_club_id, 'rake_in', p_rake, v_cw_after, p_hand_id,
      'Rake collected (hand ' || COALESCE('#' || p_hand_number::text, 'unknown') ||
      ', BBJ contribution ' || v_bbj::text || ' banked to pool separately)');

    IF NOT v_first_claim THEN v_recovered := true; END IF;
  END IF;

  IF v_union_id IS NOT NULL THEN
    v_route := 'union_rake_wallet';
    INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
    VALUES (v_leg_key, 'union_rake', p_club_id, v_union_id, p_rake)
    ON CONFLICT (leg_key, leg) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      -- RAKE TREASURY ONLY. chip_balance (Union Bank) is deliberately NOT
      -- touched: the union does not own this money yet, it is held in trust
      -- for the weekly 90/10 close.
      INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
           VALUES (v_union_id, 0, p_rake, p_rake)
      ON CONFLICT (union_id) DO UPDATE SET
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
END; $function$;

-- 2. record_tournament_buyin_rake: same law, keeps trust-held treasury -------
CREATE OR REPLACE FUNCTION public.record_tournament_buyin_rake(p_tournament_id uuid DEFAULT NULL::uuid, p_amount numeric DEFAULT 0, p_player_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_club_id uuid; v_union_id uuid; v_is_private boolean := false; v_rake_id uuid; v_union_rake numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_tournament_id IS NULL THEN RETURN; END IF;

  -- UNION LAW (Dan, re-applied 2026-08-20): route by the tournament's own
  -- union stamp. Private tournaments never touch union numbers.
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
    -- Rake Treasury only.
    INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
         VALUES (v_union_id, 0, p_amount, p_amount)
    ON CONFLICT (union_id) DO UPDATE SET
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

    INSERT INTO public.club_wallet_transactions (club_id, type, amount, balance_after, related_id, reason)
    SELECT v_club_id, 'rake_in', p_amount, chip_balance, v_rake_id,
           'Tournament buy-in rake (tournament ' || p_tournament_id::text || ')'
      FROM public.club_wallets WHERE club_id = v_club_id;
  END IF;

  UPDATE public.clubs SET total_rake = COALESCE(total_rake,0) + p_amount, updated_at = NOW() WHERE id = v_club_id;
  UPDATE public.tournaments SET total_rake = COALESCE(total_rake,0) + p_amount, updated_at = NOW() WHERE id = p_tournament_id;
END; $function$;

-- 3. RLS fast-path: non-overseers short-circuit without per-row function calls
CREATE OR REPLACE FUNCTION public.fn_is_any_union_overseer(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL AND (
       EXISTS (SELECT 1 FROM unions u WHERE u.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM union_admins a WHERE a.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM clubs c
                WHERE COALESCE(c.is_union, false) AND c.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM club_members m
                JOIN clubs c2 ON c2.id = m.club_id AND COALESCE(c2.is_union, false)
               WHERE m.user_id = p_user_id AND m.role IN ('owner','admin')
                 AND m.status IN ('active','approved'))
  );
$function$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_policies
     WHERE schemaname = 'public' AND policyname = 'union_overseer_read'
       AND tablename <> 'table_seats'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS union_overseer_read ON public.%I', r.tablename);
    EXECUTE format(
      'CREATE POLICY union_overseer_read ON public.%I FOR SELECT TO authenticated
         USING ( (SELECT public.fn_is_any_union_overseer((SELECT auth.uid())))
                 AND public.fn_union_oversees_club(club_id, (SELECT auth.uid())) )', r.tablename);
  END LOOP;
END $$;

DROP POLICY IF EXISTS union_overseer_read ON public.table_seats;
CREATE POLICY union_overseer_read ON public.table_seats
  FOR SELECT TO authenticated
  USING ( (SELECT public.fn_is_any_union_overseer((SELECT auth.uid())))
          AND EXISTS (
            SELECT 1 FROM public.tables t
             WHERE t.id = table_seats.table_id
               AND public.fn_is_union_overseer(t.union_id, (SELECT auth.uid()))
          ) );

-- 4. Legacy record_rake: alert if a union game's rake sneaks through it ------
CREATE OR REPLACE FUNCTION public.record_rake(p_hand_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_rake_amount numeric DEFAULT 0, p_pot_size numeric DEFAULT 0, p_num_players integer DEFAULT 0, p_player_contributions jsonb DEFAULT NULL::jsonb, p_is_tournament boolean DEFAULT false, p_tournament_id uuid DEFAULT NULL::uuid, p_bbj_pct numeric DEFAULT 0.05)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bbj_amount numeric := 0;
  v_rake_id uuid; v_pool_id uuid; v_new_balance numeric;
  v_union uuid; v_private boolean := false;
BEGIN
  IF p_rake_amount IS NULL OR p_rake_amount <= 0 THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'zero_rake');
  END IF;

  -- UNION LAW guard: this legacy path keeps everything club-side. If it is
  -- ever used for a union-visible game the union treasury silently loses the
  -- rake — delegate to atomic_distribute_rake instead and alert.
  IF p_table_id IS NOT NULL THEN
    SELECT t.union_id, COALESCE(t.is_private, false) INTO v_union, v_private
      FROM public.tables t WHERE t.id = p_table_id;
  END IF;
  IF v_union IS NULL AND NOT v_private AND p_club_id IS NOT NULL THEN
    SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = p_club_id;
  END IF;
  IF v_union IS NOT NULL AND NOT v_private THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('warning', 'record_rake',
      'Legacy record_rake called for a UNION game — delegated to atomic_distribute_rake',
      jsonb_build_object('club_id', p_club_id, 'table_id', p_table_id,
                         'tournament_id', p_tournament_id, 'rake', p_rake_amount));
    PERFORM public.atomic_distribute_rake(
      p_table_id, p_club_id, p_hand_id, NULL, p_rake_amount,
      ROUND(p_rake_amount * COALESCE(p_bbj_pct, 0), 4), p_pot_size,
      p_num_players, p_player_contributions, p_tournament_id);
    RETURN jsonb_build_object('success', true, 'delegated', 'atomic_distribute_rake');
  END IF;

  v_bbj_amount := ROUND(p_rake_amount * COALESCE(p_bbj_pct, 0)::numeric, 4);

  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution,
    pot_size, num_players, player_contributions,
    is_tournament, tournament_id, source, metadata
  ) VALUES (
    p_hand_id, p_table_id, p_club_id, p_rake_amount, v_bbj_amount,
    p_pot_size, p_num_players, p_player_contributions,
    p_is_tournament, p_tournament_id,
    CASE WHEN p_is_tournament THEN 'tournament' ELSE 'cash_game' END,
    jsonb_build_object('bbj_pct_applied', p_bbj_pct, 'is_private', v_private)
  )
  RETURNING id INTO v_rake_id;

  IF p_club_id IS NOT NULL AND v_bbj_amount > 0 THEN
    INSERT INTO public.bbj_pools (club_id, pool_amount, hands_contributed, total_contributed)
    VALUES (p_club_id, v_bbj_amount, 1, v_bbj_amount)
    ON CONFLICT (club_id) DO UPDATE
      SET pool_amount       = public.bbj_pools.pool_amount + v_bbj_amount,
          hands_contributed = public.bbj_pools.hands_contributed + 1,
          total_contributed = public.bbj_pools.total_contributed + v_bbj_amount,
          updated_at        = NOW()
    RETURNING id INTO v_pool_id;
  END IF;

  IF p_club_id IS NOT NULL THEN
    UPDATE public.club_wallets
       SET period_rake_collected     = period_rake_collected     + p_rake_amount,
           period_bbj_contribution   = period_bbj_contribution   + v_bbj_amount,
           lifetime_rake_collected   = lifetime_rake_collected   + p_rake_amount,
           lifetime_bbj_contribution = lifetime_bbj_contribution + v_bbj_amount,
           chip_balance              = chip_balance + (p_rake_amount - v_bbj_amount),
           updated_at                = NOW()
     WHERE club_id = p_club_id
    RETURNING chip_balance INTO v_new_balance;

    IF v_new_balance IS NOT NULL THEN
      INSERT INTO public.club_wallet_transactions (
        club_id, type, amount, balance_after, related_id, reason
      ) VALUES (
        p_club_id, 'rake_in', (p_rake_amount - v_bbj_amount), v_new_balance,
        v_rake_id, 'Rake collected (BBJ pct: ' || p_bbj_pct::text || ')'
      );
    END IF;

    UPDATE public.clubs
       SET total_rake = COALESCE(total_rake, 0) + p_rake_amount,
           updated_at = NOW()
     WHERE id = p_club_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'rake_record_id', v_rake_id, 'bbj_pool_id', v_pool_id,
    'rake', p_rake_amount, 'bbj_contribution', v_bbj_amount
  );
END;
$function$;

-- 5. Daily union-law self-test: alert if the law ever regresses again --------
CREATE OR REPLACE FUNCTION public.fn_union_law_selftest()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_breaches jsonb := '[]'::jsonb;
  v_n bigint;
BEGIN
  -- (a) money routers must carry the UNION LAW private routing
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='atomic_distribute_rake'
                    AND p.prosrc LIKE '%UNION LAW%' AND p.prosrc LIKE '%v_is_private%') THEN
    v_breaches := v_breaches || jsonb_build_object('check','atomic_distribute_rake_law_missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='record_tournament_buyin_rake'
                    AND p.prosrc LIKE '%UNION LAW%' AND p.prosrc LIKE '%v_is_private%') THEN
    v_breaches := v_breaches || jsonb_build_object('check','record_tournament_buyin_rake_law_missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_resolve_bbj_pool'
                    AND p.prosrc LIKE '%is_private%') THEN
    v_breaches := v_breaches || jsonb_build_object('check','fn_resolve_bbj_pool_law_missing');
  END IF;

  -- (b) ownership + revival triggers present
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgname IN ('trg_tables_union_ownership','trg_tournaments_union_ownership','trg_tables_block_deleted_revival');
  IF v_n < 3 THEN
    v_breaches := v_breaches || jsonb_build_object('check','ownership_or_revival_trigger_missing','found',v_n);
  END IF;

  -- (c) weekly close scheduled
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='union-weekly-rakeback-close' AND active) THEN
    v_breaches := v_breaches || jsonb_build_object('check','weekly_close_cron_missing');
  END IF;

  -- (d) oversight policies present
  SELECT count(*) INTO v_n FROM pg_policies WHERE policyname='union_overseer_read';
  IF v_n < 15 THEN
    v_breaches := v_breaches || jsonb_build_object('check','oversight_policies_missing','found',v_n);
  END IF;

  -- (e) live data: no union-visible game may live in a member club lobby
  SELECT count(*) INTO v_n
    FROM tables t JOIN union_clubs uc ON uc.club_id = t.club_id
   WHERE COALESCE(t.is_private,false)=false AND COALESCE(t.is_deleted,false)=false
     AND t.status IN ('running','waiting','active','open');
  IF v_n > 0 THEN
    v_breaches := v_breaches || jsonb_build_object('check','live_games_in_member_club_lobby','count',v_n);
  END IF;

  -- (f) no private row may carry a union stamp
  SELECT count(*) INTO v_n FROM (
    SELECT id FROM tables WHERE COALESCE(is_private,false) AND union_id IS NOT NULL
    UNION ALL
    SELECT id FROM tournaments WHERE COALESCE(is_private,false) AND union_id IS NOT NULL
  ) x;
  IF v_n > 0 THEN
    v_breaches := v_breaches || jsonb_build_object('check','private_rows_union_stamped','count',v_n);
  END IF;

  IF jsonb_array_length(v_breaches) > 0
     AND NOT EXISTS (SELECT 1 FROM financial_alerts
                      WHERE source='fn_union_law_selftest'
                        AND created_at > now() - interval '20 hours') THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('critical', 'fn_union_law_selftest',
            'UNION LAW self-test failed — the law has been clobbered or breached',
            jsonb_build_object('breaches', v_breaches));
  END IF;

  RETURN jsonb_build_object('healthy', jsonb_array_length(v_breaches)=0, 'breaches', v_breaches);
END $function$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'union-law-selftest') THEN
    PERFORM cron.unschedule('union-law-selftest');
  END IF;
  PERFORM cron.schedule('union-law-selftest', '20 0 * * *',
                        'SELECT public.fn_union_law_selftest();');
END $$;

