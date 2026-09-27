-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260501151438 "social_posts_audience_aware_rls"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 27329c928575a7e74e403c5235640300 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Compose V2 — audience-aware feed visibility
-- Replaces the permissive "Anyone can view posts" SELECT policy with one
-- that honors audience_mode + audience_list.

-- 1. Helper: are two users mutual friends? Returns TRUE if either direction
--    has status='accepted'. SECURITY DEFINER so it can read friendships
--    even when called from an RLS policy as a non-owner.
CREATE OR REPLACE FUNCTION public.fn_are_friends(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM friendships
    WHERE status = 'accepted'
      AND (
        (user_id = p_a AND friend_id = p_b)
        OR (user_id = p_b AND friend_id = p_a)
      )
  );
$$;
REVOKE ALL ON FUNCTION public.fn_are_friends FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_are_friends TO authenticated, anon;

-- 2. Helper: can the current viewer see this post? Returns TRUE if:
--   - the post is public (no audience_mode set OR public)
--   - the viewer is the author
--   - audience_mode='friends' AND viewer is a friend
--   - audience_mode='friends_except' AND viewer is a friend AND NOT in audience_list
--   - audience_mode='specific' AND viewer IS in audience_list
--   - audience_mode='only_me' AND viewer is the author (same as the author check above)
--   - audience_mode='custom' AND viewer IS in audience_list (same as specific)
--
-- The viewer is read from auth.uid() inside this function so the RLS
-- policy is a single-call expression.
CREATE OR REPLACE FUNCTION public.fn_can_view_post(
  p_author_id uuid,
  p_audience_mode text,
  p_audience_list text[]
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_viewer uuid;
  v_mode text;
BEGIN
  v_viewer := auth.uid();
  v_mode := COALESCE(p_audience_mode, 'public');

  -- Author always sees their own posts.
  IF v_viewer IS NOT NULL AND v_viewer = p_author_id THEN
    RETURN TRUE;
  END IF;

  IF v_mode = 'public' THEN
    RETURN TRUE;
  END IF;

  -- All non-public modes require the viewer to be authenticated.
  IF v_viewer IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_mode = 'only_me' THEN
    RETURN FALSE; -- author already returned above
  END IF;

  IF v_mode = 'friends' THEN
    RETURN public.fn_are_friends(v_viewer, p_author_id);
  END IF;

  IF v_mode = 'friends_except' THEN
    -- audience_list holds excluded user ids
    RETURN public.fn_are_friends(v_viewer, p_author_id)
       AND NOT (v_viewer::text = ANY(COALESCE(p_audience_list, '{}'::text[])));
  END IF;

  IF v_mode IN ('specific', 'custom') THEN
    RETURN v_viewer::text = ANY(COALESCE(p_audience_list, '{}'::text[]));
  END IF;

  -- Unknown mode: fail closed.
  RETURN FALSE;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_can_view_post FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_can_view_post TO authenticated, anon;

-- 3. Replace the SELECT policy with the audience-aware version.
DROP POLICY IF EXISTS "Anyone can view posts" ON public.social_posts;
CREATE POLICY "Audience-aware view"
  ON public.social_posts
  FOR SELECT
  USING (
    public.fn_can_view_post(author_id, audience_mode, audience_list)
  );
