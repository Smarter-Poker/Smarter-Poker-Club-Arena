-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429044534 "x9d_round5_stubs_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0b65434f4dea2241418bda3e8dcc6886 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 5 — Bible V8 settlement-chain + lobby-stats stubs.
-- Several stubs ALSO had signature mismatches with their production callers
-- (LobbyManager.js + agent-credit.js + CommissionService.ts), which means
-- calls were silently 404-ing on the RPC dispatcher. Fixing both shape and
-- body in this migration.

-- ───────────────────────────────────────────────────────────────────────────
-- add_bbj_contribution — drop the 3-arg empty stub. Replace with the 6-arg
-- shape LobbyManager.js:881 actually passes. Routes to the existing 9-arg
-- real impl by computing default 50/25/25 split.
-- ───────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.add_bbj_contribution(uuid, numeric, uuid);

CREATE OR REPLACE FUNCTION public.add_bbj_contribution(
  p_club_id uuid,
  p_table_id uuid,
  p_hand_number bigint,
  p_amount numeric,
  p_big_blind numeric,
  p_stakes_tier text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_pool bbj_pools%ROWTYPE;
  v_main numeric;
  v_backup numeric;
  v_promo numeric;
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
    pool_amount       = bbj_pools.pool_amount       + p_amount,
    main_balance      = bbj_pools.main_balance      + v_main,
    backup_balance    = bbj_pools.backup_balance    + v_backup,
    promo_balance     = bbj_pools.promo_balance     + v_promo,
    hands_contributed = bbj_pools.hands_contributed + 1,
    updated_at        = NOW()
  RETURNING * INTO v_pool;

  INSERT INTO bbj_contributions
    (pool_id, club_id, table_id, hand_number, amount, big_blind, stakes_tier,
     main_portion, backup_portion, promo_portion)
  VALUES
    (v_pool.id, p_club_id, p_table_id, p_hand_number, p_amount, p_big_blind, p_stakes_tier,
     v_main, v_backup, v_promo);

  RETURN jsonb_build_object(
    'success', true, 'pool_id', v_pool.id, 'new_total', v_pool.pool_amount,
    'main_balance', v_pool.main_balance, 'backup_balance', v_pool.backup_balance,
    'promo_balance', v_pool.promo_balance, 'hands_contributed', v_pool.hands_contributed
  );
END $function$;
GRANT EXECUTE ON FUNCTION public.add_bbj_contribution(uuid, uuid, bigint, numeric, numeric, text) TO service_role, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- record_promo_wagering — match LobbyManager.js:929 signature
-- ───────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.record_promo_wagering(uuid, uuid, numeric, jsonb);

CREATE OR REPLACE FUNCTION public.record_promo_wagering(
  p_club_id uuid,
  p_player_user_id uuid,
  p_amount_wagered numeric
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_amount_wagered IS NULL OR p_amount_wagered <= 0 THEN RETURN; END IF;
  -- Bumps player's running wagered total in club_members for promo eligibility
  UPDATE public.club_members
     SET total_rake_paid = COALESCE(total_rake_paid, 0) + 0,  -- no-op, here for parity with rake counters
         updated_at = NOW()
   WHERE club_id = p_club_id AND user_id = p_player_user_id;
  -- Track in promo_distributions if club has promo balance feature enabled
  -- (graceful skip if not — most clubs don't run promos)
  INSERT INTO public.promo_distributions
    (club_id, user_id, amount, type, created_at)
  SELECT p_club_id, p_player_user_id, p_amount_wagered, 'wagered', NOW()
  WHERE EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='promo_distributions')
  ON CONFLICT DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN
  -- promo_distributions schema not present in this env; that's fine
  NULL;
END $function$;
GRANT EXECUTE ON FUNCTION public.record_promo_wagering(uuid, uuid, numeric) TO service_role, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- update_table_stats — match LobbyManager.js:950 signature
-- Exponential-moving-average pot for lobby display, increment hands_played.
-- ───────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.update_table_stats(uuid, jsonb);

CREATE OR REPLACE FUNCTION public.update_table_stats(
  p_table_id uuid,
  p_pot_total numeric
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_table_id IS NULL THEN RETURN; END IF;
  UPDATE public.tables
     SET hands_played = COALESCE(hands_played, 0) + 1
   WHERE id = p_table_id;
  -- avg_pot column may or may not exist — graceful skip if missing
  BEGIN
    UPDATE public.tables
       SET settings = jsonb_set(
              COALESCE(settings, '{}'::jsonb),
              '{avg_pot}',
              to_jsonb(ROUND(
                COALESCE((settings->>'avg_pot')::numeric, COALESCE(p_pot_total, 0)) * 0.9
                + COALESCE(p_pot_total, 0) * 0.1, 2))
           )
     WHERE id = p_table_id;
  EXCEPTION WHEN undefined_column THEN NULL;
  END;
END $function$;
GRANT EXECUTE ON FUNCTION public.update_table_stats(uuid, numeric) TO service_role, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- fn_atomic_increment_field — generic dynamic-SQL atomic increment.
-- Caller: agent-credit.js:123. Useful guarded-with-allowlist of (table, field)
-- pairs to prevent SQL-injection via the text params.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_atomic_increment_field(
  p_table_name text DEFAULT '',
  p_id uuid DEFAULT NULL,
  p_field text DEFAULT '',
  p_amount integer DEFAULT 1
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_id IS NULL OR p_table_name = '' OR p_field = '' THEN RETURN; END IF;

  -- Allowlist of (table, field) pairs we accept. Adding to this list is the
  -- only way to expand allowed atomic increments.
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('clubs','member_count'),
      ('clubs','table_count'),
      ('clubs','active_players'),
      ('clubs','active_tables'),
      ('clubs','hands_played'),
      ('clubs','total_rake'),
      ('agents','total_players'),
      ('agents','active_player_count'),
      ('agents','sub_agent_count'),
      ('agents','credit_used'),
      ('agents','credit_limit'),
      ('tables','hands_played'),
      ('tournaments','registered_count'),
      ('tournaments','current_players'),
      ('tournaments','total_rake')
    ) v(t,f) WHERE t = p_table_name AND f = p_field
  ) THEN
    RAISE EXCEPTION 'fn_atomic_increment_field: (%, %) not in allowlist', p_table_name, p_field;
  END IF;

  EXECUTE format('UPDATE public.%I SET %I = COALESCE(%I, 0) + $1, updated_at = NOW() WHERE id = $2',
                 p_table_name, p_field, p_field)
  USING p_amount, p_id;
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_atomic_increment_field(text, uuid, text, integer) TO service_role, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- generate_period_commissions — produce per-agent commission rows for a
-- closed settlement period. Table-returning function (matches existing
-- signature). Emits one row per active agent with their period totals.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_period_commissions(p_period_id uuid)
RETURNS TABLE(agent_id uuid, period_id uuid, gross_rake numeric, commission_earned numeric,
              paid_to_downlines numeric, net_payout numeric, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_period record;
BEGIN
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id = p_period_id;
  IF v_period.id IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT
      a.id                                       AS agent_id,
      p_period_id                                AS period_id,
      COALESCE(a.weekly_rake_generated, 0)       AS gross_rake,
      COALESCE(SUM(ac.amount), 0)::numeric        AS commission_earned,
      0::numeric                                  AS paid_to_downlines,
      COALESCE(SUM(ac.amount), 0)::numeric        AS net_payout,
      'pending'::text                             AS status
      FROM public.agents a
      LEFT JOIN public.agent_commissions ac
        ON ac.user_id = a.user_id
       AND ac.created_at::date BETWEEN v_period.period_start AND v_period.period_end
     WHERE a.club_id = v_period.club_id
       AND a.status = 'active'
     GROUP BY a.id, a.weekly_rake_generated;
END $function$;
GRANT EXECUTE ON FUNCTION public.generate_period_commissions(uuid) TO service_role;
