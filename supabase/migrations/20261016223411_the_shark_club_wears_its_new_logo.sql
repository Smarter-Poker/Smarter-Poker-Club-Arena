-- @live-proof: (SELECT logo_url = '/hub/club-arena/images/shark-club-logo-v2.png' FROM public.clubs WHERE id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4') AND (SELECT avatar_url = '/hub/club-arena/images/shark-club-logo-v2.png' FROM public.social_pages WHERE id = 'eba7d82a-94dd-43b8-840d-1d547961174a')
-- 20261016223411_the_shark_club_wears_its_new_logo.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-16: "make sure you add the logo for shark club ... upload this
-- everywhere it should be including social media pages". Shark Club
-- (clubs a41434bb-8d0c-400a-8f0d-e8b3d65afed4, club_id 25450) had no
-- logo_url, so every surface fell back to the old bundled emblem, and its
-- club social page (social_pages eba7d82a-94dd-43b8-840d-1d547961174a)
-- still carried an older uploaded image. Both now name the new emblem,
-- shipped in the same change as public/images/shark-club-logo-v2.png and
-- served at /hub/club-arena/images/shark-club-logo-v2.png, the same pattern
-- Club JAQK uses (20260317_club_logos.sql).
--
-- Each row is changed only from the value read live on 2026-10-16; anything
-- else refuses, so a later owner upload is never overwritten by a replay.
-- No money, membership or permission changes.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $shark_logo$
DECLARE
  v_clubs int;
  v_pages int;
BEGIN
  UPDATE public.clubs
     SET logo_url = '/hub/club-arena/images/shark-club-logo-v2.png'
   WHERE id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
     AND logo_url IS NULL;
  GET DIAGNOSTICS v_clubs = ROW_COUNT;
  IF v_clubs <> 1 THEN
    RAISE EXCEPTION 'shark_club_logo_preimage_changed: clubs rows %', v_clubs;
  END IF;

  UPDATE public.social_pages
     SET avatar_url = '/hub/club-arena/images/shark-club-logo-v2.png',
         updated_at = now()
   WHERE id = 'eba7d82a-94dd-43b8-840d-1d547961174a'
     AND avatar_url = 'https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public/club-logos/eba7d82a-94dd-43b8-840d-1d547961174a/logo_v2.jpg';
  GET DIAGNOSTICS v_pages = ROW_COUNT;
  IF v_pages <> 1 THEN
    RAISE EXCEPTION 'shark_club_social_avatar_preimage_changed: social_pages rows %', v_pages;
  END IF;
END
$shark_logo$;

COMMIT;
