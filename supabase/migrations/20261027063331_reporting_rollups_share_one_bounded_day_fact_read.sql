-- Reporting reads one day of facts once for all five report relations.
-- The first cutoff fix moved natural job128 past its former first-query timeout,
-- but run1524449 still exhausted 300s at the fourth full fact-table read.
-- Preserve every aggregation, predicate, precision, row count and private ACL.
-- Function-only installation; no recount, cron change, hot-table DDL or money move.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $guard$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_reporting_rollups_from_facts(date)') AND md5(prosrc)='17640230b3b7587ed09a7f18c765f74f') THEN
  RAISE EXCEPTION 'Reporting day fact producer changed or already installed';
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

  WITH day_facts AS MATERIALIZED (
    SELECT f.club_id, f.game_id, f.stat_date, f.kind, f.user_id, f.fee, f.buyins, f.cashouts, f.winnings
      FROM public.ca_club_data_fact f
     WHERE f.stat_date = p_day
  ), rr AS MATERIALIZED (
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
  ),
  table_rows AS (
    INSERT INTO public.club_table_daily
      (club_id, table_id, stat_date, union_id, rake, hands, players, buyins, cashouts, net, source_rows, updated_at)
    SELECT f.club_id, f.game_id, p_day, t.union_id,
           SUM(f.fee), COALESCE(MAX(h.hands), 0),
           (count(DISTINCT f.user_id) FILTER (WHERE f.fee > 0 AND f.user_id <> v_zero))::int,
           round(SUM(f.buyins), 2), round(SUM(f.cashouts), 2), round(SUM(f.cashouts) - SUM(f.buyins), 2),
           COALESCE(MAX(h.src), 0), now()
      FROM day_facts f
      JOIN public.tables t ON t.id = f.game_id
      LEFT JOIN hands h ON h.club_id = f.club_id AND h.table_id = f.game_id
     WHERE f.stat_date = p_day AND f.kind = 'CASH'
     GROUP BY f.club_id, f.game_id, t.union_id
    RETURNING 1
  ),
  table_player_rows AS (
    INSERT INTO public.ca_club_table_player_daily (club_id, table_id, stat_date, user_id)
    SELECT DISTINCT f.club_id, f.game_id, p_day, f.user_id
      FROM day_facts f
     WHERE f.stat_date = p_day AND f.kind = 'CASH' AND f.fee > 0 AND f.user_id <> v_zero
    ON CONFLICT DO NOTHING
    RETURNING 1
  ),
  player_rows AS (
    INSERT INTO public.ca_club_player_daily (club_id, user_id, stat_date, cash_net, tournament_net, updated_at)
    SELECT f.club_id, f.user_id, p_day,
           COALESCE(SUM(f.winnings) FILTER (WHERE f.kind = 'CASH'), 0),
           COALESCE(SUM(f.winnings) FILTER (WHERE f.kind = 'TOURNAMENT'), 0), now()
      FROM day_facts f
     WHERE f.stat_date = p_day AND f.user_id <> v_zero
     GROUP BY f.club_id, f.user_id
    HAVING bool_or(f.buyins <> 0 OR f.cashouts <> 0)
    RETURNING 1
  ),
  tournament_rows AS (
    INSERT INTO public.ca_club_tournament_daily (club_id, tournament_id, stat_date, fee, winnings, updated_at)
    SELECT f.club_id, f.game_id, p_day, SUM(f.fee), SUM(f.winnings), now()
      FROM day_facts f
     WHERE f.stat_date = p_day AND f.kind = 'TOURNAMENT'
     GROUP BY f.club_id, f.game_id
    RETURNING 1
  ),
  tournament_player_rows AS (
    INSERT INTO public.ca_club_tournament_player_daily (club_id, tournament_id, user_id, stat_date, updated_at)
    SELECT DISTINCT f.club_id, f.game_id, f.user_id, p_day, now()
      FROM day_facts f
     WHERE f.stat_date = p_day AND f.kind = 'TOURNAMENT' AND f.user_id <> v_zero
       AND (f.buyins <> 0 OR f.cashouts <> 0)
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM table_rows),
         (SELECT count(*) FROM player_rows),
         (SELECT count(*) FROM tournament_rows)
    INTO v_tables, v_players, v_tournaments;

  RETURN jsonb_build_object('day', p_day, 'source', 'ca_club_data_fact', 'table_rows', v_tables,
                            'player_rows', v_players, 'tournament_rows', v_tournaments);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_reporting_rollups_from_facts(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_reporting_rollups_from_facts(date) TO service_role;

-- Function-only follow-up: retain exact day/club coverage and all rollup calls.
-- A validated FK makes clubs + EXISTS identical to non-null rake club DISTINCT.
DO $caller_preimage$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_club_rake_rollup_catchup(integer)'::regprocedure)) <> '44fcd6e3e1afb37db33498a2aac98c05' THEN
    RAISE EXCEPTION 'club_rake_catchup_preimage_changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.rake_records'::regclass
                    AND confrelid = 'public.clubs'::regclass AND contype = 'f'
                    AND convalidated AND confdeltype = 'n'
                    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.rake_records'::regclass AND attname = 'club_id')]::smallint[]
                    AND confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.clubs'::regclass AND attname = 'id')]::smallint[]) THEN
    RAISE EXCEPTION 'club_rake_catchup_club_fk_unproved';
  END IF;
END $caller_preimage$;

CREATE OR REPLACE FUNCTION public.fn_club_rake_rollup_catchup(p_days integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  rec record; d date;
  v_days int := 0; v_rows int := 0; v_fail int := 0; v_gaps int := 0;
  v_ctd jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR rec IN
    SELECT DISTINCT club_id FROM union_clubs
    UNION
    SELECT c.id AS club_id FROM public.clubs c
     WHERE EXISTS (SELECT 1 FROM public.rake_records r
                    WHERE r.club_id = c.id
                      AND r.created_at >= current_date - GREATEST(p_days,1) - 1)
  LOOP
    FOR d IN
      SELECT gs::date FROM generate_series(
               current_date - GREATEST(p_days,1), current_date - 1, interval '1 day') gs
    LOOP
      IF EXISTS (SELECT 1 FROM club_rake_rollup_complete
                  WHERE club_id = rec.club_id AND day = d) THEN
        CONTINUE;
      END IF;
      BEGIN
        v_rows := v_rows + public.fn_club_rake_rollup_day(rec.club_id, d);
        v_days := v_days + 1;
      EXCEPTION WHEN OTHERS THEN
        v_fail := v_fail + 1;
      END;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_gaps
    FROM (SELECT c.id AS cid FROM public.clubs c
           WHERE EXISTS (SELECT 1 FROM public.rake_records r
                          WHERE r.club_id = c.id
                            AND r.created_at >= current_date - GREATEST(p_days,1) - 1)) src
    CROSS JOIN generate_series(current_date - GREATEST(p_days,1),
                               current_date - 1, interval '1 day') g
   WHERE NOT EXISTS (SELECT 1 FROM club_rake_rollup_complete rc
                      WHERE rc.club_id = src.cid AND rc.day = g::date);

  IF v_gaps > 0 THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_club_rake_rollup_catchup',
            'Club rake rollup has uncovered days - the live downline view is falling back to full scans',
            jsonb_build_object('gap_club_days', v_gaps, 'lookback_days', p_days,
                               'failures', v_fail, 'ran_at', now()));
  END IF;

  -- Club Data screen rollup. Additive; never allowed to break the above.
  BEGIN
    v_ctd := public.fn_club_table_daily_catchup(2);
  EXCEPTION WHEN OTHERS THEN
    v_ctd := jsonb_build_object('success', false, 'error', SQLERRM);
  END;

  RETURN jsonb_build_object('days_built', v_days, 'rows', v_rows,
                            'failures', v_fail, 'remaining_gaps', v_gaps,
                            'club_table_daily', v_ctd,
                            'ran_at', now());
END $function$;

REVOKE ALL ON FUNCTION public.fn_club_rake_rollup_catchup(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_rake_rollup_catchup(integer) TO service_role;

COMMIT;
