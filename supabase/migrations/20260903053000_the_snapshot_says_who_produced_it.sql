-- WHO PRODUCED IT.
--
-- ca_rake_snapshot answers "how much". For a union it also answers "which
-- club", because fn_ca_rake_by_club existed from the start. For a club owner
-- and for an agent it answered only the headline, and the headline is not the
-- question either of them asks second. A club owner asks which of their agents
-- is carrying the club. An agent asks which of their players is.
--
-- Two different grains, so two different reads, and neither needs a new table:
--
--   club   club_rake_daily_user is a (club_id, day, user_id) rollup that is
--          already computed nightly and already current. Rolling it up through
--          club_members.agent_id and then through the agents tree turns it into
--          rake per agent - direct, and network including everyone beneath
--          them. The agents table is 145 rows estate-wide, so the recursion is
--          free; the rollup is 31k rows, so the range scan is too.
--
--   agent  fn_agent_downline_rake already returns exactly this, per member,
--          with the ancestry check and the weighted-contributed attribution,
--          and it already splits a window into whole rollup days plus live
--          head and tail slices - so it is fast over a year without help.
--          Delegated, not reimplemented, for the same reason the summary was.
--
-- ONE HONESTY, CARRIED THROUGH. club_rake_daily_user only finalises COMPLETE
-- UTC days. Today is not in it. The club headline comes from club_table_daily,
-- which is written live, so the two disagree by today's rake - and an agent
-- table that silently stops at midnight, under a headline that does not, reads
-- as "my agents produced nothing today". So the payload now carries
-- rake_complete_through and the breakdown's own total, and the panel says so.
-- Shares are computed against the attributed total, never against the headline,
-- because a percentage of a larger number is a smaller and wronger percentage.

CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_agent(
  p_club_id uuid, p_start date, p_end date, p_limit integer
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH RECURSIVE club_agents AS (
    SELECT a.id, a.user_id, a.parent_agent_id, a.role, a.commission_rate
      FROM public.agents a
     WHERE a.club_id = p_club_id AND a.status = 'active'
  ), rake AS (
    SELECT r.user_id AS player_id,
           SUM(r.rake_amount)      AS rake,
           SUM(r.hands)::bigint    AS hands
      FROM public.club_rake_daily_user r
     WHERE r.club_id = p_club_id AND r.day BETWEEN p_start AND p_end
     GROUP BY r.user_id
  ), direct AS (
    SELECT cm.agent_id,
           COUNT(*)                                                   AS players,
           COUNT(*) FILTER (WHERE COALESCE(rk.rake, 0) <> 0)          AS active,
           COALESCE(SUM(rk.rake), 0)                                  AS rake,
           COALESCE(SUM(rk.hands), 0)::bigint                         AS hands
      FROM public.club_members cm
      LEFT JOIN rake rk ON rk.player_id = cm.user_id
     WHERE cm.club_id = p_club_id
     GROUP BY cm.agent_id
  ), tree AS (
    -- Each agent is the root of its own subtree, and also a node in every
    -- subtree above it. The depth cap is not decoration: parent_agent_id is a
    -- plain uuid column with no cycle constraint, and one bad edge would spin
    -- this query until the statement timeout killed the page.
    SELECT ca.id AS root_id, ca.id AS node_id, 0 AS depth FROM club_agents ca
    UNION ALL
    SELECT t.root_id, c.id, t.depth + 1
      FROM tree t JOIN club_agents c ON c.parent_agent_id = t.node_id
     WHERE t.depth < 12
  ), network AS (
    SELECT t.root_id,
           COALESCE(SUM(d.rake), 0)              AS rake,
           COALESCE(SUM(d.players), 0)           AS players,
           COUNT(*) FILTER (WHERE t.node_id <> t.root_id) AS sub_agents
      FROM (SELECT DISTINCT root_id, node_id FROM tree) t
      JOIN club_agents n ON n.id = t.node_id
      LEFT JOIN direct d ON d.agent_id = n.user_id
     GROUP BY t.root_id
  ), listed AS (
    SELECT ca.user_id                              AS agent_user_id,
           COALESCE(pr.username, 'Agent')          AS name,
           pr.avatar_url,
           ca.role,
           ca.commission_rate,
           COALESCE(dr.players, 0)                 AS direct_players,
           COALESCE(dr.active, 0)                  AS direct_active,
           round(COALESCE(dr.rake, 0), 2)          AS direct_rake,
           COALESCE(dr.hands, 0)                   AS direct_hands,
           COALESCE(nw.players, 0)                 AS network_players,
           round(COALESCE(nw.rake, 0), 2)          AS network_rake,
           COALESCE(nw.sub_agents, 0)              AS sub_agents,
           false                                   AS is_unassigned
      FROM club_agents ca
      LEFT JOIN direct  dr ON dr.agent_id = ca.user_id
      LEFT JOIN network nw ON nw.root_id  = ca.id
      LEFT JOIN public.profiles pr ON pr.id = ca.user_id
    UNION ALL
    -- Players with no agent are not nobody's rake. Dropping them makes the
    -- column sum to less than the club total with nothing saying why.
    SELECT NULL, 'Unassigned', NULL, 'none', NULL,
           d.players, d.active, round(d.rake, 2), d.hands,
           d.players, round(d.rake, 2), 0, true
      FROM direct d WHERE d.agent_id IS NULL AND d.players > 0
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY x.is_unassigned, x.network_rake DESC NULLS LAST), '[]'::jsonb)
    FROM (
      SELECT * FROM listed
       ORDER BY is_unassigned, network_rake DESC NULLS LAST
       LIMIT GREATEST(LEAST(COALESCE(p_limit, 50), 200), 1)
    ) x;
