-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260426013732 "20260426080000_hg_unread_count_excludes_hidden_posts"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b6373ec2395cfe756b8c771f65dfd406 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG FIX: get_home_group_unread_count counted hidden posts.
--
-- The COUNT(*) had no is_hidden filter. So if a host moderates a post,
-- the unread badge for non-author non-staff members would still include
-- that hidden post, but the post wouldn't appear in their feed.
-- Result: "3 new posts" badge but only 2 visible posts. UX bug.
--
-- Fix: exclude hidden posts from the unread tally for non-staff non-author
-- viewers. Staff and the post author still see them counted (matching
-- their feed visibility).

CREATE OR REPLACE FUNCTION public.get_home_group_unread_count(
  p_group_id uuid,
  p_caller_user_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_last_read timestamptz;
  v_count int;
  v_is_staff boolean;
BEGIN
  IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  SELECT last_read_posts_at INTO v_last_read
    FROM commander_home_members
   WHERE group_id = p_group_id
     AND user_id = p_caller_user_id
     AND status = 'approved';
  IF NOT FOUND THEN RETURN 0; END IF;

  v_is_staff := public.fn_home_is_group_staff(p_caller_user_id, p_group_id);

  SELECT COUNT(*) INTO v_count
    FROM commander_home_posts
   WHERE group_id = p_group_id
     AND created_at > COALESCE(v_last_read, '1970-01-01'::timestamptz)
     AND author_id <> p_caller_user_id
     AND (
       COALESCE(is_hidden, false) = false  -- visible posts always counted
       OR v_is_staff                       -- staff: include hidden in their badge too
     );

  RETURN COALESCE(v_count, 0);
END;
$$;
