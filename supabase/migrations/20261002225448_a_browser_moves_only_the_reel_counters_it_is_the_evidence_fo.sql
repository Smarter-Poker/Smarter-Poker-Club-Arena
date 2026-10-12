-- 20261002225448_a_browser_moves_only_the_reel_counters_it_is_the_evidence_fo.sql
--
-- THIS FILE IS THE TEXT THAT RAN. Installed as schema_migrations version
-- 20261002232859 at 23:28:59Z on 2026-10-02 (md5 of
-- array_to_string(statements, E';\n') = bffd1d417d4472e9bccebd84ebab8e7f, 4546
-- bytes, byte-identical to everything below this header).
--
-- WHY IT DOES NOT LOOK LIKE WHAT #5878 MERGED
--
-- Telemetry Exposure run 37071022389 found increment_reel_count and
-- decrement_reel_count SECURITY DEFINER, executable by `authenticated`, and
-- blind to the caller: one logged-in account could move any reel's like,
-- comment, share or view count on anybody's reel, because a definer bypasses
-- the "Users can update own reels" policy. All nine browser call sites in the
-- World Hub (pages/hub/reels.js:1535,2153,2212,
-- src/components/social/Reels.jsx:726,1788,1847,
-- src/components/social/ReelsFeedCarousel.jsx:1642,1679,1802) pass view_count
-- or share_count and always +1; like_count and comment_count are kept by
-- trg_sync_like_count on social_likes and trig_update_reel_comment_count on
-- social_comments.
--
-- #5876 landed its own answer in the same half hour: fn_count_content_engagement,
-- which records one view or one share for auth.uid() at most once a day per
-- piece of content. The two fixes are the same fix at different depths, so the
-- install RECONCILED them rather than letting the later version win - a browser
-- caller is admitted the same way this file admits it, and is then routed
-- through #5876's receipt door instead of writing the column itself. A browser
-- never decrements at all.
--
-- The reconciliation is the reason this file is edited rather than reverted:
-- what the database runs and what the repository says must be the same text
-- (scripts/ci/check-applied-migrations-are-recorded.mjs), and a Midway Union
-- rebuild reads these files.
--
-- NOTHING WAS WIDENED. `authenticated` keeps exactly the EXECUTE it held before
-- Telemetry Exposure ever reported this; PUBLIC and anon hold nothing.
--
-- THIS FUNCTION'S SOURCE OF TRUTH LIVES IN THE WORLD HUB. If you edit these
-- routines there, keep the caller check and the receipt door: without them Club
-- Arena's Telemetry Exposure goes red again, which is how the hole was found.
--
-- @live-proof: (SELECT count(*) = 2 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('increment_reel_count','decrement_reel_count') AND p.prosrc LIKE '%auth.uid()%' AND p.prosrc LIKE '%fn_count_content_engagement%' AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))

-- 20261002225448_a_browser_moves_only_the_reel_counters_it_is_the_evidence_fo (reconciled with phase 3; full header in the repository file)
BEGIN;
SET LOCAL lock_timeout = '2s';

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

REVOKE ALL ON FUNCTION public.increment_reel_count(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decrement_reel_count(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_reel_count(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decrement_reel_count(uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.increment_reel_count(uuid, text) IS
  'Atomic reel engagement counter. A browser caller must be a signed-in viewer and may add only its own view or share, at most once a day per reel, through fn_count_content_engagement; like_count and comment_count are kept by the triggers on social_likes and social_comments and are service-side only. See 20261002225448 and 20261002232011.';
COMMENT ON FUNCTION public.decrement_reel_count(uuid, text) IS
  'Atomic reel engagement counter. Service-side only: a browser caller never takes a count down. See 20261002225448 and 20261002232011.';

COMMIT;
