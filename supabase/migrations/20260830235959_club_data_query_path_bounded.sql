-- Club Data was not merely slow on production volume: both public RPCs were
-- cancelled by the authenticated role's 8 second statement_timeout.  The
-- game helper scanned 80k+ tournament rake rows and ran two entrant-count
-- subqueries for every untagged row, while the snapshot executed that helper
-- three times.  Bound the same ledger math to set-based passes and give the
-- two high-volume fact reads covering partial indexes.

CREATE INDEX IF NOT EXISTS idx_rake_records_club_data_tournament_window
  ON public.rake_records (created_at, tournament_id)
  INCLUDE (rake_amount, metadata)
  WHERE is_tournament
    AND rake_amount <> 0
    AND tournament_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_tx_club_data_tournament_user_window
  ON public.wallet_transactions (user_id, created_at)
  INCLUDE (category, amount, related_entity_id)
  WHERE category IN ('tournament_buyin', 'prize', 'bounty')
    AND related_entity_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_ca_club_games(
  p_club_id uuid,
  p_start date,
  p_end date,
  p_game text DEFAULT 'ALL'::text,
  p_stakes text DEFAULT 'ALL'::text,
  p_search text DEFAULT NULL::text
)
RETURNS TABLE(
  kind text,
  id text,
  name text,
  variant text,
  game_class text,
  stakes_tier text,
  small_blind numeric,
  big_blind numeric,
  rake_percent numeric,
  started_at timestamptz,
  created_by uuid,
  status text,
  fee numeric,
  winnings numeric,
  hands bigint,
  players integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_from   timestamptz := (p_start::timestamp AT TIME ZONE 'UTC');
  v_to     timestamptz := ((p_end + 1)::timestamp AT TIME ZONE 'UTC');
  v_game   text := UPPER(COALESCE(NULLIF(p_game, ''), 'ALL'));
  v_stakes text := UPPER(COALESCE(NULLIF(p_stakes, ''), 'ALL'));
  v_q      text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_union  uuid;
BEGIN
  SELECT uc.union_id INTO v_union
    FROM union_clubs uc
   WHERE uc.club_id = p_club_id
   LIMIT 1;

  RETURN QUERY
  WITH att_club AS MATERIALIZED (
    SELECT a.user_id
      FROM (
        SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
          FROM club_members cm
          JOIN union_clubs uc
            ON uc.club_id = cm.club_id
           AND uc.union_id = v_union
         WHERE v_union IS NOT NULL
         ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
      ) a
     WHERE a.club_id = p_club_id
    UNION
    SELECT cm.user_id
      FROM club_members cm
     WHERE v_union IS NULL
       AND cm.club_id = p_club_id
  ),
  cash AS (
    SELECT c.table_id,
           SUM(c.rake) AS fee,
           SUM(c.net) AS winnings,
           SUM(c.hands) AS hands,
           MAX(c.players) AS players
      FROM club_table_daily c
     WHERE c.club_id = p_club_id
       AND c.stat_date BETWEEN p_start AND p_end
     GROUP BY c.table_id
  ),
  cash_rows AS (
    SELECT 'CASH'::text,
           t.id::text,
           COALESCE(t.name, 'Unnamed'),
           UPPER(COALESCE(t.game_variant, 'nlh')),
           CASE
             WHEN COALESCE(t.game_variant, '') ILIKE '%plo%'
               OR COALESCE(t.game_variant, '') ILIKE '%omaha%' THEN 'OMAHA'
             WHEN COALESCE(t.game_variant, '') ILIKE '%mixed%'
               OR COALESCE(t.game_mode, '') ILIKE '%mixed%' THEN 'MIXED'
             ELSE 'HOLDEM'
           END,
           COALESCE(t.small_blind, 0),
           COALESCE(t.big_blind, 0),
           CASE WHEN COALESCE(t.rake_percent, -1) >= 0 THEN t.rake_percent ELSE NULL END,
           t.created_at,
           t.created_by,
           t.status,
           round(cash.fee, 2),
           round(cash.winnings, 2),
           cash.hands,
           cash.players
      FROM cash
      JOIN tables t ON t.id = cash.table_id
  ),
  tournament_rake_source AS MATERIALIZED (
    SELECT r.tournament_id,
           SUM(r.rake_amount) FILTER (WHERE r.metadata ? 'user_id') AS direct_fee,
           SUM(r.rake_amount) FILTER (WHERE NOT (r.metadata ? 'user_id')) AS shared_fee
      FROM rake_records r
      LEFT JOIN att_club payer
        ON payer.user_id::text = r.metadata->>'user_id'
     WHERE r.is_tournament
       AND r.created_at >= v_from
       AND r.created_at < v_to
       AND r.rake_amount <> 0
       AND r.tournament_id IS NOT NULL
       AND (NOT (r.metadata ? 'user_id') OR payer.user_id IS NOT NULL)
     GROUP BY r.tournament_id
  ),
  tournament_entrants AS (
    SELECT tp.tournament_id,
           count(*)::numeric AS total_players,
           count(a.user_id)::numeric AS club_players
      FROM tournament_players tp
      JOIN tournament_rake_source rs ON rs.tournament_id = tp.tournament_id
      LEFT JOIN att_club a ON a.user_id = tp.user_id
     GROUP BY tp.tournament_id
  ),
  trn_rake AS (
    SELECT rs.tournament_id,
           COALESCE(rs.direct_fee, 0)
             + COALESCE(rs.shared_fee, 0) * COALESCE(e.club_players, 0)
               / NULLIF(e.total_players, 0) AS fee
      FROM tournament_rake_source rs
      LEFT JOIN tournament_entrants e ON e.tournament_id = rs.tournament_id
  ),
  trn_pnl AS (
    SELECT wt.related_entity_id AS tournament_id,
           SUM(CASE WHEN wt.category = 'tournament_buyin' THEN -wt.amount ELSE wt.amount END) AS winnings,
           count(DISTINCT wt.user_id) AS players
      FROM wallet_transactions wt
      JOIN att_club a ON a.user_id = wt.user_id
     WHERE wt.created_at >= v_from
       AND wt.created_at < v_to
       AND wt.category IN ('tournament_buyin', 'prize', 'bounty')
       AND wt.related_entity_id IS NOT NULL
     GROUP BY wt.related_entity_id
  ),
  trn_rows AS (
    SELECT CASE
             WHEN tr.tournament_type = 'SPIN' THEN 'SPIN'
             WHEN tr.tournament_type = 'SNG' THEN 'SNG'
             ELSE 'MTT'
           END::text,
           tr.id::text,
           COALESCE(tr.name, 'Tournament'),
           UPPER(COALESCE(tr.variant, tr.game_type, 'nlh')),
           CASE WHEN tr.tournament_type = 'SNG' THEN 'SNG' ELSE 'MTT' END,
           0::numeric,
           0::numeric,
           NULL::numeric,
           tr.start_time,
           NULL::uuid,
           tr.status,
           round(COALESCE(k.fee, 0), 2),
           round(COALESCE(p.winnings, 0), 2),
           0::bigint,
           COALESCE(p.players, 0)::integer
      FROM tournaments tr
      LEFT JOIN trn_rake k ON k.tournament_id = tr.id
      LEFT JOIN trn_pnl p ON p.tournament_id = tr.id
     WHERE k.tournament_id IS NOT NULL
        OR p.tournament_id IS NOT NULL
  ),
  all_rows AS (
    SELECT * FROM cash_rows
    UNION ALL
    SELECT * FROM trn_rows
  ),
  tagged AS (
    SELECT r.*,
           CASE
             WHEN r.game_class IN ('MTT', 'SNG') THEN 'NA'
             WHEN r.big_blind < 1 THEN 'MICRO'
             WHEN r.big_blind < 5 THEN 'SMALL'
             WHEN r.big_blind < 25 THEN 'MID'
             ELSE 'HIGH'
           END AS stakes_tier
      FROM all_rows r(
        kind, id, name, variant, game_class, small_blind, big_blind,
        rake_percent, started_at, created_by, status, fee, winnings,
        hands, players
      )
  )
  SELECT t.kind,
         t.id,
         t.name,
         t.variant,
         t.game_class,
         t.stakes_tier,
         t.small_blind,
         t.big_blind,
         t.rake_percent,
         t.started_at,
         t.created_by,
         t.status,
         t.fee,
         t.winnings,
         t.hands,
         t.players
    FROM tagged t
   WHERE (v_game = 'ALL' OR t.game_class = v_game)
     AND (v_stakes = 'ALL' OR t.stakes_tier = v_stakes)
     AND (
       v_q IS NULL
       OR t.name ILIKE '%' || v_q || '%'
       OR t.id ILIKE '%' || v_q || '%'
       OR EXISTS (
         SELECT 1
           FROM profiles pr
          WHERE pr.id = t.created_by
            AND (
              COALESCE(pr.username, '') ILIKE '%' || v_q || '%'
              OR pr.id::text ILIKE '%' || v_q || '%'
            )
       )
     );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_data_snapshot(
  p_club_id uuid,
  p_start date DEFAULT NULL::date,
  p_end date DEFAULT NULL::date,
  p_game text DEFAULT 'ALL'::text,
  p_stakes text DEFAULT 'ALL'::text,
  p_search text DEFAULT NULL::text,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today  date := (now() AT TIME ZONE 'UTC')::date;
  v_end    date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start  date := COALESCE(p_start, v_end - 13);
  v_days   int;
  v_pstart date;
  v_pend   date;
  v_game   text := UPPER(COALESCE(NULLIF(p_game, ''), 'ALL'));
  v_stakes text := UPPER(COALESCE(NULLIF(p_stakes, ''), 'ALL'));
  v_q      text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_lim    int := GREATEST(LEAST(COALESCE(p_limit, 100), 500), 1);
  v_union  uuid;
  v_cur    jsonb;
  v_prev   jsonb;
  v_rows   jsonb;
  v_out    jsonb;
BEGIN
  IF NOT ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  IF v_start < v_end - 92 THEN v_start := v_end - 92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  v_days := (v_end - v_start) + 1;
  v_pend := v_start - 1;
  v_pstart := v_pend - (v_days - 1);

  SELECT uc.union_id INTO v_union
    FROM union_clubs uc
   WHERE uc.club_id = p_club_id
   LIMIT 1;

  WITH current_games AS MATERIALIZED (
    SELECT *
      FROM fn_ca_club_games(p_club_id, v_start, v_end, v_game, v_stakes, v_q)
  )
  SELECT (
           SELECT jsonb_build_object(
             'games', count(*),
             'total_winnings', round(COALESCE(SUM(g.winnings), 0), 2),
             'mtt_winnings', round(COALESCE(SUM(g.winnings) FILTER (WHERE g.game_class IN ('MTT', 'SNG')), 0), 2),
             'cash_winnings', round(COALESCE(SUM(g.winnings) FILTER (WHERE g.game_class NOT IN ('MTT', 'SNG')), 0), 2),
             'fee', round(COALESCE(SUM(g.fee), 0), 2),
             'cash_fee', round(COALESCE(SUM(g.fee) FILTER (WHERE g.game_class NOT IN ('MTT', 'SNG')), 0), 2),
             'mtt_fee', round(COALESCE(SUM(g.fee) FILTER (WHERE g.game_class IN ('MTT', 'SNG')), 0), 2),
             'hands', COALESCE(SUM(g.hands), 0)
           )
             FROM current_games g
         ),
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'kind', q.kind,
                    'id', q.id,
                    'name', q.name,
                    'variant', q.variant,
                    'game_class', q.game_class,
                    'stakes_tier', q.stakes_tier,
                    'blinds', CASE WHEN q.big_blind > 0
                                   THEN trim(trailing '.' from trim(trailing '0' from q.small_blind::text))
                                        || '/' || trim(trailing '.' from trim(trailing '0' from q.big_blind::text))
                                   ELSE NULL END,
                    'rake_percent', q.rake_percent,
                    'started_at', q.started_at,
                    'status', q.status,
                    'creator_id', q.created_by,
                    'creator_name', pr.username,
                    'creator_avatar', pr.avatar_url,
                    'fee', q.fee,
                    'winnings', q.winnings,
                    'hands', q.hands,
                    'players', q.players
                  ) ORDER BY q.started_at DESC NULLS LAST)
             FROM (
               SELECT *
                 FROM current_games
                ORDER BY started_at DESC NULLS LAST
                LIMIT v_lim
             ) q
             LEFT JOIN profiles pr ON pr.id = q.created_by
         ), '[]'::jsonb)
    INTO v_cur, v_rows;

  SELECT jsonb_build_object(
           'games', count(*),
           'total_winnings', round(COALESCE(SUM(g.winnings), 0), 2),
           'mtt_winnings', round(COALESCE(SUM(g.winnings) FILTER (WHERE g.game_class IN ('MTT', 'SNG')), 0), 2),
           'cash_winnings', round(COALESCE(SUM(g.winnings) FILTER (WHERE g.game_class NOT IN ('MTT', 'SNG')), 0), 2),
           'fee', round(COALESCE(SUM(g.fee), 0), 2),
           'hands', COALESCE(SUM(g.hands), 0)
         )
    INTO v_prev
    FROM fn_ca_club_games(p_club_id, v_pstart, v_pend, v_game, v_stakes, v_q) g;

  SELECT jsonb_build_object(
    'range', jsonb_build_object('start', v_start, 'end', v_end, 'days', v_days),
    'previous_range', jsonb_build_object('start', v_pstart, 'end', v_pend, 'days', v_days),
    'filters', jsonb_build_object('game', v_game, 'stakes', v_stakes, 'search', v_q),
    'summary', v_cur,
    'previous', v_prev,
    'delta', jsonb_build_object(
      'fee_pct', CASE WHEN COALESCE((v_prev->>'fee')::numeric, 0) = 0 THEN NULL
                      ELSE round(((v_cur->>'fee')::numeric - (v_prev->>'fee')::numeric)
                                 / abs((v_prev->>'fee')::numeric) * 100, 1) END,
      'games_pct', CASE WHEN COALESCE((v_prev->>'games')::numeric, 0) = 0 THEN NULL
                        ELSE round(((v_cur->>'games')::numeric - (v_prev->>'games')::numeric)
                                   / abs((v_prev->>'games')::numeric) * 100, 1) END,
      'winnings_abs', round((v_cur->>'total_winnings')::numeric
                            - (v_prev->>'total_winnings')::numeric, 2),
      'fee_abs', round((v_cur->>'fee')::numeric - (v_prev->>'fee')::numeric, 2)
    ),
    'rows', v_rows,
    'row_count', (v_cur->>'games')::int,
    'union_id', v_union,
    'data_updated_at', (
      SELECT max(c.updated_at)
        FROM club_table_daily c
       WHERE c.club_id = p_club_id
         AND c.stat_date BETWEEN v_start AND v_end
    ),
    'generated_at', now()
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_club_games(uuid, date, date, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_games(uuid, date, date, text, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.ca_club_data_snapshot(uuid, date, date, text, text, text, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_data_snapshot(uuid, date, date, text, text, text, integer)
  TO authenticated, service_role;
