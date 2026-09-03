-- THE SNAPSHOT AN OPERATOR ACTUALLY ASKS FOR.
--
-- ca_club_data_snapshot answers "what did this club produce", and it answers it
-- well, but it answers it for at most 93 days: it materialises one row per game
-- and clamps its own window so that materialisation stays bounded. The question
-- an operator asks at the top of the page is not that question. It is:
--
--   "What has my union / my club / my downline done in rake today? This week?
--    This month? This year?"
--
-- That question needs no game list at all. Both daily rollups -
-- club_table_daily and ca_club_tournament_daily - already carry every figure it
-- wants, keyed on (club_id, stat_date), so a year is a range scan over a rollup
-- rather than a year of hand attribution. This function reads only those, which
-- is why it can be asked for a year when the ledger below it cannot.
--
-- Three scopes, three different gates, all of them server-side:
--
--   club    ca_can_view_club_finances   owner / admin / super_agent
--   union   ca_can_oversee_union        union owner / union staff
--   agent   fn_agent_downline_rake_summary, which raises not_an_agent or
--           not_authorised on its own. Downline rake is attributed per player
--           out of rake_records, not per club out of a rollup, so it is
--           delegated rather than recomputed - an agent's live figure and the
--           figure they are eventually paid on must be the same figure.
--
-- Every window is reported against the equal-length window immediately before
-- it. A percentage against a zero baseline is null, not "+100%".

-- ---------------------------------------------------------------------------
-- One window, one set of clubs, one row of totals.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_rake_window(
  p_club_ids uuid[], p_start date, p_end date
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH cash AS (
    SELECT COALESCE(SUM(c.rake), 0)          AS fee,
           COALESCE(SUM(c.net), 0)           AS winnings,
           COALESCE(SUM(c.hands), 0)::bigint AS hands,
           COUNT(DISTINCT c.table_id)        AS games
      FROM public.club_table_daily c
     WHERE c.club_id = ANY (p_club_ids)
       AND c.stat_date BETWEEN p_start AND p_end
  ), mtt AS (
    SELECT COALESCE(SUM(d.fee), 0)        AS fee,
           COALESCE(SUM(d.winnings), 0)   AS winnings,
           COUNT(DISTINCT d.tournament_id) AS games
      FROM public.ca_club_tournament_daily d
     WHERE d.club_id = ANY (p_club_ids)
       AND d.stat_date BETWEEN p_start AND p_end
  )
  SELECT jsonb_build_object(
    'games',          cash.games + mtt.games,
    'cash_games',     cash.games,
    'mtt_games',      mtt.games,
    'hands',          cash.hands,
    'fee',            round(cash.fee + mtt.fee, 2),
    'cash_fee',       round(cash.fee, 2),
    'mtt_fee',        round(mtt.fee, 2),
    'total_winnings', round(cash.winnings + mtt.winnings, 2),
    'cash_winnings',  round(cash.winnings, 2),
    'mtt_winnings',   round(mtt.winnings, 2)
  )
  FROM cash, mtt;
$function$;

-- ---------------------------------------------------------------------------
-- The trend beneath the headline. Bucketed so that a year does not return 365
-- points into a 200px strip, and a day does not return one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_rake_series(
  p_club_ids uuid[], p_start date, p_end date, p_bucket text
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH b AS (
    SELECT CASE WHEN lower(COALESCE(p_bucket, 'day')) IN ('day', 'week', 'month')
                THEN lower(p_bucket) ELSE 'day' END AS unit
  ), rows AS (
    SELECT c.stat_date AS d, c.rake AS fee, c.net AS winnings
      FROM public.club_table_daily c
     WHERE c.club_id = ANY (p_club_ids) AND c.stat_date BETWEEN p_start AND p_end
    UNION ALL
    SELECT t.stat_date, t.fee, t.winnings
      FROM public.ca_club_tournament_daily t
     WHERE t.club_id = ANY (p_club_ids) AND t.stat_date BETWEEN p_start AND p_end
  ), grouped AS (
    SELECT date_trunc((SELECT unit FROM b), rows.d::timestamp)::date AS bucket,
           round(SUM(rows.fee), 2)      AS fee,
           round(SUM(rows.winnings), 2) AS winnings
      FROM rows GROUP BY 1
  )
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object('bucket', bucket, 'fee', fee, 'winnings', winnings)
              ORDER BY bucket),
    '[]'::jsonb)
  FROM grouped;
$function$;

