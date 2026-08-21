-- =====================================================================
-- 20260821_ca_stats_rpcs.sql
-- Tier 2: additive only. One ADD COLUMN, one new table, four new
-- functions. No DROP, no ALTER COLUMN TYPE, no data rewrite.
--
-- Read surfaces over ca_hand_facts / ca_hand_transfers for:
--   ca_player_ev_curve      -> EV vs actual profit ("luck" graph)
--   ca_player_hand_grid     -> 13x13 hole-card heatmap
--   ca_player_nemesis       -> Nemesis / Target
--   ca_player_benchmarks    -> percentile benchmarking vs the field
--
-- ⚠ SECURITY, THE WHOLE POINT ⚠
-- ca_hand_facts.hole_cards contains cards that NEVER went to showdown.
-- Its RLS policy is `user_id = auth.uid()`. Every function below is
-- SECURITY DEFINER, which BYPASSES RLS — so each one asserts the caller
-- is the subject before reading a single row. Without that assertion
-- these functions would hand any authenticated user any other player's
-- mucked holdings. Do not add a function to this file without the
-- assertion, and do not relax it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. opponent_ids on the fact row
--
-- Nemesis needs "hands played together", which cannot be counted from
-- ca_hand_transfers: two players who both lose a hand generate no
-- transfer row between them, so a transfer-based count silently
-- undercounts exactly the hands where neither beat the other.
-- ---------------------------------------------------------------------
ALTER TABLE public.ca_hand_facts
  ADD COLUMN IF NOT EXISTS opponent_ids uuid[];

COMMENT ON COLUMN public.ca_hand_facts.opponent_ids IS
  'Every other user dealt into this hand. Enables an honest hands-played-together count for Nemesis, which transfers alone cannot give.';

CREATE INDEX IF NOT EXISTS idx_ca_hand_facts_opponents
  ON public.ca_hand_facts USING gin (opponent_ids);

-- ---------------------------------------------------------------------
-- 1. Shared guard
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_assert_self(p_user uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  -- service_role (the engine and cron) may read anyone. An end user may
  -- only ever read themselves.
  IF coalesce(auth.role(), '') = 'service_role' THEN
    RETURN;
  END IF;
  IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user THEN
    RAISE EXCEPTION 'forbidden: this data is readable only by its owner'
      USING ERRCODE = '42501';
  END IF;
END $$;

COMMENT ON FUNCTION public.ca_assert_self(uuid) IS
  'Identity gate for SECURITY DEFINER stats RPCs. DEFINER bypasses RLS, so every such function must call this first.';

-- ---------------------------------------------------------------------
-- 2. EV vs actual profit — the luck graph
--
-- Cash hands only. bb/100 across tournament hands is not comparable
-- (chips are not money and the blind level changes under you), so
-- mixing them would make the curve meaningless rather than merely
-- noisy.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_player_ev_curve(
  p_user  uuid,
  p_days  int DEFAULT NULL,
  p_limit int DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_cap    int := least(greatest(coalesce(p_limit, 5000), 100), 20000);
BEGIN
  PERFORM public.ca_assert_self(p_user);

  WITH picked AS (
    SELECT f.played_at, f.net_bb, f.ev_net_bb, f.was_all_in, f.all_in_equity
    FROM public.ca_hand_facts f
    WHERE f.user_id = p_user
      AND f.tournament_id IS NULL
      AND (p_days IS NULL OR f.played_at >= now() - make_interval(days => p_days))
    ORDER BY f.played_at DESC
    LIMIT v_cap
  ),
  ordered AS (
    SELECT
      row_number() OVER (ORDER BY played_at) AS i,
      played_at, net_bb, ev_net_bb, was_all_in, all_in_equity,
      sum(net_bb)    OVER (ORDER BY played_at ROWS UNBOUNDED PRECEDING) AS cum_net_bb,
      sum(ev_net_bb) OVER (ORDER BY played_at ROWS UNBOUNDED PRECEDING) AS cum_ev_net_bb
    FROM picked
  )
  SELECT jsonb_build_object(
    'points', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'i', i,
        'at', played_at,
        'net_bb', round(net_bb, 2),
        'ev_net_bb', round(ev_net_bb, 2),
        'cum_net_bb', round(cum_net_bb, 2),
        'cum_ev_net_bb', round(cum_ev_net_bb, 2)
      ) ORDER BY i)
      FROM ordered
    ), '[]'::jsonb),
    'summary', (
      SELECT jsonb_build_object(
        'hands', count(*),
        'all_in_hands', count(*) FILTER (WHERE was_all_in AND all_in_equity IS NOT NULL),
        'net_bb', round(coalesce(sum(net_bb), 0), 2),
        'ev_net_bb', round(coalesce(sum(ev_net_bb), 0), 2),
        -- Positive luck means running ABOVE expectation.
        'luck_bb', round(coalesce(sum(net_bb) - sum(ev_net_bb), 0), 2),
        'luck_bb_per_100', CASE WHEN count(*) > 0
          THEN round((coalesce(sum(net_bb) - sum(ev_net_bb), 0) / count(*)) * 100, 2)
          ELSE 0 END,
        'biggest_suckout', round(coalesce(max(net_bb - ev_net_bb) FILTER (WHERE was_all_in), 0), 2),
        'biggest_beat',    round(coalesce(min(net_bb - ev_net_bb) FILTER (WHERE was_all_in), 0), 2),
        'capped', (count(*) >= v_cap)
      )
      FROM ordered
    ),
    'generated_at', now()
  ) INTO v_result;

  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.ca_player_ev_curve(uuid, int, int)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. 13x13 hole-card grid
