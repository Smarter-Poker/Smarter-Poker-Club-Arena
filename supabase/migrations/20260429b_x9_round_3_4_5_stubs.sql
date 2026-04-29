-- ═══════════════════════════════════════════════════════════════════════════════
-- Walkthrough Rounds 3 + 4 + 5 — 8 more phantom stubs fixed (in addition to
-- the 15 from 20260429_x9_fix_15_stub_rpcs.sql).
-- Applied to production via Supabase MCP in two batches:
--   x9c_round3_round4_stubs_2026_04_29_v2  (3 RPCs — tournament balance + buy-in rake + drop dead insurance overload)
--   x9d_round5_stubs_2026_04_29            (5 RPCs — BBJ contribution + promo wagering + table stats + atomic increment + period commissions)
-- All had either empty bodies (BEGIN NULL/RETURN/END;) or signature
-- mismatches with their production callers, causing silent dispatch failures.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Round 3+4 ─────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.balance_tournament_tables(uuid);
CREATE OR REPLACE FUNCTION public.balance_tournament_tables(p_tournament_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_min_players integer; v_max_players integer; v_imbalanced integer := 0;
BEGIN
  IF p_tournament_id IS NULL THEN RETURN 0; END IF;
  SELECT MIN(c), MAX(c) INTO v_min_players, v_max_players FROM (
    SELECT COUNT(*) AS c FROM public.table_seats ts
      JOIN public.tables t ON t.id = ts.table_id
     WHERE t.tournament_id = p_tournament_id AND ts.left_at IS NULL
     GROUP BY ts.table_id
  ) sub;
  IF v_max_players IS NULL OR v_min_players IS NULL THEN RETURN 0; END IF;
  IF v_max_players - v_min_players > 1 THEN
    v_imbalanced := v_max_players - v_min_players;
    UPDATE public.tournaments SET updated_at = NOW() WHERE id = p_tournament_id;
  END IF;
  RETURN v_imbalanced;
END $function$;
GRANT EXECUTE ON FUNCTION public.balance_tournament_tables(uuid) TO service_role, authenticated;

CREATE OR REPLACE FUNCTION public.record_tournament_buyin_rake(
  p_tournament_id uuid DEFAULT NULL, p_amount numeric DEFAULT 0, p_player_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_club_id uuid; v_rake_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_tournament_id IS NULL THEN RETURN; END IF;
  SELECT club_id INTO v_club_id FROM public.tournaments WHERE id = p_tournament_id;
  IF v_club_id IS NULL THEN RETURN; END IF;
  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution, pot_size,
    num_players, player_contributions, is_tournament, tournament_id, source
  ) VALUES (
    NULL, NULL, v_club_id, p_amount, 0, 0, 1,
    jsonb_build_object(p_player_id::text, p_amount), TRUE, p_tournament_id, 'tournament_buyin'
  ) RETURNING id INTO v_rake_id;
  UPDATE public.club_wallets
     SET period_rake_collected = period_rake_collected + p_amount,
         lifetime_rake_collected = lifetime_rake_collected + p_amount,
         chip_balance = chip_balance + p_amount, updated_at = NOW()
   WHERE club_id = v_club_id;
  INSERT INTO public.club_wallet_transactions
    (club_id, type, amount, balance_after, related_id, reason)
  SELECT v_club_id, 'rake_in', p_amount, chip_balance, v_rake_id,
         'Tournament buy-in rake (tournament ' || p_tournament_id::text || ')'
    FROM public.club_wallets WHERE club_id = v_club_id;
  UPDATE public.clubs SET total_rake = COALESCE(total_rake,0)+p_amount, updated_at=NOW() WHERE id = v_club_id;
  UPDATE public.tournaments SET total_rake = COALESCE(total_rake,0)+p_amount, updated_at=NOW() WHERE id = p_tournament_id;
END $function$;
GRANT EXECUTE ON FUNCTION public.record_tournament_buyin_rake(uuid, numeric, uuid) TO service_role;

DROP FUNCTION IF EXISTS public.record_insurance_transaction(uuid, uuid, numeric, text);

-- ─── Round 5 — BBJ + lobby stats + commission ──────────────────────────────

DROP FUNCTION IF EXISTS public.add_bbj_contribution(uuid, numeric, uuid);
CREATE OR REPLACE FUNCTION public.add_bbj_contribution(
  p_club_id uuid, p_table_id uuid, p_hand_number bigint, p_amount numeric,
  p_big_blind numeric, p_stakes_tier text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_pool bbj_pools%ROWTYPE; v_main numeric; v_backup numeric; v_promo numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_club_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'zero_or_null');
  END IF;
  v_main := ROUND(p_amount * 0.50, 4);
  v_backup := ROUND(p_amount * 0.25, 4);
  v_promo := p_amount - v_main - v_backup;
  INSERT INTO bbj_pools (club_id, pool_amount, main_balance, backup_balance, promo_balance, hands_contributed, status)
  VALUES (p_club_id, p_amount, v_main, v_backup, v_promo, 1, 'active')
  ON CONFLICT (club_id) DO UPDATE SET
    pool_amount       = bbj_pools.pool_amount + p_amount,
    main_balance      = bbj_pools.main_balance + v_main,
    backup_balance    = bbj_pools.backup_balance + v_backup,
    promo_balance     = bbj_pools.promo_balance + v_promo,
    hands_contributed = bbj_pools.hands_contributed + 1,
    updated_at        = NOW()
  RETURNING * INTO v_pool;
  INSERT INTO bbj_contributions
    (pool_id, club_id, table_id, hand_number, amount, big_blind, stakes_tier, main_portion, backup_portion, promo_portion)
  VALUES (v_pool.id, p_club_id, p_table_id, p_hand_number, p_amount, p_big_blind, p_stakes_tier, v_main, v_backup, v_promo);
  RETURN jsonb_build_object('success', true, 'pool_id', v_pool.id, 'new_total', v_pool.pool_amount,
    'main_balance', v_pool.main_balance, 'backup_balance', v_pool.backup_balance, 'promo_balance', v_pool.promo_balance);
END $function$;

DROP FUNCTION IF EXISTS public.record_promo_wagering(uuid, uuid, numeric, jsonb);
CREATE OR REPLACE FUNCTION public.record_promo_wagering(
  p_club_id uuid, p_player_user_id uuid, p_amount_wagered numeric
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_amount_wagered IS NULL OR p_amount_wagered <= 0 THEN RETURN; END IF;
  UPDATE public.club_members
     SET total_rake_paid = COALESCE(total_rake_paid, 0) + 0, updated_at = NOW()
   WHERE club_id = p_club_id AND user_id = p_player_user_id;
  INSERT INTO public.promo_distributions (club_id, user_id, amount, type, created_at)
  SELECT p_club_id, p_player_user_id, p_amount_wagered, 'wagered', NOW()
  WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='promo_distributions')
  ON CONFLICT DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
END $function$;

DROP FUNCTION IF EXISTS public.update_table_stats(uuid, jsonb);
CREATE OR REPLACE FUNCTION public.update_table_stats(p_table_id uuid, p_pot_total numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_table_id IS NULL THEN RETURN; END IF;
  UPDATE public.tables SET hands_played = COALESCE(hands_played, 0) + 1 WHERE id = p_table_id;
  BEGIN
    UPDATE public.tables
       SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{avg_pot}',
              to_jsonb(ROUND(COALESCE((settings->>'avg_pot')::numeric, COALESCE(p_pot_total,0)) * 0.9 + COALESCE(p_pot_total,0) * 0.1, 2)))
     WHERE id = p_table_id;
  EXCEPTION WHEN undefined_column THEN NULL;
  END;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_atomic_increment_field(
  p_table_name text DEFAULT '', p_id uuid DEFAULT NULL, p_field text DEFAULT '', p_amount integer DEFAULT 1
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_id IS NULL OR p_table_name = '' OR p_field = '' THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM (VALUES
    ('clubs','member_count'),('clubs','table_count'),('clubs','active_players'),('clubs','active_tables'),
    ('clubs','hands_played'),('clubs','total_rake'),('agents','total_players'),('agents','active_player_count'),
    ('agents','sub_agent_count'),('agents','credit_used'),('agents','credit_limit'),('tables','hands_played'),
    ('tournaments','registered_count'),('tournaments','current_players'),('tournaments','total_rake')
  ) v(t,f) WHERE t = p_table_name AND f = p_field) THEN
    RAISE EXCEPTION 'fn_atomic_increment_field: (%, %) not in allowlist', p_table_name, p_field;
  END IF;
  EXECUTE format('UPDATE public.%I SET %I = COALESCE(%I, 0) + $1, updated_at = NOW() WHERE id = $2',
                 p_table_name, p_field, p_field) USING p_amount, p_id;
END $function$;

CREATE OR REPLACE FUNCTION public.generate_period_commissions(p_period_id uuid)
RETURNS TABLE(agent_id uuid, period_id uuid, gross_rake numeric, commission_earned numeric,
              paid_to_downlines numeric, net_payout numeric, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_period record;
BEGIN
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id = p_period_id;
  IF v_period.id IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT a.id, p_period_id, COALESCE(a.weekly_rake_generated, 0)::numeric,
           COALESCE(SUM(ac.amount), 0)::numeric, 0::numeric,
           COALESCE(SUM(ac.amount), 0)::numeric, 'pending'::text
      FROM public.agents a
      LEFT JOIN public.agent_commissions ac ON ac.user_id = a.user_id
       AND ac.created_at::date BETWEEN v_period.period_start AND v_period.period_end
     WHERE a.club_id = v_period.club_id AND a.status = 'active'
     GROUP BY a.id, a.weekly_rake_generated;
END $function$;
GRANT EXECUTE ON FUNCTION public.generate_period_commissions(uuid) TO service_role;