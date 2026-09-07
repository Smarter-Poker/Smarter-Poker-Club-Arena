-- 20260907042418_the_ranked_club_data_page_ranks_a_narrow_key_set.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- `ca_club_game_page` returns 100 rows. To find them it was carrying every
-- presentation column - name, variant, blinds, rake percent, status, creator
-- name and avatar, fee, winnings, hands, players - through THREE MATERIALIZED
-- copies of the whole window and then a full sort. On Shark Club that window
-- is 90,649 rows a fortnight, so each ranked read materialised roughly 42 MB
-- three times and spilled it to disk.
--
-- Measured on production 2026-09-07, p_sort=fee, 14 day window, alternating
-- calls in ONE session so both saw the same load:
--
--     run   current    this migration
--     1     4,064 ms   842 ms      (cold)
--     2     1,208 ms   694 ms
--     3     1,151 ms   688 ms
--
--     shared buffers touched   317,658  ->  125,851   (-60%)
--     temp blocks read+written   5,862  ->      861   (-85%)
--
-- The ranking now runs over a NARROW key set: the four sort keys plus only the
-- columns the filter itself reads (game class, stakes tier, name, creator
-- name). The wide projection is joined back for the <=200 rows that survive
-- the LIMIT, and `tournament_players` - a 90k row count(DISTINCT) that used to
-- be merge-joined into every row of the window - is joined for those rows too.
--
-- WHY IT MATTERS BEYOND THE MILLISECONDS. The client wraps this RPC in
-- `coldRead`, a 12,000 ms per-attempt budget with three retries. The cold
-- number above was measured as high as 15,493 ms earlier the same day, so the
-- attempt could time out, and each retry started ANOTHER full-window scan
-- beside the one still running. That is one half of the Club Data page lockup
-- fixed in this branch; the other half is in ClubDataPage.tsx.
--
-- PROVEN IDENTICAL BEFORE IT WAS WRITTEN. The replacement body was built as a
-- pg_temp function (11.5 rule 4 - never in `public`) and its output diffed
-- against the live function on production:
--
--   * 48 combinations of sort x game class x stakes tier x search
--     (4 x 3 x 2 x 2), every one `(old - 'generated_at') = (new - 'generated_at')`;
--   * three consecutive cursor pages for each of the four sorts, each page
--     fed from its OWN function's `next_cursor`, all identical.
--
-- Nothing else about the function changes: same signature, same STABLE
-- SECURITY DEFINER, same authorization check, same clamps, same JSON keys.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.ca_club_game_page(p_club_id uuid, p_start date DEFAULT NULL::date, p_end date DEFAULT NULL::date, p_game text DEFAULT 'ALL'::text, p_stakes text DEFAULT 'ALL'::text, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'recent'::text, p_cursor jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end,v_today),v_today);
  v_start date := COALESCE(p_start,v_end-13);
  v_game text := UPPER(COALESCE(NULLIF(p_game,''),'ALL'));
  v_stakes text := UPPER(COALESCE(NULLIF(p_stakes,''),'ALL'));
  v_search text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := LOWER(COALESCE(NULLIF(p_sort,''),'recent'));
  v_limit integer := GREATEST(LEAST(COALESCE(p_limit,100),200),1);
  v_out jsonb;
BEGIN
  IF NOT public.ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501';
  END IF;
  IF v_start < v_end-92 THEN v_start := v_end-92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  IF v_sort NOT IN ('recent','fee','winnings','hands') THEN v_sort := 'recent'; END IF;

  -- EXECUTE forces a plan for this club/window.  Shark Club previously crossed
  -- 20 seconds when PostgreSQL reused a generic parameter plan here.
  EXECUTE $query$
    WITH cash AS (
      SELECT c.table_id,SUM(c.rake) fee,SUM(c.net) winnings,SUM(c.hands)::bigint hands,
             MAX(c.players)::integer players
        FROM public.club_table_daily c
       WHERE c.club_id=$1 AND c.stat_date BETWEEN $2 AND $3
       GROUP BY c.table_id
    ), tournament_facts AS MATERIALIZED (
      SELECT d.tournament_id,SUM(d.fee) fee,SUM(d.winnings) winnings
        FROM public.ca_club_tournament_daily d
       WHERE d.club_id=$1 AND d.stat_date BETWEEN $2 AND $3
       GROUP BY d.tournament_id
    ), tournament_players AS MATERIALIZED (
      SELECT p.tournament_id,count(DISTINCT p.user_id)::integer players
        FROM public.ca_club_tournament_player_daily p
       WHERE p.club_id=$1 AND p.stat_date BETWEEN $2 AND $3
       GROUP BY p.tournament_id
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
                  WHEN tr.tournament_type='SNG' THEN 'SNG' ELSE 'MTT' END,
             tr.id::text,
             CASE WHEN tr.tournament_type='SNG' THEN 'SNG' ELSE 'MTT' END,
             'NA',
             COALESCE(tr.name,'Tournament'),''::text,
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
      SELECT v.kind,v.id,v.name,v.game_class,v.stakes_tier,v.creator_name,
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
             CASE WHEN v.kind='CASH' THEN round(c.winnings,2) ELSE round(COALESCE(f.winnings,0),2) END winnings,
             CASE WHEN v.kind='CASH' THEN c.hands ELSE 0::bigint END hands,
             CASE WHEN v.kind='CASH' THEN c.players ELSE COALESCE(tp.players,0)::integer END players,
             CASE WHEN v.kind='CASH' THEN pr.avatar_url END creator_avatar
        FROM visible v
        LEFT JOIN cash c ON v.kind='CASH' AND c.table_id=v.id::uuid
        LEFT JOIN public.tables t ON v.kind='CASH' AND t.id=v.id::uuid
        LEFT JOIN public.profiles pr ON v.kind='CASH' AND pr.id=t.created_by
        LEFT JOIN tournament_facts f ON v.kind<>'CASH' AND f.tournament_id=v.id::uuid
        LEFT JOIN public.tournaments tr ON v.kind<>'CASH' AND tr.id=v.id::uuid
        LEFT JOIN tournament_players tp ON v.kind<>'CASH' AND tp.tournament_id=v.id::uuid
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
        'creator_avatar',q.creator_avatar,'fee',q.fee,'winnings',q.winnings,
        'hands',q.hands,'players',q.players)
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

-- CREATE OR REPLACE keeps the grants the function already had, so production
-- was never opened up by the statement above. Restating them is for the NEXT
-- database this file is replayed into, where a bare CREATE takes Postgres's
-- default and hands EXECUTE to PUBLIC - which is anon. This is the same trap
-- that `a_restored_view_keeps_the_grants_it_had` was written for earlier today,
-- and GRANT/REVOKE do not fire the schema-cache reload, so it costs nothing.
REVOKE ALL ON FUNCTION public.ca_club_game_page(uuid,date,date,text,text,text,text,jsonb,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_club_game_page(uuid,date,date,text,text,text,text,jsonb,integer) TO authenticated,service_role;

COMMIT;