--
-- hand_class is NULL for PLO (a 169-cell grid cannot represent a 4-6
-- card holding), so those rows drop out here rather than being coerced
-- into a grid that would mean nothing.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_player_hand_grid(
  p_user     uuid,
  p_position text DEFAULT NULL,
  p_variant  text DEFAULT NULL,
  p_days     int  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public.ca_assert_self(p_user);

  WITH picked AS (
    SELECT f.hand_class, f.vpip, f.net_bb, f.ev_net_bb, f.net
    FROM public.ca_hand_facts f
    WHERE f.user_id = p_user
      AND f.hand_class IS NOT NULL
      AND (p_position IS NULL OR f.position = p_position)
      AND (p_variant  IS NULL OR f.game_variant = p_variant)
      AND (p_days     IS NULL OR f.played_at >= now() - make_interval(days => p_days))
  ),
  grouped AS (
    SELECT
      hand_class,
      count(*)                              AS hands,
      count(*) FILTER (WHERE vpip)          AS hands_vpip,
      count(*) FILTER (WHERE net > 0)       AS hands_won,
      sum(net_bb)                           AS net_bb,
      sum(ev_net_bb)                        AS ev_net_bb
    FROM picked
    GROUP BY hand_class
  )
  SELECT jsonb_build_object(
    'cells', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'hand_class', hand_class,
        'hands', hands,
        'hands_vpip', hands_vpip,
        'hands_won', hands_won,
        'vpip_pct', CASE WHEN hands > 0 THEN round(hands_vpip::numeric / hands, 4) ELSE 0 END,
        'net_bb', round(net_bb, 2),
        'ev_net_bb', round(ev_net_bb, 2),
        'bb100', CASE WHEN hands > 0 THEN round((net_bb / hands) * 100, 2) ELSE 0 END
      ))
      FROM grouped
    ), '[]'::jsonb),
    'totals', (
      SELECT jsonb_build_object(
        'hands', coalesce(sum(hands), 0),
        'classes_seen', count(*)
      ) FROM grouped
    ),
    'filters', jsonb_build_object(
      'position', p_position, 'variant', p_variant, 'days', p_days
    ),
    'generated_at', now()
  ) INTO v_result;

  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.ca_player_hand_grid(uuid, text, text, int)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Nemesis / Target
