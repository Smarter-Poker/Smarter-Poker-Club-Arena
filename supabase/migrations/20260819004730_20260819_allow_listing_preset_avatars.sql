-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819004730 "20260819_allow_listing_preset_avatars"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 beca5bcb4067029bf725fdcc19a8a43b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- The Choose Avatar gallery showed "Free (0)" and an empty grid.
--
-- CAUSE: storage.objects has exactly ONE SELECT policy -
--   "Authenticated users can list own objects in all buckets"
--   USING (owner = auth.uid())
-- The 436 preset avatars in social-media/avatars/ have owner = NULL (they were
-- seeded, not uploaded by a user). NULL = auth.uid() evaluates to NULL, which
-- is not TRUE, so every preset row is filtered out and .list() returns zero.
--
-- The bucket being PUBLIC only makes objects readable by direct URL - it does
-- not grant LIST. So the images were fetchable all along; the gallery simply
-- could never enumerate them.
--
-- FIX: a narrowly scoped SELECT policy that permits listing ONLY the preset
-- avatar prefix. Deliberately NOT the whole bucket: social-media holds 16,700
-- objects, the other ~16,264 of which are user posts/stories/messenger media
-- that must stay unlistable. Restricting to name LIKE 'avatars/%' exposes
-- exactly the set that is already public by URL, and nothing else.
--
-- anon is included so the avatar chooser also works pre-auth (signup flow).
-- ============================================================================

DO $$
DECLARE v_files bigint; v_owned bigint;
BEGIN
  SELECT count(*) INTO v_files FROM storage.objects
   WHERE bucket_id='social-media' AND name LIKE 'avatars/%';
  SELECT count(*) INTO v_owned FROM storage.objects
   WHERE bucket_id='social-media' AND name LIKE 'avatars/%' AND owner IS NOT NULL;

  IF v_files = 0 THEN
    RAISE EXCEPTION 'Pre-flight: no preset avatars under social-media/avatars/ - nothing to expose, investigate first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id='social-media' AND public) THEN
    RAISE EXCEPTION 'Pre-flight: social-media is not a public bucket - listing it would expose non-public data.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
     WHERE c.relname='objects' AND c.relnamespace='storage'::regnamespace
       AND p.polname='preset_avatars_are_listable'
  ) THEN
    RAISE EXCEPTION 'Pre-flight: policy already exists.';
  END IF;

  RAISE NOTICE 'Pre-flight: % preset avatars (% user-owned) will become listable.', v_files, v_owned;
END $$;

CREATE POLICY preset_avatars_are_listable
  ON storage.objects
  FOR SELECT
  TO authenticated, anon
  USING (bucket_id = 'social-media' AND name LIKE 'avatars/%');

DO $$
DECLARE v_visible bigint; v_leaked bigint;
BEGIN
  -- Verify AS a real client role that the presets are now listable...
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_visible FROM storage.objects
   WHERE bucket_id='social-media' AND name LIKE 'avatars/%';
  -- ...and that the rest of the bucket is still NOT.
  SELECT count(*) INTO v_leaked FROM storage.objects
   WHERE bucket_id='social-media' AND name NOT LIKE 'avatars/%';
  RESET ROLE;

  IF v_visible = 0 THEN
    RAISE EXCEPTION 'Post-apply: authenticated still cannot list preset avatars.';
  END IF;
  IF v_leaked > 0 THEN
    RAISE EXCEPTION 'Post-apply: LEAK - authenticated can list % non-avatar objects in social-media.', v_leaked;
  END IF;

  RAISE NOTICE 'Post-apply OK: % preset avatars listable, 0 other social-media objects exposed.', v_visible;
END $$;

-- ROLLBACK:
--   DROP POLICY preset_avatars_are_listable ON storage.objects;
--   (the avatar gallery returns to showing Free (0))