-- ---------------------------------------------------------------------------
-- Which club produced it. Union scope wants this; club scope has one row and
-- shows it as the split rather than a list.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_club(
  p_club_ids uuid[], p_start date, p_end date, p_limit integer
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH rows AS (
    SELECT c.club_id, c.rake AS fee, c.net AS winnings,
           COALESCE(c.hands, 0)::bigint AS hands,
           'c:' || c.table_id::text AS gid, false AS is_mtt
      FROM public.club_table_daily c
     WHERE c.club_id = ANY (p_club_ids) AND c.stat_date BETWEEN p_start AND p_end
    UNION ALL
    SELECT t.club_id, t.fee, t.winnings, 0::bigint,
           't:' || t.tournament_id::text, true
      FROM public.ca_club_tournament_daily t
     WHERE t.club_id = ANY (p_club_ids) AND t.stat_date BETWEEN p_start AND p_end
  ), agg AS (
    SELECT rows.club_id,
           round(SUM(rows.fee), 2)                                  AS fee,
           round(SUM(rows.fee) FILTER (WHERE rows.is_mtt), 2)       AS mtt_fee,
           round(SUM(rows.fee) FILTER (WHERE NOT rows.is_mtt), 2)   AS cash_fee,
           round(SUM(rows.winnings), 2)                             AS winnings,
           SUM(rows.hands)                                          AS hands,
           COUNT(DISTINCT rows.gid)                                 AS games
      FROM rows GROUP BY rows.club_id
  ), top AS (
    SELECT a.*, cl.name AS club_name, cl.avatar_url, cl.logo_url, cl.code AS club_code
      FROM agg a JOIN public.clubs cl ON cl.id = a.club_id
     ORDER BY a.fee DESC NULLS LAST
     LIMIT GREATEST(LEAST(COALESCE(p_limit, 50), 200), 1)
  )
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object(
      'club_id',   top.club_id,
      'name',      COALESCE(top.club_name, 'Club'),
      'code',      top.club_code,
      'avatar_url', COALESCE(top.avatar_url, top.logo_url),
      'fee',       COALESCE(top.fee, 0),
      'cash_fee',  COALESCE(top.cash_fee, 0),
      'mtt_fee',   COALESCE(top.mtt_fee, 0),
      'winnings',  COALESCE(top.winnings, 0),
      'hands',     COALESCE(top.hands, 0),
      'games',     top.games)
      ORDER BY top.fee DESC NULLS LAST),
    '[]'::jsonb)
  FROM top;
$function$;

-- ---------------------------------------------------------------------------
-- The public entry point.
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
  v_label   text;
  v_agent   jsonb;
  v_agent_p jsonb;
BEGIN
  IF v_scope NOT IN ('club', 'union', 'agent') THEN
    RAISE EXCEPTION 'unknown scope %', v_scope USING ERRCODE = '22023';
  END IF;

  -- Two years is the ceiling. A rollup range scan stays cheap well past that,
  -- but an unbounded p_start is an unbounded plan and this is a public RPC.
  IF v_start < v_end - 730 THEN v_start := v_end - 730; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  v_days   := (v_end - v_start) + 1;
  v_pend   := v_start - 1;
  v_pstart := v_pend - (v_days - 1);

  -- Roughly 30-60 points whatever the window, so one strip renders every period.
  v_bucket := CASE WHEN v_days <= 62 THEN 'day'
                   WHEN v_days <= 400 THEN 'week'
                   ELSE 'month' END;

  ------------------------------------------------------------------ agent ----
  IF v_scope = 'agent' THEN
    IF p_club_id IS NULL THEN
      RAISE EXCEPTION 'agent scope needs a club' USING ERRCODE = '22023';
    END IF;
    -- Delegated, not recomputed: fn_agent_downline_rake_summary owns both the
    -- ancestry check and the weighted-contributed attribution. It is SECURITY
    -- DEFINER over auth.uid(), which this function has not changed.
    v_agent := public.fn_agent_downline_rake_summary(
      p_agent_user_id, p_club_id,
      (v_start::timestamp AT TIME ZONE 'UTC'),
      ((v_end + 1)::timestamp AT TIME ZONE 'UTC'));
    v_agent_p := public.fn_agent_downline_rake_summary(
      p_agent_user_id, p_club_id,
      (v_pstart::timestamp AT TIME ZONE 'UTC'),
      ((v_pend + 1)::timestamp AT TIME ZONE 'UTC'));

    SELECT COALESCE(c.name, 'Club') INTO v_label FROM public.clubs c WHERE c.id = p_club_id;

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
      'breakdown', '[]'::jsonb,
      'breakdown_kind', 'downline',
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
  END IF;

  IF v_clubs IS NULL OR array_length(v_clubs, 1) IS NULL THEN
    v_clubs := ARRAY[]::uuid[];
  END IF;

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
    'breakdown_kind', CASE WHEN v_scope = 'union' THEN 'club' ELSE 'none' END,
    'data_updated_at', GREATEST(
      (SELECT max(c.updated_at) FROM public.club_table_daily c
        WHERE c.club_id = ANY (v_clubs) AND c.stat_date BETWEEN v_start AND v_end),
      (SELECT max(d.updated_at) FROM public.ca_club_tournament_daily d
        WHERE d.club_id = ANY (v_clubs) AND d.stat_date BETWEEN v_start AND v_end)),
    'generated_at', now());
END;
$function$;

-- The three helpers are internal: they take a club-id array and check nothing,
-- because ca_rake_snapshot has already decided which clubs the caller may read.
-- Exposing them to `authenticated` would hand any signed-in user every club's
-- rake for the asking.
REVOKE ALL ON FUNCTION public.fn_ca_rake_window(uuid[], date, date)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_rake_series(uuid[], date, date, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_rake_by_club(uuid[], date, date, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_window(uuid[], date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_series(uuid[], date, date, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_club(uuid[], date, date, integer) TO service_role;

REVOKE ALL ON FUNCTION public.ca_rake_snapshot(text, uuid, uuid, date, date, uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_rake_snapshot(text, uuid, uuid, date, date, uuid, integer)
  TO authenticated, service_role;