--
-- Net flow is signed from the caller's point of view:
--   net > 0  -> the caller is up on that opponent  (a Target)
--   net < 0  -> the opponent is up on the caller   (a Nemesis)
--
-- p_min_hands exists because below roughly 25 shared hands a "nemesis"
-- is one cooler, not a rivalry.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_player_nemesis(
  p_user      uuid,
  p_days      int DEFAULT NULL,
  p_min_hands int DEFAULT 25,
  p_limit     int DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public.ca_assert_self(p_user);

  WITH flows AS (
    SELECT t.loser_id  AS opponent_id,  t.amount AS delta
    FROM public.ca_hand_transfers t
    WHERE t.winner_id = p_user
      AND (p_days IS NULL OR t.played_at >= now() - make_interval(days => p_days))
    UNION ALL
    SELECT t.winner_id AS opponent_id, -t.amount AS delta
    FROM public.ca_hand_transfers t
    WHERE t.loser_id = p_user
      AND (p_days IS NULL OR t.played_at >= now() - make_interval(days => p_days))
  ),
  netted AS (
    SELECT opponent_id, sum(delta) AS net_chips
    FROM flows
    GROUP BY opponent_id
  ),
  -- Shared-hand counts come from the fact rows' opponent list, not from
  -- transfers: two players who both lost a hand exchange nothing, and a
  -- transfer-based count would silently omit exactly those hands.
  shared AS (
    SELECT o.opponent_id, count(*) AS hands_together, max(f.played_at) AS last_played_at
    FROM public.ca_hand_facts f
    CROSS JOIN LATERAL unnest(coalesce(f.opponent_ids, '{}'::uuid[])) AS o(opponent_id)
    WHERE f.user_id = p_user
      AND (p_days IS NULL OR f.played_at >= now() - make_interval(days => p_days))
    GROUP BY o.opponent_id
  ),
  joined AS (
    SELECT
      n.opponent_id,
      n.net_chips,
      coalesce(s.hands_together, 0) AS hands_together,
      s.last_played_at,
      pr.username,
      pr.avatar_url
    FROM netted n
    LEFT JOIN shared s   ON s.opponent_id = n.opponent_id
    LEFT JOIN public.profiles pr ON pr.id = n.opponent_id
    WHERE coalesce(s.hands_together, 0) >= p_min_hands
  )
  SELECT jsonb_build_object(
    'nemesis', (
      SELECT jsonb_build_object(
        'opponent_id', opponent_id, 'username', username, 'avatar_url', avatar_url,
        'net_chips', round(net_chips, 2), 'hands_together', hands_together,
        'last_played_at', last_played_at)
      FROM joined WHERE net_chips < 0 ORDER BY net_chips ASC LIMIT 1
    ),
    'target', (
      SELECT jsonb_build_object(
        'opponent_id', opponent_id, 'username', username, 'avatar_url', avatar_url,
        'net_chips', round(net_chips, 2), 'hands_together', hands_together,
        'last_played_at', last_played_at)
      FROM joined WHERE net_chips > 0 ORDER BY net_chips DESC LIMIT 1
    ),
    'worst', coalesce((
      SELECT jsonb_agg(x) FROM (
        SELECT opponent_id, username, avatar_url, round(net_chips, 2) AS net_chips,
               hands_together, last_played_at
        FROM joined WHERE net_chips < 0 ORDER BY net_chips ASC LIMIT p_limit
      ) x), '[]'::jsonb),
    'best', coalesce((
      SELECT jsonb_agg(x) FROM (
        SELECT opponent_id, username, avatar_url, round(net_chips, 2) AS net_chips,
               hands_together, last_played_at
        FROM joined WHERE net_chips > 0 ORDER BY net_chips DESC LIMIT p_limit
      ) x), '[]'::jsonb),
    'min_hands', p_min_hands,
    'opponents_qualified', (SELECT count(*) FROM joined),
    'generated_at', now()
  ) INTO v_result;

  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.ca_player_nemesis(uuid, int, int, int)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Percentile benchmarking
--
-- COHORT HONESTY: 584 of the 585 users with hands are horses. A
-- percentile computed today is a percentile against the horse field.
-- That is a genuinely useful comparison — they are the opponents a
-- player actually faces — but it is NOT a human population, and the UI
-- must say "the field", never "players like you".
--
-- The cohort column exists from day one so that switching to a human
-- cohort later is a config change, not a rebuild.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ca_stat_distribution (
  cohort      text    NOT NULL,
  metric      text    NOT NULL,
  p10 numeric, p25 numeric, p50 numeric, p75 numeric, p90 numeric,
  sample_size int     NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cohort, metric)
);

COMMENT ON TABLE public.ca_stat_distribution IS
  'Percentile breakpoints per metric per cohort. cohort=field includes horses (584 of 585 users with hands). Refreshed by ca_refresh_stat_distribution().';

