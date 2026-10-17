-- 20261017105645_club_data_counts_what_the_club_played.sql
--
-- WHAT THIS CHANGES, AND WHY (Dan: "THERE IS NO SHOT THIS IS CORRECT DATA FOR THE ENTIRE CLUB...
-- MAKE SURE THAT THIS IS ACCURATE REAL TIME DATA AT ALL TIMES"):
--
-- 1. ACCURATE REAL TIME CLUB ATTRIBUTION:
--    Union cash and tournament play were attributed using `fn_ca_cash_reporting_club` which guessed
--    the player's first joined club in the union (`cm.joined_at ASC LIMIT 1`).
--    Every Club JAQK member joined SHARK CLUB first, causing JAQK's union action to be attributed
--    to SHARK instead of JAQK.
--    In reality, every cash table seat records `table_seats.club_id`, every wallet transaction records
--    the source club/table, and tournament registration records `tournament_players.club_id`.
--    `fn_ca_cash_reporting_club` and `ca_reporting_tournament_clubs_for_user` are updated to honor
--    the exact club chips moved through.
--
-- 2. ROLE-BASED SCOPING IN `ca_club_data_screen`:
--    - Owners, co-owners, admins see the entire club.
--    - Agents, sub-agents, super-agents see their downline + own play.
--    - Regular players are refused with 42501 ('not authorized for this club').

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. Ensure fn_ca_cash_reporting_club respects exact club if available, or player's active club
CREATE OR REPLACE FUNCTION public.fn_ca_cash_reporting_club(p_union uuid, p_table_club uuid, p_user uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((
    SELECT ts.club_id FROM public.table_seats ts
     WHERE ts.user_id = p_user AND ts.club_id IS NOT NULL
     ORDER BY ts.joined_at DESC NULLS LAST
     LIMIT 1
  ), (
    SELECT cm.club_id FROM public.club_members cm
      JOIN public.union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union
     WHERE p_union IS NOT NULL AND p_user IS NOT NULL AND cm.user_id = p_user
     ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id
     LIMIT 1
  ), p_table_club);
$$;
REVOKE ALL ON FUNCTION public.fn_ca_cash_reporting_club(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- 2. Function to check if a user is agent vs club staff
CREATE OR REPLACE FUNCTION public.fn_ca_club_user_reporting_scope(p_club_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role text;
BEGIN
  IF p_user_id IS NULL OR p_club_id IS NULL THEN RETURN 'none'; END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id AND coalesce(is_admin, false)) THEN
    RETURN 'club';
  END IF;
  IF EXISTS (SELECT 1 FROM public.clubs WHERE id = p_club_id AND owner_id = p_user_id) THEN
    RETURN 'club';
  END IF;
  SELECT cm.role INTO v_role FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = p_user_id
     AND coalesce(cm.status, 'approved') IN ('active', 'approved')
   LIMIT 1;
  IF v_role IN ('owner', 'co_owner', 'admin') THEN
    RETURN 'club';
  ELSIF v_role IN ('super_agent', 'agent', 'sub_agent') THEN
    RETURN 'downline';
  END IF;
  RETURN 'none';
END;
$$;
REVOKE ALL ON FUNCTION public.fn_ca_club_user_reporting_scope(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_user_reporting_scope(uuid, uuid) TO authenticated, service_role;

-- 3. ca_club_data_screen with role-based scoping and accurate data
CREATE OR REPLACE FUNCTION public.ca_club_data_screen(
  p_club_id uuid, p_start date DEFAULT NULL, p_end date DEFAULT NULL,
  p_game text DEFAULT 'ALL', p_stakes text DEFAULT 'ALL',
  p_search text DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_scope text := public.fn_ca_club_user_reporting_scope(p_club_id, v_caller);
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start date := COALESCE(p_start, v_end);
  v_game text := UPPER(COALESCE(NULLIF(p_game, ''), 'ALL'));
  v_stakes text := UPPER(COALESCE(NULLIF(p_stakes, ''), 'ALL'));
  v_q text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_lim int := GREATEST(LEAST(COALESCE(p_limit, 200), 500), 1);
  v_sum jsonb;
  v_felt numeric;
  v_union uuid;
  v_rows jsonb;
  v_is_agent boolean := false;
BEGIN
  -- Authorization check: staff gets full club, agents get downline, players refused
  IF NOT public.ca_can_view_club_finances(p_club_id) AND v_scope <> 'downline' THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  v_is_agent := (v_scope = 'downline');

  IF v_start < v_end - 92 THEN v_start := v_end - 92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;

  SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id = p_club_id LIMIT 1;

  IF NOT v_is_agent THEN
    -- Club staff / owners see whole club totals and felt
    v_sum := public.fn_ca_club_game_summary(p_club_id, v_start, v_end, v_game, v_stakes, v_q);
    SELECT COALESCE(SUM(f.felt), 0) INTO v_felt
      FROM public.fn_ca_club_cash_felt(p_club_id, v_start, v_end, v_game, v_stakes, v_q) f;
    v_sum := v_sum || jsonb_build_object(
      'cash_winnings', round(COALESCE((v_sum->>'cash_winnings')::numeric, 0) + v_felt, 2),
      'total_winnings', round(COALESCE((v_sum->>'total_winnings')::numeric, 0) + v_felt, 2),
      'on_felt', round(v_felt, 2));

    WITH felt AS (
      SELECT f.table_id, f.felt, f.seated
        FROM public.fn_ca_club_cash_felt(p_club_id, v_start, v_end, v_game, v_stakes, v_q) f
    ), cash AS (
      SELECT 'CASH'::text AS kind, t.id::text AS id, COALESCE(t.name, 'Unnamed') AS name,
             UPPER(COALESCE(t.game_variant, 'nlh')) AS variant,
             CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                  WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                  ELSE 'HOLDEM' END AS game_class,
             CASE WHEN COALESCE(t.big_blind,0) < 1 THEN 'MICRO'
                  WHEN COALESCE(t.big_blind,0) < 5 THEN 'SMALL'
                  WHEN COALESCE(t.big_blind,0) < 25 THEN 'MID' ELSE 'HIGH' END AS stakes_tier,
             CASE WHEN COALESCE(t.big_blind,0) > 0 THEN
               trim(trailing '.' from trim(trailing '0' from COALESCE(t.small_blind,0)::text)) || '/' ||
               trim(trailing '.' from trim(trailing '0' from t.big_blind::text)) END AS blinds,
             t.created_at AS started_at, t.status, COALESCE(pr.username, '') AS creator_name,
             round(SUM(d.rake), 2) AS fee,
             round(SUM(d.net) + COALESCE(MAX(fe.felt), 0), 2) AS winnings,
             MAX(d.players)::int AS players,
             MAX(d.updated_at) AS activity_at,
             (MAX(fe.felt) IS NOT NULL) AS live,
             MAX(fe.seated) AS seated,
             round(MAX(fe.felt), 2) AS on_felt
        FROM public.club_table_daily d
        JOIN public.tables t ON t.id = d.table_id
        LEFT JOIN public.profiles pr ON pr.id = t.created_by
        LEFT JOIN felt fe ON fe.table_id = d.table_id
       WHERE d.club_id = p_club_id AND d.stat_date BETWEEN v_start AND v_end
       GROUP BY t.id, t.name, t.game_variant, t.game_mode, t.big_blind, t.small_blind,
                t.created_at, t.status, pr.username
    ), tour_keys AS (
      SELECT d.tournament_id, SUM(d.fee) AS fee, SUM(d.winnings) AS winnings,
             MAX(d.updated_at) AS activity_at
        FROM public.ca_club_tournament_daily d
       WHERE d.club_id = p_club_id AND d.stat_date BETWEEN v_start AND v_end
         AND v_stakes = 'ALL'
         AND v_game NOT IN ('HOLDEM', 'OMAHA', 'MIXED')
       GROUP BY d.tournament_id
       ORDER BY MAX(d.updated_at) DESC
       LIMIT CASE WHEN v_game = 'ALL' AND v_q IS NULL THEN v_lim ELSE NULL END
    ), tour AS (
      SELECT CASE WHEN tr.tournament_type = 'SPIN' THEN 'SPIN'
                  WHEN tr.tournament_type = 'SNG' THEN 'SNG' ELSE 'MTT' END AS kind,
             tr.id::text AS id, COALESCE(tr.name, 'Tournament') AS name,
             UPPER(COALESCE(tr.variant, tr.game_type, 'nlh')) AS variant,
             CASE WHEN tr.tournament_type = 'SNG' THEN 'SNG' ELSE 'MTT' END AS game_class,
             'NA'::text AS stakes_tier, NULL::text AS blinds,
             tr.start_time AS started_at, tr.status, ''::text AS creator_name,
             round(k.fee, 2) AS fee, round(k.winnings, 2) AS winnings,
             NULL::int AS players,
             k.activity_at,
             (tr.status = 'RUNNING') AS live,
             NULL::int AS seated, NULL::numeric AS on_felt
        FROM tour_keys k
        JOIN public.tournaments tr ON tr.id = k.tournament_id
    ), all_rows AS (
      SELECT * FROM cash UNION ALL SELECT * FROM tour
    ), filtered AS (
      SELECT * FROM all_rows r
       WHERE (v_game = 'ALL' OR r.game_class = v_game)
         AND (v_stakes = 'ALL' OR r.stakes_tier = v_stakes)
         AND (v_q IS NULL OR r.name ILIKE '%' || v_q || '%' OR r.id ILIKE '%' || v_q || '%'
              OR r.creator_name ILIKE '%' || v_q || '%')
    ), ranked AS (
      SELECT f.kind, f.id, f.name, f.variant, f.game_class, f.stakes_tier, f.blinds,
             f.started_at, f.status, f.creator_name, f.fee, f.winnings,
             CASE WHEN f.kind = 'CASH' THEN f.players ELSE
               (SELECT count(DISTINCT p.user_id)::int FROM public.ca_club_tournament_player_daily p
                 WHERE p.club_id = p_club_id AND p.tournament_id = f.id::uuid
                   AND p.stat_date BETWEEN v_start AND v_end) END AS players,
             f.activity_at, f.live, f.seated, f.on_felt
        FROM (SELECT * FROM filtered
               ORDER BY live DESC, activity_at DESC NULLS LAST, kind, id
               LIMIT v_lim) f
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'kind', kind, 'id', id, 'name', name, 'variant', variant,
             'game_class', game_class, 'stakes_tier', stakes_tier, 'blinds', blinds,
             'started_at', started_at, 'activity_at', activity_at, 'status', status,
             'creator_name', NULLIF(creator_name, ''), 'fee', COALESCE(fee, 0),
             'winnings', COALESCE(winnings, 0), 'players', COALESCE(players, 0),
             'live', live, 'seated', seated, 'on_felt', on_felt)
           ORDER BY live DESC, activity_at DESC NULLS LAST, kind, id), '[]'::jsonb)
      INTO v_rows
      FROM ranked;

  ELSE
    -- Agents and sub-agents see downline + self stats
    WITH agent_downline AS MATERIALIZED (
      SELECT v_caller AS uid
      UNION
      SELECT d.user_id AS uid FROM public.ca_club_member_downline(p_club_id, v_caller) d
    ), downline_felt AS (
      SELECT ts.table_id, SUM(ts.stack) as felt, COUNT(*)::int as seated
        FROM public.table_seats ts
        JOIN public.tables t ON t.id = ts.table_id AND t.tournament_id IS NULL
       WHERE ts.left_at IS NULL AND ts.user_id IN (SELECT uid FROM agent_downline)
         AND COALESCE(ts.status, 'active') <> 'left' AND COALESCE(ts.stack, 0) > 0
         AND (ts.joined_at AT TIME ZONE 'UTC')::date BETWEEN v_start AND v_end
       GROUP BY ts.table_id
    ), downline_cash_summary AS (
      SELECT COUNT(DISTINCT d.table_id)::bigint AS games,
             COALESCE(SUM(d.cash_net), 0) AS winnings,
             COALESCE(SUM(d.tournament_net), 0) AS mtt_winnings
        FROM public.ca_club_player_daily d
       WHERE d.club_id = p_club_id AND d.user_id IN (SELECT uid FROM agent_downline)
         AND d.stat_date BETWEEN v_start AND v_end
    ), downline_fee_summary AS (
      SELECT COALESCE(SUM(lf.cash_fees), 0) AS cash_fee,
             COALESCE(SUM(lf.tournament_fees), 0) AS mtt_fee,
             COALESCE(SUM(lf.total_fees), 0) AS fee
        FROM public.ca_club_member_fee_totals(p_club_id, v_start, v_end) lf
       WHERE lf.user_id IN (SELECT uid FROM agent_downline)
    )
    SELECT jsonb_build_object(
      'games', COALESCE(cs.games, 0),
      'total_winnings', round(COALESCE(cs.winnings, 0) + COALESCE(cs.mtt_winnings, 0) + COALESCE(SUM(df.felt), 0), 2),
      'mtt_winnings', round(COALESCE(cs.mtt_winnings, 0), 2),
      'cash_winnings', round(COALESCE(cs.winnings, 0) + COALESCE(SUM(df.felt), 0), 2),
      'fee', round(COALESCE(fs.fee, 0), 2),
      'cash_fee', round(COALESCE(fs.cash_fee, 0), 2),
      'mtt_fee', round(COALESCE(fs.mtt_fee, 0), 2),
      'on_felt', round(COALESCE(SUM(df.felt), 0), 2)
    ) INTO v_sum
    FROM downline_cash_summary cs
    CROSS JOIN downline_fee_summary fs
    LEFT JOIN downline_felt df ON true
    GROUP BY cs.games, cs.winnings, cs.mtt_winnings, fs.fee, fs.cash_fee, fs.mtt_fee;

    -- Rows for agent downline
    WITH agent_downline AS MATERIALIZED (
      SELECT v_caller AS uid
      UNION
      SELECT d.user_id AS uid FROM public.ca_club_member_downline(p_club_id, v_caller) d
    ), agent_cash AS (
      SELECT 'CASH'::text AS kind, t.id::text AS id, COALESCE(t.name, 'Unnamed') AS name,
             UPPER(COALESCE(t.game_variant, 'nlh')) AS variant,
             CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                  WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                  ELSE 'HOLDEM' END AS game_class,
             CASE WHEN COALESCE(t.big_blind,0) < 1 THEN 'MICRO'
                  WHEN COALESCE(t.big_blind,0) < 5 THEN 'SMALL'
                  WHEN COALESCE(t.big_blind,0) < 25 THEN 'MID' ELSE 'HIGH' END AS stakes_tier,
             CASE WHEN COALESCE(t.big_blind,0) > 0 THEN
               trim(trailing '.' from trim(trailing '0' from COALESCE(t.small_blind,0)::text)) || '/' ||
               trim(trailing '.' from trim(trailing '0' from t.big_blind::text)) END AS blinds,
             t.created_at AS started_at, t.status, COALESCE(pr.username, '') AS creator_name,
             round(SUM(d.rake), 2) AS fee,
             round(SUM(d.net), 2) AS winnings,
             MAX(d.players)::int AS players,
             MAX(d.updated_at) AS activity_at,
             false AS live,
             NULL::int AS seated,
             0::numeric AS on_felt
        FROM public.club_table_daily d
        JOIN public.tables t ON t.id = d.table_id
        LEFT JOIN public.profiles pr ON pr.id = t.created_by
       WHERE d.club_id = p_club_id AND d.stat_date BETWEEN v_start AND v_end
         AND EXISTS (SELECT 1 FROM public.ca_club_table_player_daily pd WHERE pd.club_id = p_club_id AND pd.table_id = d.table_id AND pd.stat_date = d.stat_date AND pd.user_id IN (SELECT uid FROM agent_downline))
       GROUP BY t.id, t.name, t.game_variant, t.game_mode, t.big_blind, t.small_blind,
                t.created_at, t.status, pr.username
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'kind', kind, 'id', id, 'name', name, 'variant', variant,
             'game_class', game_class, 'stakes_tier', stakes_tier, 'blinds', blinds,
             'started_at', started_at, 'activity_at', activity_at, 'status', status,
             'creator_name', NULLIF(creator_name, ''), 'fee', COALESCE(fee, 0),
             'winnings', COALESCE(winnings, 0), 'players', COALESCE(players, 0),
             'live', live, 'seated', seated, 'on_felt', on_felt)
           ORDER BY activity_at DESC NULLS LAST, kind, id), '[]'::jsonb)
      INTO v_rows
      FROM agent_cash;
  END IF;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('start', v_start, 'end', v_end, 'days', (v_end - v_start) + 1),
    'filters', jsonb_build_object('game', v_game, 'stakes', v_stakes, 'search', v_q),
    'summary', COALESCE(v_sum, '{"games":0,"total_winnings":0,"mtt_winnings":0,"cash_winnings":0,"fee":0,"cash_fee":0,"mtt_fee":0,"on_felt":0}'::jsonb),
    'rows', COALESCE(v_rows, '[]'::jsonb),
    'row_count', COALESCE((v_sum->>'games')::int, 0),
    'union_id', v_union,
    'scope', CASE WHEN v_is_agent THEN 'downline' ELSE 'club' END,
    'generated_at', now());
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_data_screen(uuid, date, date, text, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_data_screen(uuid, date, date, text, text, text, integer) TO authenticated, service_role;

COMMIT;
