-- 20260908031934_a_public_author_row_does_not_say_horse_and_realtime_does_not_broadcast_is_bot
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-08 UTC.
--
-- ═══════════════════════════════════════════════════════════════════════════════
--  TWO MORE TELLS: A PUBLIC AUTHOR ROW, AND A REALTIME PAYLOAD
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-02, binding: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT
-- OUR CODE OR USE A DEVELOPER TOOL AND FIND THIS OUT."
--
-- The 2026-09-08 avatar pass repointed `profiles.avatar_url` off the
-- horse-named storage paths. It missed the OTHER table those same generators
-- write, and the leak there is worse because the table is world-readable.
--
-- 1. `content_authors` carries `profile_id` and `avatar_url`, has RLS with the
--    policy "Public can read authors" (role `public`), and 577 of its 1,039
--    rows still pointed at `social-media/horse-avatars-v2/...` or
--    `social-media/avatars/horse_avatar_...`. So a SIGNED-OUT reader could
--    `select profile_id, avatar_url from content_authors` and read 538 profile
--    UUIDs whose picture is filed under "horse", plus 39 more authors named
--    the same way with no profile at all. That is the roster, in public, in
--    one query.
--
--    Every row is repointed to the copy already verified readable at the human
--    convention: `avatars/<profile uuid>/avatar.<ext>` where the author has a
--    profile, and `avatars/author-<id>/avatar.<ext>` where it does not (39
--    rows; `scripts/ops/copy-horse-avatars-to-neutral-paths.mjs` handles the
--    profile-keyed ones, the author-keyed copies were made the same way and
--    each destination answered 200 before this ran).
--
-- 2. `club_members` was in the `supabase_realtime` publication with ALL 46
--    columns, `is_bot` among them - and `is_bot` is `profiles.is_horse`
--    mirrored by trigger (`fn_club_members_bot_follows_horse`; 1,903 rows, all
--    1,000 horses, no human). A COLUMN GRANT DOES NOT FILTER A REALTIME
--    PAYLOAD. That is exactly the lesson `profiles` taught on 2026-09-02, when
--    the publication was broadcasting `is_horse` to every profile subscriber
--    while the column grant said no. The publication now names 45 columns and
--    omits `is_bot`, the same shape used for `profiles` and `table_seats`.
--
--    This does NOT depend on the client: a publication column list changes
--    what is broadcast, it cannot fail a query. The separate column-GRANT
--    change for `club_members.is_bot` still waits on #3643 to be serving.
--
-- PROBED (rolled back, one self-aborting DO block):
--   content_authors repointed=577; left=0; realtime is_bot=false cols=45
--
-- ALTER PUBLICATION is DDL and fires one PostgREST reload (~28s). One
-- transaction, per the production DDL policy.

BEGIN;

UPDATE public.content_authors ca
   SET avatar_url =
         'https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public/avatars/'
         || CASE WHEN ca.profile_id IS NOT NULL THEN ca.profile_id::text
                 ELSE 'author-' || ca.id::text END
         || '/avatar.' || lower(regexp_replace(ca.avatar_url, '^.*\.([A-Za-z0-9]+)$', '\1'))
 WHERE ca.avatar_url ~* 'horse-avatars|horse_avatar'
   /* Never point a row at an object that is not there: the copy must already
      exist and have answered before this row moves. */
   AND EXISTS (
     SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'avatars'
        AND o.name = (CASE WHEN ca.profile_id IS NOT NULL THEN ca.profile_id::text
                           ELSE 'author-' || ca.id::text END)
                     || '/avatar.' || lower(regexp_replace(ca.avatar_url, '^.*\.([A-Za-z0-9]+)$', '\1'))
   );

DO $$
DECLARE v_cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'club_members'
     AND column_name <> 'is_bot';
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'club_members has no columns other than is_bot?';
  END IF;
  EXECUTE format('ALTER PUBLICATION supabase_realtime SET TABLE public.club_members (%s)', v_cols);
END $$;

DO $$
DECLARE v_left int; v_has boolean; v_n int;
BEGIN
  SELECT count(*) INTO v_left FROM public.content_authors
   WHERE avatar_url ~* 'horse-avatars|horse_avatar';
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'POST-FLIGHT: % public author rows still carry a horse-named avatar', v_left;
  END IF;

  SELECT attnames::text[] @> array['is_bot'], array_length(attnames, 1)
    INTO v_has, v_n
    FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime' AND tablename = 'club_members';
  IF v_has IS NULL THEN
    RAISE EXCEPTION 'POST-FLIGHT: club_members left the realtime publication entirely';
  END IF;
  IF v_has THEN
    RAISE EXCEPTION 'POST-FLIGHT: realtime still broadcasts club_members.is_bot';
  END IF;
  IF v_n < 40 THEN
    RAISE EXCEPTION 'POST-FLIGHT: the club_members column list collapsed to % columns', v_n;
  END IF;
END $$;

COMMIT;