ALTER TABLE public.ca_stat_distribution ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='ca_stat_distribution'
      AND policyname='ca_stat_distribution_read'
  ) THEN
    -- Aggregate breakpoints only. No individual is identifiable from them.
    CREATE POLICY ca_stat_distribution_read ON public.ca_stat_distribution
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.ca_refresh_stat_distribution(
  p_min_hands int DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows int := 0;
BEGIN
  -- Rate stats need far more hands to stabilise than volume stats do,
  -- which is why this qualifier is 1000 and not the 20 that
  -- fn_global_leaderboard_period uses.
  WITH base AS (
    SELECT
      ps.user_id,
      sum(ps.hands_played)                        AS hands,
      avg(nullif(ps.vpip, 0))                     AS vpip,
      avg(nullif(ps.pfr, 0))                      AS pfr,
      CASE WHEN sum(ps.sum_big_blind) > 0
        THEN (sum(ps.total_winnings) - sum(ps.total_losses)) / sum(ps.sum_big_blind) * 100
        ELSE NULL END                             AS bb100
    FROM public.player_stats ps
    GROUP BY ps.user_id
    HAVING sum(ps.hands_played) >= p_min_hands
  ),
  pos AS (
    SELECT
      pps.user_id,
      CASE WHEN sum(pps.hands_played) > 0
        THEN sum(pps.three_bet_count)::numeric / sum(pps.hands_played) * 100
        ELSE NULL END AS three_bet,
      CASE WHEN sum(pps.hands_played) > 0
        THEN sum(pps.hands_won)::numeric / sum(pps.hands_played) * 100
        ELSE NULL END AS win_rate
    FROM public.player_position_stats pps
    GROUP BY pps.user_id
    HAVING sum(pps.hands_played) >= p_min_hands
  ),
  merged AS (
    SELECT b.user_id, b.vpip, b.pfr, b.bb100, p.three_bet, p.win_rate
    FROM base b LEFT JOIN pos p ON p.user_id = b.user_id
  ),
  unpivoted AS (
    SELECT 'vpip'::text AS metric, vpip AS v FROM merged
    UNION ALL SELECT 'pfr', pfr FROM merged
    UNION ALL SELECT 'bb100', bb100 FROM merged
    UNION ALL SELECT 'three_bet', three_bet FROM merged
    UNION ALL SELECT 'win_rate', win_rate FROM merged
  ),
  computed AS (
    SELECT
      metric,
      percentile_cont(0.10) WITHIN GROUP (ORDER BY v) AS p10,
      percentile_cont(0.25) WITHIN GROUP (ORDER BY v) AS p25,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY v) AS p50,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY v) AS p75,
      percentile_cont(0.90) WITHIN GROUP (ORDER BY v) AS p90,
      count(v) AS n
    FROM unpivoted
    WHERE v IS NOT NULL
    GROUP BY metric
  )
  INSERT INTO public.ca_stat_distribution
    (cohort, metric, p10, p25, p50, p75, p90, sample_size, computed_at)
  SELECT 'field', metric,
         round(p10, 3), round(p25, 3), round(p50, 3), round(p75, 3), round(p90, 3),
         n, now()
  FROM computed
  ON CONFLICT (cohort, metric) DO UPDATE SET
    p10 = EXCLUDED.p10, p25 = EXCLUDED.p25, p50 = EXCLUDED.p50,
    p75 = EXCLUDED.p75, p90 = EXCLUDED.p90,
    sample_size = EXCLUDED.sample_size, computed_at = EXCLUDED.computed_at;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('metrics_written', v_rows, 'min_hands', p_min_hands, 'at', now());
END $$;

GRANT EXECUTE ON FUNCTION public.ca_refresh_stat_distribution(int) TO service_role;

-- ---------------------------------------------------------------------
-- 6. Post-apply assertions
-- ---------------------------------------------------------------------
DO $$
DECLARE v_fns int;
BEGIN
  SELECT count(*) INTO v_fns FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('ca_assert_self','ca_player_ev_curve','ca_player_hand_grid',
                      'ca_player_nemesis','ca_refresh_stat_distribution');
  IF v_fns < 5 THEN
    RAISE EXCEPTION 'ASSERT FAILED: expected 5 stats functions, found %.', v_fns;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ca_hand_facts' AND column_name='opponent_ids'
  ) THEN
    RAISE EXCEPTION 'ASSERT FAILED: ca_hand_facts.opponent_ids missing.';
  END IF;

  RAISE NOTICE 'stats RPCs installed: % functions.', v_fns;
END $$;
