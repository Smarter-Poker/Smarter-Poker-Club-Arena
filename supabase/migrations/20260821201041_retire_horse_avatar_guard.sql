-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821201041 "retire_horse_avatar_guard"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 43891dd14cc7acab8c5ca5419bdbda1e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  RETIRE trg_guard_horse_avatar — Dan 2026-08-21
--  "no photo uploading to the club arena, avatars only. for all the horses and
--   players that are using a photo, swap out to a random avatar."
--
--  WHAT THE GUARD DID
--    IF NEW.is_horse AND NEW.avatar_url LIKE '/avatars/%'
--       AND OLD.avatar_url <> '' AND OLD.avatar_url NOT LIKE '/avatars/%'
--    THEN NEW.avatar_url := OLD.avatar_url;   -- silently revert
--
--  i.e. it SILENTLY reverted any attempt to move a horse off a non-library
--  avatar onto library art. It was protecting the fleet's bespoke portraits,
--  which is a reasonable thing to have wanted at the time.
--
--  WHY IT GOES NOW
--  Those portraits are photoREALISTIC AI images of people — checked one
--  directly: a 1024x1024 render of a man in a cap at a poker table,
--  indistinguishable from a photograph. That is precisely the look the product
--  is moving away from. The guard is no longer protecting a feature, it is
--  blocking the decision.
--
--  Dropping a guard another workstream deliberately added is not something to
--  do quietly, so it is recorded here rather than just removed. If the fleet
--  ever wants bespoke portraits again, the guard is three lines and this
--  comment is the argument for and against it.
-- ═══════════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS trg_guard_horse_avatar ON public.profiles;

COMMENT ON FUNCTION public.fn_guard_horse_avatar() IS
  'RETIRED 2026-08-21 - trigger dropped. It silently reverted any move of a horse from a bespoke portrait to library art. Those portraits are photorealistic AI renders of people, and Club Arena is now avatars-only, so the guard blocked the product decision rather than protecting a feature. Function kept (unattached) so the logic is recoverable if the fleet ever wants bespoke portraits back.';