$function$;

-- ---------------------------------------------------------------------------
-- The per-member list for an agent, shaped like every other breakdown so the
-- panel renders one component rather than three.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_downline(
  p_agent_user_id uuid, p_club_id uuid,
  p_since timestamptz, p_until timestamptz, p_limit integer
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'player_id',        d.player_id,
    'name',             COALESCE(d.username, 'Player'),
    'role',             d.role,
    'depth',            d.depth,
    'upline_user_id',   d.upline_user_id,
    'upline_name',      d.upline_name,
    'rake',             round(COALESCE(d.rake_generated, 0), 2),
    'hands',            COALESCE(d.hands, 0),
    'last_hand_at',     d.last_hand_at,
    -- Non-zero means this member is themselves an agent, which is what makes
    -- their row a door rather than a leaf.
    'downline_players', COALESCE(d.downline_players, 0),
    'downline_rake',    round(COALESCE(d.downline_rake, 0), 2))
    ORDER BY d.rake_generated DESC NULLS LAST), '[]'::jsonb)
  FROM public.fn_agent_downline_rake(
         p_agent_user_id, p_club_id, p_since, p_until, NULL,
         GREATEST(LEAST(COALESCE(p_limit, 100), 500), 1)) d;
$function$;

-- ---------------------------------------------------------------------------
-- ca_rake_snapshot gains the breakdown for the two scopes that had none, and
-- the completeness boundary for the rollup those breakdowns read.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_rake_snapshot(
  p_scope text DEFAULT 'club'::text,
  p_club_id uuid DEFAULT NULL::uuid,
  p_union_id uuid DEFAULT NULL::uuid,
  p_start date DEFAULT NULL::date,
  p_end date DEFAULT NULL::date,
  p_agent_user_id uuid DEFAULT NULL::uuid,
  p_limit integer DEFAULT 50
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_scope   text := lower(COALESCE(NULLIF(btrim(p_scope), ''), 'club'));
  v_today   date := (now() AT TIME ZONE 'UTC')::date;
  v_end     date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start   date := COALESCE(p_start, v_end - 6);
  v_days    int;
  v_pstart  date;
  v_pend    date;
  v_bucket  text;
  v_union   uuid;
  v_clubs   uuid[];
  v_cur     jsonb;
  v_prev    jsonb;
  v_series  jsonb;
  v_break   jsonb := '[]'::jsonb;
  v_kind    text  := 'none';
  v_label   text;
  v_agent   jsonb;
  v_agent_p jsonb;
  v_through date;
  v_btotal  numeric := NULL;
BEGIN
  IF v_scope NOT IN ('club', 'union', 'agent') THEN
    RAISE EXCEPTION 'unknown scope %', v_scope USING ERRCODE = '22023';
  END IF;

  IF v_start < v_end - 730 THEN v_start := v_end - 730; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  v_days   := (v_end - v_start) + 1;
  v_pend   := v_start - 1;
  v_pstart := v_pend - (v_days - 1);

  v_bucket := CASE WHEN v_days <= 62 THEN 'day'
                   WHEN v_days <= 400 THEN 'week'
                   ELSE 'month' END;

  ------------------------------------------------------------------ agent ----
  IF v_scope = 'agent' THEN
    IF p_club_id IS NULL THEN
      RAISE EXCEPTION 'agent scope needs a club' USING ERRCODE = '22023';
    END IF;
    v_agent := public.fn_agent_downline_rake_summary(
      p_agent_user_id, p_club_id,
      (v_start::timestamp AT TIME ZONE 'UTC'),
      ((v_end + 1)::timestamp AT TIME ZONE 'UTC'));
    v_agent_p := public.fn_agent_downline_rake_summary(
      p_agent_user_id, p_club_id,
      (v_pstart::timestamp AT TIME ZONE 'UTC'),
      ((v_pend + 1)::timestamp AT TIME ZONE 'UTC'));
    v_break := public.fn_ca_rake_by_downline(
      p_agent_user_id, p_club_id,
      (v_start::timestamp AT TIME ZONE 'UTC'),
      ((v_end + 1)::timestamp AT TIME ZONE 'UTC'), p_limit);

    SELECT COALESCE(c.name, 'Club') INTO v_label FROM public.clubs c WHERE c.id = p_club_id;
    SELECT COALESCE(SUM((e->>'rake')::numeric), 0) INTO v_btotal
      FROM jsonb_array_elements(v_break) e;

    RETURN jsonb_build_object(
      'scope', 'agent',
      'scope_label', COALESCE(v_label, 'Downline'),
      'club_id', p_club_id,
      'union_id', NULL,
      'agent_user_id', p_agent_user_id,
      'range', jsonb_build_object('start', v_start, 'end', v_end, 'days', v_days),
      'previous_range', jsonb_build_object('start', v_pstart, 'end', v_pend, 'days', v_days),
      'summary', jsonb_build_object(
        'fee',            round(COALESCE((v_agent->>'rake_generated')::numeric, 0), 2),
        'cash_fee',       NULL,
        'mtt_fee',        NULL,
        'games',          NULL,
        'hands',          COALESCE((v_agent->>'hands')::bigint, 0),
        'total_winnings', NULL,
        'mtt_winnings',   NULL,
        'members',        COALESCE((v_agent->>'members')::int, 0),
        'active',         COALESCE((v_agent->>'active')::int, 0),
        'commission_rate',      (v_agent->>'commission_rate')::numeric,
        'estimated_commission', round(COALESCE((v_agent->>'estimated_commission')::numeric, 0), 2)),
      'previous', jsonb_build_object(
        'fee',   round(COALESCE((v_agent_p->>'rake_generated')::numeric, 0), 2),
        'hands', COALESCE((v_agent_p->>'hands')::bigint, 0)),
      'delta', jsonb_build_object(
        'fee_pct', CASE WHEN COALESCE((v_agent_p->>'rake_generated')::numeric, 0) = 0 THEN NULL
                   ELSE round((COALESCE((v_agent->>'rake_generated')::numeric, 0)
                             - (v_agent_p->>'rake_generated')::numeric)
                             / abs((v_agent_p->>'rake_generated')::numeric) * 100, 1) END,
        'fee_abs', round(COALESCE((v_agent->>'rake_generated')::numeric, 0)
                       - COALESCE((v_agent_p->>'rake_generated')::numeric, 0), 2),
        'games_pct', NULL,
        'winnings_abs', NULL),
      'series', '[]'::jsonb,
      'series_bucket', v_bucket,
      'breakdown', v_break,
      'breakdown_kind', 'downline',
      'breakdown_total', v_btotal,
      -- The downline walker reads live edges either side of the rollup, so its
      -- figures already include today. Nothing to disclose.
      'rake_complete_through', NULL,
      'top_earner', v_agent->'top_earner',
      'generated_at', now());
  END IF;

  ------------------------------------------------------------------ union ----
  IF v_scope = 'union' THEN
    v_union := p_union_id;
    IF v_union IS NULL AND p_club_id IS NOT NULL THEN
      SELECT uc.union_id INTO v_union
        FROM public.union_clubs uc WHERE uc.club_id = p_club_id LIMIT 1;
    END IF;
    IF v_union IS NULL THEN
      RAISE EXCEPTION 'no union for this context' USING ERRCODE = '22023';
    END IF;
    IF NOT public.ca_can_oversee_union(v_union) THEN
      RAISE EXCEPTION 'not authorized for this union' USING ERRCODE = '42501';
    END IF;
    SELECT ARRAY(SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id = v_union)
      INTO v_clubs;
    SELECT u.name INTO v_label FROM public.unions u WHERE u.id = v_union;
    v_break := public.fn_ca_rake_by_club(v_clubs, v_start, v_end, p_limit);
    v_kind  := 'club';

  ------------------------------------------------------------------- club ----
  ELSE
    IF p_club_id IS NULL THEN
      RAISE EXCEPTION 'club scope needs a club' USING ERRCODE = '22023';
    END IF;
    IF NOT public.ca_can_view_club_finances(p_club_id) THEN
      RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
    END IF;
    v_clubs := ARRAY[p_club_id];
    SELECT uc.union_id INTO v_union
      FROM public.union_clubs uc WHERE uc.club_id = p_club_id LIMIT 1;
    SELECT c.name INTO v_label FROM public.clubs c WHERE c.id = p_club_id;
    v_break := public.fn_ca_rake_by_agent(p_club_id, v_start, v_end, p_limit);
    v_kind  := 'agent';
    -- The last COMPLETE day the per-player rollup holds for this club inside
    -- the window. Null means it holds nothing here at all, which is a different
    -- statement from "your agents produced nothing".
    SELECT max(r.day) INTO v_through
      FROM public.club_rake_daily_user r
     WHERE r.club_id = p_club_id AND r.day BETWEEN v_start AND v_end;
  END IF;

  IF v_clubs IS NULL OR array_length(v_clubs, 1) IS NULL THEN
    v_clubs := ARRAY[]::uuid[];
  END IF;

  -- DIRECT rake, never network rake. Every player is assigned to exactly one
  -- agent or to none, so summing direct_rake counts each player's rake once.
  -- Network rake deliberately double-counts - a super agent's total contains
  -- their sub-agents' - so summing it would produce a denominator larger than
  -- the club's own rake and every share below 100% of nothing real.
  SELECT COALESCE(SUM(COALESCE((e->>'direct_rake')::numeric, (e->>'fee')::numeric, 0)), 0)
    INTO v_btotal
    FROM jsonb_array_elements(v_break) e;

  v_cur    := public.fn_ca_rake_window(v_clubs, v_start, v_end);
  v_prev   := public.fn_ca_rake_window(v_clubs, v_pstart, v_pend);
  v_series := public.fn_ca_rake_series(v_clubs, v_start, v_end, v_bucket);

  RETURN jsonb_build_object(
    'scope', v_scope,
    'scope_label', COALESCE(v_label, initcap(v_scope)),
    'club_id', p_club_id,
    'union_id', v_union,
    'club_count', array_length(v_clubs, 1),
    'range', jsonb_build_object('start', v_start, 'end', v_end, 'days', v_days),
    'previous_range', jsonb_build_object('start', v_pstart, 'end', v_pend, 'days', v_days),
    'summary', v_cur,
    'previous', v_prev,
    'delta', jsonb_build_object(
      'fee_pct', CASE WHEN COALESCE((v_prev->>'fee')::numeric, 0) = 0 THEN NULL
                 ELSE round(((v_cur->>'fee')::numeric - (v_prev->>'fee')::numeric)
                          / abs((v_prev->>'fee')::numeric) * 100, 1) END,
      'games_pct', CASE WHEN COALESCE((v_prev->>'games')::numeric, 0) = 0 THEN NULL
                   ELSE round(((v_cur->>'games')::numeric - (v_prev->>'games')::numeric)
                            / abs((v_prev->>'games')::numeric) * 100, 1) END,
      'fee_abs', round((v_cur->>'fee')::numeric - (v_prev->>'fee')::numeric, 2),
      'winnings_abs', round((v_cur->>'total_winnings')::numeric
                          - (v_prev->>'total_winnings')::numeric, 2)),
    'series', v_series,
    'series_bucket', v_bucket,
    'breakdown', v_break,
    'breakdown_kind', v_kind,
    'breakdown_total', v_btotal,
    'rake_complete_through', v_through,
    'data_updated_at', GREATEST(
      (SELECT max(c.updated_at) FROM public.club_table_daily c
        WHERE c.club_id = ANY (v_clubs) AND c.stat_date BETWEEN v_start AND v_end),
      (SELECT max(d.updated_at) FROM public.ca_club_tournament_daily d
        WHERE d.club_id = ANY (v_clubs) AND d.stat_date BETWEEN v_start AND v_end)),
    'generated_at', now());
END;
$function$;

-- Same reasoning as the first three helpers: these take a club id and check
-- nothing, because ca_rake_snapshot has already decided the caller may read it.
-- fn_ca_rake_by_downline is the one exception that still gates itself, because
-- fn_agent_downline_rake refuses a stranger's book on its own - but it is
-- revoked anyway, so there is one door and not two.
REVOKE ALL ON FUNCTION public.fn_ca_rake_by_agent(uuid, date, date, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_rake_by_downline(uuid, uuid, timestamptz, timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_agent(uuid, date, date, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_downline(uuid, uuid, timestamptz, timestamptz, integer) TO service_role;

REVOKE ALL ON FUNCTION public.ca_rake_snapshot(text, uuid, uuid, date, date, uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_rake_snapshot(text, uuid, uuid, date, date, uuid, integer)
  TO authenticated, service_role;
