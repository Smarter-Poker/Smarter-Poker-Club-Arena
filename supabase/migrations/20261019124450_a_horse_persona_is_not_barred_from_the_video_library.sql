-- 20261019124450_a_horse_persona_is_not_barred_from_the_video_library.sql
--
-- HORSES CAN PUBLISH VIDEOS, PART TWO (Dan, 2026-10-19, verbatim: "HORSES CAN PUBLISH VIDEOS.")
--
-- 20261019093704 removed `p.is_horse IS FALSE` from
-- public.fn_video_library_publisher_is_eligible. Read back on production
-- straight after it installed, the number of horses that rule admits was
-- still ZERO. The rule's other clause,
--
--     AND NOT EXISTS (SELECT 1 FROM public.content_authors ca
--                      WHERE ca.profile_id = p_profile_id)
--
-- is the same exclusion by another name. content_authors is the horse persona
-- roster: on 2026-10-19 it held 1,039 rows, 1,000 of them the 1,000 horse
-- profiles, 39 with no profile at all, and not one human. Every horse has a
-- row and no human does, so "not a content author" meant exactly "not a
-- horse". CLAUDE.md 10.5 names this shape: "THERE IS NO 'EQUAL OUTCOME BY A
-- DIFFERENT MECHANISM' EXEMPTION", and the test is "is it identical".
--
-- THE FIX. The content_authors clause is removed. The rule is now the one
-- rule for everybody: the profile exists. content_authors stays what 10.5
-- allows it to be, data that identifies a persona (it is still read by
-- publish_horse_video_reel to drive horse uploads), and it no longer denies
-- anything. The two guard messages drop "with no content_authors row" so
-- they say what the rule is. Codes, constraint names and hints are unchanged.
--
-- WHAT STILL GUARDS THE LIBRARY, unchanged and not horse-specific:
-- publish_video_library_reel requires the service role, both pipeline
-- controls enabled, and an author equal to
-- video_reels_pipeline_config.video_library_publisher_profile_id (today the
-- official account 00000000-0000-0000-0000-000000000001). The managed
-- provenance and visibility guards require that publisher's transaction-local
-- proof. A horse becomes a library author exactly as a human would, by being
-- configured as the publisher, and in no other way.
--
-- Pre-images are this database's live text (the post-images of
-- 20261019093704, read 2026-10-19). Grants are restated as production holds
-- them, and the closing block proves each post-image and that the rule now
-- admits every horse profile. Pinned by
-- tests/horses-can-publish-to-the-video-library.law.test.ts.
--
-- @live-proof: md5(pg_get_functiondef('public.fn_video_library_publisher_is_eligible(uuid)'::regprocedure)) = '6e6119e2372a378ab5055d3c314dfa97'

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preimage$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_video_library_publisher_is_eligible(uuid)','d537fb621ea283930feb325abade3637','6e6119e2372a378ab5055d3c314dfa97'),
    ('public.fn_guard_video_library_row_author()','fa09b212c7c477b2dd90381c4f7f5ac2','8334d458567e670abccc37d7fcf5db4c'),
    ('public.fn_guard_video_library_publisher_config()','5bbdc021a1ea0ea3dc571cb327a5cb89','8a1ff8282519f86679582fbf309f5e14')
  ) AS v(sig, pre, post) LOOP
    v_md5 := md5(pg_get_functiondef(r.sig::regprocedure));
    IF v_md5 IS DISTINCT FROM r.pre AND v_md5 IS DISTINCT FROM r.post THEN
      RAISE EXCEPTION 'HORSE_PERSONA_VIDEO_PREIMAGE_CHANGED: % is %, expected % or %',
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
        'video_library %s rows must be authored by an existing profile',
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
      MESSAGE = 'video_library_publisher_profile_id must be an existing profile',
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
DECLARE r record; v_md5 text; v_acl text; v_refused bigint;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_video_library_publisher_is_eligible(uuid)','6e6119e2372a378ab5055d3c314dfa97'),
    ('public.fn_guard_video_library_row_author()','8334d458567e670abccc37d7fcf5db4c'),
    ('public.fn_guard_video_library_publisher_config()','8a1ff8282519f86679582fbf309f5e14')
  ) AS v(sig, post) LOOP
    v_md5 := md5(pg_get_functiondef(r.sig::regprocedure));
    IF v_md5 IS DISTINCT FROM r.post THEN
      RAISE EXCEPTION 'HORSE_PERSONA_VIDEO_POSTIMAGE_CHANGED: % is %, expected %', r.sig, v_md5, r.post;
    END IF;
    SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid=r.sig::regprocedure;
    IF v_acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
      RAISE EXCEPTION 'HORSE_PERSONA_VIDEO_ACL_CHANGED: % is %', r.sig, v_acl;
    END IF;
  END LOOP;
  -- The outcome, not just the text: no horse profile is refused.
  SELECT count(*) INTO v_refused FROM public.profiles p
   WHERE p.is_horse IS TRUE AND NOT public.fn_video_library_publisher_is_eligible(p.id);
  IF v_refused <> 0 THEN
    RAISE EXCEPTION 'HORSE_PERSONA_VIDEO_STILL_REFUSES_HORSES: %', v_refused;
  END IF;
END
$postimage$;

COMMIT;
