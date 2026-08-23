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
