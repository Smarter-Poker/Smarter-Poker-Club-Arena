CREATE ROLE postgres; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.tables(id uuid PRIMARY KEY,union_id uuid,club_id uuid,tournament_id uuid);
CREATE TABLE public.rake_records(id uuid PRIMARY KEY,table_id uuid,created_at timestamptz,player_contributions jsonb,rake_amount numeric,tournament_id uuid,is_tournament boolean);
CREATE TABLE public.rake_attributions(rake_record_id uuid,player_id uuid,club_id uuid);
CREATE TABLE public.cash_participant_funding_receipts(funding_club_id uuid,operation_kind text,table_id uuid,account_entity_id uuid,seat_joined_at timestamptz);
CREATE TABLE public.table_seats(club_id uuid,table_id uuid,user_id uuid,joined_at timestamptz);
CREATE TABLE public.ca_club_data_fact(club_id uuid,game_id uuid,stat_date date,kind text,user_id uuid,fee numeric,buyins numeric,cashouts numeric,winnings numeric);
CREATE TABLE public.club_table_daily(club_id uuid,table_id uuid,stat_date date,union_id uuid,rake numeric,hands int,players int,buyins numeric,cashouts numeric,net numeric,source_rows int,updated_at timestamptz);
CREATE TABLE public.ca_club_table_player_daily(club_id uuid,table_id uuid,stat_date date,user_id uuid, UNIQUE(club_id,table_id,stat_date,user_id));
CREATE TABLE public.ca_club_player_daily(club_id uuid,user_id uuid,stat_date date,cash_net numeric,tournament_net numeric,updated_at timestamptz);
CREATE TABLE public.ca_club_tournament_daily(club_id uuid,tournament_id uuid,stat_date date,fee numeric,winnings numeric,updated_at timestamptz);
CREATE TABLE public.ca_club_tournament_player_daily(club_id uuid,tournament_id uuid,user_id uuid,stat_date date,updated_at timestamptz,UNIQUE(club_id,tournament_id,user_id,stat_date));
CREATE FUNCTION public.fn_ca_club_data_facts_from() RETURNS date LANGUAGE sql AS $$SELECT current_date-30$$;
CREATE FUNCTION public.fn_ca_cash_reporting_club(uuid,uuid,uuid) RETURNS uuid LANGUAGE sql AS $$SELECT $2$$;
CREATE TABLE public.fixture_boundaries(club_id uuid PRIMARY KEY,cutoff timestamptz);
CREATE SEQUENCE public.fixture_cutoff_calls;
CREATE FUNCTION public.fn_ca_launch_accounting_cutoff(text,uuid) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$BEGIN PERFORM nextval('public.fixture_cutoff_calls'); RETURN(SELECT cutoff FROM public.fixture_boundaries WHERE club_id=$2); END$$;
CREATE FUNCTION public.fn_ca_launch_accounting_accepts(uuid,timestamptz) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT CASE WHEN b.cutoff IS NULL THEN true ELSE $2 IS NOT NULL AND isfinite($2) AND $2>=b.cutoff END FROM(SELECT public.fn_ca_launch_accounting_cutoff('club',$1) cutoff)b$$;
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
  ), hands AS (
    SELECT h.club_id, h.table_id, SUM(h.hands)::int AS hands, SUM(h.src)::int AS src FROM (
      SELECT cl.club_id, cl.table_id, count(DISTINCT cl.id) AS hands, count(*) AS src
        FROM clubbed cl
       WHERE cl.club_id IS NOT NULL AND public.fn_ca_launch_accounting_accepts(cl.club_id, cl.created_at) IS TRUE
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
INSERT INTO public.tables VALUES('10000000-0000-0000-0000-000000000001',NULL,'20000000-0000-0000-0000-000000000001',NULL);
INSERT INTO public.fixture_boundaries VALUES('20000000-0000-0000-0000-000000000001',(current_date-1)::timestamptz+interval '12 hours');
INSERT INTO public.rake_records SELECT md5(g::text)::uuid,'10000000-0000-0000-0000-000000000001',(current_date-1)::timestamptz+g*interval '1 minute',jsonb_build_object('30000000-0000-0000-0000-000000000001','1','bad-key','3','30000000-0000-0000-0000-000000000002','0'),1,NULL,false FROM generate_series(1,1000)g;
INSERT INTO public.rake_attributions SELECT id,'30000000-0000-0000-0000-000000000001',CASE WHEN row_number()OVER(ORDER BY id)%2=0 THEN '20000000-0000-0000-0000-000000000001'::uuid ELSE '20000000-0000-0000-0000-000000000002'::uuid END FROM public.rake_records;
-- Nonobject contributions retain the existing unnamed-hand path.
INSERT INTO public.rake_records VALUES(md5('unnamed')::uuid,'10000000-0000-0000-0000-000000000001',(current_date-1)::timestamptz,'[]',1,NULL,false);
INSERT INTO public.ca_club_data_fact SELECT c,'10000000-0000-0000-0000-000000000001',current_date-1,k,'30000000-0000-0000-0000-000000000001',0.0098,10,12,2 FROM unnest(ARRAY['20000000-0000-0000-0000-000000000001'::uuid,'20000000-0000-0000-0000-000000000002'::uuid])c CROSS JOIN unnest(ARRAY['CASH','TOURNAMENT'])k;
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres;
ALTER FUNCTION public.fn_ca_reporting_rollups_from_facts(date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_reporting_rollups_from_facts(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_reporting_rollups_from_facts(date) TO service_role;
SELECT setval('public.fixture_cutoff_calls',1,false);
SELECT public.fn_ca_reporting_rollups_from_facts(current_date-1);
CREATE TABLE public.fixture_before AS SELECT 'club_table_daily' tab,to_jsonb(x)-'updated_at' val FROM public.club_table_daily x UNION ALL SELECT 'ca_club_table_player_daily',to_jsonb(x) FROM public.ca_club_table_player_daily x UNION ALL SELECT 'ca_club_player_daily',to_jsonb(x)-'updated_at' FROM public.ca_club_player_daily x UNION ALL SELECT 'ca_club_tournament_daily',to_jsonb(x)-'updated_at' FROM public.ca_club_tournament_daily x UNION ALL SELECT 'ca_club_tournament_player_daily',to_jsonb(x)-'updated_at' FROM public.ca_club_tournament_player_daily x;
DO $$BEGIN IF (SELECT last_value FROM public.fixture_cutoff_calls)<1000 THEN RAISE EXCEPTION 'baseline did not exercise per-contribution lookups'; END IF; END$$;
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

ROLLBACK;
DO $$BEGIN IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_ca_reporting_rollups_from_facts(date)'::regprocedure))<>'9b54cb00d59fa616522f049b67237def' THEN RAISE EXCEPTION 'rollback changed producer'; END IF; END$$;
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
SELECT setval('public.fixture_cutoff_calls',1,false);
SELECT public.fn_ca_reporting_rollups_from_facts(current_date-1);
DO $$DECLARE n bigint; BEGIN SELECT last_value INTO n FROM public.fixture_cutoff_calls; IF n<>2 THEN RAISE EXCEPTION 'cutoff lookup regression: expected 2 clubs, got %',n; END IF; END$$;
CREATE TEMP TABLE fixture_after AS SELECT 'club_table_daily' tab,to_jsonb(x)-'updated_at' val FROM public.club_table_daily x UNION ALL SELECT 'ca_club_table_player_daily',to_jsonb(x) FROM public.ca_club_table_player_daily x UNION ALL SELECT 'ca_club_player_daily',to_jsonb(x)-'updated_at' FROM public.ca_club_player_daily x UNION ALL SELECT 'ca_club_tournament_daily',to_jsonb(x)-'updated_at' FROM public.ca_club_tournament_daily x UNION ALL SELECT 'ca_club_tournament_player_daily',to_jsonb(x)-'updated_at' FROM public.ca_club_tournament_player_daily x;
DO $$BEGIN
 IF EXISTS((TABLE public.fixture_before EXCEPT ALL TABLE fixture_after) UNION ALL(TABLE fixture_after EXCEPT ALL TABLE public.fixture_before)) THEN RAISE EXCEPTION 'report totals changed'; END IF;
 IF (SELECT sum(rake) FROM public.club_table_daily)<>0.0196 THEN RAISE EXCEPTION 'precision lost'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_reporting_rollups_from_facts(date)'::regprocedure AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public'] AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') AND has_function_privilege('service_role',oid,'EXECUTE')) THEN RAISE EXCEPTION 'authority changed'; END IF;
END$$;
-- Predicate equivalence includes NULL/infinite source timestamps and NULL cutoffs.
DO $$BEGIN IF EXISTS(SELECT 1 FROM(VALUES(NULL::timestamptz),('-infinity'::timestamptz),('infinity'::timestamptz),((current_date-1)::timestamptz),((current_date-1)::timestamptz+interval '12 hours'),(now()))t(at) CROSS JOIN(VALUES('20000000-0000-0000-0000-000000000001'::uuid),('20000000-0000-0000-0000-000000000002'::uuid))c(id) CROSS JOIN LATERAL(SELECT public.fn_ca_launch_accounting_cutoff('club',c.id) cutoff)b WHERE public.fn_ca_launch_accounting_accepts(c.id,t.at) IS DISTINCT FROM (b.cutoff IS NULL OR(t.at IS NOT NULL AND isfinite(t.at) AND t.at>=b.cutoff))) THEN RAISE EXCEPTION 'cutoff predicate semantics changed'; END IF; END$$;
SELECT setval('public.fixture_cutoff_calls',1,false); SELECT public.fn_ca_reporting_rollups_from_facts(current_date-1); DO $$BEGIN IF(SELECT last_value FROM public.fixture_cutoff_calls)<>2 THEN RAISE EXCEPTION 'repeat lookup bound changed'; END IF; END$$;
-- An empty boundary set accepts every named contribution, as before launch.
BEGIN;
DELETE FROM public.fixture_boundaries;
SELECT setval('public.fixture_cutoff_calls',1,false);
SELECT public.fn_ca_reporting_rollups_from_facts(current_date-1);
DO $$BEGIN
 IF (SELECT sum(hands) FROM public.club_table_daily)<>1001 OR (SELECT last_value FROM public.fixture_cutoff_calls)<>2 THEN
  RAISE EXCEPTION 'empty launch boundaries changed hands or lookup bound';
 END IF;
END$$;
ROLLBACK;
