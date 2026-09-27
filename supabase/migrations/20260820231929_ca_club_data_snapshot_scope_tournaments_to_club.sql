-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820231929 "ca_club_data_snapshot_scope_tournaments_to_club"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 466f888e9b924aefc0a2f41fcab701b0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- FIX: tournament and spin rows in ca_club_data_snapshot were attributed to
-- the whole UNION, not to the club being viewed. Club JAQK's screen was
-- showing SHARK CLUB's tournament fees and winnings alongside its own
-- (mtt_winnings read +135,588.09 against a real figure that is much smaller).
-- Cash rows were always correct -- they come from club_table_daily, which is
-- keyed by member club.
--
-- Also: a club that is not in a union now falls back to its own membership
-- instead of producing an empty attribution set and silently dropping every
-- tournament row.
--
-- Applied to production via Supabase MCP as
-- 'ca_club_data_snapshot_scope_tournaments_to_club'.
CREATE OR REPLACE FUNCTION public.ca_club_data_snapshot(
  p_club_id uuid,
  p_start   date DEFAULT NULL,
  p_end     date DEFAULT NULL,
  p_game    text DEFAULT 'ALL',
  p_stakes  text DEFAULT 'ALL',
  p_search  text DEFAULT NULL,
  p_limit   integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_today  date := (now() AT TIME ZONE 'UTC')::date;
  v_end    date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start  date := COALESCE(p_start, v_end - 13);
  v_from   timestamptz;
  v_to     timestamptz;
  v_game   text := UPPER(COALESCE(NULLIF(p_game, ''), 'ALL'));
  v_stakes text := UPPER(COALESCE(NULLIF(p_stakes, ''), 'ALL'));
  v_q      text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_lim    int  := GREATEST(LEAST(COALESCE(p_limit, 100), 500), 1);
  v_union  uuid;
  v_out    jsonb;
BEGIN
  IF NOT ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  IF v_start < v_end - 92 THEN v_start := v_end - 92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  v_from := (v_start::timestamp AT TIME ZONE 'UTC');
  v_to   := ((v_end + 1)::timestamp AT TIME ZONE 'UTC');

  SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = p_club_id LIMIT 1;

  WITH att_club AS (
    -- players who count for THIS club. Union-scoped where the club is in a
    -- union (same earliest-joined rule as the settlement and ECO), otherwise
    -- plain membership.
    SELECT a.user_id
      FROM (
        SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
          FROM club_members cm
          JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = v_union
         WHERE v_union IS NOT NULL
         ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
      ) a
     WHERE a.club_id = p_club_id
    UNION
    SELECT cm.user_id FROM club_members cm
     WHERE v_union IS NULL AND cm.club_id = p_club_id
  ),
  cash AS (
    SELECT c.table_id,
           SUM(c.rake)       AS fee,
           SUM(c.net)        AS winnings,
           SUM(c.hands)      AS hands,
           MAX(c.players)    AS players,
           MAX(c.updated_at) AS updated_at
      FROM club_table_daily c
     WHERE c.club_id = p_club_id
       AND c.stat_date BETWEEN v_start AND v_end
     GROUP BY c.table_id
  ),
  cash_rows AS (
    SELECT 'CASH'::text AS kind,
           t.id::text   AS id,
           COALESCE(t.name, 'Unnamed')            AS name,
           UPPER(COALESCE(t.game_variant, 'nlh')) AS variant,
           CASE
             WHEN COALESCE(t.game_variant,'') ILIKE '%plo%'
               OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
             WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%'
               OR COALESCE(t.game_mode,'')    ILIKE '%mixed%' THEN 'MIXED'
             ELSE 'HOLDEM'
           END AS game_class,
           COALESCE(t.small_blind, 0) AS small_blind,
           COALESCE(t.big_blind, 0)   AS big_blind,
           CASE WHEN COALESCE(t.rake_percent, -1) >= 0 THEN t.rake_percent ELSE NULL END AS rake_percent,
           t.created_at AS started_at,
           t.created_by,
           t.status,
           round(cash.fee, 2)      AS fee,
           round(cash.winnings, 2) AS winnings,
           cash.hands,
           cash.players
      FROM cash
      JOIN tables t ON t.id = cash.table_id
  ),
  trn_rake AS (
    SELECT r.tournament_id,
           SUM(
             CASE WHEN r.metadata ? 'user_id' THEN r.rake_amount
                  ELSE r.rake_amount
                       * (SELECT count(*) FROM tournament_players tp
                            JOIN att_club a ON a.user_id = tp.user_id
                           WHERE tp.tournament_id = r.tournament_id)::numeric
                       / NULLIF((SELECT count(*) FROM tournament_players tp2
                                  WHERE tp2.tournament_id = r.tournament_id), 0)
             END) AS fee
      FROM rake_records r
     WHERE r.is_tournament
       AND r.created_at >= v_from AND r.created_at < v_to
       AND r.rake_amount <> 0
       AND r.tournament_id IS NOT NULL
       AND (
         (r.metadata ? 'user_id'
           AND EXISTS (SELECT 1 FROM att_club a WHERE a.user_id::text = r.metadata->>'user_id'))
         OR NOT (r.metadata ? 'user_id')
       )
     GROUP BY r.tournament_id
  ),
  trn_pnl AS (
    SELECT wt.related_entity_id AS tournament_id,
           SUM(CASE WHEN wt.category = 'tournament_buyin' THEN -wt.amount ELSE wt.amount END) AS winnings,
           count(DISTINCT wt.user_id) AS players
      FROM wallet_transactions wt
      JOIN att_club a ON a.user_id = wt.user_id
     WHERE wt.created_at >= v_from AND wt.created_at < v_to
       AND wt.category IN ('tournament_buyin','prize','bounty')
       AND wt.related_entity_id IS NOT NULL
     GROUP BY wt.related_entity_id
  ),
  trn_rows AS (
    SELECT CASE WHEN tr.tournament_type = 'SPIN' THEN 'SPIN'
                WHEN tr.tournament_type = 'SNG'  THEN 'SNG'
                ELSE 'MTT' END::text AS kind,
           tr.id::text AS id,
           COALESCE(tr.name, 'Tournament') AS name,
           UPPER(COALESCE(tr.variant, tr.game_type, 'nlh')) AS variant,
           CASE WHEN tr.tournament_type = 'SNG' THEN 'SNG' ELSE 'MTT' END AS game_class,
           0::numeric AS small_blind,
           0::numeric AS big_blind,
           NULL::numeric AS rake_percent,
           tr.start_time AS started_at,
           NULL::uuid AS created_by,
           tr.status,
           round(COALESCE(k.fee, 0), 2) AS fee,
           round(COALESCE(p.winnings, 0), 2) AS winnings,
           0::bigint AS hands,
           COALESCE(p.players, 0)::integer AS players
      FROM tournaments tr
      LEFT JOIN trn_rake k ON k.tournament_id = tr.id
      LEFT JOIN trn_pnl  p ON p.tournament_id = tr.id
     WHERE k.tournament_id IS NOT NULL OR p.tournament_id IS NOT NULL
  ),
  all_rows AS (
    SELECT * FROM cash_rows
    UNION ALL
    SELECT * FROM trn_rows
  ),
  filtered AS (
    SELECT r.*,
           CASE
             WHEN r.game_class IN ('MTT','SNG') THEN 'NA'
             WHEN r.big_blind <  1 THEN 'MICRO'
             WHEN r.big_blind <  5 THEN 'SMALL'
             WHEN r.big_blind < 25 THEN 'MID'
             ELSE 'HIGH'
           END AS stakes_tier
      FROM all_rows r
  ),
  kept AS (
    SELECT f.*
      FROM filtered f
     WHERE (v_game   = 'ALL' OR f.game_class = v_game)
       AND (v_stakes = 'ALL' OR f.stakes_tier = v_stakes)
       AND (v_q IS NULL
            OR f.name ILIKE '%' || v_q || '%'
            OR f.id ILIKE '%' || v_q || '%'
            OR EXISTS (SELECT 1 FROM profiles pr
                        WHERE pr.id = f.created_by
                          AND (COALESCE(pr.username,'') ILIKE '%' || v_q || '%'
                               OR pr.id::text ILIKE '%' || v_q || '%')))
  )
  SELECT jsonb_build_object(
    'range', jsonb_build_object('start', v_start, 'end', v_end,
                                'days', (v_end - v_start) + 1),
    'filters', jsonb_build_object('game', v_game, 'stakes', v_stakes, 'search', v_q),
    'summary', (
      SELECT jsonb_build_object(
        'games',          count(*),
        'total_winnings', round(COALESCE(SUM(k.winnings), 0), 2),
        'mtt_winnings',   round(COALESCE(SUM(k.winnings) FILTER (WHERE k.game_class IN ('MTT','SNG')), 0), 2),
        'cash_winnings',  round(COALESCE(SUM(k.winnings) FILTER (WHERE k.game_class NOT IN ('MTT','SNG')), 0), 2),
        'fee',            round(COALESCE(SUM(k.fee), 0), 2),
        'cash_fee',       round(COALESCE(SUM(k.fee) FILTER (WHERE k.game_class NOT IN ('MTT','SNG')), 0), 2),
        'mtt_fee',        round(COALESCE(SUM(k.fee) FILTER (WHERE k.game_class IN ('MTT','SNG')), 0), 2),
        'hands',          COALESCE(SUM(k.hands), 0)
      ) FROM kept k
    ),
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'kind', q.kind, 'id', q.id, 'name', q.name,
               'variant', q.variant, 'game_class', q.game_class,
               'stakes_tier', q.stakes_tier,
               'blinds', CASE WHEN q.big_blind > 0
                              THEN trim(trailing '.' from trim(trailing '0' from q.small_blind::text))
                                   || '/' || trim(trailing '.' from trim(trailing '0' from q.big_blind::text))
                              ELSE NULL END,
               'rake_percent', q.rake_percent,
               'started_at', q.started_at,
               'status', q.status,
               'creator_id', q.created_by,
               'creator_name', (SELECT pr.username FROM profiles pr WHERE pr.id = q.created_by),
               'creator_avatar', (SELECT pr.avatar_url FROM profiles pr WHERE pr.id = q.created_by),
               'fee', q.fee, 'winnings', q.winnings,
               'hands', q.hands, 'players', q.players)
             ORDER BY q.started_at DESC NULLS LAST)
      FROM (SELECT * FROM kept ORDER BY started_at DESC NULLS LAST LIMIT v_lim) q
    ), '[]'::jsonb),
    'row_count', (SELECT count(*) FROM kept),
    'union_id', v_union,
    'data_updated_at', (SELECT max(c.updated_at) FROM club_table_daily c
                         WHERE c.club_id = p_club_id AND c.stat_date BETWEEN v_start AND v_end),
    'generated_at', now()
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.ca_club_data_snapshot(uuid, date, date, text, text, text, integer)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.ca_club_data_snapshot(uuid, date, date, text, text, text, integer)
  TO authenticated;
