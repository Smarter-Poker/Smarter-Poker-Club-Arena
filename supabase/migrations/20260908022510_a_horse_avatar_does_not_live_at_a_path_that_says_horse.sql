-- 20260908022510_a_horse_avatar_does_not_live_at_a_path_that_says_horse
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-08 UTC.
--
-- ═══════════════════════════════════════════════════════════════════════════════
--  A HORSE'S AVATAR DOES NOT LIVE AT A PATH THAT SAYS "HORSE"
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-02, binding: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT
-- OUR CODE OR USE A DEVELOPER TOOL AND FIND THIS OUT."
--
-- Measured 2026-09-07: 541 of the 1,000 horse profiles carried an
-- `avatar_url` under `social-media/horse-avatars-v2/...` or
-- `social-media/avatars/horse_avatar_<name>_<ts>.png`. No human profile has
-- either. That URL is the `src` of the <img> on every seat, every social
-- post, every friend card and every messenger thread: it sits in the
-- Elements panel and the Network tab of any tab that renders the player. The
-- flag was spelled out in the address of the picture.
--
-- WHAT THIS DOES. `scripts/ops/copy-horse-avatars-to-neutral-paths.mjs`
-- copied each of the 536 distinct referenced objects to the convention human
-- uploads already use - bucket `avatars`, key `<profile uuid>/avatar.<ext>` -
-- and verified every destination answers 200 (541 copied, 0 failed). This
-- migration repoints the 541 `profiles.avatar_url` values to those copies and
-- asserts the count before and after. `arena_avatar_url` (the felt avatar,
-- already a neutral `/avatars/table/...` library path) is untouched.
--
-- It also strips the dead `_snapshot` / `snapshot` keys from `tables.settings`
-- on INACTIVE tables whose snapshot text names a horse (185 rows, none
-- active). Nothing in server/src or the database writes or reads those keys
-- any more - a client-era leftover - and `tables` is player-readable, so a
-- reader could pull "displayName": "Horse 63a2c2" and the old avatar path
-- out of them.
--
-- THE ORIGINALS ARE NOT DELETED. A tab that already holds the old URL keeps
-- rendering; the `horse-avatars-v2/` and `avatars/horse_avatar_*` objects are
-- removed by a later pass once nothing references them. The World Hub
-- generators that WROTE horse-named files (`HorseAvatarGenerator.js`,
-- `uploadGeneratedAvatars.js`) are changed in the same programme so no new
-- ones appear.
--
-- Nothing here is DDL; no PostgREST reload. One transaction regardless.

BEGIN;

-- The destination is DERIVED, not listed: bucket `avatars`, key
-- `<profile uuid>/avatar.<same extension>`. That is exactly what the copy
-- script wrote, and `storage.objects` is the proof it wrote it - every
-- target is required to exist there before a single profile is touched.
CREATE TEMP TABLE pg_temp.horse_avatar_moves AS
SELECT p.id,
       p.avatar_url AS old_url,
       p.id::text || '/avatar.' || lower(regexp_replace(p.avatar_url, '^.*\.([A-Za-z0-9]+)$', '\1')) AS new_key
  FROM public.profiles p
 WHERE p.is_horse
   AND p.avatar_url ~ 'horse-avatars|horse_avatar';

DO $$
DECLARE v_n int; v_missing int; v_badext int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_temp.horse_avatar_moves;
  IF v_n <> 541 THEN
    RAISE EXCEPTION 'PRE-FLIGHT: 541 horse profiles carried a horse-named avatar when this was written, % do now - re-run the copy script first', v_n;
  END IF;
  SELECT count(*) INTO v_badext FROM pg_temp.horse_avatar_moves WHERE new_key !~ '/avatar\.(jpg|jpeg|png|webp)$';
  IF v_badext <> 0 THEN
    RAISE EXCEPTION 'PRE-FLIGHT: % avatar urls have an extension this migration does not expect', v_badext;
  END IF;
  SELECT count(*) INTO v_missing
    FROM pg_temp.horse_avatar_moves m
   WHERE NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'avatars' AND o.name = m.new_key);
  IF v_missing <> 0 THEN
    RAISE EXCEPTION 'PRE-FLIGHT: % destination objects are not in storage.objects - the copy did not land, refusing to repoint', v_missing;
  END IF;
END $$;

-- Lock the rows in id order first. The engine updates horse profiles one
-- row at a time (status, last_seen) and the first attempt deadlocked against
-- it (40P01); taking the locks in a fixed order cannot deadlock with a
-- single-row updater.
DO $$
BEGIN
  PERFORM 1 FROM public.profiles p
   WHERE p.id IN (SELECT id FROM pg_temp.horse_avatar_moves)
   ORDER BY p.id
     FOR UPDATE;
END $$;

UPDATE public.profiles p
   SET avatar_url = 'https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public/avatars/' || m.new_key,
       updated_at = now()
  FROM pg_temp.horse_avatar_moves m
 WHERE p.id = m.id;

UPDATE public.tables
   SET settings = settings - '_snapshot' - 'snapshot'
 WHERE status <> 'active'
   AND (settings ? '_snapshot' OR settings ? 'snapshot')
   AND (COALESCE(settings->>'_snapshot','') || COALESCE(settings->>'snapshot','')) ~* 'horse';

DO $$
DECLARE v_left int; v_moved int; v_snap int;
BEGIN
  SELECT count(*) INTO v_left FROM public.profiles WHERE is_horse AND avatar_url ~ 'horse-avatars|horse_avatar';
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'POST-FLIGHT: % horse profiles still carry a horse-named avatar', v_left;
  END IF;
  SELECT count(*) INTO v_moved
    FROM public.profiles p JOIN pg_temp.horse_avatar_moves m ON m.id = p.id
   WHERE p.avatar_url = 'https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public/avatars/' || m.new_key;
  IF v_moved <> 541 THEN
    RAISE EXCEPTION 'POST-FLIGHT: only % of 541 profiles point at their copy', v_moved;
  END IF;
  SELECT count(*) INTO v_snap FROM public.tables
   WHERE status <> 'active'
     AND (COALESCE(settings->>'_snapshot','') || COALESCE(settings->>'snapshot','')) ~* 'horse';
  IF v_snap <> 0 THEN
    RAISE EXCEPTION 'POST-FLIGHT: % inactive tables still carry a horse-naming snapshot', v_snap;
  END IF;
END $$;

DROP TABLE pg_temp.horse_avatar_moves;

COMMIT;
