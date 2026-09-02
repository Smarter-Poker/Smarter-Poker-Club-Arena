-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830204329; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 2026-08-30: the PNM tournaments surface filters venue_daily_tournaments with
-- `day_of_week ilike $x` (values are case-mixed: 'Saturday' and 'saturday' both
-- exist), and no btree index can serve ILIKE. Every call walked the
-- is_active index and filtered 57k+ rows by hand — 138ms cold, 4.2s under the
-- post-restart stampede, at 11+ calls/min. A trigram GIN index serves ILIKE
-- directly. pg_trgm is already installed.
create index if not exists idx_vdt_day_of_week_trgm
  on public.venue_daily_tournaments
  using gin (day_of_week gin_trgm_ops);
