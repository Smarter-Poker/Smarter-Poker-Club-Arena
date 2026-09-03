-- The Club Messages surface has been dead in production, both directions.
--
-- Found 2026-09-03 by calling every RPC behind Table Management as the club
-- owner and reading what came back. Surface 03 answered:
--
--   ERROR: column a.updated_at does not exist
--
-- public.club_announcements has fourteen columns and updated_at is not one of
-- them. Both sides of the feature reference it anyway:
--
--   fn_get_club_message_management         SELECT ... 'updated_at', a.updated_at
--   fn_manage_club_announcement_versioned  UPDATE ... SET updated_at = now()
--                                          in every branch: edit, pin,
--                                          unpin, set_active, set_inactive
--
-- So reading the panel threw, and every write threw. Not a degraded surface -
-- an announcement could not be listed, created, edited, pinned or retired at
-- all, and the club had no way to know why. It has evidently been this way
-- since the versioned writer shipped: the column it was written against never
-- arrived, and nothing called these two functions in a test that touched a
-- real table.
--
-- The fix is the column, not the code. Both functions are already correct and
-- already agree with each other about what they expect; the client even maps
-- `item.updated_at || item.created_at`. Removing the references instead would
-- mean an edited announcement reporting its creation time as its last change,
-- which is a small lie told forever to avoid one ALTER TABLE.
--
-- Backfilled from created_at rather than now(): an announcement written in
-- July was not updated today, and stamping every existing row with the
-- migration's clock would erase the only ordering information there is.

ALTER TABLE public.club_announcements
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE public.club_announcements
   SET updated_at = created_at
 WHERE updated_at IS NULL;

ALTER TABLE public.club_announcements
  ALTER COLUMN updated_at SET DEFAULT now();