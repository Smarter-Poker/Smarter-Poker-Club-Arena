-- A UNION CLUB ROW SAYS WHETHER IT OPENS.
--
-- Same rule the agent rows got three hours ago: the panel never offers a door
-- that will not open, and the flag is computed from the SAME gate the club
-- scope enforces - ca_can_view_club_finances - so the button and the gate
-- cannot disagree.
--
-- With the companion migration admitting union overseers, an overseer sees
-- every club in their union open. A platform admin sees every row open. Read a
-- union that merely contains a club you own and you see your own row open and
-- the others shut, which is exactly right.
--
-- Measured on production as the union lead: two rows, both claiming to open,
-- both opening. A plain member of a member club never reaches the union scope
-- at all.
--
-- The flag is per viewer, not a property of the club, and it is evaluated
-- inside a SECURITY DEFINER function - which changes the ROLE but not the JWT
-- claims, so auth.uid() inside still answers with the caller.

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
           COALESCE(a.hands,0) AS hands, a.games,
           -- The same gate the club scope enforces.
           public.ca_can_view_club_finances(a.club_id) AS can_drill
      FROM agg a JOIN public.clubs cl ON cl.id = a.club_id
  ), totals AS (
    -- Before the filter, deliberately: the denominator is the whole set.
    SELECT COALESCE(SUM(l.fee),0) AS total_direct FROM listed l
  ), filtered AS (
    SELECT l.* FROM listed l
     WHERE NULLIF(btrim(COALESCE(p_search,'')),'') IS NULL
        OR l.name ILIKE '%' || public.fn_like_escape(btrim(p_search)) || '%' ESCAPE '\'
        OR COALESCE(l.code,'') ILIKE '%' || public.fn_like_escape(btrim(p_search)) || '%' ESCAPE '\'
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

-- Restated with the re-declaration. CREATE OR REPLACE keeps existing
-- privileges here, but a database rebuilt from these files would create this
-- function with PUBLIC EXECUTE and never revoke it, letting a player call the
-- definer helper directly and read another club's book.
REVOKE ALL ON FUNCTION public.fn_ca_rake_by_club(uuid[],date,date,integer,integer,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_club(uuid[],date,date,integer,integer,text,text) TO service_role;
