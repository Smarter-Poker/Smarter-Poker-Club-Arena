-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260804184825 "20260804_shift_handoffs_venue_id_integer"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 701aa47badb5daba432b499fee849db9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- PR #25 unblock (take 2): venue_id had NOT NULL; relax it for the 10 orphaned
-- legacy rows (their uuid is preserved in venue_id_uuid_legacy), then convert.
-- All API writes always supply venue_id, so new rows are unaffected.
-- ROLLBACK: ALTER TABLE commander_shift_handoffs ALTER COLUMN venue_id TYPE uuid
--   USING venue_id_uuid_legacy; SET NOT NULL; DROP COLUMN venue_id_uuid_legacy.
ALTER TABLE public.commander_shift_handoffs
  ADD COLUMN IF NOT EXISTS venue_id_uuid_legacy uuid;

UPDATE public.commander_shift_handoffs
  SET venue_id_uuid_legacy = venue_id
  WHERE venue_id IS NOT NULL AND venue_id_uuid_legacy IS NULL;

ALTER TABLE public.commander_shift_handoffs
  ALTER COLUMN venue_id DROP NOT NULL;

ALTER TABLE public.commander_shift_handoffs
  ALTER COLUMN venue_id TYPE integer USING NULL::integer;
