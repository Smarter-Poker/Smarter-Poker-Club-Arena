-- 20260903051036_the_union_card_counts_its_own_tables_again.sql
-- RECOVERED 2026-09-03 from supabase_migrations.schema_migrations.
-- This migration was APPLIED to production on 2026-09-03 at 05:10:36 UTC but was never committed, so the repo
-- could not reproduce the database and applied-migrations-recorded.yml was red.
-- The body below is the exact SQL the database recorded; it is NOT a
-- reconstruction. Re-applying it is a no-op - it is already in production.

CREATE OR REPLACE FUNCTION public.fn_batch_union_realtime_active_counts(p_union_ids uuid[])
RETURNS TABLE(union_id uuid, active_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  WITH union_club_ids AS (
    SELECT uc.union_id, uc.club_id
      FROM public.union_clubs uc
     WHERE uc.union_id = ANY(p_union_ids)
    UNION
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

  IF position('c.union_id = ANY(p_union_ids)' IN v_src) = 0 THEN
    RAISE EXCEPTION 'the union realtime count no longer reads the union''s own club row';
  END IF;

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