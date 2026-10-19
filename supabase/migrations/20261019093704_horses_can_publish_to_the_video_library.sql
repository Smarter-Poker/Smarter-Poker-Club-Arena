-- 20261019093704_horses_can_publish_to_the_video_library.sql
--
-- HORSES CAN PUBLISH VIDEOS (Dan, 2026-10-19, verbatim: "HORSES CAN PUBLISH VIDEOS.")
--
-- WHAT WAS BROKEN, READ FROM PRODUCTION
--
-- public.fn_video_library_publisher_is_eligible(uuid) decides who may author
-- a Video Library row. It is the single test behind every door into the
-- library: publish_video_library_reel refuses an ineligible author, and the
-- triggers fn_guard_video_library_row_author (social_posts, social_reels) and
-- fn_guard_video_library_publisher_config (video_reels_pipeline_config)
-- refuse one at the row. It required
--
--     AND p.is_horse IS FALSE
--
-- so a horse could never publish to the library, whatever else held. That is
-- the exclusion CLAUDE.md 10.5 forbids ("HORSES ARE NEVER EVER DISCLUDED BY
-- DESIGN ON ANYTHING! THEY MUST ALWAYS BE TREATED LIKE REAL LIVE PLAYERS!"),
-- and Dan has now ruled on this one by name.
--
-- THE FIX. The is_horse condition is removed. A horse is eligible under
-- exactly the rules a human is: the profile exists and is not a
-- content_authors row. The two guard messages that described the rule as
-- "an existing non-horse profile" would now be false, so they say "an
-- existing profile"; their logic, error codes, constraint names and hints are
-- unchanged. Nothing else in the publish path excludes horses: the other
-- is_horse reads in it (publish_horse_video_reel, and the post-contract
-- trigger tagging a horse upload's origin_type 'horse') identify horses as
-- data and drive horse uploads, which 10.5 permits.
--
-- These functions were first written by the World Hub repository
-- (20260923120000_video_library_official_publisher.sql); this is the same
-- shared database. Every other byte is production's body (md5 of
-- pg_get_functiondef read 2026-10-19), grants are restated as production
-- holds them, and the closing block proves each post-image.
-- Pinned by tests/horses-can-publish-to-the-video-library.law.test.ts.
--
-- @live-proof: md5(pg_get_functiondef('public.fn_video_library_publisher_is_eligible(uuid)'::regprocedure)) = 'd537fb621ea283930feb325abade3637'

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preimage$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_video_library_publisher_is_eligible(uuid)','ace44a5cd2b2d41044ab999367499cdd','d537fb621ea283930feb325abade3637'),
    ('public.fn_guard_video_library_row_author()','0c50fd94f894af270c88e67fd1c4e391','fa09b212c7c477b2dd90381c4f7f5ac2'),
    ('public.fn_guard_video_library_publisher_config()','cbb36310383846a1a8de0c587cc2899e','5bbdc021a1ea0ea3dc571cb327a5cb89')
  ) AS v(sig, pre, post) LOOP
    v_md5 := md5(pg_get_functiondef(r.sig::regprocedure));
    IF v_md5 IS DISTINCT FROM r.pre AND v_md5 IS DISTINCT FROM r.post THEN
      RAISE EXCEPTION 'HORSE_VIDEO_PUBLISHER_PREIMAGE_CHANGED: % is %, expected % or %',
        r.sig, v_md5, r.pre, r.post;
    END IF;
  END LOOP;
END
$preimage$;

CREATE OR REPLACE FUNCTION public.fn_video_library_publisher_is_eligible(p_profile_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT p_profile_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.profiles p
       WHERE p.id = p_profile_id
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.content_authors ca
       WHERE ca.profile_id = p_profile_id
     );
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_video_library_row_author()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF NEW.origin_type = 'video_library'
     AND (
       TG_OP = 'INSERT'
       OR NEW.author_id IS DISTINCT FROM OLD.author_id
       OR OLD.origin_type IS DISTINCT FROM 'video_library'
     )
     AND NOT public.fn_video_library_publisher_is_eligible(NEW.author_id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'video_library_author_official_account',
      MESSAGE = format(
        'video_library %s rows must be authored by an existing profile with no content_authors row',
        TG_TABLE_NAME
      ),
      DETAIL = format(
        'rejected author_id = %s',
        COALESCE(NEW.author_id::text, 'NULL')
      ),
      HINT = 'Publish Video Library Reels through publish_video_library_reel as the official Smarter.Poker account 00000000-0000-0000-0000-000000000001.';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_video_library_publisher_config()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF NOT public.fn_video_library_publisher_is_eligible(
    NEW.video_library_publisher_profile_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'video_library_publisher_official_account',
      MESSAGE = 'video_library_publisher_profile_id must be an existing profile with no content_authors row',
      DETAIL = format(
        'rejected video_library_publisher_profile_id = %s',
        COALESCE(NEW.video_library_publisher_profile_id::text, 'NULL')
      ),
      HINT = 'The canonical Video Library publisher is the official Smarter.Poker account 00000000-0000-0000-0000-000000000001.';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_video_library_publisher_is_eligible(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_video_library_publisher_is_eligible(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_guard_video_library_row_author() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_guard_video_library_row_author() TO service_role;
REVOKE ALL ON FUNCTION public.fn_guard_video_library_publisher_config() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_guard_video_library_publisher_config() TO service_role;

DO $postimage$
DECLARE r record; v_md5 text; v_acl text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_video_library_publisher_is_eligible(uuid)','d537fb621ea283930feb325abade3637'),
    ('public.fn_guard_video_library_row_author()','fa09b212c7c477b2dd90381c4f7f5ac2'),
    ('public.fn_guard_video_library_publisher_config()','5bbdc021a1ea0ea3dc571cb327a5cb89')
  ) AS v(sig, post) LOOP
    v_md5 := md5(pg_get_functiondef(r.sig::regprocedure));
    IF v_md5 IS DISTINCT FROM r.post THEN
      RAISE EXCEPTION 'HORSE_VIDEO_PUBLISHER_POSTIMAGE_CHANGED: % is %, expected %', r.sig, v_md5, r.post;
    END IF;
    SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid=r.sig::regprocedure;
    IF v_acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
      RAISE EXCEPTION 'HORSE_VIDEO_PUBLISHER_ACL_CHANGED: % is %', r.sig, v_acl;
    END IF;
  END LOOP;
  IF position('is_horse' IN pg_get_functiondef(
       'public.fn_video_library_publisher_is_eligible(uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'HORSE_VIDEO_PUBLISHER_STILL_READS_IS_HORSE';
  END IF;
END
$postimage$;

COMMIT;
