-- Reserved with scripts/reserve-migration-version.sh, 2026-10-30.
-- The installed player semijoin still processed314291 live rows for635members.
-- The complete week reader exceeded5s. A period-derived merge plan also scanned
-- historical rows. Parameterized LATERAL/OFFSET0 keeps each original head/tail/
-- missing-day source range bounded. Aggregate per player before roster joins.
-- Resolve the immutable launch boundary once per club; the NULL-cutoff lane
-- uses the existing club/date covering index without fetching record IDs.
-- NonNULL boundaries retain the original finite timestamp/cutoff acceptance.
-- Preserve positive cash-only source, row-level cents, duplicate roster joins,
-- closed rollups, authorization, metadata, defaults and all financial records.
-- @live-proof: EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer)'::regprocedure AND md5(pg_get_functiondef(oid))='1b601263ba9a92123fa6dfaa05451369')
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $patch$
DECLARE d text; i_start integer; i_end integer;
BEGIN
 SELECT pg_get_functiondef('public.fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer)'::regprocedure) INTO d;
 IF md5(d)<>'056d558e8c39454a21f3705c631de049' THEN RAISE EXCEPTION 'Downline covered target definition drift'; END IF;
 i_start:=strpos(d,'  edge_att AS MATERIALIZED (');
 i_end:=strpos(d,'  earned AS MATERIALIZED (');
 IF i_start=0 OR i_end<=i_start THEN RAISE EXCEPTION 'Downline live block missing'; END IF;
 d:=substr(d,1,i_start-1)||$live$  edge_periods AS MATERIALIZED (
    SELECT c.club_id, v_from AS lo, v_head_end AS hi FROM in_scope_clubs c
    UNION ALL
    SELECT c.club_id, v_tail_start, v_to FROM in_scope_clubs c
    UNION ALL
    SELECT gd.club_id, gd.day::timestamptz, (gd.day+1)::timestamptz FROM gap_days gd
  ),
  edge_totals AS MATERIALIZED (
    SELECT a.player_id AS user_id, p.club_id,
           SUM(round(a.rake_amount*100)::bigint)::numeric/100 AS rake,
           count(*)::bigint AS hands, max(a.created_at) AS last_at
      FROM launch_scope lc JOIN edge_periods p ON p.club_id=lc.club_id
      CROSS JOIN LATERAL (
        SELECT a.player_id,a.rake_amount,a.created_at FROM rake_attributions a
        WHERE lc.cutoff IS NULL AND a.club_id=p.club_id AND a.created_at>=p.lo AND a.created_at<p.hi
          AND a.rake_amount>0 AND a.player_id IS NOT NULL
        OFFSET 0
      ) a
     GROUP BY a.player_id,p.club_id
    UNION ALL
    SELECT a.player_id, p.club_id,
           SUM(round(a.rake_amount*100)::bigint)::numeric/100,
           count(*)::bigint, max(a.created_at)
      FROM launch_scope lc JOIN edge_periods p ON p.club_id=lc.club_id
      CROSS JOIN LATERAL (
        SELECT a.player_id,a.rake_amount,a.created_at FROM rake_attributions a
        JOIN rake_records rr ON rr.id=a.rake_record_id
        WHERE lc.cutoff IS NOT NULL AND a.club_id=p.club_id AND a.created_at>=p.lo AND a.created_at<p.hi
          AND a.rake_amount>0 AND a.player_id IS NOT NULL
          AND rr.created_at IS NOT NULL AND isfinite(rr.created_at) AND rr.created_at>=lc.cutoff
        OFFSET 0
      ) a
     GROUP BY a.player_id,p.club_id
  ),
  from_live AS (
    SELECT t.user_id,t.club_id,SUM(t.rake) AS rake,SUM(t.hands)::bigint AS hands,MAX(t.last_at) AS last_at
    FROM edge_totals t JOIN everyone e ON e.player_id=t.user_id AND e.club_id=t.club_id
    GROUP BY t.user_id,t.club_id
  ),
$live$||substr(d,i_end);
 d:=replace(d,$old$  in_scope_clubs AS MATERIALIZED (SELECT DISTINCT club_id FROM everyone),$old$,$new$  in_scope_clubs AS MATERIALIZED (SELECT DISTINCT club_id FROM everyone),
  launch_scope AS MATERIALIZED (SELECT club_id, public.fn_ca_launch_accounting_cutoff('club',club_id) AS cutoff FROM in_scope_clubs),$new$);
 IF md5(d)<>'1b601263ba9a92123fa6dfaa05451369' THEN RAISE EXCEPTION 'Downline covered postimage mismatch'; END IF;
 EXECUTE d;
END $patch$;
COMMIT;
