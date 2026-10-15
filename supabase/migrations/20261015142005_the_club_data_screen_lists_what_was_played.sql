-- 20261015142005_the_club_data_screen_lists_what_was_played.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (Dan 2026-10-15 audit: "CHECK FOR ANY AND ALL
-- BUGS, GAPS ... WIRING ISSUES"):
--
-- The everyday Club Data screen (ClubDataSimplePage) listed its games from
-- ca_club_data_snapshot.rows, which keeps the N games with the latest
-- STARTED_AT. Read from production at 14:15 UTC for SHARK CLUB, 1 Day: 11,898
-- games, and the first rows were tournaments still REGISTERING for Saturday
-- and Sunday. A cash table's started_at is the day the table was created, so
-- every live cash game of the day sorted below thousands of future
-- registrations and never reached the list at all.
--
-- ca_club_data_screen answers the screen's actual question - what was played
-- in this window - with the snapshot's own totals (fn_ca_club_game_summary
-- plus the felt, exactly as ca_club_data_snapshot adds it) and rows
-- ordered by last activity inside the window: games in play first, then the
-- most recently active. The advanced report keeps ca_club_data_snapshot and
-- its cursor paging untouched.
--
-- Read-only, SECURITY DEFINER behind the same ca_can_view_club_finances gate.
-- Creates one function; touches no table.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.ca_club_data_screen(
  p_club_id uuid, p_start date DEFAULT NULL, p_end date DEFAULT NULL,
  p_game text DEFAULT 'ALL', p_stakes text DEFAULT 'ALL',
  p_search text DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $function$
DECLARE
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
BEGIN
  IF NOT public.ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;
  IF v_start < v_end - 92 THEN v_start := v_end - 92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;

  -- The same totals ca_club_data_snapshot reports for this window (felt
  -- included), without its previous-window comparison the screen never shows.
  v_sum := public.fn_ca_club_game_summary(p_club_id, v_start, v_end, v_game, v_stakes, v_q);
  SELECT COALESCE(SUM(f.felt), 0) INTO v_felt
    FROM public.fn_ca_club_cash_felt(p_club_id, v_start, v_end, v_game, v_stakes, v_q) f;
  v_sum := v_sum || jsonb_build_object(
    'cash_winnings', round(COALESCE((v_sum->>'cash_winnings')::numeric, 0) + v_felt, 2),
    'total_winnings', round(COALESCE((v_sum->>'total_winnings')::numeric, 0) + v_felt, 2),
    'on_felt', round(v_felt, 2));
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id = p_club_id LIMIT 1;

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
    -- Aggregate the window's tournament facts by id first (one index range),
    -- and when nothing filters on tournament fields keep only the most
    -- recently active ones before any join: a busy club has hundreds of
    -- thousands of tournament-days in fourteen days.
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

  RETURN jsonb_build_object(
    'range', jsonb_build_object('start', v_start, 'end', v_end, 'days', (v_end - v_start) + 1),
    'filters', jsonb_build_object('game', v_game, 'stakes', v_stakes, 'search', v_q),
    'summary', v_sum,
    'rows', v_rows,
    'row_count', (v_sum->>'games')::int,
    'union_id', v_union,
    'generated_at', now());
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_data_screen(uuid, date, date, text, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_data_screen(uuid, date, date, text, text, text, integer) TO authenticated, service_role;

COMMIT;
