-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828040356; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
--  A PROFILE SHOWED ITS ACCOUNT STATUS WHERE ITS CUSTOM STATUS SHOULD BE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- PlayerStatusService.setStatusText wrote profiles.status_text, a column that
-- has never existed, so every write was rejected. That alone would only be a
-- dead control - but the two READERS in the same file papered over it with
--
--     .select('id, status_text:status, is_online, last_seen')
--
-- which aliases the ACCOUNT STATUS column into the custom-status field. So
-- PublicProfilePage has been rendering "active" under a player's name as if it
-- were something they wrote about themselves.
--
-- One nullable text column makes the whole feature coherent: the writer lands
-- somewhere, the readers stop borrowing an unrelated column, and a profile
-- with nothing set shows nothing instead of showing its account state.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS status_text text;

COMMENT ON COLUMN public.profiles.status_text IS
  'A player''s own short status line, e.g. "Grinding MTTs". NULL means they have not set one. Distinct from profiles.status, which is the account state and must never be displayed in its place.';

