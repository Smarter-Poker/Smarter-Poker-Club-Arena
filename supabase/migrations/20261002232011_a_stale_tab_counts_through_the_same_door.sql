-- ============================================================================
-- A STALE TAB COUNTS THROUGH THE SAME DOOR
-- ============================================================================
--
-- 20261002223109_a_counter_is_not_a_public_write took the four raw counters
-- (increment_/decrement_reel_count, increment_/decrement_post_count) away from
-- every browser role and gave the browser fn_count_content_engagement: one view
-- or one share, for auth.uid(), at most once a day per content.
--
-- The World Hub reels pages still call the old names for a view and a share,
-- and so does every tab a player already has open. Those calls now fail with
-- 42501 and are swallowed by the page's catch, so a view or a share by a real
-- player stopped counting at all. That is not the outcome phase 3 wanted:
-- the defect was that a browser could write ANY count in ANY direction for
-- ANYONE, not that a browser could report its own view.
--
-- So the four names keep their signatures and their server behaviour, and
-- decide by who is calling, the way the definer-exposure audit asks
-- (COALESCE(auth.role(), 'service_role') = 'service_role', never current_user):
--
--   * the service role (World Hub API routes, the horse social engine) and a
--     session with no request at all: the body is unchanged, byte for byte;
--   * a browser asking for view_count or share_count on the increment: it is
--     the caller's own view or share, so it goes through
--     fn_count_content_engagement - the same receipt, the same once-a-day key,
--     auth.uid() as the subject;
--   * a browser asking for anything else (a like, a comment, any decrement):
--     refused with 42501. Like and comment counts are kept by the triggers on
--     social_likes and social_comments; the two browser comment-delete
--     handlers that also called decrement_post_count were counting every
--     delete twice, and now they count it once.
--
-- anon stays out: an anonymous visitor's view was never countable (the reel
-- counter was never granted to anon, and the post counter under anon's RLS
-- changed nothing), and it has no auth.uid() to key a receipt on.
--
-- The server bodies are the pinned live text: each replacement asserts the
-- md5 of pg_get_functiondef before it runs and aborts if the live function
-- moved. Nothing is backfilled and nothing is repaired (CLAUDE.md 10.12).
--
-- THE REEL BODIES ARE 20261002225448'S, WORD FOR WORD. That migration
-- (#5878, restored by #5886 as the text that ran) reached the same two reel
-- routines with a signed-in-viewer and kept-counter check of its own. The
-- reel bodies below carry those checks beside this file's once-a-day receipt
-- and no browser decrement, and 225448's file holds the same two bodies.
--
-- PRODUCTION AND A REBUILD RUN THE TWO FILES IN OPPOSITE ORDERS. Production
-- applied this file first (schema_migrations 20261002232315) and 225448 second
-- (20261002232859). A rebuild runs them by file version: 225448 first, then
-- this file. So the pin below accepts, per routine, either the pre-image this
-- file first replaced or this file's own result (identical to what 225448
-- leaves: pg_get_functiondef carries no COMMENT). Anything else still aborts.
-- That is the only difference from the text recorded at 20261002232315, and
-- it makes no difference to a database that ran it. Both orders end on the
-- same four definitions; the harness runs both.
--
-- @live-proof: (SELECT has_function_privilege('authenticated', 'public.increment_reel_count(uuid,text)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.increment_reel_count(uuid,text)', 'EXECUTE') AND (SELECT prosrc LIKE '%fn_count_content_engagement%' FROM pg_proc WHERE oid = 'public.increment_post_count(uuid,text)'::regprocedure))

BEGIN;
SET LOCAL lock_timeout = '2s';

DO $pins$
DECLARE
  -- Each routine must be the pinned pre-image, or already exactly what this
  -- file writes (the post-image, measured on production after the apply).
  v_expected CONSTANT jsonb := jsonb_build_object(
    'public.increment_reel_count(uuid,text)', jsonb_build_array('23f843d6fb8c218559dfed7ad59f8421', '320e296097947b7d2b8046de486eeefb'),
    'public.decrement_reel_count(uuid,text)', jsonb_build_array('2f3f5d1cf59b0645aaee4951943dec6c', '134cd0b4b7ec6f3275541bf101869d57'),
    'public.increment_post_count(uuid,text)', jsonb_build_array('4dab81e6b5c5eed82f71ab751a07a54e', '8c24e53c088acfa607cf9ffa3c636be2'),
    'public.decrement_post_count(uuid,text)', jsonb_build_array('6e8206b74bc797839782a9017bb94570', '211f5a4ce3d048732300767d815bf661'));
  k text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(v_expected) LOOP
    IF NOT (v_expected -> k) ? md5(pg_get_functiondef(k::regprocedure)) THEN
      RAISE EXCEPTION 'COUNTER_MOVED_UNDERNEATH: % is neither the pinned pre-image nor this file''s result', k;
    END IF;
  END LOOP;
END
$pins$;

