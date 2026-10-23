-- 20261022165130_club_data_and_union_data_read_each_window_once.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- CLUB DATA AND UNION DATA READ EACH WINDOW ONCE (2026-10-22)
--
-- Full account: docs/changelog/2026-10-22-club-data-and-union-data-read-each-window-once.md
--
-- Measured on production after 20261022134523 (read-only; every probe a DO
-- block ended by RAISE):
--
--   ca_club_data_snapshot_v2 (Club Data, 414 calls, mean 4.7 s; the top lock
--   holder on the hot tables, in 96 of 150 pg_locks samples):
--     ca_club_game_page_core_20261006, the page's 100 rows   4.5 to 5.9 s
--       ranks every game of the window (208,000 for The Felt Society's
--       fortnight) through tournaments to pick the newest 100
--     ca_club_data_screen x2 (summary only)                   1.1 + 0.8 s
--       the MTT split joined 200,000 tournament fact rows to tournaments
--     fn_ca_club_data_hand_count, union                       timed out
--       LANGUAGE sql planned with unknown parameters: a bitmap of every raked
--       hand in the window once per eligible table
--   ca_rake_snapshot_v2, Midway Union, month to date         12 to 31 s
--     fn_ca_rake_by_club_v2: the window once per club         13.5 to 19.3 s
--     fn_ca_rake_window_v2 (current, previous)               4.9 s, 2.3 s
--       GROUP BY (kind, game) spilled to disk at the default work_mem
--     fn_ca_rake_series_v2: every per-player fact row          4.0 s
--
-- WHAT CHANGES. Every figure, row, order and contract is unchanged.
--  1. fn_ca_rake_windows_v3 reads a window's per-game rows once: sums per
--     club, the union's games and every club's games from one distinct pass
--     (each game carries its clubs as bits), MTTs from tournaments by key.
--     fn_ca_rake_window_v2 is its 'all'; fn_ca_rake_by_club_v2 lists its
--     'clubs' through fn_ca_rake_by_club_from (the old listing, verbatim);
--     ca_rake_snapshot_v2 computes the union's window and every club's once.
--  2. fn_ca_rake_series_v2 sums ca_club_data_game_ct (the per-player facts
--     summed per game by the same statement; equal per club and day to the
--     digit on production, 138 club-days).
--  3. fn_ca_club_data_hand_count is the same query planned with its values.
--  4. ca_club_data_screen's unfiltered totals and MTT split read the per-game
--     rows when no downline filter applies (equal on production for all
--     1,066,121 club, day, game and kind keys, last_at included).
--  5. ca_club_data_snapshot_v2's rows come from fn_ca_club_game_recent_rows:
--     the newest tournaments walked down idx_tournaments_start_time, kept when
--     the club played them, merged with every cash table, described by the
--     page core's own detail query. It answers NULL unless it can prove its
--     rows are the page's (its last tournament is newer than the 20,000th
--     newest start), and the page core is then read as before.
--
-- Report-only: no money table, rule or row is touched; no table, index or
-- trigger is created. Day basis, MTT split, scope, authorization and every
-- response shape are unchanged. Every replaced function is pinned by md5 to
-- its live text; the two it calls are pinned too. Qualified natively by
-- scripts/ci/test-club-data-reads-each-window-once.py, which installs every
-- Club Data migration in order and compares every reader's output before and
-- after this one.
--
-- @live-proof: to_regprocedure('public.fn_ca_rake_windows_v3(uuid[],date,date,boolean)') IS NOT NULL
-- @live-proof: position('fn_ca_club_game_recent_rows' IN pg_get_functiondef('public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer)'::regprocedure))>0
-- @live-proof: position('force_custom_plan' IN pg_get_functiondef('public.fn_ca_club_data_hand_count(uuid,date,date,text,text,text)'::regprocedure))>0

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE r record; v_actual text;
BEGIN
  IF current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'club data migration requires the maintained installer';
  END IF;
  IF to_regprocedure('public.fn_ca_rake_windows_v3(uuid[],date,date,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'Club Data window reader already installed';
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('public.ca_club_data_screen(uuid,date,date,text,text,text,integer)', '33922bec7a85906e3a3925aeb269d0ce'),
    ('public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer)', '01dde673050f62c1290ad3b74a138c4c'),
    -- The same two readers after 20261022200354 (installed 2026-10-22 20:03 UTC
    -- from PR #7725): only its date-range probes and latest-day data_updated_at
    -- differ (reverting those edits on production gives the two pins above).
    ('public.ca_club_data_screen(uuid,date,date,text,text,text,integer)', '56f842f8cedd067d8ea1543939c3a89d'),
    ('public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer)', 'd096a7f7b602f60e0bf7510385eeb2aa'),
    ('public.ca_club_game_page_core_20261006(uuid,date,date,text,text,text,text,jsonb,integer)', '7f788701d61ae1a2137b8fe4d0f532a2'),
    ('public.ca_rake_snapshot_v2(text,uuid,uuid,date,date,uuid,integer,integer,text,text)', 'f9d7e19f531145a8aea60af103aa95ed'),
    ('public.fn_ca_club_data_hand_count(uuid,date,date,text,text,text)', '81e9ebcdd7cce5ff2d08b858f9ce25d8'),
    ('public.fn_ca_rake_by_club_v2(uuid[],date,date,integer,integer,text,text)', '135f2c29ffd5ed7ad0440add76577fbd'),
    ('public.fn_ca_rake_window_v2(uuid[],date,date)', '29d518cdc9d32b7f923c758f569c9dc5'),
    ('public.fn_ca_rake_series_v2(uuid[],date,date,text)', '0c0f44a3b1626605af48d347b65b6499'),
    ('public.fn_ca_rake_felt_v2(uuid[],date,date)', '958e2544fe5818426b489072adc7f3d3'),
    ('public.fn_ca_club_data_clubs(uuid)', '6f4a0c250357251b86b2756f11423389')
  ) v(sig, pin) LOOP
    v_actual := md5(pg_get_functiondef(r.sig::regprocedure));
    IF v_actual IS DISTINCT FROM r.pin AND NOT EXISTS (
         SELECT 1 FROM (VALUES
           ('public.ca_club_data_screen(uuid,date,date,text,text,text,integer)', '33922bec7a85906e3a3925aeb269d0ce', '56f842f8cedd067d8ea1543939c3a89d'),
           ('public.ca_club_data_screen(uuid,date,date,text,text,text,integer)', '56f842f8cedd067d8ea1543939c3a89d', '33922bec7a85906e3a3925aeb269d0ce'),
           ('public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer)', '01dde673050f62c1290ad3b74a138c4c', 'd096a7f7b602f60e0bf7510385eeb2aa'),
           ('public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer)', 'd096a7f7b602f60e0bf7510385eeb2aa', '01dde673050f62c1290ad3b74a138c4c')
         ) a(sig, pin, alt) WHERE a.sig = r.sig AND a.pin = r.pin AND a.alt = v_actual) THEN
      RAISE EXCEPTION 'Club Data reader preimage changed: % (md5 %)', r.sig, v_actual;
    END IF;
  END LOOP;
END $guard$;

CREATE FUNCTION public.fn_ca_rake_windows_v3(p_clubs uuid[], p_start date, p_end date, p_per_club boolean)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET work_mem TO '256MB'
AS $function$
 /* EVERY WINDOW OF A UNION FROM ONE PASS (20261022165130).

    fn_ca_rake_window_v2 grouped every per-game row of the window into games
    (spilling to disk at the default work_mem: 8.7 s for Midway's month), and
    Union Data then read the same rows again once per member club (13.5 s for
    the month). Here they are read once: sums per club, the union's games and
    every club's games from one distinct pass (each game carries the clubs
    that played it as bits), the MTTs from tournaments by key. 'all' is
    fn_ca_rake_window_v2(p_clubs), field for field; with p_per_club, 'clubs'
    holds fn_ca_rake_window_v2(ARRAY[club]) for every distinct club of p_clubs.
    'data_updated_at' is the newest last_at of the rows read.

    A window's games are its distinct (kind, game) rows plus the cash tables
    still seated that have no cash row of their own: counted as the distinct
    rows plus the seated tables missing from them, which is the size of their
    UNION. */
 WITH ids AS (SELECT DISTINCT unnest(p_clubs) AS club_id),
 ord AS MATERIALIZED (
  SELECT array_agg(i.club_id ORDER BY i.club_id) a, p_per_club AND count(*) <= 62 AS masked,
         p_per_club AND count(*) > 62 AS wide
    FROM ids i
 ), r AS NOT MATERIALIZED (
  SELECT d.club_id, d.kind, d.game_id, d.fee, d.winnings, d.last_at FROM public.ca_club_data_game_ct d
   WHERE d.club_id = ANY (p_clubs) AND d.stat_date BETWEEN p_start AND p_end
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
    FROM (SELECT DISTINCT r.kind, r.game_id FROM r WHERE NOT p_per_club) x HAVING NOT p_per_club
 ), ccash AS MATERIALIZED (
  -- Every club's cash tables (a few thousand), and the union's.
  SELECT o.club_id, z.game_id FROM z CROSS JOIN LATERAL unnest((SELECT x.a FROM ord x)) WITH ORDINALITY o(club_id, i)
   WHERE z.kind='CASH' AND z.mask & (1::bigint << (o.i::int - 1)) <> 0
  UNION ALL
  SELECT y.club_id, y.game_id FROM cg y WHERE y.kind='CASH'
  UNION ALL
  SELECT DISTINCT NULL::uuid, r.game_id FROM r WHERE NOT p_per_club AND r.kind='CASH'
 ), felt AS MATERIALIZED (SELECT * FROM public.fn_ca_rake_felt_v2(p_clubs, p_start, p_end)
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
   WHERE p_per_club AND NOT EXISTS (SELECT 1 FROM ccash x WHERE x.club_id=f.club_id AND x.game_id=f.table_id)
   GROUP BY f.club_id
 ), mtt AS MATERIALIZED (
  SELECT d.club_id, d.game_id, sum(d.fee) fee, sum(d.winnings) winnings,
         bool_or(COALESCE(tr.status IN ('COMPLETED','CANCELLED'),false)) finished
    FROM public.tournaments tr JOIN public.ca_club_data_game_ct d ON d.game_id=tr.id AND d.kind='TOURNAMENT'
         AND d.club_id = ANY (p_clubs) AND d.stat_date BETWEEN p_start AND p_end
   WHERE tr.tournament_type='MTT' GROUP BY d.club_id, d.game_id
 ), hands_one AS MATERIALIZED (
  SELECT c.club_id, coalesce(sum(c.hands),0)::bigint n FROM public.ca_club_data_hands_ct c
   WHERE c.club_id = ANY (p_clubs) AND c.stat_date BETWEEN p_start AND p_end GROUP BY c.club_id
 ), u AS (
  SELECT
   coalesce((SELECT g.n FROM ugc g),0) + (SELECT e.n FROM uextra e) games,
   coalesce((SELECT g.nc FROM ugc g),0) + (SELECT e.n FROM uextra e) cash_games,
   (SELECT count(DISTINCT m.game_id) FROM mtt m) mtt_games,
   coalesce((SELECT g.nt FROM ugc g),0) tournament_games,
   CASE WHEN cardinality(p_clubs)>1 THEN
    (SELECT count(*) FROM public.rake_records rr WHERE rr.created_at>=p_start::timestamp AT TIME ZONE 'America/Chicago' AND rr.created_at<(p_end+1)::timestamp AT TIME ZONE 'America/Chicago'
      AND rr.tournament_id IS NULL AND rr.is_tournament IS NOT TRUE AND rr.rake_amount>0
      AND EXISTS(SELECT 1 FROM public.ca_club_data_hands_ct c WHERE c.club_id=ANY(p_clubs) AND c.stat_date BETWEEN p_start AND p_end AND c.table_id=rr.table_id))
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
  WHERE p_per_club
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
$function$;

CREATE FUNCTION public.fn_ca_rake_by_club_from(p_clubs uuid[], p_windows jsonb, p_limit integer, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'rake'::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 WITH ids AS(SELECT DISTINCT unnest(p_clubs) id),
 listed AS(SELECT c.id club_id,c.name,c.code,coalesce(c.avatar_url,c.logo_url) avatar_url,
 (w.s->>'fee_exact')::numeric fee,(w.s->>'cash_fee_exact')::numeric cash_fee,(w.s->>'mtt_fee_exact')::numeric mtt_fee,(w.s->>'tournament_fee_exact')::numeric tournament_fee,
 (w.s->>'total_winnings')::numeric winnings,(w.s->>'hands')::bigint hands,(w.s->>'games')::bigint games,public.ca_can_read_club_production(c.id) can_drill
 FROM ids JOIN public.clubs c ON c.id=ids.id CROSS JOIN LATERAL(SELECT p_windows->(c.id::text) s) w),
 filtered AS(SELECT * FROM listed WHERE nullif(btrim(coalesce(p_search,'')),'') IS NULL OR name ILIKE '%'||public.fn_like_escape(btrim(p_search))||'%' ESCAPE '\' OR coalesce(code,'') ILIKE '%'||public.fn_like_escape(btrim(p_search))||'%' ESCAPE '\'),
 page AS(SELECT * FROM filtered ORDER BY CASE WHEN p_sort='name' THEN name END,CASE WHEN p_sort='hands' THEN hands END DESC,CASE WHEN p_sort NOT IN('name','hands') THEN fee END DESC,name,club_id OFFSET greatest(coalesce(p_offset,0),0) LIMIT greatest(least(coalesce(p_limit,50),200),1))
 SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM page p),'[]'::jsonb),'total',(SELECT count(*) FROM filtered),'total_direct',(SELECT round(coalesce(sum(fee),0),2) FROM listed),'total_commission',NULL);
$function$;

CREATE FUNCTION public.fn_ca_club_game_recent_rows(p_club_id uuid, p_start date, p_end date, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit integer := GREATEST(LEAST(COALESCE(p_limit,100),200),1);
  v_bound timestamptz;
  v_out jsonb;
BEGIN
  /* THE NEWEST GAMES, READ NEWEST FIRST (20261022165130).

     ca_club_data_snapshot_v2 shows the unfiltered game page's rows in its
     'recent' order: newest start first (a cash table's created_at, a
     tournament's start_time), then kind, then id. ca_club_game_page_core
     ranks every game of the window to pick them, which for a large club is
     200,000 tournaments read from tournaments every call (4 to 6 s). Here the
     tournaments are walked newest first down idx_tournaments_start_time,
     keeping those this club played in the window, and they stop at the
     page's size: the top of every game is the top of the cash tables (read
     whole, as before) and the top tournaments.

     The walk goes no further than the 20,000th newest start ($10), and reads
     the reporting clubs once ($11, fn_ca_club_data_clubs) rather than once
     per tournament walked. When the
     page's last tournament is newer than that bound every tournament that
     could outrank it was walked, and the rows are the page's rows exactly;
     otherwise this answers NULL and the caller reads the page as before.
     Every row is described by the page's own detail query; for a union the
     raked hands are counted for the page's cash tables only, by the same
     filter as the page's union_hands. The caller has authorized the viewer
     (ca_can_view_whole_club_report). */
  SELECT tr.start_time INTO v_bound FROM public.tournaments tr
   WHERE tr.start_time IS NOT NULL ORDER BY tr.start_time DESC OFFSET 20000 LIMIT 1;
  v_bound := COALESCE(v_bound, '-infinity'::timestamptz);

  EXECUTE $query$
    WITH felt AS MATERIALIZED (SELECT * FROM public.fn_ca_club_cash_felt($1,$2,$3,$4,$5,$6)), raw_cash AS (
      SELECT c.table_id,SUM(c.rake) fee,SUM(c.net) winnings,SUM(c.hands)::bigint hands
        FROM (SELECT g.game_id AS table_id,g.fee AS rake,g.winnings AS net,0::bigint AS hands
                FROM public.ca_club_data_game_ct g
               WHERE g.kind='CASH' AND g.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND g.stat_date BETWEEN $2 AND $3
              UNION ALL
              SELECT h.table_id,0,0,h.hands
                FROM public.ca_club_data_hands_ct h
               WHERE h.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND h.stat_date BETWEEN $2 AND $3) c
       GROUP BY c.table_id
    ), cash AS (
      SELECT coalesce(c.table_id,f.table_id) table_id,coalesce(c.fee,0) fee,
             coalesce(c.winnings,0)+coalesce(f.felt,0) winnings,coalesce(f.felt,0) on_felt,coalesce(c.hands,0)::bigint hands,
             coalesce(f.seated,0)::integer seated
        FROM raw_cash c FULL JOIN felt f ON f.table_id=c.table_id
    ), tour_top AS MATERIALIZED (
      SELECT tr.id,tr.start_time,tr.tournament_type
        FROM public.tournaments tr
       WHERE tr.start_time >= $10
         AND EXISTS (SELECT 1 FROM public.ca_club_data_game_ct d
                      WHERE d.kind='TOURNAMENT' AND d.club_id = ANY ($11)
                        AND d.game_id=tr.id AND d.stat_date BETWEEN $2 AND $3)
       ORDER BY tr.start_time DESC,
                CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN'
                     WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END DESC,
                tr.id::text DESC
       LIMIT $9
    ), keys AS MATERIALIZED (
      -- The ranking set carries the four sort keys and NOTHING the page does
      -- not filter on. Every other column is presentation, it is needed for at
      -- most $9 rows, and carrying it here is what spilled 42 MB to disk three
      -- times per read.
      SELECT 'CASH'::text kind,t.id::text id,
             CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%'
                        OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                  WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%'
                        OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                  ELSE 'HOLDEM' END game_class,
             CASE WHEN COALESCE(t.big_blind,0)<1 THEN 'MICRO'
                  WHEN COALESCE(t.big_blind,0)<5 THEN 'SMALL'
                  WHEN COALESCE(t.big_blind,0)<25 THEN 'MID' ELSE 'HIGH' END stakes_tier,
             COALESCE(t.name,'Unnamed') name,COALESCE(pr.username,'') creator_name,
             CASE $7 WHEN 'fee' THEN round(c.fee,2)
                     WHEN 'winnings' THEN round(c.winnings,2)
                     WHEN 'hands' THEN c.hands::numeric
                     ELSE extract(epoch FROM COALESCE(t.created_at,'0001-01-01'::timestamptz))::numeric
              END sort_value,
             extract(epoch FROM COALESCE(t.created_at,'0001-01-01'::timestamptz))::numeric sort_time
        FROM cash c JOIN public.tables t ON t.id=c.table_id
        LEFT JOIN public.profiles pr ON pr.id=t.created_by
      UNION ALL
      SELECT CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN'
                  WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,
             tr.id::text,
             CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN' WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,
             'NA',
             NULL::text,''::text,
             extract(epoch FROM COALESCE(tr.start_time,'0001-01-01'::timestamptz))::numeric,
             extract(epoch FROM COALESCE(tr.start_time,'0001-01-01'::timestamptz))::numeric
        FROM tour_top tr
    ), visible AS MATERIALIZED (
      SELECT * FROM keys
       ORDER BY sort_value DESC,sort_time DESC,kind DESC,id DESC LIMIT $9
    ), visible_hands AS MATERIALIZED (
      -- The page's union_hands, for the page's cash tables only.
      SELECT r.table_id,count(*)::bigint hands
        FROM public.rake_records r
       WHERE EXISTS(SELECT 1 FROM public.unions u WHERE u.id=$1)
         AND r.created_at>=$2::timestamp AT TIME ZONE 'America/Chicago' AND r.created_at<($3+1)::timestamp AT TIME ZONE 'America/Chicago'
         AND r.tournament_id IS NULL AND r.is_tournament IS NOT TRUE AND r.rake_amount>0
         AND r.table_id IN (SELECT DISTINCT h.table_id FROM public.ca_club_data_hands_ct h
                             WHERE h.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND h.stat_date BETWEEN $2 AND $3)
         AND r.table_id::text IN (SELECT v.id FROM visible v WHERE v.kind='CASH')
       GROUP BY r.table_id
    ), detail AS (
      -- Presentation, for the <=$9 rows that survived the LIMIT and no others.
      SELECT v.kind,v.id,CASE WHEN v.kind='CASH' THEN v.name ELSE COALESCE(tr.name,'Tournament') END name,
             v.game_class,v.stakes_tier,v.creator_name,
             v.sort_value,v.sort_time,
             CASE WHEN v.kind='CASH' THEN UPPER(COALESCE(t.game_variant,'nlh'))
                  ELSE UPPER(COALESCE(tr.variant,tr.game_type,'nlh')) END variant,
             CASE WHEN v.kind='CASH' THEN COALESCE(t.small_blind,0) ELSE 0::numeric END small_blind,
             CASE WHEN v.kind='CASH' THEN COALESCE(t.big_blind,0) ELSE 0::numeric END big_blind,
             CASE WHEN v.kind='CASH' AND COALESCE(t.rake_percent,-1)>=0 THEN t.rake_percent END rake_percent,
             CASE WHEN v.kind='CASH' THEN t.created_at ELSE tr.start_time END started_at,
             CASE WHEN v.kind='CASH' THEN t.created_by END created_by,
             CASE WHEN v.kind='CASH' THEN t.status ELSE tr.status END status,
             CASE WHEN v.kind='CASH' THEN round(c.fee,2) ELSE round(COALESCE(f.fee,0),2) END fee,
             CASE WHEN v.kind='CASH' THEN c.fee ELSE coalesce(f.fee,0) END fee_exact,
             CASE WHEN v.kind='CASH' THEN round(c.winnings,2) ELSE round(COALESCE(f.winnings,0),2) END winnings,
             CASE WHEN v.kind='CASH' THEN CASE WHEN EXISTS(SELECT 1 FROM public.unions u WHERE u.id=$1) THEN coalesce(vh.hands,0)::bigint ELSE c.hands END ELSE 0::bigint END hands,
             CASE WHEN v.kind='CASH' THEN coalesce(c.on_felt,0) ELSE 0 END on_felt,
             CASE WHEN v.kind='CASH' THEN coalesce(c.on_felt,0)>0 ELSE tr.status='RUNNING' END live,
             CASE WHEN v.kind='CASH' THEN greatest(COALESCE(cp.players,0),COALESCE(c.seated,0))::integer ELSE COALESCE(tp.players,0)::integer END players,
             CASE WHEN v.kind='CASH' THEN pr.avatar_url END creator_avatar
        FROM visible v
        LEFT JOIN cash c ON v.kind='CASH' AND c.table_id=v.id::uuid
        LEFT JOIN public.tables t ON v.kind='CASH' AND t.id=v.id::uuid
        LEFT JOIN visible_hands vh ON v.kind='CASH' AND vh.table_id=v.id::uuid
        LEFT JOIN public.profiles pr ON v.kind='CASH' AND pr.id=t.created_by
        LEFT JOIN public.tournaments tr ON v.kind<>'CASH' AND tr.id=v.id::uuid
        -- The same rows tournament_facts summed for a visible tournament, and
        -- its players in the same window, each read through its own
        -- (club_id, tournament_id, ...) key for the <=$9 visible rows only.
        LEFT JOIN LATERAL (
          SELECT SUM(d.fee) fee,SUM(d.winnings) winnings
            FROM public.ca_club_data_game_ct d
           WHERE v.kind<>'CASH' AND d.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND d.game_id=v.id::uuid
             AND d.stat_date BETWEEN $2 AND $3
        ) f ON true
        LEFT JOIN LATERAL (
          SELECT count(DISTINCT p.user_id)::integer players
            FROM public.ca_club_data_fact_ct p
           WHERE v.kind<>'CASH' AND p.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND p.game_id=v.id::uuid
             AND p.stat_date BETWEEN $2 AND $3 AND p.user_id<>'00000000-0000-0000-0000-000000000000'::uuid
        ) tp ON true
        LEFT JOIN LATERAL (
          SELECT count(DISTINCT z.user_id)::integer players
            FROM public.ca_club_data_fact_ct z
           WHERE v.kind='CASH' AND z.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND z.stat_date BETWEEN $2 AND $3
             AND z.kind='CASH' AND z.game_id=v.id::uuid AND z.user_id<>'00000000-0000-0000-0000-000000000000'::uuid
        ) cp ON true
    )
    SELECT CASE WHEN (SELECT count(*) FROM tour_top) = $9 AND (SELECT min(t.start_time) FROM tour_top t) > $10 THEN
      COALESCE((SELECT jsonb_agg(jsonb_build_object(

        'kind',q.kind,'id',q.id,'name',q.name,'variant',q.variant,
        'game_class',q.game_class,'stakes_tier',q.stakes_tier,
        'blinds',CASE WHEN q.big_blind>0 THEN
          trim(trailing '.' from trim(trailing '0' from q.small_blind::text))||'/'||
          trim(trailing '.' from trim(trailing '0' from q.big_blind::text)) END,
        'rake_percent',q.rake_percent,'started_at',q.started_at,'status',q.status,
        'creator_id',q.created_by,'creator_name',NULLIF(q.creator_name,''),
        'creator_avatar',q.creator_avatar,'fee',q.fee,'fee_exact',q.fee_exact,'winnings',q.winnings,
        'hands',q.hands,'players',q.players,'on_felt',q.on_felt,'live',q.live)
        ORDER BY q.sort_value DESC,q.sort_time DESC,q.kind DESC,q.id DESC) FROM detail q),'[]'::jsonb) END
  $query$ INTO v_out
  USING p_club_id,p_start,p_end,'ALL'::text,'ALL'::text,NULL::text,'recent'::text,NULL::jsonb,v_limit,v_bound,
        public.fn_ca_club_data_clubs(p_club_id);

  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_rake_window_v2(p_clubs uuid[], p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 -- 20261022165130: the same window, read by fn_ca_rake_windows_v3 in one pass.
 SELECT public.fn_ca_rake_windows_v3(p_clubs, p_start, p_end, false)->'all';
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_club_v2(p_clubs uuid[], p_start date, p_end date, p_limit integer, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'rake'::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 -- 20261022165130: every club's window from one pass (fn_ca_rake_windows_v3),
 -- listed exactly as before (fn_ca_rake_by_club_from).
 SELECT public.fn_ca_rake_by_club_from(p_clubs, public.fn_ca_rake_windows_v3(p_clubs, p_start, p_end, true)->'clubs', p_limit, p_offset, p_search, p_sort);
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_rake_series_v2(p_clubs uuid[], p_start date, p_end date, p_bucket text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 WITH rows AS(SELECT d.stat_date d,d.fee,d.winnings FROM public.ca_club_data_game_ct d WHERE d.club_id=ANY(p_clubs) AND d.stat_date BETWEEN p_start AND p_end
 UNION ALL SELECT stat_date,0,felt FROM public.fn_ca_rake_felt_v2(p_clubs,p_start,p_end)),
 agg AS(SELECT date_trunc(CASE WHEN p_bucket IN('day','week','month') THEN p_bucket ELSE 'day' END,d::timestamp)::date bucket,sum(fee) fee,sum(winnings) winnings FROM rows GROUP BY 1)
 SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY bucket),'[]'::jsonb) FROM agg a;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_data_hand_count(p_club_id uuid, p_start date, p_end date, p_game text, p_stakes text, p_search text)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
BEGIN
 -- 20261022165130: the same query, planned with its values. As a LANGUAGE sql
 -- SECURITY DEFINER function it was planned with unknown parameters, and for
 -- a union the planner built a bitmap of every raked hand in the window once
 -- per eligible table (930 tables a week): the Club Data screen of a union
 -- timed out. Planned with the values it is one hash join over the window.
 RETURN (
 WITH eligible AS (
  SELECT DISTINCT d.table_id FROM public.ca_club_data_hands_ct d
   JOIN public.tables t ON t.id=d.table_id LEFT JOIN public.profiles pr ON pr.id=t.created_by
  WHERE d.club_id=ANY(public.fn_ca_club_data_clubs(p_club_id)) AND d.stat_date BETWEEN p_start AND p_end
    AND (p_game='ALL' OR p_game=CASE WHEN coalesce(t.game_variant,'') ILIKE '%plo%' OR coalesce(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA' WHEN coalesce(t.game_variant,'') ILIKE '%mixed%' OR coalesce(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED' ELSE 'HOLDEM' END)
    AND (p_stakes='ALL' OR p_stakes=CASE WHEN coalesce(t.big_blind,0)<1 THEN 'MICRO' WHEN coalesce(t.big_blind,0)<5 THEN 'SMALL' WHEN coalesce(t.big_blind,0)<25 THEN 'MID' ELSE 'HIGH' END)
    AND (p_search IS NULL OR t.name ILIKE '%'||p_search||'%' OR t.id::text ILIKE '%'||p_search||'%' OR pr.username ILIKE '%'||p_search||'%')
 )
 SELECT CASE WHEN EXISTS(SELECT 1 FROM public.unions WHERE id=p_club_id) THEN
  (SELECT count(*) FROM public.rake_records r JOIN eligible e ON e.table_id=r.table_id
    WHERE r.created_at>=p_start::timestamp AT TIME ZONE 'America/Chicago' AND r.created_at<(p_end+1)::timestamp AT TIME ZONE 'America/Chicago'
      AND r.tournament_id IS NULL AND r.is_tournament IS NOT TRUE AND r.rake_amount>0)
 ELSE (SELECT coalesce(sum(d.hands),0)::bigint FROM public.ca_club_data_hands_ct d JOIN eligible e ON e.table_id=d.table_id
   WHERE d.club_id=p_club_id AND d.stat_date BETWEEN p_start AND p_end) END);
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_rake_snapshot_v2(p_scope text DEFAULT 'club'::text, p_club_id uuid DEFAULT NULL::uuid, p_union_id uuid DEFAULT NULL::uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_agent_user_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'rake'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '20s'
 SET work_mem TO '64MB'
AS $function$
DECLARE
  v_scope text := lower(COALESCE(NULLIF(btrim(p_scope),''),'club'));
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_end date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start date := COALESCE(p_start, v_end - 6);
  v_off int := GREATEST(COALESCE(p_offset,0),0);
  v_q text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := lower(COALESCE(NULLIF(btrim(p_sort),''),'rake'));
  v_days int; v_pstart date; v_pend date; v_bucket text;
  v_union uuid; v_clubs uuid[];
  v_cur jsonb; v_prev jsonb; v_series jsonb;
  v_pack jsonb := jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0);
  v_kind text := 'none'; v_label text;
  v_agent jsonb; v_agent_p jsonb; v_live boolean := false;
  v_w jsonb;
BEGIN
  IF v_scope NOT IN ('club','union','agent') THEN
    RAISE EXCEPTION 'unknown scope %', v_scope USING ERRCODE='22023'; END IF;
  IF v_start < v_end - 730 THEN v_start := v_end - 730; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  v_days := (v_end - v_start) + 1; v_pend := v_start - 1; v_pstart := v_pend - (v_days - 1);
  v_bucket := CASE WHEN v_days <= 62 THEN 'day' WHEN v_days <= 400 THEN 'week' ELSE 'month' END;

  IF v_scope = 'agent' THEN
    IF p_club_id IS NULL THEN RAISE EXCEPTION 'agent scope needs a club' USING ERRCODE='22023'; END IF;
    v_agent := public.fn_agent_downline_rake_summary(p_agent_user_id, p_club_id,
      (v_start::timestamp AT TIME ZONE 'America/Chicago'), ((v_end+1)::timestamp AT TIME ZONE 'America/Chicago'));
    v_agent_p := public.fn_agent_downline_rake_summary(p_agent_user_id, p_club_id,
      (v_pstart::timestamp AT TIME ZONE 'America/Chicago'), ((v_pend+1)::timestamp AT TIME ZONE 'America/Chicago'));
    IF v_sort NOT IN ('rake','name','hands') THEN v_sort := 'rake'; END IF;
    v_pack := public.fn_ca_rake_by_downline(p_agent_user_id, p_club_id,
      (v_start::timestamp AT TIME ZONE 'America/Chicago'), ((v_end+1)::timestamp AT TIME ZONE 'America/Chicago'),
      p_limit, v_off, v_q, v_sort);
    SELECT COALESCE(c.name,'Club') INTO v_label FROM public.clubs c WHERE c.id = p_club_id;
    RETURN jsonb_build_object(
      'scope','agent','scope_label',COALESCE(v_label,'Downline'),'club_id',p_club_id,
      'union_id',NULL,'agent_user_id',p_agent_user_id,
      'range',jsonb_build_object('start',v_start,'end',v_end,'days',v_days),
      'previous_range',jsonb_build_object('start',v_pstart,'end',v_pend,'days',v_days),
      'summary',jsonb_build_object(
        'fee',round(COALESCE((v_agent->>'rake_generated')::numeric,0),2),
        'cash_fee',NULL,'mtt_fee',NULL,'games',NULL,
        'hands',COALESCE((v_agent->>'hands')::bigint,0),
        'total_winnings',NULL,'mtt_winnings',NULL,'running_mtt_entries',NULL,
        'members',COALESCE((v_agent->>'members')::int,0),
        'active',COALESCE((v_agent->>'active')::int,0),
        'commission_rate',(v_agent->>'commission_rate')::numeric,
        'estimated_commission',round(COALESCE((v_agent->>'estimated_commission')::numeric,0),2)),
      'previous',jsonb_build_object('fee',round(COALESCE((v_agent_p->>'rake_generated')::numeric,0),2),
        'hands',COALESCE((v_agent_p->>'hands')::bigint,0)),
      'delta',jsonb_build_object(
        'fee_pct',CASE WHEN COALESCE((v_agent_p->>'rake_generated')::numeric,0)=0 THEN NULL
          ELSE round((COALESCE((v_agent->>'rake_generated')::numeric,0)-(v_agent_p->>'rake_generated')::numeric)
               /abs((v_agent_p->>'rake_generated')::numeric)*100,1) END,
        'fee_abs',round(COALESCE((v_agent->>'rake_generated')::numeric,0)-COALESCE((v_agent_p->>'rake_generated')::numeric,0),2),
        'games_pct',NULL,'winnings_abs',NULL),
      'series','[]'::jsonb,'series_bucket',v_bucket,
      'breakdown',v_pack->'rows','breakdown_kind','downline',
      'breakdown_total',(v_pack->>'total_direct')::numeric,
      'breakdown_count',(v_pack->>'total')::int,
      'breakdown_offset',v_off,'commission_total',(v_pack->>'total_commission')::numeric,
      'breakdown_live',true,'rake_complete_through',NULL,
      'applied_search',v_q,'applied_sort',v_sort,
      'top_earner',v_agent->'top_earner','accounting_basis','chicago_net_money_flow','day_basis','America/Chicago','generated_at',now());
  END IF;

  IF v_scope = 'union' THEN
    v_union := p_union_id;
    IF v_union IS NULL AND p_club_id IS NOT NULL THEN
      SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id=p_club_id LIMIT 1; END IF;
    IF v_union IS NULL THEN RAISE EXCEPTION 'no union for this context' USING ERRCODE='22023'; END IF;
    IF NOT public.ca_can_oversee_union(v_union) THEN
      RAISE EXCEPTION 'not authorized for this union' USING ERRCODE='42501'; END IF;
    v_clubs:=public.fn_ca_club_data_clubs(v_union);
    SELECT u.name INTO v_label FROM public.unions u WHERE u.id=v_union;
    IF v_sort NOT IN ('rake','name','hands') THEN v_sort := 'rake'; END IF;
    -- 20261022165130: the clubs' windows and the union's from one pass.
    v_w := public.fn_ca_rake_windows_v3(v_clubs, v_start, v_end, true);
    v_pack := public.fn_ca_rake_by_club_from(v_clubs, v_w->'clubs', p_limit, v_off, v_q, v_sort);
    v_cur := v_w->'all';
    v_kind := 'club'; v_live := false;
  ELSE
    IF p_club_id IS NULL THEN RAISE EXCEPTION 'club scope needs a club' USING ERRCODE='22023'; END IF;
    IF NOT public.ca_can_read_whole_club_production(p_club_id) THEN
      RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
    v_clubs := ARRAY[p_club_id];
    SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id=p_club_id LIMIT 1;
    SELECT c.name INTO v_label FROM public.clubs c WHERE c.id=p_club_id;
    IF v_sort NOT IN ('rake','name','cost','players') THEN v_sort := 'rake'; END IF;
    v_pack := public.fn_ca_rake_by_agent(p_club_id, v_start, v_end, p_limit, v_off, v_q, v_sort);
    v_kind := 'agent'; v_live := true;
  END IF;

  IF v_clubs IS NULL OR array_length(v_clubs,1) IS NULL THEN v_clubs := ARRAY[]::uuid[]; END IF;

  IF v_cur IS NULL THEN v_cur := public.fn_ca_rake_window_v2(v_clubs, v_start, v_end); END IF;
  v_prev := public.fn_ca_rake_window_v2(v_clubs, v_pstart, v_pend);
  v_series := public.fn_ca_rake_series_v2(v_clubs, v_start, v_end, v_bucket);

  RETURN jsonb_build_object(
    'scope',v_scope,'scope_label',COALESCE(v_label,initcap(v_scope)),
    'club_id',p_club_id,'union_id',v_union,'club_count',CASE WHEN v_scope='union' THEN (SELECT count(DISTINCT uc.club_id) FROM public.union_clubs uc WHERE uc.union_id=v_union) ELSE array_length(v_clubs,1) END,
    'range',jsonb_build_object('start',v_start,'end',v_end,'days',v_days),
    'previous_range',jsonb_build_object('start',v_pstart,'end',v_pend,'days',v_days),
    'summary',v_cur,'previous',v_prev,
    'delta',jsonb_build_object(
      'fee_pct',CASE WHEN COALESCE((v_prev->>'fee')::numeric,0)=0 THEN NULL
        ELSE round(((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric)/abs((v_prev->>'fee')::numeric)*100,1) END,
      'games_pct',CASE WHEN COALESCE((v_prev->>'games')::numeric,0)=0 THEN NULL
        ELSE round(((v_cur->>'games')::numeric-(v_prev->>'games')::numeric)/abs((v_prev->>'games')::numeric)*100,1) END,
      'fee_abs',round((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric,2),
      'winnings_abs',round((v_cur->>'total_winnings')::numeric-(v_prev->>'total_winnings')::numeric,2)),
    'series',v_series,'series_bucket',v_bucket,
    'breakdown',v_pack->'rows','breakdown_kind',v_kind,
    'breakdown_total',(v_pack->>'total_direct')::numeric,
    'breakdown_count',(v_pack->>'total')::int,
    'breakdown_offset',v_off,'commission_total',(v_pack->>'total_commission')::numeric,
    'breakdown_live',v_live,'rake_complete_through',NULL,
    'applied_search',v_q,'applied_sort',v_sort,
    'data_updated_at',CASE WHEN v_w IS NOT NULL THEN (v_w->>'data_updated_at')::timestamptz ELSE (SELECT max(g.last_at) FROM public.ca_club_data_game_ct g
        WHERE g.club_id = ANY(v_clubs) AND g.stat_date BETWEEN v_start AND v_end) END,
    'accounting_basis','chicago_net_money_flow','day_basis','America/Chicago','generated_at',now());
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_data_snapshot_v2(p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date:=(now() AT TIME ZONE 'America/Chicago')::date;
  v_end date:=LEAST(COALESCE(p_end,v_today),v_today);
  v_start date:=COALESCE(p_start,v_end-13); v_days int; v_pstart date; v_pend date;
  v_game text:=UPPER(COALESCE(NULLIF(p_game,''),'ALL'));
  v_stakes text:=UPPER(COALESCE(NULLIF(p_stakes,''),'ALL'));
  v_q text:=NULLIF(btrim(COALESCE(p_search,'')),'');
  v_lim int:=GREATEST(LEAST(COALESCE(p_limit,100),500),1);
  v_union uuid; v_cur jsonb; v_prev jsonb; v_rows jsonb;
  v_felt numeric; v_pfelt numeric; v_felt_rows jsonb;
BEGIN
  IF NOT public.ca_can_view_whole_club_report(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501'; END IF;
  IF v_start<v_end-92 THEN v_start:=v_end-92; END IF;
  IF v_start>v_end THEN v_start:=v_end; END IF;
  v_days:=(v_end-v_start)+1; v_pend:=v_start-1; v_pstart:=v_pend-(v_days-1);
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id=p_club_id LIMIT 1;
  v_cur:=public.ca_club_data_screen(p_club_id,v_start,v_end,v_game,v_stakes,v_q,1)->'summary';
  v_prev:=public.ca_club_data_screen(p_club_id,v_pstart,v_pend,v_game,v_stakes,v_q,1)->'summary';
  -- 20261022134523: the same hand count fn_ca_club_game_summary returns for
  -- these normalized arguments, read directly instead of through two more
  -- full screens.
  v_cur:=v_cur||jsonb_build_object('hands',coalesce(public.fn_ca_club_data_hand_count(p_club_id,v_start,v_end,v_game,v_stakes,v_q),0));
  v_prev:=v_prev||jsonb_build_object('hands',coalesce(public.fn_ca_club_data_hand_count(p_club_id,v_pstart,v_pend,v_game,v_stakes,v_q),0));
  -- 20261022165130: the unfiltered page's rows are the newest games; read them
  -- by walking the newest tournaments (fn_ca_club_game_recent_rows) instead of
  -- ranking every game of the window. It answers NULL when the walk cannot
  -- prove its rows are the page's, and the page is then read as before.
  IF v_game='ALL' AND v_stakes='ALL' AND v_q IS NULL THEN
    v_rows:=public.fn_ca_club_game_recent_rows(p_club_id,v_start,v_end,v_lim);
  END IF;
  IF v_rows IS NULL THEN
    v_rows:=public.ca_club_game_page_core_20261006(p_club_id,v_start,v_end,v_game,v_stakes,v_q,'recent',NULL,v_lim)->'rows';
  END IF;
  IF EXISTS(SELECT 1 FROM public.unions u WHERE u.id=p_club_id) THEN v_union:=p_club_id; END IF;
  RETURN jsonb_build_object(
    'range',jsonb_build_object('start',v_start,'end',v_end,'days',v_days),
    'previous_range',jsonb_build_object('start',v_pstart,'end',v_pend,'days',v_days),
    'filters',jsonb_build_object('game',v_game,'stakes',v_stakes,'search',v_q),
    'summary',v_cur,'previous',v_prev,'delta',jsonb_build_object(
      'fee_pct',CASE WHEN COALESCE((v_prev->>'fee')::numeric,0)=0 THEN NULL ELSE round(((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric)/abs((v_prev->>'fee')::numeric)*100,1) END,
      'games_pct',CASE WHEN COALESCE((v_prev->>'games')::numeric,0)=0 THEN NULL ELSE round(((v_cur->>'games')::numeric-(v_prev->>'games')::numeric)/abs((v_prev->>'games')::numeric)*100,1) END,
      'winnings_abs',round((v_cur->>'total_winnings')::numeric-(v_prev->>'total_winnings')::numeric,2),
      'fee_abs',round((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric,2)),
    'rows',v_rows,'row_count',(v_cur->>'games')::int,'union_id',v_union,
    'data_updated_at',(SELECT max(x.m) FROM unnest(public.fn_ca_club_data_clubs(p_club_id)) c(id)
       CROSS JOIN LATERAL (SELECT max(g.last_at) m FROM public.ca_club_data_game_ct g
         WHERE g.club_id = c.id AND g.stat_date = (SELECT max(d.stat_date) FROM public.ca_club_data_game_ct d
           WHERE d.club_id = c.id AND d.stat_date BETWEEN v_start AND v_end)) x),
    'accounting_basis','chicago_net_money_flow','day_basis','America/Chicago',
    'generated_at',now());
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_data_screen(p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET work_mem TO '64MB'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_end date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start date := COALESCE(p_start, v_end);
  v_game text := UPPER(COALESCE(NULLIF(p_game, ''), 'ALL'));
  v_stakes text := UPPER(COALESCE(NULLIF(p_stakes, ''), 'ALL'));
  v_q text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_lim int := GREATEST(LEAST(COALESCE(p_limit, 200), 500), 1);
  v_scope text := public.fn_ca_club_data_scope(p_club_id);
  v_attrs boolean;
  v_mtt_win numeric; v_mtt_fee numeric; v_run_win numeric; v_run_fee numeric;
  v_users uuid[];
  v_role text;
  v_club_name text;
  v_union uuid;
  v_facts_from date;
  v_sum jsonb;
  v_rows jsonb;
  v_days date[];
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_games bigint; v_cash_fee numeric; v_tour_fee numeric; v_cash_win numeric; v_tour_win numeric;
  v_felt_ids uuid[]; v_felt_amt numeric[]; v_felt_seated int[]; v_felt_sum numeric;
  v_live_t uuid[]; v_cands uuid[]; v_need int; v_day date;
BEGIN
  IF v_scope IS NULL THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;
  IF v_start < v_end - 92 THEN v_start := v_end - 92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  IF v_scope = 'downline' THEN
    v_users := public.fn_ca_club_data_downline(p_club_id, auth.uid());
  END IF;
  -- Tournament attributes for every game only when a filter reads them.
  v_attrs := v_game IN ('MTT', 'SNG') OR v_q IS NOT NULL;
  SELECT c.name INTO v_club_name FROM public.clubs c WHERE c.id = p_club_id;
  SELECT cm.role INTO v_role FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = auth.uid()
   ORDER BY public.fn_club_role_rank(cm.role) DESC LIMIT 1;
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc WHERE uc.club_id = p_club_id LIMIT 1;
  IF EXISTS(SELECT 1 FROM public.unions u WHERE u.id=p_club_id) THEN v_union:=p_club_id; END IF;
  v_facts_from := public.fn_ca_club_data_facts_from();
  v_days := ARRAY(SELECT gs::date FROM generate_series(v_start, v_end, interval '1 day') gs);

  IF v_game = 'ALL' AND v_stakes = 'ALL' AND v_q IS NULL THEN
    -- THE PLAIN SCREEN (20261017221938). Measured on production at 22:20 UTC,
    -- Club JAQK, 14 days: 3.79 s through the one-query form below, because
    -- the totals grouped 450,000 fact rows into 248,000 games to pick 200 of
    -- them, and the per-game player count was planned as a range scan per
    -- game. Here:
    --   * the totals are one aggregate over the window, never grouped by game;
    --   * the page's rows are chosen from the most recent days first - every
    --     fact's last_at falls on its own stat_date, so a game seen on a later
    --     day outranks every game seen only earlier, and the order is exact;
    --   * only those rows are totalled, counted and described, by exact
    --     (club, day, game) lookups.
    SELECT array_agg(x.table_id), array_agg(x.felt), array_agg(x.seated), COALESCE(SUM(x.felt), 0)
      INTO v_felt_ids, v_felt_amt, v_felt_seated, v_felt_sum
      FROM (
        -- Chips still in front of this club's seated players: part of the
        -- result, not a loss. The seat's own club, as the money was.
        SELECT s.table_id, SUM(s.stack) AS felt, count(*)::int AS seated
          FROM public.table_seats s
          JOIN public.tables t ON t.id = s.table_id AND t.tournament_id IS NULL
         WHERE s.left_at IS NULL AND s.user_id IS NOT NULL
           AND COALESCE(s.status, 'active') <> 'left' AND COALESCE(s.stack, 0) > 0
           AND (s.joined_at AT TIME ZONE 'America/Chicago')::date BETWEEN v_start AND v_end
           AND COALESCE(s.club_id, public.fn_ca_cash_reporting_club(t.union_id, t.club_id, s.user_id)) = ANY (public.fn_ca_club_data_clubs(p_club_id))
           AND (v_users IS NULL OR s.user_id = ANY (v_users))
         GROUP BY s.table_id) x;
    v_felt_ids := COALESCE(v_felt_ids, ARRAY[]::uuid[]);

    -- 20261022165130: without a downline filter the totals are the per-game
    -- rows' (ca_club_data_game_ct is ca_club_data_fact_ct summed over players,
    -- written by the same statement): a third of the rows, the same sums and
    -- the same games.
    IF v_users IS NULL THEN
    SELECT count(DISTINCT d.game_id),
           COALESCE(SUM(d.fee) FILTER (WHERE d.kind = 'CASH'), 0),
           COALESCE(SUM(d.fee) FILTER (WHERE d.kind <> 'CASH'), 0),
           COALESCE(SUM(d.winnings) FILTER (WHERE d.kind = 'CASH'), 0),
           COALESCE(SUM(d.winnings) FILTER (WHERE d.kind <> 'CASH'), 0)
      INTO v_games, v_cash_fee, v_tour_fee, v_cash_win, v_tour_win
      FROM public.ca_club_data_game_ct d
     WHERE d.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND d.stat_date BETWEEN v_start AND v_end;
    ELSE
    SELECT count(DISTINCT d.game_id),
           COALESCE(SUM(d.fee) FILTER (WHERE d.kind = 'CASH'), 0),
           COALESCE(SUM(d.fee) FILTER (WHERE d.kind <> 'CASH'), 0),
           COALESCE(SUM(d.winnings) FILTER (WHERE d.kind = 'CASH'), 0),
           COALESCE(SUM(d.winnings) FILTER (WHERE d.kind <> 'CASH'), 0)
      INTO v_games, v_cash_fee, v_tour_fee, v_cash_win, v_tour_win
      FROM public.ca_club_data_fact_ct d
     WHERE d.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND d.stat_date BETWEEN v_start AND v_end
       AND (v_users IS NULL OR d.user_id = ANY (v_users));
    END IF;
    -- 20261022120121: MTT Winnings are FINISHED MTTs only (tournaments.status
    -- COMPLETED or CANCELLED); every other MTT's entries and payouts so far are
    -- Running MTT Entries. Both stay inside tournament_winnings, so
    -- total = cash + tournament still holds.
    -- 20261022165130: without a downline filter, from the MTTs (6,000 in all)
    -- to their per-game rows by key, instead of every tournament row of the
    -- window to tournaments (200,000 probes a fortnight for a large club).
    IF v_users IS NULL THEN
    SELECT coalesce(sum(d.winnings) FILTER (WHERE COALESCE(tr.status IN ('COMPLETED','CANCELLED'),false)),0),
           coalesce(sum(d.fee) FILTER (WHERE COALESCE(tr.status IN ('COMPLETED','CANCELLED'),false)),0),
           coalesce(sum(d.winnings) FILTER (WHERE NOT COALESCE(tr.status IN ('COMPLETED','CANCELLED'),false)),0),
           coalesce(sum(d.fee) FILTER (WHERE NOT COALESCE(tr.status IN ('COMPLETED','CANCELLED'),false)),0)
      INTO v_mtt_win,v_mtt_fee,v_run_win,v_run_fee
      FROM public.tournaments tr JOIN public.ca_club_data_game_ct d ON d.game_id=tr.id AND d.kind='TOURNAMENT'
           AND d.club_id=ANY(public.fn_ca_club_data_clubs(p_club_id)) AND d.stat_date BETWEEN v_start AND v_end
     WHERE tr.tournament_type='MTT';
    ELSE
    SELECT coalesce(sum(d.winnings) FILTER (WHERE COALESCE(tr.status IN ('COMPLETED','CANCELLED'),false)),0),
           coalesce(sum(d.fee) FILTER (WHERE COALESCE(tr.status IN ('COMPLETED','CANCELLED'),false)),0),
           coalesce(sum(d.winnings) FILTER (WHERE NOT COALESCE(tr.status IN ('COMPLETED','CANCELLED'),false)),0),
           coalesce(sum(d.fee) FILTER (WHERE NOT COALESCE(tr.status IN ('COMPLETED','CANCELLED'),false)),0)
      INTO v_mtt_win,v_mtt_fee,v_run_win,v_run_fee
      FROM public.ca_club_data_fact_ct d JOIN public.tournaments tr ON tr.id=d.game_id AND tr.tournament_type='MTT'
     WHERE d.club_id=ANY(public.fn_ca_club_data_clubs(p_club_id)) AND d.stat_date BETWEEN v_start AND v_end
       AND d.kind='TOURNAMENT' AND (v_users IS NULL OR d.user_id=ANY(v_users));
    END IF;
    -- A seated table with no fact in the window is still a game on the screen.
    v_games := v_games + (SELECT count(*) FROM unnest(v_felt_ids) ft(id)
      WHERE NOT EXISTS (SELECT 1 FROM public.ca_club_data_fact_ct f
                         WHERE f.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND f.stat_date BETWEEN v_start AND v_end AND f.game_id = ft.id
                           AND (v_users IS NULL OR f.user_id = ANY (v_users))));

    -- Running tournaments this club (or this agent's downline) played in.
    v_live_t := ARRAY(
      SELECT tr.id FROM public.tournaments tr
       WHERE tr.status = 'RUNNING'
         AND EXISTS (SELECT 1 FROM public.ca_club_data_fact_ct f
                      WHERE f.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND f.stat_date BETWEEN v_start AND v_end AND f.game_id = tr.id
                        AND (v_users IS NULL OR f.user_id = ANY (v_users))));

    -- The page: every live game, then the most recently active, newest day first.
    v_cands := v_felt_ids || v_live_t;
    v_need := v_lim;
    FOR v_day IN SELECT u.d FROM unnest(v_days) u(d) ORDER BY u.d DESC LOOP
      v_cands := v_cands || ARRAY(
        SELECT f.game_id FROM public.ca_club_data_fact_ct f
         WHERE f.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND f.stat_date = v_day
           AND (v_users IS NULL OR f.user_id = ANY (v_users))
           AND NOT (f.game_id = ANY (v_cands))
         GROUP BY f.game_id ORDER BY max(f.last_at) DESC LIMIT v_need);
      v_need := v_lim - (cardinality(v_cands) - cardinality(v_felt_ids) - cardinality(v_live_t));
      EXIT WHEN v_need <= 0;
    END LOOP;

    WITH c AS (
      SELECT f.kind, f.game_id, SUM(f.fee) AS fee, SUM(f.winnings) AS winnings, max(f.last_at) AS activity_at,
             count(DISTINCT f.user_id) FILTER (WHERE f.user_id <> v_zero) AS players
        FROM public.ca_club_data_fact_ct f
       WHERE f.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND f.stat_date BETWEEN v_start AND v_end AND f.game_id = ANY (v_cands)
         AND (v_users IS NULL OR f.user_id = ANY (v_users))
       GROUP BY f.kind, f.game_id
    ), fe AS (
      SELECT x.table_id, x.felt, x.seated
        FROM unnest(v_felt_ids, COALESCE(v_felt_amt, ARRAY[]::numeric[]), COALESCE(v_felt_seated, ARRAY[]::int[])) AS x(table_id, felt, seated)
    ), rows_ AS (
      SELECT COALESCE(c.kind, 'CASH') AS k, COALESCE(c.game_id, fe.table_id) AS game_id,
             COALESCE(c.fee, 0) AS fee, COALESCE(c.winnings, 0) + COALESCE(fe.felt, 0) AS winnings,
             COALESCE(c.activity_at, now()) AS activity_at,
             (fe.table_id IS NOT NULL OR (c.kind = 'TOURNAMENT' AND c.game_id = ANY (v_live_t))) AS live,
             fe.seated, fe.felt AS on_felt, COALESCE(c.players, 0) AS players
        FROM c FULL JOIN fe ON fe.table_id = c.game_id
    ), top AS (
      SELECT * FROM rows_ ORDER BY live DESC, activity_at DESC NULLS LAST, k, game_id LIMIT v_lim
    ), described AS (
      SELECT CASE WHEN tp.k = 'CASH' THEN 'CASH'
                  WHEN tr.tournament_type = 'SPIN' THEN 'SPIN'
                  WHEN tr.tournament_type = 'SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END AS kind,
             tp.game_id::text AS id,
             CASE WHEN tp.k = 'CASH' THEN COALESCE(t.name, 'Unnamed') ELSE COALESCE(tr.name, 'Tournament') END AS name,
             CASE WHEN tp.k = 'CASH' THEN UPPER(COALESCE(t.game_variant, 'nlh'))
                  ELSE UPPER(COALESCE(tr.variant, tr.game_type, 'nlh')) END AS variant,
             CASE WHEN tp.k = 'CASH' THEN
                    CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                         WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                         ELSE 'HOLDEM' END
                  WHEN tr.tournament_type = 'SPIN' THEN 'SPIN' WHEN tr.tournament_type = 'SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END AS game_class,
             CASE WHEN tp.k <> 'CASH' THEN 'NA'
                  WHEN COALESCE(t.big_blind,0) < 1 THEN 'MICRO'
                  WHEN COALESCE(t.big_blind,0) < 5 THEN 'SMALL'
                  WHEN COALESCE(t.big_blind,0) < 25 THEN 'MID' ELSE 'HIGH' END AS stakes_tier,
             CASE WHEN tp.k = 'CASH' AND COALESCE(t.big_blind,0) > 0 THEN
               trim(trailing '.' from trim(trailing '0' from COALESCE(t.small_blind,0)::text)) || '/' ||
               trim(trailing '.' from trim(trailing '0' from t.big_blind::text)) END AS blinds,
             CASE WHEN tp.k = 'CASH' THEN t.created_at ELSE tr.start_time END AS started_at,
             CASE WHEN tp.k = 'CASH' THEN t.status ELSE tr.status END AS status,
             CASE WHEN tp.k = 'CASH' THEN COALESCE(pr.username, '') ELSE '' END AS creator_name,
             round(tp.fee, 2) AS fee, round(tp.winnings, 2) AS winnings,
             GREATEST(tp.players, COALESCE(tp.seated, 0))::int AS players,
             tp.activity_at, tp.live, tp.seated, round(tp.on_felt, 2) AS on_felt, tp.k
        FROM top tp
        LEFT JOIN public.tables t ON tp.k = 'CASH' AND t.id = tp.game_id
        LEFT JOIN public.profiles pr ON pr.id = t.created_by
        LEFT JOIN public.tournaments tr ON tp.k = 'TOURNAMENT' AND tr.id = tp.game_id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'kind', kind, 'id', id, 'name', name, 'variant', variant,
             'game_class', game_class, 'stakes_tier', stakes_tier, 'blinds', blinds,
             'started_at', started_at, 'activity_at', activity_at, 'status', status,
             'creator_name', NULLIF(creator_name, ''), 'fee', COALESCE(fee, 0),
             'winnings', COALESCE(winnings, 0), 'players', COALESCE(players, 0),
             'live', live, 'seated', seated, 'on_felt', on_felt)
             ORDER BY live DESC, activity_at DESC NULLS LAST, k, id), '[]'::jsonb)
      INTO v_rows FROM described;

    v_sum := jsonb_build_object(
      'games', v_games,
      'total_winnings', round(v_cash_win + v_tour_win + v_felt_sum, 2),
      'mtt_winnings', round(v_mtt_win, 2), 'tournament_winnings', round(v_tour_win,2),
      'running_mtt_entries', round(v_run_win, 2), 'running_mtt_fee', round(v_run_fee, 2),
      'cash_winnings', round(v_cash_win + v_felt_sum, 2),
      'fee', round(v_cash_fee + v_tour_fee, 2),
      'cash_fee', round(v_cash_fee, 2),
      'mtt_fee', round(v_mtt_fee, 2), 'tournament_fee', round(v_tour_fee,2),
      'on_felt', round(v_felt_sum, 2),
      'live_games', cardinality(v_felt_ids) + cardinality(v_live_t));

    RETURN jsonb_build_object(
      'range', jsonb_build_object('start', v_start, 'end', v_end, 'days', (v_end - v_start) + 1),
      'filters', jsonb_build_object('game', v_game, 'stakes', v_stakes, 'search', v_q),
      'scope', v_scope, 'reporting_scope', CASE WHEN v_union=p_club_id THEN 'union' ELSE 'club' END, 'reporting_club_count', cardinality(public.fn_ca_club_data_clubs(p_club_id)), 'accounting_basis', 'chicago_net_money_flow', 'day_basis', 'America/Chicago', 'viewer_role', v_role, 'club_name', v_club_name, 'facts_from', v_facts_from,
      'summary', v_sum, 'rows', v_rows, 'row_count', (v_sum->>'games')::int,
      'union_id', v_union, 'generated_at', now());
  END IF;

  -- A FILTERED SCREEN (a game class, stakes, or a search): every game's
  -- attributes are read, as before; the players are counted for the page's
  -- rows by exact (club, day, game) lookups.

  WITH g AS MATERIALIZED (
    SELECT d.kind, d.game_id, SUM(d.fee) AS fee, SUM(d.winnings) AS winnings, max(d.last_at) AS activity_at
      FROM public.ca_club_data_fact_ct d
     WHERE d.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND d.stat_date BETWEEN v_start AND v_end
       AND (v_users IS NULL OR d.user_id = ANY (v_users))
       AND (v_game = 'ALL'
            OR (v_game IN ('HOLDEM', 'OMAHA', 'MIXED') AND d.kind = 'CASH')
            OR (v_game IN ('MTT', 'SNG') AND d.kind = 'TOURNAMENT'))
       AND (v_stakes = 'ALL' OR d.kind = 'CASH')
     GROUP BY d.kind, d.game_id
  ), felt AS MATERIALIZED (
    -- Chips still in front of this club's seated players: part of the result,
    -- not a loss. The seat's own club, as the money was.
    SELECT s.table_id, SUM(s.stack) AS felt, count(*)::int AS seated
      FROM public.table_seats s
      JOIN public.tables t ON t.id = s.table_id AND t.tournament_id IS NULL
     WHERE s.left_at IS NULL AND s.user_id IS NOT NULL
       AND COALESCE(s.status, 'active') <> 'left' AND COALESCE(s.stack, 0) > 0
       AND (s.joined_at AT TIME ZONE 'America/Chicago')::date BETWEEN v_start AND v_end
       AND COALESCE(s.club_id, public.fn_ca_cash_reporting_club(t.union_id, t.club_id, s.user_id)) = ANY (public.fn_ca_club_data_clubs(p_club_id))
       AND (v_users IS NULL OR s.user_id = ANY (v_users))
       AND v_game IN ('ALL', 'HOLDEM', 'OMAHA', 'MIXED')
     GROUP BY s.table_id
  ), running AS MATERIALIZED (
    SELECT tr.id FROM public.tournaments tr WHERE tr.status = 'RUNNING'
  ), cash AS (
    -- Cash games are few; every one is described.
    SELECT t.id AS game_id, COALESCE(t.name, 'Unnamed') AS name,
           CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                ELSE 'HOLDEM' END AS game_class,
           CASE WHEN COALESCE(t.big_blind,0) < 1 THEN 'MICRO'
                WHEN COALESCE(t.big_blind,0) < 5 THEN 'SMALL'
                WHEN COALESCE(t.big_blind,0) < 25 THEN 'MID' ELSE 'HIGH' END AS stakes_tier,
           COALESCE(pr.username, '') AS creator_name,
           COALESCE(gg.fee, 0) AS fee,
           COALESCE(gg.winnings, 0) + COALESCE(fe.felt, 0) AS winnings,
           COALESCE(gg.activity_at, now()) AS activity_at,
           (fe.felt IS NOT NULL) AS live, fe.seated, fe.felt AS on_felt
      FROM (SELECT * FROM g WHERE g.kind = 'CASH') gg
      FULL JOIN felt fe ON fe.table_id = gg.game_id
      JOIN public.tables t ON t.id = COALESCE(gg.game_id, fe.table_id)
      LEFT JOIN public.profiles pr ON pr.id = t.created_by
  ), tour AS (
    SELECT g.game_id, g.fee, g.winnings, g.activity_at,
           (g.game_id IN (SELECT r.id FROM running r)) AS live
      FROM g WHERE g.kind = 'TOURNAMENT'
  ), tour_described AS (
    -- Read only when a filter needs it: v_attrs is a one-time filter, so the
    -- tournaments join is never executed for the plain screen.
    SELECT tu.*, COALESCE(tr.name, 'Tournament') AS name,
           CASE WHEN tr.tournament_type = 'SPIN' THEN 'SPIN' WHEN tr.tournament_type = 'SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END AS game_class
      FROM tour tu JOIN public.tournaments tr ON tr.id = tu.game_id
     WHERE v_attrs
  ), filtered AS (
    SELECT 'CASH'::text AS k, c.game_id, c.fee, c.winnings, c.activity_at, c.live, c.seated, c.on_felt
      FROM cash c
     WHERE (v_game = 'ALL' OR c.game_class = v_game)
       AND (v_stakes = 'ALL' OR c.stakes_tier = v_stakes)
       AND (v_q IS NULL OR c.name ILIKE '%' || v_q || '%' OR c.game_id::text ILIKE '%' || v_q || '%'
            OR c.creator_name ILIKE '%' || v_q || '%')
    UNION ALL
    SELECT 'TOURNAMENT', tu.game_id, tu.fee, tu.winnings, tu.activity_at, tu.live, NULL::int, NULL::numeric
      FROM tour tu WHERE NOT v_attrs
    UNION ALL
    SELECT 'TOURNAMENT', td.game_id, td.fee, td.winnings, td.activity_at, td.live, NULL::int, NULL::numeric
      FROM tour_described td
     WHERE v_attrs
       AND (v_game = 'ALL' OR td.game_class = v_game)
       AND (v_q IS NULL OR td.name ILIKE '%' || v_q || '%' OR td.game_id::text ILIKE '%' || v_q || '%')
  ), summary AS (
    SELECT jsonb_build_object(
      'games', count(*),
      'total_winnings', round(COALESCE(SUM(winnings), 0), 2),
      'mtt_winnings', round(COALESCE(SUM(winnings) FILTER (WHERE k = 'TOURNAMENT' AND EXISTS(SELECT 1 FROM public.tournaments mt WHERE mt.id=filtered.game_id AND mt.tournament_type='MTT' AND COALESCE(mt.status IN ('COMPLETED','CANCELLED'),false))), 0), 2),
      'running_mtt_entries', round(COALESCE(SUM(winnings) FILTER (WHERE k = 'TOURNAMENT' AND EXISTS(SELECT 1 FROM public.tournaments mt WHERE mt.id=filtered.game_id AND mt.tournament_type='MTT' AND NOT COALESCE(mt.status IN ('COMPLETED','CANCELLED'),false))), 0), 2),
      'running_mtt_fee', round(COALESCE(SUM(fee) FILTER (WHERE k = 'TOURNAMENT' AND EXISTS(SELECT 1 FROM public.tournaments mt WHERE mt.id=filtered.game_id AND mt.tournament_type='MTT' AND NOT COALESCE(mt.status IN ('COMPLETED','CANCELLED'),false))), 0), 2),
      'cash_winnings', round(COALESCE(SUM(winnings) FILTER (WHERE k = 'CASH'), 0), 2),
      'fee', round(COALESCE(SUM(fee), 0), 2),
      'cash_fee', round(COALESCE(SUM(fee) FILTER (WHERE k = 'CASH'), 0), 2),
      'mtt_fee', round(COALESCE(SUM(fee) FILTER (WHERE k = 'TOURNAMENT' AND EXISTS(SELECT 1 FROM public.tournaments mt WHERE mt.id=filtered.game_id AND mt.tournament_type='MTT' AND COALESCE(mt.status IN ('COMPLETED','CANCELLED'),false))),0),2), 'tournament_fee',round(COALESCE(SUM(fee) FILTER(WHERE k <> 'CASH'),0),2), 'tournament_winnings',round(COALESCE(SUM(winnings) FILTER(WHERE k <> 'CASH'),0),2),
      'on_felt', round(COALESCE(SUM(on_felt), 0), 2),
      'live_games', count(*) FILTER (WHERE live)) AS s
      FROM filtered
  ), top AS MATERIALIZED (
    SELECT * FROM filtered ORDER BY live DESC, activity_at DESC NULLS LAST, k, game_id LIMIT v_lim
  ), pl AS (
    SELECT f.game_id, count(DISTINCT f.user_id) AS n
      FROM public.ca_club_data_fact_ct f
     WHERE f.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND f.stat_date BETWEEN v_start AND v_end
       AND f.user_id <> '00000000-0000-0000-0000-000000000000'::uuid
       AND (v_users IS NULL OR f.user_id = ANY (v_users))
       AND f.game_id IN (SELECT tp.game_id FROM top tp)
     GROUP BY f.game_id
  ), described AS (
    SELECT CASE WHEN tp.k = 'CASH' THEN 'CASH'
                WHEN tr.tournament_type = 'SPIN' THEN 'SPIN'
                WHEN tr.tournament_type = 'SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END AS kind,
           tp.game_id::text AS id,
           CASE WHEN tp.k = 'CASH' THEN COALESCE(t.name, 'Unnamed') ELSE COALESCE(tr.name, 'Tournament') END AS name,
           CASE WHEN tp.k = 'CASH' THEN UPPER(COALESCE(t.game_variant, 'nlh'))
                ELSE UPPER(COALESCE(tr.variant, tr.game_type, 'nlh')) END AS variant,
           CASE WHEN tp.k = 'CASH' THEN
                  CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
                       WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
                       ELSE 'HOLDEM' END
                WHEN tr.tournament_type = 'SPIN' THEN 'SPIN' WHEN tr.tournament_type = 'SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END AS game_class,
           CASE WHEN tp.k <> 'CASH' THEN 'NA'
                WHEN COALESCE(t.big_blind,0) < 1 THEN 'MICRO'
                WHEN COALESCE(t.big_blind,0) < 5 THEN 'SMALL'
                WHEN COALESCE(t.big_blind,0) < 25 THEN 'MID' ELSE 'HIGH' END AS stakes_tier,
           CASE WHEN tp.k = 'CASH' AND COALESCE(t.big_blind,0) > 0 THEN
             trim(trailing '.' from trim(trailing '0' from COALESCE(t.small_blind,0)::text)) || '/' ||
             trim(trailing '.' from trim(trailing '0' from t.big_blind::text)) END AS blinds,
           CASE WHEN tp.k = 'CASH' THEN t.created_at ELSE tr.start_time END AS started_at,
           CASE WHEN tp.k = 'CASH' THEN t.status ELSE tr.status END AS status,
           CASE WHEN tp.k = 'CASH' THEN COALESCE(pr.username, '') ELSE '' END AS creator_name,
           round(tp.fee, 2) AS fee, round(tp.winnings, 2) AS winnings,
           GREATEST(COALESCE(pl.n, 0), COALESCE(tp.seated, 0))::int AS players,
           tp.activity_at, tp.live, tp.seated, round(tp.on_felt, 2) AS on_felt, tp.k
      FROM top tp
      LEFT JOIN public.tables t ON tp.k = 'CASH' AND t.id = tp.game_id
      LEFT JOIN public.profiles pr ON pr.id = t.created_by
      LEFT JOIN public.tournaments tr ON tp.k = 'TOURNAMENT' AND tr.id = tp.game_id
      LEFT JOIN pl ON pl.game_id = tp.game_id
  )
  SELECT (SELECT s FROM summary),
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
           'kind', kind, 'id', id, 'name', name, 'variant', variant,
           'game_class', game_class, 'stakes_tier', stakes_tier, 'blinds', blinds,
           'started_at', started_at, 'activity_at', activity_at, 'status', status,
           'creator_name', NULLIF(creator_name, ''), 'fee', COALESCE(fee, 0),
           'winnings', COALESCE(winnings, 0), 'players', COALESCE(players, 0),
           'live', live, 'seated', seated, 'on_felt', on_felt)
           ORDER BY live DESC, activity_at DESC NULLS LAST, k, id) FROM described), '[]'::jsonb)
    INTO v_sum, v_rows;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('start', v_start, 'end', v_end, 'days', (v_end - v_start) + 1),
    'filters', jsonb_build_object('game', v_game, 'stakes', v_stakes, 'search', v_q),
    'scope', v_scope, 'reporting_scope', CASE WHEN v_union=p_club_id THEN 'union' ELSE 'club' END, 'reporting_club_count', cardinality(public.fn_ca_club_data_clubs(p_club_id)), 'accounting_basis', 'chicago_net_money_flow', 'day_basis', 'America/Chicago',
    'viewer_role', v_role,
    'club_name', v_club_name,
    'facts_from', v_facts_from,
    'summary', v_sum,
    'rows', v_rows,
    'row_count', (v_sum->>'games')::int,
    'union_id', v_union,
    'generated_at', now());
END;
$function$;

-- The new readers are internal (called by SECURITY DEFINER readers only).
REVOKE ALL ON FUNCTION public.fn_ca_rake_windows_v3(uuid[],date,date,boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_rake_by_club_from(uuid[],jsonb,integer,integer,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_club_game_recent_rows(uuid,date,date,integer) FROM PUBLIC, anon, authenticated, service_role;
-- The grants are the installed ones, restated.
REVOKE ALL ON FUNCTION public.fn_ca_rake_window_v2(uuid[],date,date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_rake_by_club_v2(uuid[],date,date,integer,integer,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_rake_series_v2(uuid[],date,date,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_hand_count(uuid,date,date,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_rake_snapshot_v2(text,uuid,uuid,date,date,uuid,integer,integer,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_rake_snapshot_v2(text,uuid,uuid,date,date,uuid,integer,integer,text,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_club_data_screen(uuid,date,date,text,text,text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_data_screen(uuid,date,date,text,text,text,integer) TO authenticated, service_role;

COMMIT;
