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

  WITH picked AS MATERIALIZED (
    SELECT f.played_at, f.net_bb, f.ev_net_bb, f.was_all_in, f.all_in_equity
    FROM public.ca_hand_facts f
    WHERE f.user_id = p_user
      AND f.went_to_showdown = true
      AND f.game_variant NOT IN ('mtt', 'sit_and_go')
      AND (p_days IS NULL OR f.played_at >= now() - make_interval(days => p_days))
    ORDER BY f.played_at DESC
    LIMIT v_cap
  ),
  accum AS MATERIALIZED (
    SELECT
      row_number() OVER w AS i,
      played_at AS at,
      net_bb,
      ev_net_bb,
      sum(net_bb) OVER w AS cum_net_bb,
      sum(ev_net_bb) OVER w AS cum_ev_net_bb,
      sum(net_bb - ev_net_bb) OVER w AS luck_bb
    FROM picked
    WINDOW w AS (ORDER BY played_at ASC)
  ),
  agg AS MATERIALIZED (
    SELECT
      count(*) AS hands,
      count(*) FILTER (WHERE was_all_in = true) AS all_in_hands,
      sum(net_bb) AS net_bb,
      sum(ev_net_bb) AS ev_net_bb,
      sum(net_bb - ev_net_bb) AS luck_bb,
      max(net_bb - ev_net_bb) AS biggest_suckout,
      min(net_bb - ev_net_bb) AS biggest_beat,
      CASE WHEN count(*) = 0 THEN 0
           ELSE (sum(net_bb - ev_net_bb) / count(*)) * 100 END AS luck_bb_per_100,
      (count(*) = v_cap) AS capped
    FROM accum
  )
  SELECT jsonb_build_object(
    'points', coalesce((
      SELECT jsonb_agg(x) FROM (
        SELECT i, at, net_bb, ev_net_bb, cum_net_bb, cum_ev_net_bb
        FROM accum
      ) x
    ), '[]'::jsonb),
    'summary', (
      SELECT jsonb_build_object(
        'hands', hands,
        'all_in_hands', all_in_hands,
        'net_bb', round(coalesce(net_bb, 0), 2),
        'ev_net_bb', round(coalesce(ev_net_bb, 0), 2),
        'luck_bb', round(coalesce(luck_bb, 0), 2),
        'luck_bb_per_100', round(coalesce(luck_bb_per_100, 0), 2),
        'biggest_suckout', round(coalesce(biggest_suckout, 0), 2),
        'biggest_beat', round(coalesce(biggest_beat, 0), 2),
        'capped', capped
      )
      FROM agg
    ),
    'generated_at', now()
  ) INTO v_result;

  RETURN v_result;
