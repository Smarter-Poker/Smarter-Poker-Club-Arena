-- ═══════════════════════════════════════════════════════════════════════════════
--  LIBRARY-ONLY AVATARS — move existing profile pictures onto library art
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan 2026-08-21: "they can now only use avatars."
--
-- The UI and the service guard stop NEW photos. This handles the players who
-- already have one, so the rule is actually true rather than true-going-forward.
--
-- THREE SHAPES EXIST, and a migration that only matched '/storage/' would miss
-- a third of them:
--   1. Club Arena upload      .../object/public/avatars/<uid>/avatar-<ts>.jpg
--   2. Hub upload             .../object/public/social-media/avatars/<uid>/...
--   3. OAuth provider photo   https://lh3.googleusercontent.com/...  (no storage
--                             path at all — this is what "Use Profile Photo"
--                             wrote, and it is why matching on bucket paths
--                             alone is not enough)
--
-- WHAT IS DELIBERATELY NOT TOUCHED
--   /avatars/...                      library art
--   .../custom-avatars/generated/...  AI art from a text prompt, not a photo
--   data:image/svg+xml...             the generated monogram
--   clubs.avatar_url, horses.avatar_url — different things entirely
--
-- REVERSIBLE BY CONSTRUCTION
-- Every old value is recorded in avatar_photo_migration_backup BEFORE anything
-- changes, so this can be undone exactly. The storage objects are left in place
-- for the same reason — deleting the buckets would make the rollback a lie.
-- The ROLLBACK block is at the bottom, written out, not described.

