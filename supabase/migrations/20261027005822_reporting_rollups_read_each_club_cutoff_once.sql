-- Reporting rollups read each club launch boundary once.
-- Job128 failed at 300s in fn_ca_launch_accounting_accepts over named contributors.
-- Preserve facts, timestamp acceptance, unnamed hands, report precision and ACLs.
-- No recount, cron change, hot-table DDL or financial operation at installation.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $guard$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_reporting_rollups_from_facts(date)') AND md5(prosrc)='9b54cb00d59fa616522f049b67237def') THEN
  RAISE EXCEPTION 'Reporting rollup producer changed or already installed';
 END IF;
END
$guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_reporting_rollups_from_facts(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_from_day date := public.fn_ca_club_data_facts_from();
  v_lo timestamptz := (p_day::timestamp AT TIME ZONE 'UTC');
  v_hi timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_tables bigint; v_players bigint; v_tournaments bigint;
BEGIN
  IF p_day IS NULL OR p_day > v_today OR v_from_day IS NULL OR p_day < v_from_day THEN
    RETURN jsonb_build_object('day', p_day, 'skipped', 'outside_club_data_facts', 'facts_from', v_from_day);
  END IF;
  IF now() < v_hi + interval '10 minutes' THEN
    PERFORM pg_advisory_xact_lock(918273645);
  END IF;

  DELETE FROM public.club_table_daily WHERE stat_date = p_day;
  DELETE FROM public.ca_club_table_player_daily WHERE stat_date = p_day;
  DELETE FROM public.ca_club_player_daily WHERE stat_date = p_day;
  DELETE FROM public.ca_club_tournament_daily WHERE stat_date = p_day;
  DELETE FROM public.ca_club_tournament_player_daily WHERE stat_date = p_day;

  WITH rr AS MATERIALIZED (
    SELECT r.id, r.table_id, r.created_at, t.union_id, t.club_id AS table_club,
           CASE WHEN jsonb_typeof(r.player_contributions) = 'object' THEN r.player_contributions ELSE '{}'::jsonb END AS pc
      FROM public.rake_records r
      JOIN public.tables t ON t.id = r.table_id AND t.tournament_id IS NULL
     WHERE r.created_at >= v_lo AND r.created_at < v_hi
       AND r.rake_amount > 0 AND r.tournament_id IS NULL AND NOT COALESCE(r.is_tournament, false)
  ), contrib AS (
    SELECT rr.id, rr.table_id, rr.created_at, rr.union_id, rr.table_club, e.key::uuid AS uid
      FROM rr CROSS JOIN LATERAL jsonb_each_text(rr.pc) e
     WHERE e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND (CASE WHEN e.value ~ '^[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END) > 0
  ), clubbed AS (
    SELECT c.id, c.table_id,
           COALESCE(ra.club_id, rc.club, st.club,
                    public.fn_ca_cash_reporting_club(c.union_id, c.table_club, c.uid)) AS club_id,
           c.created_at
      FROM contrib c
      LEFT JOIN public.rake_attributions ra ON ra.rake_record_id = c.id AND ra.player_id = c.uid
      LEFT JOIN LATERAL (
        SELECT x.funding_club_id AS club FROM public.cash_participant_funding_receipts x
         WHERE ra.club_id IS NULL AND x.operation_kind = 'buyin' AND x.table_id = c.table_id
           AND x.account_entity_id = c.uid AND x.seat_joined_at <= c.created_at
         ORDER BY x.seat_joined_at DESC LIMIT 1) rc ON true
      LEFT JOIN LATERAL (
        SELECT ts.club_id AS club FROM public.table_seats ts
         WHERE ra.club_id IS NULL AND rc.club IS NULL AND ts.table_id = c.table_id
           AND ts.user_id = c.uid AND ts.club_id IS NOT NULL AND ts.joined_at <= c.created_at
         ORDER BY ts.joined_at DESC LIMIT 1) st ON true
  ), cut AS MATERIALIZED (
    -- A stable boundary is a property of the club, not each contribution.
    SELECT c.club_id, public.fn_ca_launch_accounting_cutoff('club', c.club_id) AS cutoff
      FROM (SELECT DISTINCT club_id FROM clubbed WHERE club_id IS NOT NULL) c
  ), hands AS (
    SELECT h.club_id, h.table_id, SUM(h.hands)::int AS hands, SUM(h.src)::int AS src FROM (
      SELECT cl.club_id, cl.table_id, count(DISTINCT cl.id) AS hands, count(*) AS src
        FROM clubbed cl JOIN cut ON cut.club_id = cl.club_id
       WHERE cut.cutoff IS NULL
          OR (cl.created_at IS NOT NULL AND isfinite(cl.created_at) AND cl.created_at >= cut.cutoff)
       GROUP BY 1, 2
      UNION ALL
      -- A raked hand that named nobody is the table's club's hand.
      SELECT rr.table_club, rr.table_id, count(*), count(*)
        FROM rr
       WHERE rr.table_club IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM contrib c WHERE c.id = rr.id)
       GROUP BY 1, 2) h
     GROUP BY 1, 2
  )
  INSERT INTO public.club_table_daily
    (club_id, table_id, stat_date, union_id, rake, hands, players, buyins, cashouts, net, source_rows, updated_at)
  SELECT f.club_id, f.game_id, p_day, t.union_id,
         SUM(f.fee), COALESCE(MAX(h.hands), 0),
         (count(DISTINCT f.user_id) FILTER (WHERE f.fee > 0 AND f.user_id <> v_zero))::int,
         round(SUM(f.buyins), 2), round(SUM(f.cashouts), 2), round(SUM(f.cashouts) - SUM(f.buyins), 2),
         COALESCE(MAX(h.src), 0), now()
    FROM public.ca_club_data_fact f
    JOIN public.tables t ON t.id = f.game_id
    LEFT JOIN hands h ON h.club_id = f.club_id AND h.table_id = f.game_id
   WHERE f.stat_date = p_day AND f.kind = 'CASH'
   GROUP BY f.club_id, f.game_id, t.union_id;
  GET DIAGNOSTICS v_tables = ROW_COUNT;

  INSERT INTO public.ca_club_table_player_daily (club_id, table_id, stat_date, user_id)
  SELECT DISTINCT f.club_id, f.game_id, p_day, f.user_id
    FROM public.ca_club_data_fact f
   WHERE f.stat_date = p_day AND f.kind = 'CASH' AND f.fee > 0 AND f.user_id <> v_zero
  ON CONFLICT DO NOTHING;

  INSERT INTO public.ca_club_player_daily (club_id, user_id, stat_date, cash_net, tournament_net, updated_at)
  SELECT f.club_id, f.user_id, p_day,
         COALESCE(SUM(f.winnings) FILTER (WHERE f.kind = 'CASH'), 0),
         COALESCE(SUM(f.winnings) FILTER (WHERE f.kind = 'TOURNAMENT'), 0), now()
    FROM public.ca_club_data_fact f
   WHERE f.stat_date = p_day AND f.user_id <> v_zero
   GROUP BY f.club_id, f.user_id
  HAVING bool_or(f.buyins <> 0 OR f.cashouts <> 0);
  GET DIAGNOSTICS v_players = ROW_COUNT;

  INSERT INTO public.ca_club_tournament_daily (club_id, tournament_id, stat_date, fee, winnings, updated_at)
  SELECT f.club_id, f.game_id, p_day, SUM(f.fee), SUM(f.winnings), now()
    FROM public.ca_club_data_fact f
   WHERE f.stat_date = p_day AND f.kind = 'TOURNAMENT'
   GROUP BY f.club_id, f.game_id;
  GET DIAGNOSTICS v_tournaments = ROW_COUNT;

  INSERT INTO public.ca_club_tournament_player_daily (club_id, tournament_id, user_id, stat_date, updated_at)
  SELECT DISTINCT f.club_id, f.game_id, f.user_id, p_day, now()
    FROM public.ca_club_data_fact f
   WHERE f.stat_date = p_day AND f.kind = 'TOURNAMENT' AND f.user_id <> v_zero
     AND (f.buyins <> 0 OR f.cashouts <> 0)
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('day', p_day, 'source', 'ca_club_data_fact', 'table_rows', v_tables,
                            'player_rows', v_players, 'tournament_rows', v_tournaments);
END;
$function$;

COMMIT;
