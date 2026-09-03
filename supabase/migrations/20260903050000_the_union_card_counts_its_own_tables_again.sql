-- THE UNION CARD COUNTS ITS OWN TABLES AGAIN
--
-- Midway Union's card reads ACTIVE 0 while 254 players are seated at tables
-- belonging to the union's own club row, and 481 across the union as a whole.
--
-- This is the SAME bug that was fixed on 2026-08-20, reintroduced by a later
-- rewrite. The comment explaining that fix is still sitting in HomePage.tsx
-- (lines 942-955) and describes it exactly:
--
--     "For unions it was flatly wrong, not merely stale. This summed per-club
--      active counts over `union_clubs` - the union's MEMBER clubs - and never
--      looked at the union's OWN club row, which is exactly where its tables
--      live. Midway Union had 377 players seated across 72 running tables and
--      its card read 0."
--
-- fn_union_active_player_counts was written to fix that and still returns 481
-- today. But the page was later switched to a new "realtime" variant,
-- fn_batch_union_realtime_active_counts, which reintroduced the original
-- mistake: it joins ONLY through union_clubs. The explanatory comment stayed
-- pointing at the corrected function while the call underneath it moved to the
-- broken one, so the code reads as though it is fixed.
--
-- A union owns tables through two different paths and needs both:
--     union_clubs.union_id -> its MEMBER clubs
--     clubs.union_id       -> its OWN club row
-- That is precisely the union_club_ids CTE in fn_union_active_player_counts,
-- adopted here verbatim so the two functions can no longer disagree.
--
-- Two things kept deliberately:
--   * The LEFT JOIN shape stays, so a union with nobody playing still returns a
--     row with 0. The client maps a MISSING row to null and renders nothing,
--     which is a different statement from "nobody is playing".
--   * The `t.club_id = uc.club_id` restriction is dropped, matching the
--     corrected function. The basis is MEMBERSHIP, not table ownership: a union
--     member seated anywhere live is an active player of that union, counted
--     DISTINCT so belonging to two of its clubs does not count them twice.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_batch_union_realtime_active_counts(p_union_ids uuid[])
RETURNS TABLE(union_id uuid, active_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  WITH union_club_ids AS (
    -- The union's member clubs...
    SELECT uc.union_id, uc.club_id
      FROM public.union_clubs uc
     WHERE uc.union_id = ANY(p_union_ids)
    UNION
    -- ...AND the union's own club row, which is where its tables actually live.
    -- Omitting this line is the whole of the bug, both times.
    SELECT c.union_id, c.id
      FROM public.clubs c
     WHERE c.union_id = ANY(p_union_ids)
  )
  SELECT requested.union_id,
         count(DISTINCT ts.user_id) FILTER (WHERE t.id IS NOT NULL)::bigint AS active_count
    FROM unnest(p_union_ids) requested(union_id)
    LEFT JOIN union_club_ids u ON u.union_id = requested.union_id
    LEFT JOIN public.club_members cm ON cm.club_id = u.club_id
      AND cm.status IN ('active', 'approved')
    LEFT JOIN public.table_seats ts ON ts.user_id = cm.user_id
      AND ts.left_at IS NULL AND COALESCE(ts.is_away, false) = false
    LEFT JOIN public.tables t ON t.id = ts.table_id
      AND lower(COALESCE(t.status, '')) NOT IN ('closed','completed','cancelled','finished')
   GROUP BY requested.union_id;
$function$;

REVOKE ALL ON FUNCTION public.fn_batch_union_realtime_active_counts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_batch_union_realtime_active_counts(uuid[])
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_batch_union_realtime_active_counts(uuid[]) IS
  'Distinct players of a union currently seated at a live table, counted across BOTH the union''s member clubs and its own club row. Returns a row per requested union, zero included.';

DO $assert$
DECLARE
  v_src text;
  v_union uuid;
  v_realtime bigint;
  v_reference bigint;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_batch_union_realtime_active_counts';

  -- The union's own club row must be consulted. Its absence is the bug, twice.
  IF position('c.union_id = ANY(p_union_ids)' IN v_src) = 0 THEN
    RAISE EXCEPTION 'the union realtime count no longer reads the union''s own club row';
  END IF;

  -- Behavioural check against the function that was already correct: on the
  -- largest union the two must now agree. They differed by 481 before this.
  SELECT u.id INTO v_union
    FROM public.unions u
    ORDER BY coalesce(u.member_count, 0) DESC
    LIMIT 1;

  IF v_union IS NOT NULL THEN
    SELECT active_count INTO v_realtime
      FROM public.fn_batch_union_realtime_active_counts(ARRAY[v_union]);
    SELECT coalesce(active_count, 0) INTO v_reference
      FROM public.fn_union_active_player_counts(ARRAY[v_union]);

    IF coalesce(v_realtime, -1) <> coalesce(v_reference, 0) THEN
      RAISE EXCEPTION
        'union realtime count (%) disagrees with fn_union_active_player_counts (%) for union %',
        v_realtime, v_reference, v_union;
    END IF;
  END IF;
END;
$assert$;

COMMIT;
