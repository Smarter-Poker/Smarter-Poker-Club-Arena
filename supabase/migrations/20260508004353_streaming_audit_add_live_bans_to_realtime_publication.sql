-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260508004353 "streaming_audit_add_live_bans_to_realtime_publication"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4b9cceefb8ee5be349230989f0d1ddc4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- R12 dependency: live_bans must be in supabase_realtime publication so
-- the LiveStreamViewer's INSERT subscription receives ban events. Without
-- this, the R12 subscription would silently never fire — banned viewers
-- would still continue watching (the exact bug R12 is meant to fix).
--
-- Also enabling REPLICA IDENTITY FULL for live_bans so payload.old/new
-- contain the banned_user_id column on UPDATE/DELETE if we ever add that.
-- For INSERT, replica identity is irrelevant (payload.new always full).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
    JOIN pg_publication p ON p.oid = pr.prpubid
    JOIN pg_class c ON c.oid = pr.prrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE p.pubname = 'supabase_realtime'
      AND n.nspname = 'public'
      AND c.relname = 'live_bans'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.live_bans;
  END IF;
END $$;

ALTER TABLE public.live_bans REPLICA IDENTITY FULL;