END $$;


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

  WITH picked AS MATERIALIZED (
    SELECT f.hand_class, f.vpip, f.net_bb, f.ev_net_bb, f.net
    FROM public.ca_hand_facts f
    WHERE f.user_id = p_user
      AND f.hand_class IS NOT NULL
      AND (p_position IS NULL OR f.position = p_position)
      AND (p_variant  IS NULL OR f.game_variant = p_variant)
      AND (p_days     IS NULL OR f.played_at >= now() - make_interval(days => p_days))
  ),
  grouped AS MATERIALIZED (
    SELECT
      hand_class,
      count(*) AS hands,
      count(*) FILTER (WHERE vpip) AS hands_vpip,
      count(*) FILTER (WHERE net > 0) AS hands_won,
      (count(*) FILTER (WHERE vpip)::numeric / count(*)) AS vpip_pct,
      round(sum(net_bb), 2) AS net_bb,
      round(sum(ev_net_bb), 2) AS ev_net_bb,
      round((sum(net_bb) / nullif(count(*), 0)) * 100, 2) AS bb100
    FROM picked
    GROUP BY hand_class
  )
  SELECT jsonb_build_object(
    'cells', coalesce((
      SELECT jsonb_agg(x) FROM (
        SELECT hand_class, hands, hands_vpip, hands_won, vpip_pct, net_bb, ev_net_bb, bb100
        FROM grouped
      ) x
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'hands', (SELECT sum(hands) FROM grouped),
      'classes_seen', (SELECT count(*) FROM grouped)
    ),
    'filters', jsonb_build_object(
      'position', p_position,
      'variant',  p_variant,
      'days',     p_days
    ),
    'generated_at', now()
  ) INTO v_result;

  RETURN v_result;
END $$;


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

  WITH flows AS MATERIALIZED (
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
  netted AS MATERIALIZED (
    SELECT opponent_id, sum(delta) AS net_chips
    FROM flows
    GROUP BY opponent_id
  ),
  shared AS MATERIALIZED (
    SELECT o.opponent_id, count(*) AS hands_together, max(f.played_at) AS last_played_at
    FROM public.ca_hand_facts f
    CROSS JOIN LATERAL unnest(coalesce(f.opponent_ids, '{}'::uuid[])) AS o(opponent_id)
    WHERE f.user_id = p_user
      AND (p_days IS NULL OR f.played_at >= now() - make_interval(days => p_days))
    GROUP BY o.opponent_id
  ),
  joined AS MATERIALIZED (
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

CREATE OR REPLACE FUNCTION public.ca_club_my_downline(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_scope uuid[];
  v_uid   uuid := auth.uid();
  v_role  text;
  v_res   jsonb;
BEGIN
  v_scope := public.fn_club_scope_ids(p_club_id);
  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    RETURN jsonb_build_object('scoped', true, 'user_ids', '[]'::jsonb);
  END IF;

  -- Grab highest role in scope
  SELECT cm.role INTO v_role
  FROM public.club_members cm
  WHERE cm.club_id = ANY(v_scope) AND cm.user_id = v_uid
  ORDER BY CASE cm.role
    WHEN 'owner' THEN 100 WHEN 'co_owner' THEN 90 WHEN 'admin' THEN 80
    WHEN 'super_agent' THEN 60 WHEN 'agent' THEN 40 WHEN 'sub_agent' THEN 20
    ELSE 0 END DESC
  LIMIT 1;

  IF v_role IN ('owner', 'co_owner', 'admin') THEN
    RETURN jsonb_build_object('scoped', false, 'user_ids', null);
  END IF;

  WITH RECURSIVE
  edges AS MATERIALIZED (
    SELECT DISTINCT cm.user_id AS child, cm.agent_id AS parent
    FROM public.club_members cm
    WHERE cm.club_id = ANY(v_scope)
      AND cm.agent_id IS NOT NULL
      AND cm.agent_id <> cm.user_id
  ),
  tree AS MATERIALIZED (
    SELECT child FROM edges WHERE parent = v_uid
    UNION ALL
    SELECT e.child FROM tree t JOIN edges e ON e.parent = t.child
  )
  SELECT jsonb_build_object(
    'scoped', true,
    'user_ids', coalesce(jsonb_agg(DISTINCT child), '[]'::jsonb)
  ) INTO v_res
  FROM tree;

  RETURN v_res;
END $$;

-- Apply MATERIALIZED to CTEs in ca_player_stats_full
DROP FUNCTION IF EXISTS public.ca_player_stats_full(uuid);
DROP FUNCTION IF EXISTS public.ca_player_stats_full(uuid, int);

-- ============================================================================
-- 20260819_ca_player_stats_full_rpc.sql
-- Club Arena Player Stats rebuild (Tier 2 migration — additive only)
--
-- WHY: /hub/club-arena/stats showed "No Stats Yet" for everyone.
--   Root causes:
--   1. player_stats has ONE ROW PER CLUB per user; the page called
--      .maybeSingle() which errors on >1 row -> data=null -> empty state.
--   2. player_sessions is essentially unpopulated (3 rows total) while the
--      real source of truth (hand_history, 2.2M rows) was never queried.
--
-- WHAT THIS ADDS (no destructive changes, no data rewrites):
--   1. GIN index on hand_history.players (jsonb_path_ops) for @> lookups.
--      (Built CONCURRENTLY out-of-band on 2026-08-19; IF NOT EXISTS keeps
--      this migration idempotent.)
--   2. ca_player_stats_full(p_user uuid) RETURNS jsonb — SECURITY DEFINER
--      RPC that computes lifetime cash + tournament statistics directly
--      from hand_history + tournament_registrations:
--      totals, VPIP/PFR/3-bet/fold-to-3-bet/c-bet/AF/WTSD/WSD, profit,
--      bb/100, per-position stats, per-variant stats, daily series,
--      gap-clustered session history, tournament results (entries, ITM,
--      wins, ROI) and recent tournaments.
--
-- SECURITY: definer bypasses hand_history RLS but only returns aggregates
--   (never hole cards). EXECUTE granted to authenticated + service_role
--   only. Stats are club-visible by design (same as player_stats RLS).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.ca_player_stats_full(uuid, int);
--   DROP INDEX IF EXISTS public.idx_hand_history_players_gin;
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_hand_history_players_gin
  ON public.hand_history USING gin (players jsonb_path_ops);

CREATE OR REPLACE FUNCTION public.ca_player_stats_full(p_user uuid, p_days int DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  -- Cap: the `authenticated` role has statement_timeout=8s. Measured per-hand
  -- cost is ~3.8ms (random heap fetch plus per-hand JSONB expansion of players,
  -- actions and winners); 1500 hands measured 5.7s warm and was CANCELLED
  -- outright under concurrent load, so the window is the most recent 750 hands
  -- (~2.1s measured for the heaviest account on production).
  -- Ordinary players are unaffected — under 750 hands you get your full
  -- history. Above it, overall.hand_cap / hands_capped drive a "Based on your
  -- most recent N hands" line so a truncated window is never presented as a
  -- lifetime total.
  c_cap  constant int := 750;
  v_ids  uuid[];
  v_floor timestamptz;
  v_ceil  timestamptz;
  v_need int;
  -- p_days: analyse only hands newer than this many days (NULL = no time bound,
  -- i.e. the most recent c_cap hands whenever they were played).
  v_since timestamptz := CASE WHEN p_days IS NULL OR p_days <= 0
                              THEN NULL ELSE now() - make_interval(days => p_days) END;
  -- Lifetime volume, independent of both the cap and the window. This is an
  -- index-only scan over ca_hand_player_idx (23ms for a 71,700-hand account
  -- after VACUUM), so the headline "hands played" can be the TRUE number even
  -- though the behavioural stats below are computed from a sample.
  v_life_hands int := 0;
  v_life_first timestamptz;
  v_life_last  timestamptz;
BEGIN
  SELECT count(*)::int, min(created_at), max(created_at)
  INTO v_life_hands, v_life_first, v_life_last
  FROM ca_hand_player_idx WHERE user_id = p_user;
  -- Hand selection is deliberately two-step. hand_history.players is JSONB, so a
  -- containment scan has to materialise EVERY hand a player appears in before
  -- ORDER BY/LIMIT can apply (measured: 71,238 rows / 35,807 heap blocks / ~12s
  -- for an active account — past the 8s timeout). ca_hand_player_idx gives a
  -- (user_id, created_at DESC) btree, so step 1 is an index range scan that
  -- heap-fetches only the hands we actually use.
  SELECT array_agg(hand_id ORDER BY created_at DESC)
  INTO v_ids
  FROM (SELECT hand_id, created_at FROM ca_hand_player_idx
        WHERE user_id = p_user
          AND (v_since IS NULL OR created_at >= v_since)
        ORDER BY created_at DESC LIMIT c_cap) q;

  -- FORWARD TAIL: hands played since the index was last refreshed are not in
  -- ca_hand_player_idx yet. Without this a player's newest hands — the ones they
  -- just played and are most likely checking on — would be missing. The window
  -- is bounded by the refresh cadence and served by idx_hand_history_created,
  -- so it stays cheap; ca_refresh_hand_player_index() keeps it short.
  SELECT idx_ceil INTO v_ceil FROM ca_hand_player_idx_state WHERE id;
  IF v_ceil IS NOT NULL THEN
    SELECT coalesce(array_agg(id ORDER BY created_at DESC), '{}'::uuid[]) || coalesce(v_ids, '{}'::uuid[])
    INTO v_ids
    FROM (SELECT h.id, h.created_at FROM hand_history h
          WHERE h.created_at > v_ceil
            AND (v_since IS NULL OR h.created_at >= v_since)
            AND h.players @> jsonb_build_array(jsonb_build_object('userId', p_user::text))
          ORDER BY h.created_at DESC LIMIT c_cap) q0;

    IF coalesce(array_length(v_ids, 1), 0) > c_cap THEN
      v_ids := v_ids[1:c_cap];
    END IF;
  END IF;

  v_need := c_cap - coalesce(array_length(v_ids, 1), 0);

  -- Step 2 only runs while the backfill is still descending AND this player has
  -- fewer than c_cap indexed hands — which necessarily means a small match set,
  -- so the containment scan here is cheap. High-volume accounts are fully
  -- served by step 1 and never reach this branch.
  IF v_need > 0 THEN
    SELECT idx_floor INTO v_floor FROM ca_hand_player_idx_state WHERE id;
    IF v_floor IS NOT NULL THEN
      SELECT coalesce(v_ids, '{}'::uuid[]) || coalesce(array_agg(id ORDER BY created_at DESC), '{}'::uuid[])
      INTO v_ids
      FROM (SELECT h.id, h.created_at FROM hand_history h
            WHERE h.created_at < v_floor
              AND (v_since IS NULL OR h.created_at >= v_since)
              AND h.players @> jsonb_build_array(jsonb_build_object('userId', p_user::text))
            ORDER BY h.created_at DESC LIMIT v_need) q2;
    END IF;
  END IF;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    v_ids := '{}'::uuid[];
  END IF;

RETURN (
WITH my_hands AS MATERIALIZED (
  SELECT h.id, h.tournament_id,
         lower(coalesce(h.game_variant, 'nlh')) AS game_variant,
         coalesce(h.big_blind, 0)::numeric   AS big_blind,
         coalesce(h.small_blind, 0)::numeric AS small_blind,
         h.button_seat, h.created_at, h.started_at, h.ended_at,
         h.players,
         coalesce(h.actions, '[]'::jsonb) AS actions,
         coalesce(h.winners, '[]'::jsonb) AS winners
  FROM hand_history h
  WHERE h.id = ANY(v_ids)
),
per_hand AS (
  SELECT
    mh.id,
    (mh.tournament_id IS NULL) AS is_cash,
    mh.tournament_id, mh.game_variant, mh.big_blind, mh.created_at,
    s.my_seat, s.seats, mh.button_seat,
    w.won_amt, w.is_winner,
    a.no_fold_players,
    a.invested_actions, a.vpip, a.pfr, a.aggro_cnt, a.call_cnt, a.folded,
    a.three_bet, a.three_bet_opp, a.faced_three_bet, a.folded_to_three_bet,
    a.cbet_opp, a.cbet_made,
    mh.small_blind,
    CASE
      WHEN mh.button_seat IS NULL OR s.seats IS NULL
        OR s.my_seat IS NULL OR array_length(s.seats, 1) < 2
        OR array_position(s.seats, mh.button_seat::int) IS NULL THEN NULL
      ELSE (array_position(s.seats, s.my_seat)
            - array_position(s.seats, mh.button_seat::int)
            + array_length(s.seats, 1)) % array_length(s.seats, 1)
    END AS pos_offset,
    array_length(s.seats, 1) AS n_players,
    CASE
      WHEN mh.started_at IS NOT NULL AND mh.ended_at IS NOT NULL
      THEN GREATEST(0, LEAST(1800, EXTRACT(epoch FROM (mh.ended_at - mh.started_at))))::numeric
      ELSE 45
    END AS hand_secs
  FROM my_hands mh
  CROSS JOIN LATERAL (
    SELECT
      (SELECT (pl->>'seat')::int FROM jsonb_array_elements(mh.players) pl
        WHERE pl->>'userId' = p_user::text LIMIT 1) AS my_seat,
      (SELECT array_agg((pl->>'seat')::int ORDER BY (pl->>'seat')::int)
         FROM jsonb_array_elements(mh.players) pl) AS seats
  ) s
  CROSS JOIN LATERAL (
    SELECT
      coalesce(sum((w1->>'amount')::numeric)
        FILTER (WHERE w1->>'userId' = p_user::text), 0) AS won_amt,
      count(*) FILTER (WHERE w1->>'userId' = p_user::text) > 0 AS is_winner
    FROM jsonb_array_elements(mh.winners) w1
  ) w
  CROSS JOIN LATERAL (
    -- Single expansion of the actions array + cheap follow-up passes over the
    -- tiny materialized act list (perf: authenticated statement_timeout=8s).
    WITH acts AS (
      SELECT x.ord,
             x.act->>'userId' AS auid,
             x.act->>'stage'  AS stage,
             x.act->>'action' AS action,
             coalesce((x.act->>'amount')::numeric, 0) AS amount
      FROM jsonb_array_elements(mh.actions) WITH ORDINALITY x(act, ord)
    ),
    base AS (
      SELECT
        coalesce(sum(amount) FILTER (WHERE auid = p_user::text
          AND action IN ('bet','call','raise','all_in')), 0) AS invested_actions,
        coalesce(bool_or(auid = p_user::text AND stage = 'preflop'
          AND action IN ('call','bet','raise','all_in')), false) AS vpip,
        coalesce(bool_or(auid = p_user::text AND stage = 'preflop'
          AND action IN ('raise','all_in')), false) AS pfr,
        count(*) FILTER (WHERE auid = p_user::text
          AND action IN ('bet','raise','all_in')) AS aggro_cnt,
        count(*) FILTER (WHERE auid = p_user::text AND action = 'call') AS call_cnt,
        coalesce(bool_or(auid = p_user::text AND action = 'fold'), false) AS folded,
        min(ord) FILTER (WHERE auid <> p_user::text AND stage = 'preflop'
          AND action IN ('raise','all_in')) AS first_other_pf_raise,
        min(ord) FILTER (WHERE auid = p_user::text AND stage = 'preflop'
          AND action IN ('raise','all_in')) AS my_first_pf_raise,
        (array_agg(auid ORDER BY ord DESC) FILTER (WHERE stage = 'preflop'
          AND action IN ('raise','all_in')))[1] AS last_pf_raiser,
        (array_agg(auid ORDER BY ord) FILTER (WHERE stage = 'flop'
          AND action IN ('bet','all_in')))[1] AS first_flop_bettor,
        coalesce(bool_or(auid = p_user::text AND stage = 'flop'), false) AS acted_on_flop
      FROM acts
    ),
    derived AS (
      SELECT b.*,
        EXISTS (SELECT 1 FROM acts
          WHERE auid = p_user::text AND stage = 'preflop'
            AND action IN ('raise','all_in') AND ord > b.first_other_pf_raise) AS three_bet_x,
        EXISTS (SELECT 1 FROM acts
          WHERE auid = p_user::text AND stage = 'preflop'
            AND ord > b.first_other_pf_raise) AS three_bet_opp_x,
        (SELECT min(ord) FROM acts
          WHERE auid <> p_user::text AND stage = 'preflop'
            AND action IN ('raise','all_in') AND ord > b.my_first_pf_raise) AS reraise_after_me
      FROM base b
    )
    SELECT d.invested_actions, d.vpip, d.pfr, d.aggro_cnt, d.call_cnt, d.folded,
      coalesce(d.three_bet_x, false) AS three_bet,
      coalesce(d.three_bet_opp_x, false) AS three_bet_opp,
      (d.reraise_after_me IS NOT NULL) AS faced_three_bet,
      coalesce(d.reraise_after_me IS NOT NULL AND EXISTS (
        SELECT 1 FROM acts
        WHERE auid = p_user::text AND stage = 'preflop'
          AND action = 'fold' AND ord > d.reraise_after_me), false) AS folded_to_three_bet,
      coalesce(d.last_pf_raiser = p_user::text AND d.acted_on_flop, false) AS cbet_opp,
      coalesce(d.last_pf_raiser = p_user::text
        AND d.first_flop_bettor = p_user::text, false) AS cbet_made,
      (SELECT count(*) FROM jsonb_array_elements(mh.players) pl
        WHERE pl->>'userId' NOT IN (
          SELECT auid FROM acts
          WHERE action = 'fold' AND auid IS NOT NULL)) AS no_fold_players
    FROM derived d
  ) a
),
enriched AS (
  SELECT ph.*,
    CASE
      WHEN ph.pos_offset IS NULL THEN 0
      WHEN ph.n_players = 2 THEN
        CASE WHEN ph.pos_offset = 0 THEN ph.small_blind ELSE ph.big_blind END
      WHEN ph.pos_offset = 1 THEN ph.small_blind
      WHEN ph.pos_offset = 2 THEN ph.big_blind
      ELSE 0
    END AS my_blind,
    CASE
      WHEN ph.pos_offset IS NULL THEN 'UNK'
      WHEN ph.n_players = 2 THEN CASE WHEN ph.pos_offset = 0 THEN 'BTN' ELSE 'BB' END
      WHEN ph.pos_offset = 0 THEN 'BTN'
      WHEN ph.pos_offset = 1 THEN 'SB'
      WHEN ph.pos_offset = 2 THEN 'BB'
      WHEN ph.pos_offset = ph.n_players - 1 THEN 'CO'
      WHEN ph.pos_offset = 3 THEN 'UTG'
      WHEN ph.pos_offset = 4 AND ph.n_players >= 8 THEN 'UTG+1'
      ELSE 'MP'
    END AS position
  FROM per_hand ph
),
scored AS MATERIALIZED (
  SELECT e.*,
    (e.won_amt - e.invested_actions - e.my_blind) AS profit,
    (NOT e.folded AND e.no_fold_players >= 2) AS showdown
  FROM enriched e
),
totals AS (
  SELECT
    count(*)::int AS hands,
    count(*) FILTER (WHERE is_cash)::int AS cash_hands,
    count(*) FILTER (WHERE NOT is_cash)::int AS tourney_hands,
    count(DISTINCT tournament_id) FILTER (WHERE NOT is_cash)::int AS tournaments_with_hands,
    count(*) FILTER (WHERE is_winner)::int AS hands_won,
    count(*) FILTER (WHERE vpip)::int AS vpip_hands,
    count(*) FILTER (WHERE pfr)::int AS pfr_hands,
    count(*) FILTER (WHERE three_bet)::int AS three_bet_hands,
    count(*) FILTER (WHERE three_bet_opp)::int AS three_bet_opps,
    count(*) FILTER (WHERE faced_three_bet)::int AS faced_three_bet_hands,
    count(*) FILTER (WHERE folded_to_three_bet)::int AS folded_to_three_bet_hands,
    count(*) FILTER (WHERE cbet_opp)::int AS cbet_opps,
    count(*) FILTER (WHERE cbet_made)::int AS cbet_made_hands,
    coalesce(sum(aggro_cnt), 0)::int AS aggro_actions,
    coalesce(sum(call_cnt), 0)::int AS call_actions,
    count(*) FILTER (WHERE showdown)::int AS showdowns,
    count(*) FILTER (WHERE showdown AND is_winner)::int AS showdowns_won,
    coalesce(sum(profit) FILTER (WHERE is_cash), 0) AS cash_profit,
    coalesce(sum(won_amt) FILTER (WHERE is_cash), 0) AS cash_won,
    coalesce(sum(invested_actions + my_blind) FILTER (WHERE is_cash), 0) AS cash_invested,
    coalesce(max(won_amt) FILTER (WHERE is_cash), 0) AS biggest_pot_won,
    coalesce(min(profit) FILTER (WHERE is_cash), 0) AS biggest_hand_loss,
    coalesce(sum(profit / NULLIF(big_blind, 0)) FILTER (WHERE is_cash), 0) AS cash_bb_profit,
    coalesce(sum(hand_secs), 0) AS total_secs,
    min(created_at) AS first_hand_at,
    max(created_at) AS last_hand_at
  FROM scored
),
daily AS (
  SELECT date(created_at) AS d,
         count(*)::int AS hands,
         round(coalesce(sum(profit), 0), 2) AS profit
  FROM scored WHERE is_cash AND created_at >= now() - interval '90 days'
  GROUP BY 1 ORDER BY 1
),
sess_marked AS (
  SELECT *, CASE WHEN created_at - lag(created_at) OVER (ORDER BY created_at)
                   > interval '45 minutes'
                 OR lag(created_at) OVER (ORDER BY created_at) IS NULL
            THEN 1 ELSE 0 END AS new_sess
  FROM scored WHERE is_cash
),
sess_grouped AS (
  SELECT *, sum(new_sess) OVER (ORDER BY created_at) AS sess_no
  FROM sess_marked
),
sessions_agg AS (
  SELECT sess_no,
         min(created_at) AS started,
         max(created_at) AS ended,
         count(*)::int AS hands,
         round(coalesce(sum(profit), 0), 2) AS profit,
         round(coalesce(sum(invested_actions + my_blind), 0), 2) AS invested
  FROM sess_grouped GROUP BY sess_no ORDER BY sess_no DESC LIMIT 50
),
positions AS (
  SELECT position,
         count(*)::int AS hands_played,
         count(*) FILTER (WHERE vpip)::int AS vpip_count,
         count(*) FILTER (WHERE pfr)::int AS pfr_count,
         count(*) FILTER (WHERE three_bet)::int AS three_bet_count,
         count(*) FILTER (WHERE is_winner)::int AS hands_won,
         round(coalesce(sum(profit) FILTER (WHERE is_cash), 0), 2) AS total_profit,
         CASE WHEN count(*) FILTER (WHERE is_cash) > 0
              THEN round(coalesce(sum(profit / NULLIF(big_blind, 0)) FILTER (WHERE is_cash), 0)
                   / count(*) FILTER (WHERE is_cash) * 100, 2)
              ELSE 0 END AS bb100
  FROM scored WHERE position <> 'UNK'
  GROUP BY position
),
stakes AS (
  -- Cash results grouped by big blind, so a player can see which game size is
  -- actually carrying (or bleeding) their results rather than one blended number.
  SELECT big_blind,
         count(*)::int AS hands,
         count(*) FILTER (WHERE is_winner)::int AS hands_won,
         round(coalesce(sum(profit), 0), 2) AS profit,
         CASE WHEN count(*) > 0
              THEN round(coalesce(sum(profit / NULLIF(big_blind, 0)), 0) / count(*) * 100, 2)
              ELSE 0 END AS bb100
  FROM scored
  WHERE is_cash AND big_blind > 0
  GROUP BY big_blind
  ORDER BY big_blind DESC
),
variants AS (
  SELECT game_variant,
         count(*)::int AS hands,
         count(*) FILTER (WHERE is_winner)::int AS hands_won,
         round(coalesce(sum(profit) FILTER (WHERE is_cash), 0), 2) AS profit,
         CASE WHEN count(*) FILTER (WHERE is_cash) > 0
              THEN round(coalesce(sum(profit / NULLIF(big_blind, 0)) FILTER (WHERE is_cash), 0)
                   / count(*) FILTER (WHERE is_cash) * 100, 2)
              ELSE 0 END AS bb100
  FROM scored GROUP BY game_variant ORDER BY count(*) DESC
),
-- Tournament entries live in tournament_players (41,684 rows), NOT in
-- tournament_registrations — that table is empty platform-wide (0 rows), so
-- reading it made the Tournaments tab show zeros for everyone. Buy-in cost is
-- reconstructed from the tournament (buy-in + fee) plus this player's rebuys
-- and add-on; winnings include bounty_winnings for PKO/bounty events.
tourn AS (
  SELECT count(*)::int AS entries,
         count(*) FILTER (WHERE coalesce(tp.prize, 0) > 0)::int AS cashes,
         count(*) FILTER (WHERE tp.position = 1 OR tp.status = 'winner')::int AS wins,
         min(tp.position) FILTER (WHERE tp.position IS NOT NULL) AS best_finish,
         coalesce(sum(coalesce(t.buy_in_amount, 0) + coalesce(t.buy_in_fee, 0)
           + coalesce(tp.rebuys, 0) * coalesce(t.rebuy_cost, 0)
           + CASE WHEN tp.add_on THEN coalesce(t.addon_cost, 0) ELSE 0 END), 0) AS total_buyins,
         coalesce(sum(coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0)), 0) AS total_winnings
  FROM tournament_players tp
  LEFT JOIN tournaments t ON t.id = tp.tournament_id
  WHERE tp.user_id = p_user
),
tourn_recent AS (
  SELECT t.name, t.start_time, t.variant,
         tp.position AS finish_rank, tp.status,
         coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0) AS prize,
         coalesce(t.buy_in_amount, 0) + coalesce(t.buy_in_fee, 0)
           + coalesce(tp.rebuys, 0) * coalesce(t.rebuy_cost, 0)
           + CASE WHEN tp.add_on THEN coalesce(t.addon_cost, 0) ELSE 0 END AS buyin
  FROM tournament_players tp
  JOIN tournaments t ON t.id = tp.tournament_id
  WHERE tp.user_id = p_user
  ORDER BY t.start_time DESC NULLS LAST LIMIT 25
)
SELECT jsonb_build_object(
  'generated_at', now(),
  'window_days', p_days,
  'lifetime', jsonb_build_object(
    'hands', v_life_hands,
    'first_hand_at', v_life_first,
    'last_hand_at', v_life_last,
    -- True when the indexer has not yet reached this player's oldest hands, so
    -- the UI can avoid calling a still-growing number "lifetime".
    'indexed_complete', (SELECT backfill_complete FROM ca_hand_player_idx_state WHERE id)
  ),
  'user_id', p_user,
  'overall', (SELECT jsonb_build_object(
    'total_hands', hands,
    'cash_hands', cash_hands,
    'tourney_hands', tourney_hands,
    'tournaments_with_hands', tournaments_with_hands,
    'hands_won', hands_won,
    'hands_lost', hands - hands_won,
    'vpip', CASE WHEN hands > 0 THEN round(vpip_hands::numeric / hands, 4) ELSE 0 END,
    'pfr', CASE WHEN hands > 0 THEN round(pfr_hands::numeric / hands, 4) ELSE 0 END,
    'three_bet_percent', CASE WHEN three_bet_opps > 0
        THEN round(three_bet_hands::numeric / three_bet_opps, 4) ELSE 0 END,
    'fold_to_three_bet', CASE WHEN faced_three_bet_hands > 0
        THEN round(folded_to_three_bet_hands::numeric / faced_three_bet_hands, 4) ELSE 0 END,
    'cbet_flop', CASE WHEN cbet_opps > 0
        THEN round(cbet_made_hands::numeric / cbet_opps, 4) ELSE 0 END,
    'aggression_factor', CASE WHEN call_actions > 0
        THEN round(aggro_actions::numeric / call_actions, 2) ELSE aggro_actions END,
    'showdowns_total', showdowns,
    'showdowns_won', showdowns_won,
    'wtsd', CASE WHEN hands > 0 THEN round(showdowns::numeric / hands, 4) ELSE 0 END,
    'total_profit', round(cash_profit, 2),
    'total_winnings', round(cash_won, 2),
    'total_invested', round(cash_invested, 2),
    'biggest_pot_won', round(biggest_pot_won, 2),
    'biggest_hand_loss', round(biggest_hand_loss, 2),
    'bb_per_100', CASE WHEN cash_hands > 0
        THEN round(cash_bb_profit / cash_hands * 100, 2) ELSE 0 END,
    'hours_played', round(total_secs / 3600.0, 2),
    'hand_cap', 750,
    'hands_capped', (hands >= 750),
    'first_hand_at', first_hand_at,
    'last_hand_at', last_hand_at
  ) FROM totals),
  'daily', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'date', d, 'hands', hands, 'profit', profit) ORDER BY d) FROM daily), '[]'::jsonb),
  'sessions', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', sess_no,
      'date', started,
      'ended', ended,
      'duration_minutes', GREATEST(1, round(EXTRACT(epoch FROM (ended - started)) / 60)::int),
      'hands_played', hands,
      'buy_in', invested,
      'cash_out', round(invested + profit, 2),
      'profit_loss', profit) ORDER BY sess_no DESC) FROM sessions_agg), '[]'::jsonb),
  'positions', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'position', position,
      'hands_played', hands_played,
      'vpip_count', vpip_count,
      'pfr_count', pfr_count,
      'three_bet_count', three_bet_count,
      'hands_won', hands_won,
      'total_profit', total_profit,
      'bb100', bb100)) FROM positions), '[]'::jsonb),
  'variants', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'variant', game_variant,
      'hands', hands,
      'hands_won', hands_won,
      'profit', profit,
      'bb100', bb100)) FROM variants), '[]'::jsonb),
  'stakes', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'big_blind', big_blind,
      'hands', hands,
      'hands_won', hands_won,
      'profit', profit,
      'bb100', bb100) ORDER BY big_blind DESC) FROM stakes), '[]'::jsonb),
  'tournaments', (SELECT jsonb_build_object(
      'entries', entries,
      'cashes', cashes,
      'wins', wins,
      'best_finish', best_finish,
      'itm_percent', CASE WHEN entries > 0 THEN round(cashes::numeric / entries, 4) ELSE 0 END,
      'total_buyins', round(total_buyins, 2),
      'total_winnings', round(total_winnings, 2),
      'net_profit', round(total_winnings - total_buyins, 2),
      'roi', CASE WHEN total_buyins > 0
          THEN round((total_winnings - total_buyins) / total_buyins, 4) ELSE 0 END
  ) FROM tourn),
  'recent_tournaments', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'name', name,
      'start_time', start_time,
      'variant', variant,
      'finish_rank', finish_rank,
      'status', status,
      'prize', prize,
      'buyin', buyin) ORDER BY start_time DESC NULLS LAST) FROM tourn_recent), '[]'::jsonb)
)
);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_player_stats_full(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_player_stats_full(uuid, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_full(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_full(uuid, int) TO service_role;
