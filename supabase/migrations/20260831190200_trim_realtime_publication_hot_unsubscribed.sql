-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831190200; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Realtime publication trim (2026-08-31).
-- The supabase_realtime publication carried 115 tables. Every write to a
-- published table is logically decoded and shipped through the Realtime
-- poller - the single largest consumer of DB time today (wal poll: ~3,000s,
-- 516ms mean) on an instance that hard-crashed twice this afternoon.
--
-- Cross-checked every postgres_changes subscription in both codebases
-- (club-arena src+server, World Hub pages/lib/src/components/hooks/utils/
-- engine/worker/services; no dynamic table names found). Two published
-- tables have REAL write volume and ZERO subscribers:
--   table_hole_cards                      110,823 writes this stats window -
--     every hole card dealt, decoded for nobody. Also a needless exposure
--     surface for hole-card data.
--   daily_challenge_dashboard_revisions     4,636 writes, no subscribers.
-- Everything else stays: table_seats, tables, chat, wallets etc. all have
-- live subscribers.
ALTER PUBLICATION supabase_realtime DROP TABLE public.table_hole_cards;
ALTER PUBLICATION supabase_realtime DROP TABLE public.daily_challenge_dashboard_revisions;
