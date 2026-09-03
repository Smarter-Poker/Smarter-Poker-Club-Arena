-- 20260903044507_the_count_is_of_matches_not_of_the_page_you_landed_on.sql
-- RECOVERED 2026-09-03 from supabase_migrations.schema_migrations.
-- This migration was APPLIED to production on 2026-09-03 at 04:45:07 UTC but was never committed, so the repo
-- could not reproduce the database and applied-migrations-recorded.yml was red.
-- The body below is the exact SQL the database recorded; it is NOT a
-- reconstruction. Re-applying it is a no-op - it is already in production.

-- THE COUNT IS OF MATCHES, NOT OF THE PAGE YOU LANDED ON.
--
-- All three helpers took 'total' from a window function computed on the SLICED
-- rows. That reads correctly right up until the slice is empty: ask for offset
-- 60 of a 33-row result and the answer is "total 0" - the list reports that
-- nothing matches while matches plainly exist. Paging made that reachable;
-- search makes it easy, because a filter can shrink the set under an offset
-- the caller is still holding.
--
-- The count now comes from counting the filtered set, which cannot depend on
-- which page was asked for.

CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_club(
  p_club_ids uuid[], p_start date, p_end date, p_limit integer,
  p_offset integer DEFAULT 0, p_search text DEFAULT NULL, p_sort text DEFAULT 'rake'
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH rows_in AS (
    SELECT c.club_id, c.rake AS fee, c.net AS winnings,
           COALESCE(c.hands,0)::bigint AS hands,
           'c:' || c.table_id::text AS gid, false AS is_mtt
      FROM public.club_table_daily c
     WHERE c.club_id = ANY (p_club_ids) AND c.stat_date BETWEEN p_start AND p_end
    UNION ALL
    SELECT t.club_id, t.fee, t.winnings, 0::bigint,
           't:' || t.tournament_id::text, true
      FROM public.ca_club_tournament_daily t
     WHERE t.club_id = ANY (p_club_ids) AND t.stat_date BETWEEN p_start AND p_end
  ), agg AS (
    SELECT r.club_id,
           round(SUM(r.fee),2) AS fee,
           round(SUM(r.fee) FILTER (WHERE r.is_mtt),2) AS mtt_fee,
           round(SUM(r.fee) FILTER (WHERE NOT r.is_mtt),2) AS cash_fee,
           round(SUM(r.winnings),2) AS winnings,
           SUM(r.hands) AS hands,
           COUNT(DISTINCT r.gid) AS games
      FROM rows_in r GROUP BY r.club_id
  ), listed AS (
    SELECT a.club_id, COALESCE(cl.name,'Club') AS name, cl.code,
           COALESCE(cl.avatar_url, cl.logo_url) AS avatar_url,
           COALESCE(a.fee,0) AS fee, COALESCE(a.cash_fee,0) AS cash_fee,
           COALESCE(a.mtt_fee,0) AS mtt_fee, COALESCE(a.winnings,0) AS winnings,
           COALESCE(a.hands,0) AS hands, a.games
      FROM agg a JOIN public.clubs cl ON cl.id = a.club_id
  ), totals AS (
    SELECT COALESCE(SUM(l.fee),0) AS total_direct FROM listed l
  ), filtered AS (
    SELECT l.* FROM listed l
     WHERE NULLIF(btrim(COALESCE(p_search,'')),'') IS NULL
        OR l.name ILIKE '%' || btrim(p_search) || '%'
        OR COALESCE(l.code,'') ILIKE '%' || btrim(p_search) || '%'
  ), page AS (
    SELECT f.* FROM filtered f
     ORDER BY
       CASE WHEN lower(COALESCE(p_sort,'rake')) = 'name'  THEN f.name END ASC,
       CASE WHEN lower(COALESCE(p_sort,'rake')) = 'hands' THEN f.hands END DESC,
       CASE WHEN lower(COALESCE(p_sort,'rake')) NOT IN ('name','hands') THEN f.fee END DESC,
       f.name ASC
     OFFSET GREATEST(COALESCE(p_offset,0),0)
      LIMIT GREATEST(LEAST(COALESCE(p_limit,50),200),1)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM page p), '[]'::jsonb),
    'total', (SELECT count(*) FROM filtered),
    'total_direct', (SELECT t.total_direct FROM totals t),
    'total_commission', NULL);
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_downline(
  p_agent_user_id uuid, p_club_id uuid,
  p_since timestamptz, p_until timestamptz, p_limit integer,
  p_offset integer DEFAULT 0, p_search text DEFAULT NULL, p_sort text DEFAULT 'rake'
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH listed AS (
    SELECT d.* FROM public.fn_agent_downline_rake(
      p_agent_user_id, p_club_id, p_since, p_until, NULL, 5000) d
  ), totals AS (
    SELECT COALESCE(SUM(l.rake_generated),0) AS total_direct FROM listed l
  ), filtered AS (
    SELECT l.* FROM listed l
     WHERE NULLIF(btrim(COALESCE(p_search,'')),'') IS NULL
        OR COALESCE(l.username,'') ILIKE '%' || btrim(p_search) || '%'
  ), page AS (
    SELECT f.* FROM filtered f
     ORDER BY
       CASE WHEN lower(COALESCE(p_sort,'rake')) = 'name'  THEN f.username END ASC,
       CASE WHEN lower(COALESCE(p_sort,'rake')) = 'hands' THEN f.hands END DESC,
       CASE WHEN lower(COALESCE(p_sort,'rake')) NOT IN ('name','hands')
            THEN f.rake_generated END DESC,
       f.username ASC
     OFFSET GREATEST(COALESCE(p_offset,0),0)
      LIMIT GREATEST(LEAST(COALESCE(p_limit,100),500),1)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'player_id', p.player_id,
              'name', COALESCE(p.username,'Player'),
              'role', p.role,
              'depth', p.depth,
              'upline_user_id', p.upline_user_id,
              'upline_name', p.upline_name,
              'rake', round(COALESCE(p.rake_generated,0),2),
              'hands', COALESCE(p.hands,0),
              'last_hand_at', p.last_hand_at,
              'downline_players', COALESCE(p.downline_players,0),
              'downline_rake', round(COALESCE(p.downline_rake,0),2))) FROM page p), '[]'::jsonb),
    'total', (SELECT count(*) FROM filtered),
    'total_direct', (SELECT t.total_direct FROM totals t),
    'total_commission', NULL);
$function$;