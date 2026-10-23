-- 20261023032335_rake_windows_plan_with_their_actual_values.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Union Data's month view (ca_rake_snapshot_v2 for the Midway Union, Oct 1-22)
-- still took about 7 s after 20261022165130, against the 8 s statement timeout
-- of a browser call. 4.9 s of it was fn_ca_rake_windows_v3: as a LANGUAGE sql
-- function its statement is planned with its arguments as unknown parameters,
-- and the planner joined every MTT ever run (6,399) to the per-game rows one
-- index probe at a time (5.4 s under EXPLAIN). The same MTT query with the
-- values known takes 0.22 s.
--
-- The function now runs the identical statement text through EXECUTE ... USING,
-- so it is planned for the window and clubs it was asked about. Nothing in the
-- statement changes except p_clubs/p_start/p_end/p_per_club becoming $1..$4.
-- Measured read-only on production on closed Chicago days, old against new:
--   Midway Oct 1-21 per club    4.49 s -> 2.38 s  equal
--   Midway Sep 16-Oct 21 union  4.42 s -> 2.48 s  equal
--   Midway Oct 8-21 per club    2.65 s -> 2.20 s  equal
--   Midway Oct 15-21 per club   1.57 s -> 1.57 s  equal
--   Midway Oct 21 per club      0.27 s -> 0.27 s  equal
--   KINGS CLUB, Deep Stack Society, The Felt Society, Oct 8-21: equal
-- (equal = identical jsonb apart from data_updated_at, which reads the clock
-- of live rows). Same owner, SECURITY DEFINER, search_path, work_mem and grants.
-- No table, index, trigger or money changes.
--
-- @live-proof: position('EXECUTE' IN pg_get_functiondef('public.fn_ca_rake_windows_v3(uuid[],date,date,boolean)'::regprocedure))>0

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
  IF current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'rake windows migration requires the maintained installer';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_rake_windows_v3(uuid[],date,date,boolean)'::regprocedure))
     IS DISTINCT FROM '88eb254e0a975b87182904562a7e63f1' THEN
    RAISE EXCEPTION 'fn_ca_rake_windows_v3 preimage changed (md5 %)',
      md5(pg_get_functiondef('public.fn_ca_rake_windows_v3(uuid[],date,date,boolean)'::regprocedure));
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_ca_rake_windows_v3(p_clubs uuid[], p_start date, p_end date, p_per_club boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET work_mem TO '256MB'
AS $function$
DECLARE
  v jsonb;
BEGIN
  -- The 20261022165130 statement, unchanged but for $1..$4, planned with its values.
  EXECUTE $windows$
 /* EVERY WINDOW OF A UNION FROM ONE PASS (20261022165130).

    fn_ca_rake_window_v2 grouped every per-game row of the window into games
    (spilling to disk at the default work_mem: 8.7 s for Midway's month), and
    Union Data then read the same rows again once per member club (13.5 s for
    the month). Here they are read once: sums per club, the union's games and
    every club's games from one distinct pass (each game carries the clubs
    that played it as bits), the MTTs from tournaments by key. 'all' is
    fn_ca_rake_window_v2($1), field for field; with $4, 'clubs'
    holds fn_ca_rake_window_v2(ARRAY[club]) for every distinct club of $1.
    'data_updated_at' is the newest last_at of the rows read.

    A window's games are its distinct (kind, game) rows plus the cash tables
    still seated that have no cash row of their own: counted as the distinct
    rows plus the seated tables missing from them, which is the size of their
    UNION. */
 WITH ids AS (SELECT DISTINCT unnest($1) AS club_id),
 ord AS MATERIALIZED (
  SELECT array_agg(i.club_id ORDER BY i.club_id) a, $4 AND count(*) <= 62 AS masked,
         $4 AND count(*) > 62 AS wide
    FROM ids i
 ), r AS NOT MATERIALIZED (
  SELECT d.club_id, d.kind, d.game_id, d.fee, d.winnings, d.last_at FROM public.ca_club_data_game_ct d
   WHERE d.club_id = ANY ($1) AND d.stat_date BETWEEN $2 AND $3
 ), s AS MATERIALIZED (
  SELECT r.club_id, sum(r.fee) fee, sum(r.winnings) win,
         sum(r.fee) FILTER (WHERE r.kind='CASH') cf, sum(r.winnings) FILTER (WHERE r.kind='CASH') cw,
         sum(r.fee) FILTER (WHERE r.kind='TOURNAMENT') tf, sum(r.winnings) FILTER (WHERE r.kind='TOURNAMENT') tw,
         max(r.last_at) last_at
    FROM r GROUP BY r.club_id
 ), z AS MATERIALIZED (
  -- Per club: each (kind, game) once, with its clubs as bits.
  SELECT r.kind, r.game_id, bit_or(1::bigint << (array_position((SELECT o.a FROM ord o), r.club_id) - 1)) mask
    FROM r WHERE (SELECT o.masked FROM ord o) GROUP BY r.kind, r.game_id
 ), gm AS MATERIALIZED (
  SELECT z.mask, z.kind, count(*) n FROM z GROUP BY z.mask, z.kind
 ), cg AS MATERIALIZED (
  -- Per club for a union of more than 62 clubs.
  SELECT DISTINCT r.club_id, r.kind, r.game_id FROM r WHERE (SELECT o.wide FROM ord o)
 ), ugc AS (
  SELECT sum(gm.n)::bigint n, coalesce(sum(gm.n) FILTER (WHERE gm.kind='CASH'),0)::bigint nc,
         coalesce(sum(gm.n) FILTER (WHERE gm.kind='TOURNAMENT'),0)::bigint nt
    FROM gm HAVING (SELECT o.masked FROM ord o)
  UNION ALL
  SELECT count(*), count(*) FILTER (WHERE x.kind='CASH'), count(*) FILTER (WHERE x.kind='TOURNAMENT')
    FROM (SELECT DISTINCT y.kind, y.game_id FROM cg y) x HAVING (SELECT o.wide FROM ord o)
  UNION ALL
  SELECT count(*), count(*) FILTER (WHERE x.kind='CASH'), count(*) FILTER (WHERE x.kind='TOURNAMENT')
    FROM (SELECT DISTINCT r.kind, r.game_id FROM r WHERE NOT $4) x HAVING NOT $4
 ), ccash AS MATERIALIZED (
  -- Every club's cash tables (a few thousand), and the union's.
  SELECT o.club_id, z.game_id FROM z CROSS JOIN LATERAL unnest((SELECT x.a FROM ord x)) WITH ORDINALITY o(club_id, i)
   WHERE z.kind='CASH' AND z.mask & (1::bigint << (o.i::int - 1)) <> 0
  UNION ALL
  SELECT y.club_id, y.game_id FROM cg y WHERE y.kind='CASH'
  UNION ALL
  SELECT DISTINCT NULL::uuid, r.game_id FROM r WHERE NOT $4 AND r.kind='CASH'
 ), felt AS MATERIALIZED (SELECT * FROM public.fn_ca_rake_felt_v2($1, $2, $3)
 ), uextra AS (
  SELECT count(DISTINCT f.table_id) n FROM felt f
   WHERE NOT EXISTS (SELECT 1 FROM ccash x WHERE x.game_id=f.table_id)
 ), cgc AS MATERIALIZED (
  SELECT o.club_id, sum(gm.n)::bigint n, coalesce(sum(gm.n) FILTER (WHERE gm.kind='CASH'),0)::bigint nc,
         coalesce(sum(gm.n) FILTER (WHERE gm.kind='TOURNAMENT'),0)::bigint nt
    FROM gm CROSS JOIN LATERAL unnest((SELECT x.a FROM ord x)) WITH ORDINALITY o(club_id, i)
   WHERE gm.mask & (1::bigint << (o.i::int - 1)) <> 0
   GROUP BY o.club_id
  UNION ALL
  SELECT y.club_id, count(*), count(*) FILTER (WHERE y.kind='CASH'), count(*) FILTER (WHERE y.kind='TOURNAMENT')
    FROM cg y GROUP BY y.club_id
 ), cextra AS MATERIALIZED (
  SELECT f.club_id, count(DISTINCT f.table_id) n FROM felt f
   WHERE $4 AND NOT EXISTS (SELECT 1 FROM ccash x WHERE x.club_id=f.club_id AND x.game_id=f.table_id)
   GROUP BY f.club_id
 ), mtt AS MATERIALIZED (
  SELECT d.club_id, d.game_id, sum(d.fee) fee, sum(d.winnings) winnings,
         bool_or(COALESCE(tr.status IN ('COMPLETED','CANCELLED'),false)) finished
    FROM public.tournaments tr JOIN public.ca_club_data_game_ct d ON d.game_id=tr.id AND d.kind='TOURNAMENT'
         AND d.club_id = ANY ($1) AND d.stat_date BETWEEN $2 AND $3
   WHERE tr.tournament_type='MTT' GROUP BY d.club_id, d.game_id
 ), hands_one AS MATERIALIZED (
  SELECT c.club_id, coalesce(sum(c.hands),0)::bigint n FROM public.ca_club_data_hands_ct c
   WHERE c.club_id = ANY ($1) AND c.stat_date BETWEEN $2 AND $3 GROUP BY c.club_id
 ), u AS (
  SELECT
   coalesce((SELECT g.n FROM ugc g),0) + (SELECT e.n FROM uextra e) games,
   coalesce((SELECT g.nc FROM ugc g),0) + (SELECT e.n FROM uextra e) cash_games,
   (SELECT count(DISTINCT m.game_id) FROM mtt m) mtt_games,
   coalesce((SELECT g.nt FROM ugc g),0) tournament_games,
   CASE WHEN cardinality($1)>1 THEN
    (SELECT count(*) FROM public.rake_records rr WHERE rr.created_at>=$2::timestamp AT TIME ZONE 'America/Chicago' AND rr.created_at<($3+1)::timestamp AT TIME ZONE 'America/Chicago'
      AND rr.tournament_id IS NULL AND rr.is_tournament IS NOT TRUE AND rr.rake_amount>0
      AND EXISTS(SELECT 1 FROM public.ca_club_data_hands_ct c WHERE c.club_id=ANY($1) AND c.stat_date BETWEEN $2 AND $3 AND c.table_id=rr.table_id))
   ELSE (SELECT coalesce(sum(h.n),0)::bigint FROM hands_one h) END hands,
   coalesce((SELECT sum(s.fee) FROM s),0) fee, coalesce((SELECT sum(s.win) FROM s),0) win,
   coalesce((SELECT sum(s.cf) FROM s),0) cf, coalesce((SELECT sum(s.cw) FROM s),0) cw,
   coalesce((SELECT sum(s.tf) FROM s),0) tf, coalesce((SELECT sum(s.tw) FROM s),0) tw,
   (SELECT coalesce(sum(m.fee) FILTER (WHERE m.finished),0) FROM mtt m) mf,
   (SELECT coalesce(sum(m.winnings) FILTER (WHERE m.finished),0) FROM mtt m) mw,
   (SELECT coalesce(sum(m.fee) FILTER (WHERE NOT m.finished),0) FROM mtt m) rf,
   (SELECT coalesce(sum(m.winnings) FILTER (WHERE NOT m.finished),0) FROM mtt m) rw,
   coalesce((SELECT sum(f.felt) FROM felt f),0) felt
 ), pc AS (
  SELECT i.club_id,
   coalesce(g.n,0) + coalesce(e.n,0) games,
   coalesce(g.nc,0) + coalesce(e.n,0) cash_games,
   (SELECT count(*) FROM mtt m WHERE m.club_id=i.club_id) mtt_games,
   coalesce(g.nt,0) tournament_games,
   coalesce((SELECT h.n FROM hands_one h WHERE h.club_id=i.club_id),0)::bigint hands,
   coalesce(s.fee,0) fee, coalesce(s.win,0) win, coalesce(s.cf,0) cf, coalesce(s.cw,0) cw, coalesce(s.tf,0) tf, coalesce(s.tw,0) tw,
   (SELECT coalesce(sum(m.fee) FILTER (WHERE m.finished),0) FROM mtt m WHERE m.club_id=i.club_id) mf,
   (SELECT coalesce(sum(m.winnings) FILTER (WHERE m.finished),0) FROM mtt m WHERE m.club_id=i.club_id) mw,
   (SELECT coalesce(sum(m.fee) FILTER (WHERE NOT m.finished),0) FROM mtt m WHERE m.club_id=i.club_id) rf,
   (SELECT coalesce(sum(m.winnings) FILTER (WHERE NOT m.finished),0) FROM mtt m WHERE m.club_id=i.club_id) rw,
   coalesce((SELECT sum(f.felt) FROM felt f WHERE f.club_id=i.club_id),0) felt
  FROM ids i LEFT JOIN s ON s.club_id=i.club_id LEFT JOIN cgc g ON g.club_id=i.club_id LEFT JOIN cextra e ON e.club_id=i.club_id
  WHERE $4
 )
 SELECT jsonb_build_object(
  'all', (SELECT jsonb_build_object('games',a.games,'cash_games',a.cash_games,'mtt_games',a.mtt_games,
     'tournament_games',a.tournament_games,'hands',a.hands,
     'fee_exact',a.fee,'cash_fee_exact',a.cf,'mtt_fee_exact',a.mf,'tournament_fee_exact',a.tf,'fee',round(a.fee,2),'cash_fee',round(a.cf,2),'mtt_fee',round(a.mf,2),'tournament_fee',round(a.tf,2),
     'total_winnings',round(a.win+a.felt,2),
     'cash_winnings',round(a.cw+a.felt,2),'mtt_winnings',round(a.mw,2),'tournament_winnings',round(a.tw,2),
     'running_mtt_entries',round(a.rw,2),'running_mtt_fee',round(a.rf,2),'running_mtt_fee_exact',a.rf) FROM u a),
  'clubs', (SELECT coalesce(jsonb_object_agg(a.club_id::text, jsonb_build_object('games',a.games,'cash_games',a.cash_games,'mtt_games',a.mtt_games,
     'tournament_games',a.tournament_games,'hands',a.hands,
     'fee_exact',a.fee,'cash_fee_exact',a.cf,'mtt_fee_exact',a.mf,'tournament_fee_exact',a.tf,'fee',round(a.fee,2),'cash_fee',round(a.cf,2),'mtt_fee',round(a.mf,2),'tournament_fee',round(a.tf,2),
     'total_winnings',round(a.win+a.felt,2),
     'cash_winnings',round(a.cw+a.felt,2),'mtt_winnings',round(a.mw,2),'tournament_winnings',round(a.tw,2),
     'running_mtt_entries',round(a.rw,2),'running_mtt_fee',round(a.rf,2),'running_mtt_fee_exact',a.rf)),'{}'::jsonb) FROM pc a),
  'data_updated_at', (SELECT max(s.last_at) FROM s));
$windows$
     INTO v
    USING p_clubs, p_start, p_end, p_per_club;
  RETURN v;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_rake_windows_v3(uuid[],date,date,boolean) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