-- ═══════════════════════════════════════════════════════════════════════════════
-- STATUS 2026-08-22 — APPLIED, THEN ROLLED BACK. DO NOT RE-RUN BLINDLY.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- This migration ran in production on 2026-08-21 19:49:37Z. It backed up and
-- moved 17 human profiles onto library art, exactly as designed, and its own
-- assertion block confirmed zero remaining before it committed.
--
-- It has since been UNDONE. As of 2026-08-22 the state is:
--
--   avatar_photo_migration_backup   17 rows, all timestamped 19:49:37Z
--   profiles matching old_avatar_url   17   <- every one restored to its photo
--   profiles matching new_avatar_url    0
--   fn_is_photo_avatar                 absent
--   fn_pick_library_avatar             absent
--
-- That is the ROLLBACK block at the bottom of this file, executed, with the
-- two helper functions dropped afterwards. Deliberate, by somebody — nothing
-- in this repo does it automatically, and no other migration references these
-- objects.
--
-- So Dan's 2026-08-21 instruction ("they can now only use avatars") is true
-- going forward via the UI and service guards, and NOT true for the 17
-- accounts that already had a photo.
--
-- WHOEVER PICKS THIS UP: re-running this is a POLICY decision, not a repair.
-- Someone reversed it on purpose. Find out why before you re-apply it — and if
-- it is re-applied, work out what will stop it being reversed again, because
-- nothing here did.
--
-- Recorded rather than acted on:
-- .agent/audits/2026-08-22-money-path-sweep.md §4
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Backup table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.avatar_photo_migration_backup (
  user_id           uuid PRIMARY KEY,
  old_avatar_url    text NOT NULL,
  new_avatar_url    text NOT NULL,
  migrated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.avatar_photo_migration_backup IS
  'Pre-change avatar_url for every player moved off a profile picture on '
  '2026-08-21. Retained so the change is reversible; see the ROLLBACK block in '
  'supabase/migrations/20260821_library_only_avatars.sql.';

-- ─── 2. What counts as a photo ──────────────────────────────────────────────
--
-- AN ALLOW-LIST OF KNOWN PHOTO SHAPES, NOT "anything that is not library art".
--
-- The first draft of this was the inverse — treat anything unrecognised as a
-- photo — on the theory that a new bucket should fail safe. Surveying the
-- actual column showed that reasoning backwards. Of 602 profiles with an
-- avatar, that rule would have moved:
--
--   136  horse_avatar_*.png       AI PLAYERS. Not users, not photographs, and
--                                 re-skinning the fleet is not what was asked.
--    21  /smarter-poker-logo.png  a placeholder, not anybody's face
--
-- A deny-list is only safe when you know every shape in the column, and this
-- column has been written by four different code paths over a year. So: move
-- ONLY what has been positively identified as a user photograph. Anything
-- unrecognised is left exactly as it is, which is the failure mode you want
-- when the alternative is silently changing 157 accounts you did not mean to.
--
-- The three shapes below were each confirmed present before this was written.
CREATE OR REPLACE FUNCTION public.fn_is_photo_avatar(p_url text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    p_url IS NOT NULL
    AND p_url <> ''
    AND (
      -- 1. Club Arena's upload bucket: /object/public/avatars/<uid>/avatar-<ts>.<ext>
      p_url ~* '/object/public/avatars/[0-9a-f-]{36}/'
      -- 2. Hub upload: /social-media/avatars/<uuid>.<ext>, a bare uuid filename.
      --    Preset art in the same bucket is named {tier}_{slug}, and horse art
      --    is named horse_avatar_*, so neither matches this.
      OR p_url ~* '/social-media/avatars/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$'
      -- 3. OAuth provider photos — what "Use Profile Photo" wrote. These have
      --    no storage path at all, which is why a bucket-based rule misses them.
      OR p_url ~* '^https?://(lh3\.googleusercontent\.com|graph\.facebook\.com|pbs\.twimg\.com|.*\.gravatar\.com)/'
    )
$$;

COMMENT ON FUNCTION public.fn_is_photo_avatar(text) IS
  'True only for POSITIVELY IDENTIFIED user photographs: Club Arena uploads, '
  'Hub uploads (bare-uuid filename), and OAuth provider photos. Anything '
  'unrecognised returns false and is left alone - horse_avatar_* art and the '
  'smarter-poker-logo placeholder both live in this column and neither is a '
  'profile picture.';

-- ─── 3. Deterministic library pick ──────────────────────────────────────────
-- Seeded on the user id so a player gets the SAME avatar every time this runs,
-- and re-running cannot shuffle anybody. Uses the free tier only: assigning VIP
-- artwork to a non-VIP player would hand out a paid asset by accident.
CREATE OR REPLACE FUNCTION public.fn_pick_library_avatar(p_user_id uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '/avatars/table/free_' || slug || '@2x.webp'
  FROM (
    SELECT unnest(ARRAY[
      'android','aztec','business','chef','cowboy','cyborg','detective',
      'fox','geisha','knight','lion','musician'
    ]) AS slug
  ) s
  OFFSET (('x' || substr(md5(p_user_id::text), 1, 8))::bit(32)::bigint % 12)
  LIMIT 1
$$;

COMMENT ON FUNCTION public.fn_pick_library_avatar(uuid) IS
  'Stable free-tier library avatar for a user id. md5-seeded so it is the same '
  'on every run and cannot reshuffle an existing assignment.';

-- ─── 4. Record, then move ───────────────────────────────────────────────────
-- `NOT is_horse` is a second, independent belt. The allow-list above already
-- cannot match horse_avatar_* filenames, but horses are AI PLAYERS and nothing
-- about a profile-picture policy should ever reach them, so the intent is
-- stated rather than left as a consequence of a regex.
INSERT INTO public.avatar_photo_migration_backup (user_id, old_avatar_url, new_avatar_url)
SELECT p.id, p.avatar_url, public.fn_pick_library_avatar(p.id)
FROM public.profiles p
WHERE public.fn_is_photo_avatar(p.avatar_url)
  AND COALESCE(p.is_horse, false) = false
ON CONFLICT (user_id) DO NOTHING;

UPDATE public.profiles p
SET avatar_url = b.new_avatar_url
FROM public.avatar_photo_migration_backup b
WHERE p.id = b.user_id
  AND public.fn_is_photo_avatar(p.avatar_url)
  AND COALESCE(p.is_horse, false) = false;

-- user_avatars carried the same photo as a 'custom' row. Deactivate rather than
-- delete: the row is the player's avatar history, and history should not be
-- rewritten just because one entry is no longer selectable.
UPDATE public.user_avatars ua
SET is_active = false,
    updated_at = now()
FROM public.avatar_photo_migration_backup b
WHERE ua.user_id = b.user_id
  AND ua.custom_image_url IS NOT NULL
  AND public.fn_is_photo_avatar(ua.custom_image_url);

-- ─── 5. Assert ──────────────────────────────────────────────────────────────
-- Per .agent/workflows/migration-safety.md: fail loudly here rather than leave
-- a half-applied state that looks fine.
DO $$
DECLARE
  remaining integer;
  moved     integer;
  horses_hit integer;
BEGIN
  SELECT count(*) INTO remaining
  FROM public.profiles
  WHERE public.fn_is_photo_avatar(avatar_url)
    AND COALESCE(is_horse, false) = false;

  IF remaining > 0 THEN
    RAISE EXCEPTION
      'Migration incomplete: % human profiles still carry a photo avatar', remaining;
  END IF;

  -- Nothing belonging to an AI player may have been touched. If this ever
  -- fires, the allow-list matched something it should not have.
  SELECT count(*) INTO horses_hit
  FROM public.avatar_photo_migration_backup b
  JOIN public.profiles p ON p.id = b.user_id
  WHERE COALESCE(p.is_horse, false) = true;

  IF horses_hit > 0 THEN
    RAISE EXCEPTION
      'Refusing to complete: % horse profiles were migrated. Horses are AI '
      'players and are not in scope for a profile-picture policy.', horses_hit;
  END IF;

  SELECT count(*) INTO moved FROM public.avatar_photo_migration_backup;
  RAISE NOTICE 'Moved % profile pictures onto library art.', moved;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — restores every player to the exact photo they had.
-- Safe to run at any time; the storage objects were never deleted.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- BEGIN;
--
-- UPDATE public.profiles p
-- SET avatar_url = b.old_avatar_url
-- FROM public.avatar_photo_migration_backup b
-- WHERE p.id = b.user_id;
--
-- UPDATE public.user_avatars ua
-- SET is_active = true, updated_at = now()
-- FROM public.avatar_photo_migration_backup b
-- WHERE ua.user_id = b.user_id
--   AND ua.custom_image_url = b.old_avatar_url;
--
-- -- Leave the backup table in place; it is the record of what happened.
-- COMMIT;
