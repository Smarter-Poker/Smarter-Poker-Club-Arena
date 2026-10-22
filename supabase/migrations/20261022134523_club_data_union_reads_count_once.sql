-- 20261022134523_club_data_union_reads_count_once.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- UNION DATA AND THE UNION GAME PAGE COUNT EACH THING ONCE
--
-- Measured on production right after 20261022120121 installed (2026-10-22,
-- as the Midway Union owner, figures rolled back):
--
--   ca_rake_snapshot_v2, union, 7 days          31.2 s   (statement timeout territory)
--   fn_ca_rake_by_club_v2, the per-club list    25.1 s of that
--   fn_ca_rake_window_v2, union, month to date  11.4 s
--   ca_club_game_page, union, 14 days           timed out
--
-- Three causes, all older than the Chicago change and all in reading, not in
-- the figures:
--
-- 1. fn_ca_rake_by_club_v2 reads four fields of fn_ca_rake_window_v2(club)
--    through a LATERAL the planner flattens, so the window ran four times per
--    club: 14.4 s flattened, 3.5 s with OFFSET 0 (same five clubs, same week).
-- 2. fn_ca_rake_window_v2 joined every tournament fact row (500,000 SNG and
--    Spin rows a month for Midway) to tournaments to find the MTTs. It now sums
--    per game from ca_club_data_game_ct and finds the MTTs from tournaments
--    (6,321 MTTs in all): union month to date 11.4 s -> 2.7 s, union week
--    3.7 s -> 3.0 s, Deep Stack month 2.8 s -> 0.6 s, every figure equal.
-- 3. The union game page and both game lists called
--    fn_ca_club_data_hand_count once per cash table (1,528 tables in a union
--    fortnight, ~250 ms each). They now count the union's raked hands per
--    table in one grouped pass over the same rake_records rows.
--
-- And the report snapshot read its hand counts through fn_ca_club_game_summary,
-- which runs a whole ca_club_data_screen just to pass the hand count through;
-- it now calls fn_ca_club_data_hand_count with the same normalized arguments.
--
-- Every figure is unchanged (pinned on real Postgres by
-- scripts/ci/test-club-data-union-mtt-postgres.py, which compares every
-- reader's output before and after this migration). Report-only; no money
-- table, rule or row is touched. Every replaced function is pinned by md5.
--
-- @live-proof: position('ca_club_data_game_ct' IN pg_get_functiondef('public.fn_ca_rake_window_v2(uuid[],date,date)'::regprocedure))>0
-- @live-proof: position('union_hands AS MATERIALIZED' IN pg_get_functiondef('public.ca_club_game_page_core_20261006(uuid,date,date,text,text,text,text,jsonb,integer)'::regprocedure))>0

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
  IF current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'club data migration requires the maintained installer';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_rake_window_v2(uuid[],date,date)'::regprocedure)) IS DISTINCT FROM '9ccbf658176adacb5ee28d3b9978d8ed' THEN
    RAISE EXCEPTION 'Club Data reader preimage changed: fn_ca_rake_window_v2';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_rake_by_club_v2(uuid[],date,date,integer,integer,text,text)'::regprocedure)) IS DISTINCT FROM '76d1f094f50ef072a45ea6dd1fe4dcdb' THEN
    RAISE EXCEPTION 'Club Data reader preimage changed: fn_ca_rake_by_club_v2';
  END IF;
  IF md5(pg_get_functiondef('public.ca_club_game_page_core_20261006(uuid,date,date,text,text,text,text,jsonb,integer)'::regprocedure)) IS DISTINCT FROM '4d7e358a8cf7fcfad54ad4b9369c7f81' THEN
    RAISE EXCEPTION 'Club Data reader preimage changed: ca_club_game_page_core_20261006';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_club_games_searched(uuid,date,date,text,text,text)'::regprocedure)) IS DISTINCT FROM '45605d189e66e8fd7f33e83f300a5b84' THEN
    RAISE EXCEPTION 'Club Data reader preimage changed: fn_ca_club_games_searched';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_club_games_unsearched(uuid,date,date,text,text)'::regprocedure)) IS DISTINCT FROM '65907e23abbe4d37819916aa0f63de28' THEN
    RAISE EXCEPTION 'Club Data reader preimage changed: fn_ca_club_games_unsearched';
  END IF;
  IF md5(pg_get_functiondef('public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer)'::regprocedure)) IS DISTINCT FROM 'db0e975c1641c2ee81fc9c2749dee646' THEN
    RAISE EXCEPTION 'Club Data reader preimage changed: ca_club_data_snapshot_v2';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_ca_rake_window_v2(p_clubs uuid[], p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 -- 20261022134523: summed per game first (ca_club_data_game_ct), and the MTTs
 -- found from tournaments (6k MTTs) instead of joining every tournament fact
 -- (500k SNG and Spin rows a month) to tournaments to find them.
 WITH g AS MATERIALIZED (
 SELECT d.kind,d.game_id,sum(d.fee) fee,sum(d.winnings) winnings FROM public.ca_club_data_game_ct d
 WHERE d.club_id=ANY(p_clubs) AND d.stat_date BETWEEN p_start AND p_end GROUP BY d.kind,d.game_id
 ), mtt AS MATERIALIZED (
 SELECT d.game_id,sum(d.fee) fee,sum(d.winnings) winnings,bool_or(COALESCE(tr.status IN ('COMPLETED','CANCELLED'),false)) finished
 FROM public.tournaments tr JOIN public.ca_club_data_game_ct d ON d.game_id=tr.id AND d.kind='TOURNAMENT' AND d.club_id=ANY(p_clubs) AND d.stat_date BETWEEN p_start AND p_end
 WHERE tr.tournament_type='MTT' GROUP BY d.game_id
 ), felt AS MATERIALIZED (SELECT * FROM public.fn_ca_rake_felt_v2(p_clubs,p_start,p_end)),
 a AS (SELECT coalesce(sum(fee),0) fee,coalesce(sum(winnings),0) win,
 coalesce(sum(fee) FILTER(WHERE kind='CASH'),0) cf,coalesce(sum(winnings) FILTER(WHERE kind='CASH'),0) cw,
 coalesce(sum(fee) FILTER(WHERE kind='TOURNAMENT'),0) tf,coalesce(sum(winnings) FILTER(WHERE kind='TOURNAMENT'),0) tw,
 (SELECT coalesce(sum(fee) FILTER(WHERE finished),0) FROM mtt) mf,(SELECT coalesce(sum(winnings) FILTER(WHERE finished),0) FROM mtt) mw,
 (SELECT coalesce(sum(fee) FILTER(WHERE NOT finished),0) FROM mtt) rf,(SELECT coalesce(sum(winnings) FILTER(WHERE NOT finished),0) FROM mtt) rw FROM g),
 games AS(SELECT kind,game_id FROM g UNION SELECT 'CASH',table_id FROM felt),
 hands AS(SELECT CASE WHEN cardinality(p_clubs)>1 THEN
 (SELECT count(*) FROM public.rake_records r WHERE r.created_at>=p_start::timestamp AT TIME ZONE 'America/Chicago' AND r.created_at<(p_end+1)::timestamp AT TIME ZONE 'America/Chicago'
 AND r.tournament_id IS NULL AND r.is_tournament IS NOT TRUE AND r.rake_amount>0
 AND EXISTS(SELECT 1 FROM public.ca_club_data_hands_ct c WHERE c.club_id=ANY(p_clubs) AND c.stat_date BETWEEN p_start AND p_end AND c.table_id=r.table_id))
 ELSE (SELECT coalesce(sum(c.hands),0)::bigint FROM public.ca_club_data_hands_ct c WHERE c.club_id=ANY(p_clubs) AND c.stat_date BETWEEN p_start AND p_end) END n)
 SELECT jsonb_build_object('games',(SELECT count(*) FROM games),'cash_games',(SELECT count(*) FROM games WHERE kind='CASH'),
 'mtt_games',(SELECT count(*) FROM mtt),
 'tournament_games',(SELECT count(*) FROM games WHERE kind='TOURNAMENT'),'hands',(SELECT n FROM hands),
 'fee_exact',a.fee,'cash_fee_exact',a.cf,'mtt_fee_exact',a.mf,'tournament_fee_exact',a.tf,'fee',round(a.fee,2),'cash_fee',round(a.cf,2),'mtt_fee',round(a.mf,2),'tournament_fee',round(a.tf,2),
 'total_winnings',round(a.win+coalesce((SELECT sum(felt) FROM felt),0),2),
 'cash_winnings',round(a.cw+coalesce((SELECT sum(felt) FROM felt),0),2),'mtt_winnings',round(a.mw,2),'tournament_winnings',round(a.tw,2),
 'running_mtt_entries',round(a.rw,2),'running_mtt_fee',round(a.rf,2),'running_mtt_fee_exact',a.rf) FROM a;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_club_v2(p_clubs uuid[], p_start date, p_end date, p_limit integer, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'rake'::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 WITH ids AS(SELECT DISTINCT unnest(p_clubs) id),
 listed AS(SELECT c.id club_id,c.name,c.code,coalesce(c.avatar_url,c.logo_url) avatar_url,
 (w.s->>'fee_exact')::numeric fee,(w.s->>'cash_fee_exact')::numeric cash_fee,(w.s->>'mtt_fee_exact')::numeric mtt_fee,(w.s->>'tournament_fee_exact')::numeric tournament_fee,
 (w.s->>'total_winnings')::numeric winnings,(w.s->>'hands')::bigint hands,(w.s->>'games')::bigint games,public.ca_can_read_club_production(c.id) can_drill
 FROM ids JOIN public.clubs c ON c.id=ids.id CROSS JOIN LATERAL(SELECT public.fn_ca_rake_window_v2(ARRAY[c.id],p_start,p_end) s OFFSET 0) w),
 filtered AS(SELECT * FROM listed WHERE nullif(btrim(coalesce(p_search,'')),'') IS NULL OR name ILIKE '%'||public.fn_like_escape(btrim(p_search))||'%' ESCAPE '\' OR coalesce(code,'') ILIKE '%'||public.fn_like_escape(btrim(p_search))||'%' ESCAPE '\'),
 page AS(SELECT * FROM filtered ORDER BY CASE WHEN p_sort='name' THEN name END,CASE WHEN p_sort='hands' THEN hands END DESC,CASE WHEN p_sort NOT IN('name','hands') THEN fee END DESC,name,club_id OFFSET greatest(coalesce(p_offset,0),0) LIMIT greatest(least(coalesce(p_limit,50),200),1))
 SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM page p),'[]'::jsonb),'total',(SELECT count(*) FROM filtered),'total_direct',(SELECT round(coalesce(sum(fee),0),2) FROM listed),'total_commission',NULL);
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_game_page_core_20261006(p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'recent'::text, p_cursor jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_end date := LEAST(COALESCE(p_end,v_today),v_today);
  v_start date := COALESCE(p_start,v_end-13);
  v_game text := UPPER(COALESCE(NULLIF(p_game,''),'ALL'));
  v_stakes text := UPPER(COALESCE(NULLIF(p_stakes,''),'ALL'));
  v_search text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := LOWER(COALESCE(NULLIF(p_sort,''),'recent'));
  v_limit integer := GREATEST(LEAST(COALESCE(p_limit,100),200),1);
  v_out jsonb;
BEGIN
  IF NOT public.ca_can_view_whole_club_report(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501';
  END IF;
  IF v_start < v_end-92 THEN v_start := v_end-92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  IF v_sort NOT IN ('recent','fee','winnings','hands') THEN v_sort := 'recent'; END IF;

  -- EXECUTE forces a plan for this club/window.  Shark Club previously crossed
  -- 20 seconds when PostgreSQL reused a generic parameter plan here.
  --
  -- THE PAGE READS WHAT IT SHOWS (2026-10-07). For Shark Club's 158,820-game
  -- fortnight this read the whole 1.1 GB tournaments heap to rank the games
  -- (143,527 pages), and counted players for every tournament the club ever
  -- had a row for (425,352 index entries, 203,737 heap visits) to show 200 of
  -- them: 2.2 s warm, 27 statement timeouts a day in production. The ranking
  -- now reads only a tournament's id, type and start time (covered by
  -- idx_tournaments_game_page_keys) unless the owner searches by name, and
  -- fee, winnings and players are read for the visible rows alone, by key.
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
    ), union_hands AS MATERIALIZED (
      -- 20261022134523: a union's raked cash hands per table, one grouped pass
      -- over the same rows fn_ca_club_data_hand_count reads, instead of one
      -- call per table.
      SELECT r.table_id,count(*)::bigint hands
        FROM public.rake_records r
       WHERE EXISTS(SELECT 1 FROM public.unions u WHERE u.id=$1)
         AND r.created_at>=$2::timestamp AT TIME ZONE 'America/Chicago' AND r.created_at<($3+1)::timestamp AT TIME ZONE 'America/Chicago'
         AND r.tournament_id IS NULL AND r.is_tournament IS NOT TRUE AND r.rake_amount>0
         AND r.table_id IN (SELECT DISTINCT h.table_id FROM public.ca_club_data_hands_ct h
                             WHERE h.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND h.stat_date BETWEEN $2 AND $3)
       GROUP BY r.table_id
    ), cash AS (
      SELECT coalesce(c.table_id,f.table_id) table_id,coalesce(c.fee,0) fee,
             coalesce(c.winnings,0)+coalesce(f.felt,0) winnings,coalesce(f.felt,0) on_felt,CASE WHEN EXISTS(SELECT 1 FROM public.unions u WHERE u.id=$1) THEN coalesce(uh.hands,0)::bigint ELSE coalesce(c.hands,0)::bigint END hands,
             coalesce(f.seated,0)::integer seated
        FROM raw_cash c FULL JOIN felt f ON f.table_id=c.table_id
        LEFT JOIN union_hands uh ON uh.table_id=coalesce(c.table_id,f.table_id)
    ), tournament_facts AS MATERIALIZED (
      SELECT d.game_id AS tournament_id,SUM(d.fee) fee,SUM(d.winnings) winnings
        FROM public.ca_club_data_game_ct d
       WHERE d.kind='TOURNAMENT' AND d.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND d.stat_date BETWEEN $2 AND $3
       GROUP BY d.game_id
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
             -- The name is read here only to search it. Unsearched, this branch
             -- needs id, type and start time alone (idx_tournaments_game_page_keys).
             CASE WHEN $6 IS NULL THEN NULL::text ELSE COALESCE(tr.name,'Tournament') END,''::text,
             CASE $7 WHEN 'fee' THEN round(COALESCE(f.fee,0),2)
                     WHEN 'winnings' THEN round(COALESCE(f.winnings,0),2)
                     WHEN 'hands' THEN 0::numeric
                     ELSE extract(epoch FROM COALESCE(tr.start_time,'0001-01-01'::timestamptz))::numeric
              END,
             extract(epoch FROM COALESCE(tr.start_time,'0001-01-01'::timestamptz))::numeric
        FROM tournament_facts f JOIN public.tournaments tr ON tr.id=f.tournament_id
    ), filtered AS MATERIALIZED (
      SELECT k.* FROM keys k
       WHERE ($4='ALL' OR k.game_class=$4)
         AND ($5='ALL' OR k.stakes_tier=$5)
         AND ($6 IS NULL OR k.name ILIKE '%'||$6||'%' OR k.id ILIKE '%'||$6||'%'
              OR k.creator_name ILIKE '%'||$6||'%')
    ), page_plus_one AS MATERIALIZED (
      SELECT s.* FROM filtered s
       WHERE $8 IS NULL OR ROW(s.sort_value,s.sort_time,s.kind,s.id) < ROW(
         ($8->>'value')::numeric,($8->>'time')::numeric,$8->>'kind',$8->>'id')
       ORDER BY s.sort_value DESC,s.sort_time DESC,s.kind DESC,s.id DESC
       LIMIT $9+1
    ), visible AS MATERIALIZED (
      SELECT * FROM page_plus_one
       ORDER BY sort_value DESC,sort_time DESC,kind DESC,id DESC LIMIT $9
    ), last_row AS (
      SELECT * FROM visible ORDER BY sort_value ASC,sort_time ASC,kind ASC,id ASC LIMIT 1
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
             CASE WHEN v.kind='CASH' THEN c.hands ELSE 0::bigint END hands,
             CASE WHEN v.kind='CASH' THEN coalesce(c.on_felt,0) ELSE 0 END on_felt,
             CASE WHEN v.kind='CASH' THEN coalesce(c.on_felt,0)>0 ELSE tr.status='RUNNING' END live,
             CASE WHEN v.kind='CASH' THEN greatest(COALESCE(cp.players,0),COALESCE(c.seated,0))::integer ELSE COALESCE(tp.players,0)::integer END players,
             CASE WHEN v.kind='CASH' THEN pr.avatar_url END creator_avatar
        FROM visible v
        LEFT JOIN cash c ON v.kind='CASH' AND c.table_id=v.id::uuid
        LEFT JOIN public.tables t ON v.kind='CASH' AND t.id=v.id::uuid
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
    SELECT jsonb_build_object(
      'sort',$7,
      'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'kind',q.kind,'id',q.id,'name',q.name,'variant',q.variant,
        'game_class',q.game_class,'stakes_tier',q.stakes_tier,
        'blinds',CASE WHEN q.big_blind>0 THEN
          trim(trailing '.' from trim(trailing '0' from q.small_blind::text))||'/'||
          trim(trailing '.' from trim(trailing '0' from q.big_blind::text)) END,
        'rake_percent',q.rake_percent,'started_at',q.started_at,'status',q.status,
        'creator_id',q.created_by,'creator_name',NULLIF(q.creator_name,''),
        'creator_avatar',q.creator_avatar,'fee',q.fee,'fee_exact',q.fee_exact,'winnings',q.winnings,
        'hands',q.hands,'players',q.players,'on_felt',q.on_felt,'live',q.live)
        ORDER BY q.sort_value DESC,q.sort_time DESC,q.kind DESC,q.id DESC) FROM detail q),'[]'::jsonb),
      'next_cursor',CASE WHEN (SELECT count(*) FROM page_plus_one)>$9 THEN
        (SELECT jsonb_build_object('value',l.sort_value,'time',l.sort_time,'kind',l.kind,'id',l.id)
           FROM last_row l) ELSE NULL END,
      'has_more',(SELECT count(*) FROM page_plus_one)>$9,
      'filtered_count',(SELECT count(*) FROM filtered),
      'generated_at',now())
  $query$ INTO v_out
  USING p_club_id,v_start,v_end,v_game,v_stakes,v_search,v_sort,p_cursor,v_limit;

  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_games_searched(p_club_id uuid, p_start date, p_end date, p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text, p_search text DEFAULT NULL::text)
 RETURNS TABLE(kind text, id text, name text, variant text, game_class text, stakes_tier text, small_blind numeric, big_blind numeric, rake_percent numeric, started_at timestamp with time zone, created_by uuid, status text, fee numeric, winnings numeric, hands bigint, players integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH cash_players AS MATERIALIZED (SELECT z.game_id,count(DISTINCT z.user_id)::integer players FROM public.ca_club_data_fact_ct z WHERE z.club_id=ANY(public.fn_ca_club_data_clubs($1)) AND z.stat_date BETWEEN $2 AND $3 AND z.kind='CASH' AND z.user_id<>'00000000-0000-0000-0000-000000000000'::uuid GROUP BY z.game_id), felt AS MATERIALIZED (SELECT * FROM public.fn_ca_club_cash_felt($1,$2,$3,$4,$5,$6)), raw_cash AS (
    SELECT c.table_id,SUM(c.rake) fee,SUM(c.net) winnings,SUM(c.hands) hands,
           coalesce(max(cp.players),0)::integer players FROM (SELECT g.game_id AS table_id,g.fee AS rake,g.winnings AS net,0::bigint AS hands
                FROM public.ca_club_data_game_ct g
               WHERE g.kind='CASH' AND g.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND g.stat_date BETWEEN p_start AND p_end
              UNION ALL
              SELECT h.table_id,0,0,h.hands
                FROM public.ca_club_data_hands_ct h
               WHERE h.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND h.stat_date BETWEEN p_start AND p_end) c LEFT JOIN cash_players cp ON cp.game_id=c.table_id
     GROUP BY c.table_id
  ), union_hands AS MATERIALIZED (
      -- 20261022134523: a union's raked cash hands per table, one grouped pass
      -- over the same rows fn_ca_club_data_hand_count reads, instead of one
      -- call per table.
      SELECT r.table_id,count(*)::bigint hands
        FROM public.rake_records r
       WHERE EXISTS(SELECT 1 FROM public.unions u WHERE u.id=$1)
         AND r.created_at>=$2::timestamp AT TIME ZONE 'America/Chicago' AND r.created_at<($3+1)::timestamp AT TIME ZONE 'America/Chicago'
         AND r.tournament_id IS NULL AND r.is_tournament IS NOT TRUE AND r.rake_amount>0
         AND r.table_id IN (SELECT DISTINCT h.table_id FROM public.ca_club_data_hands_ct h
                             WHERE h.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND h.stat_date BETWEEN $2 AND $3)
       GROUP BY r.table_id
    ), cash AS (
      SELECT coalesce(c.table_id,f.table_id) table_id,coalesce(c.fee,0) fee,
             coalesce(c.winnings,0)+coalesce(f.felt,0) winnings,CASE WHEN EXISTS(SELECT 1 FROM public.unions u WHERE u.id=$1) THEN coalesce(uh.hands,0)::bigint ELSE coalesce(c.hands,0)::bigint END hands,
             greatest(coalesce(c.players,0),coalesce(f.seated,0))::integer players
        FROM raw_cash c FULL JOIN felt f ON f.table_id=c.table_id
        LEFT JOIN union_hands uh ON uh.table_id=coalesce(c.table_id,f.table_id)
    ), tournament_facts AS MATERIALIZED (
    SELECT d.game_id AS tournament_id,SUM(d.fee) fee,SUM(d.winnings) winnings
      FROM public.ca_club_data_game_ct d WHERE d.kind='TOURNAMENT' AND d.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id))
       AND d.stat_date BETWEEN p_start AND p_end GROUP BY d.game_id
  ), tournament_players AS MATERIALIZED (
    SELECT p.game_id AS tournament_id,count(DISTINCT p.user_id)::integer players
      FROM public.ca_club_data_fact_ct p WHERE p.kind='TOURNAMENT' AND p.user_id<>'00000000-0000-0000-0000-000000000000'::uuid AND p.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id))
       AND p.stat_date BETWEEN p_start AND p_end GROUP BY p.game_id
  ), all_rows AS (
    SELECT 'CASH'::text kind,t.id::text id,COALESCE(t.name,'Unnamed') name,
      UPPER(COALESCE(t.game_variant,'nlh')) variant,
      CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
           WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
           ELSE 'HOLDEM' END game_class,COALESCE(t.small_blind,0) small_blind,
      COALESCE(t.big_blind,0) big_blind,
      CASE WHEN COALESCE(t.rake_percent,-1)>=0 THEN t.rake_percent END rake_percent,
      t.created_at started_at,t.created_by,t.status,c.fee fee,
      round(c.winnings,2) winnings,c.hands::bigint,c.players::integer,
      COALESCE(pr.username,'') creator_username
      FROM cash c JOIN public.tables t ON t.id=c.table_id
      LEFT JOIN public.profiles pr ON pr.id=t.created_by
    UNION ALL
    SELECT CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN'
                WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,
      tr.id::text,COALESCE(tr.name,'Tournament'),UPPER(COALESCE(tr.variant,tr.game_type,'nlh')),
      CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN' WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,
      0::numeric,0::numeric,NULL::numeric,tr.start_time,NULL::uuid,tr.status,
      COALESCE(f.fee,0),round(COALESCE(f.winnings,0),2),0::bigint,
      COALESCE(tp.players,0)::integer,''::text
      FROM tournament_facts f JOIN public.tournaments tr ON tr.id=f.tournament_id
      LEFT JOIN tournament_players tp ON tp.tournament_id=f.tournament_id
  ), tagged AS (
    SELECT r.*,CASE WHEN r.game_class IN('MTT','SNG') THEN 'NA'
      WHEN r.big_blind<1 THEN 'MICRO' WHEN r.big_blind<5 THEN 'SMALL'
      WHEN r.big_blind<25 THEN 'MID' ELSE 'HIGH' END stakes_tier FROM all_rows r
  )
  SELECT t.kind,t.id,t.name,t.variant,t.game_class,t.stakes_tier,t.small_blind,
    t.big_blind,t.rake_percent,t.started_at,t.created_by,t.status,t.fee,t.winnings,
    t.hands,t.players FROM tagged t
   WHERE (UPPER(COALESCE(NULLIF(p_game,''),'ALL'))='ALL' OR t.game_class=UPPER(p_game))
     AND (UPPER(COALESCE(NULLIF(p_stakes,''),'ALL'))='ALL' OR t.stakes_tier=UPPER(p_stakes))
     AND (NULLIF(btrim(COALESCE(p_search,'')),'') IS NULL
       OR t.name ILIKE '%'||btrim(p_search)||'%'
       OR t.id ILIKE '%'||btrim(p_search)||'%'
       OR t.creator_username ILIKE '%'||btrim(p_search)||'%');
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_club_games_unsearched(p_club_id uuid, p_start date, p_end date, p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text)
 RETURNS TABLE(kind text, id text, name text, variant text, game_class text, stakes_tier text, small_blind numeric, big_blind numeric, rake_percent numeric, started_at timestamp with time zone, created_by uuid, status text, fee numeric, winnings numeric, hands bigint, players integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY EXECUTE $query$
    WITH cash_players AS MATERIALIZED (SELECT z.game_id,count(DISTINCT z.user_id)::integer players FROM public.ca_club_data_fact_ct z WHERE z.club_id=ANY(public.fn_ca_club_data_clubs($1)) AND z.stat_date BETWEEN $2 AND $3 AND z.kind='CASH' AND z.user_id<>'00000000-0000-0000-0000-000000000000'::uuid GROUP BY z.game_id), felt AS MATERIALIZED (SELECT * FROM public.fn_ca_club_cash_felt($1,$2,$3,$4,$5,NULL)), raw_cash AS (
      SELECT c.table_id,SUM(c.rake) fee,SUM(c.net) winnings,SUM(c.hands) hands,
             coalesce(max(cp.players),0)::integer players FROM (SELECT g.game_id AS table_id,g.fee AS rake,g.winnings AS net,0::bigint AS hands
                FROM public.ca_club_data_game_ct g
               WHERE g.kind='CASH' AND g.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND g.stat_date BETWEEN $2 AND $3
              UNION ALL
              SELECT h.table_id,0,0,h.hands
                FROM public.ca_club_data_hands_ct h
               WHERE h.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND h.stat_date BETWEEN $2 AND $3) c LEFT JOIN cash_players cp ON cp.game_id=c.table_id
       GROUP BY c.table_id
    ), union_hands AS MATERIALIZED (
      -- 20261022134523: a union's raked cash hands per table, one grouped pass
      -- over the same rows fn_ca_club_data_hand_count reads, instead of one
      -- call per table.
      SELECT r.table_id,count(*)::bigint hands
        FROM public.rake_records r
       WHERE EXISTS(SELECT 1 FROM public.unions u WHERE u.id=$1)
         AND r.created_at>=$2::timestamp AT TIME ZONE 'America/Chicago' AND r.created_at<($3+1)::timestamp AT TIME ZONE 'America/Chicago'
         AND r.tournament_id IS NULL AND r.is_tournament IS NOT TRUE AND r.rake_amount>0
         AND r.table_id IN (SELECT DISTINCT h.table_id FROM public.ca_club_data_hands_ct h
                             WHERE h.club_id = ANY (public.fn_ca_club_data_clubs($1)) AND h.stat_date BETWEEN $2 AND $3)
       GROUP BY r.table_id
    ), cash AS (
      SELECT coalesce(c.table_id,f.table_id) table_id,coalesce(c.fee,0) fee,
             coalesce(c.winnings,0)+coalesce(f.felt,0) winnings,CASE WHEN EXISTS(SELECT 1 FROM public.unions u WHERE u.id=$1) THEN coalesce(uh.hands,0)::bigint ELSE coalesce(c.hands,0)::bigint END hands,
             greatest(coalesce(c.players,0),coalesce(f.seated,0))::integer players
        FROM raw_cash c FULL JOIN felt f ON f.table_id=c.table_id
        LEFT JOIN union_hands uh ON uh.table_id=coalesce(c.table_id,f.table_id)
    ), tournament_facts AS MATERIALIZED (
      SELECT d.game_id AS tournament_id,SUM(d.fee) fee,SUM(d.winnings) winnings
        FROM public.ca_club_data_game_ct d WHERE d.kind='TOURNAMENT' AND d.club_id = ANY (public.fn_ca_club_data_clubs($1))
         AND d.stat_date BETWEEN $2 AND $3 GROUP BY d.game_id
    ), tournament_players AS MATERIALIZED (
      SELECT p.game_id AS tournament_id,count(DISTINCT p.user_id)::integer players
        FROM public.ca_club_data_fact_ct p WHERE p.kind='TOURNAMENT' AND p.user_id<>'00000000-0000-0000-0000-000000000000'::uuid AND p.club_id = ANY (public.fn_ca_club_data_clubs($1))
         AND p.stat_date BETWEEN $2 AND $3 GROUP BY p.game_id
    ), all_rows AS (
      SELECT 'CASH'::text kind,t.id::text id,COALESCE(t.name,'Unnamed') name,
        UPPER(COALESCE(t.game_variant,'nlh')) variant,
        CASE WHEN COALESCE(t.game_variant,'') ILIKE '%plo%' OR COALESCE(t.game_variant,'') ILIKE '%omaha%' THEN 'OMAHA'
             WHEN COALESCE(t.game_variant,'') ILIKE '%mixed%' OR COALESCE(t.game_mode,'') ILIKE '%mixed%' THEN 'MIXED'
             ELSE 'HOLDEM' END game_class,COALESCE(t.small_blind,0) small_blind,
        COALESCE(t.big_blind,0) big_blind,
        CASE WHEN COALESCE(t.rake_percent,-1)>=0 THEN t.rake_percent END rake_percent,
        t.created_at started_at,t.created_by,t.status,c.fee fee,
        round(c.winnings,2) winnings,c.hands::bigint,c.players::integer
        FROM cash c JOIN public.tables t ON t.id=c.table_id
      UNION ALL
      SELECT CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN'
                  WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,
        tr.id::text,COALESCE(tr.name,'Tournament'),UPPER(COALESCE(tr.variant,tr.game_type,'nlh')),
        CASE WHEN tr.tournament_type='SPIN' THEN 'SPIN' WHEN tr.tournament_type='SNG' THEN 'SNG' WHEN tr.tournament_type='MTT' THEN 'MTT' ELSE coalesce(tr.tournament_type,'TOURNAMENT') END,
        0::numeric,0::numeric,NULL::numeric,tr.start_time,NULL::uuid,tr.status,
        COALESCE(f.fee,0),round(COALESCE(f.winnings,0),2),0::bigint,
        COALESCE(tp.players,0)::integer
        FROM tournament_facts f JOIN public.tournaments tr ON tr.id=f.tournament_id
        LEFT JOIN tournament_players tp ON tp.tournament_id=f.tournament_id
    ), tagged AS (
      SELECT r.*,CASE WHEN r.game_class IN('MTT','SNG') THEN 'NA'
        WHEN r.big_blind<1 THEN 'MICRO' WHEN r.big_blind<5 THEN 'SMALL'
        WHEN r.big_blind<25 THEN 'MID' ELSE 'HIGH' END stakes_tier FROM all_rows r
    )
    SELECT t.kind,t.id,t.name,t.variant,t.game_class,t.stakes_tier,t.small_blind,
      t.big_blind,t.rake_percent,t.started_at,t.created_by,t.status,t.fee,t.winnings,
      t.hands,t.players FROM tagged t
     WHERE (UPPER(COALESCE(NULLIF($4,''),'ALL'))='ALL' OR t.game_class=UPPER($4))
       AND (UPPER(COALESCE(NULLIF($5,''),'ALL'))='ALL' OR t.stakes_tier=UPPER($5))
  $query$ USING p_club_id,p_start,p_end,p_game,p_stakes;
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
  v_rows:=public.ca_club_game_page_core_20261006(p_club_id,v_start,v_end,v_game,v_stakes,v_q,'recent',NULL,v_lim)->'rows';
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
    'data_updated_at',(SELECT max(g.last_at) FROM public.ca_club_data_game_ct g WHERE g.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND g.stat_date BETWEEN v_start AND v_end),
    'accounting_basis','chicago_net_money_flow','day_basis','America/Chicago',
    'generated_at',now());
END;
$function$;

-- The grants are the installed ones, restated.
REVOKE ALL ON FUNCTION public.fn_ca_rake_window_v2(uuid[],date,date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_rake_by_club_v2(uuid[],date,date,integer,integer,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_club_game_page_core_20261006(uuid,date,date,text,text,text,text,jsonb,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_club_games_searched(uuid,date,date,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_games_searched(uuid,date,date,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_club_games_unsearched(uuid,date,date,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_games_unsearched(uuid,date,date,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer) TO authenticated, service_role;

COMMIT;