CREATE OR REPLACE FUNCTION public.increment_reel_count(p_reel_id uuid, p_field text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions'
AS $function$
DECLARE
  v_target uuid;
  v_request_role text := NULLIF(btrim(COALESCE(auth.role(), '')), '');
BEGIN
  IF p_field IS NULL OR NOT (p_field = ANY(ARRAY['like_count','comment_count','share_count','view_count']::text[])) THEN
    RAISE EXCEPTION 'increment_reel_count: invalid field %', p_field;
  END IF;
  -- A browser reports its own view or share, once a day, and nothing else.
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    IF v_request_role IN ('anon', 'authenticated') THEN
      IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'increment_reel_count: a signed-in viewer is required'
          USING ERRCODE = '42501';
      END IF;
    END IF;
    IF p_field NOT IN ('share_count', 'view_count') THEN
      RAISE EXCEPTION 'increment_reel_count: % is kept from social_likes/social_comments, not from a browser', p_field
        USING ERRCODE = '42501';
    END IF;
    IF p_field = 'view_count' THEN
      PERFORM public.fn_count_content_engagement(p_reel_id, 'view', 'reels');
    ELSIF p_field = 'share_count' THEN
      PERFORM public.fn_count_content_engagement(p_reel_id, 'share', 'reels');
    ELSE
      RAISE EXCEPTION 'increment_reel_count: % is not a browser''s to write', p_field USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;
  SELECT COALESCE(a.canonical_reel_id, p_reel_id) INTO v_target
  FROM (SELECT 1) seed
  LEFT JOIN public.social_reel_aliases a ON a.alias_reel_id = p_reel_id;
  EXECUTE format(
    'UPDATE public.social_reels SET %I = GREATEST(COALESCE(%I, 0) + 1, 0) WHERE id = $1',
    p_field, p_field
  ) USING v_target;
END
$function$;

CREATE OR REPLACE FUNCTION public.decrement_reel_count(p_reel_id uuid, p_field text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions'
AS $function$
DECLARE
  v_target uuid;
  v_request_role text := NULLIF(btrim(COALESCE(auth.role(), '')), '');
BEGIN
  IF p_field IS NULL OR NOT (p_field = ANY(ARRAY['like_count','comment_count','share_count','view_count']::text[])) THEN
    RAISE EXCEPTION 'decrement_reel_count: invalid field %', p_field;
  END IF;
  -- A browser never takes a count down: the view or share it reported is a
  -- receipt, and like and comment counts are the triggers' to keep.
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    IF v_request_role IN ('anon', 'authenticated') THEN
      IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'decrement_reel_count: a signed-in viewer is required'
          USING ERRCODE = '42501';
      END IF;
    END IF;
    IF p_field NOT IN ('share_count', 'view_count') THEN
      RAISE EXCEPTION 'decrement_reel_count: % is kept from social_likes/social_comments, not from a browser', p_field
        USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'decrement_reel_count: a count is not a browser''s to take down' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(a.canonical_reel_id, p_reel_id) INTO v_target
  FROM (SELECT 1) seed
  LEFT JOIN public.social_reel_aliases a ON a.alias_reel_id = p_reel_id;
  EXECUTE format(
    'UPDATE public.social_reels SET %I = GREATEST(COALESCE(%I, 0) - 1, 0) WHERE id = $1',
    p_field, p_field
  ) USING v_target;
END
$function$;

CREATE OR REPLACE FUNCTION public.increment_post_count(p_post_id uuid, p_field text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  _allowed_fields text[] := ARRAY[
    'like_count', 'comment_count', 'share_count', 'view_count'
  ];
BEGIN
  -- A browser reports its own view or share, once a day, and nothing else.
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    IF p_field = 'view_count' THEN
      PERFORM public.fn_count_content_engagement(p_post_id, 'view', 'posts');
    ELSIF p_field = 'share_count' THEN
      PERFORM public.fn_count_content_engagement(p_post_id, 'share', 'posts');
    ELSE
      RAISE EXCEPTION 'increment_post_count: % is not a browser''s to write', p_field USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;
  -- Allowlist guard: reject arbitrary column names
  IF NOT (p_field = ANY(_allowed_fields)) THEN
    RAISE EXCEPTION 'increment_post_count: invalid field %', p_field;
  END IF;

  EXECUTE format(
    'UPDATE public.social_posts SET %I = GREATEST(COALESCE(%I, 0) + 1, 0) WHERE id = $1',
    p_field, p_field
  ) USING p_post_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.decrement_post_count(p_post_id uuid, p_field text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  _allowed_fields text[] := ARRAY[
    'like_count', 'comment_count', 'share_count', 'view_count'
  ];
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'decrement_post_count: a count is not a browser''s to take down' USING ERRCODE = '42501';
  END IF;
  IF NOT (p_field = ANY(_allowed_fields)) THEN
    RAISE EXCEPTION 'decrement_post_count: invalid field %', p_field;
  END IF;

  EXECUTE format(
    'UPDATE public.social_posts SET %I = GREATEST(COALESCE(%I, 0) - 1, 0) WHERE id = $1',
    p_field, p_field
  ) USING p_post_id;
END;
$function$;

-- CREATE OR REPLACE keeps each function's ACL; these name it again so the
-- file states the whole grant. PUBLIC and anon stay out.
REVOKE ALL ON FUNCTION public.increment_reel_count(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decrement_reel_count(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.increment_post_count(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decrement_post_count(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_reel_count(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decrement_reel_count(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.increment_post_count(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decrement_post_count(uuid, text) TO authenticated, service_role;

COMMIT;
