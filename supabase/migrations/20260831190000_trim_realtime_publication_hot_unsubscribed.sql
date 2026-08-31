-- Applied to production 2026-08-31 ~19:00 UTC via mgmt API.
-- The supabase_realtime publication carried 115 tables; every write to a
-- published table is logically decoded and shipped through the Realtime
-- poller - the single largest consumer of DB time (wal poll ~3,000s, 516ms
-- mean) on an instance that hard-crashed twice this afternoon (15:34, 17:54).
-- Cross-checked every postgres_changes subscription in club-arena and World
-- Hub (no dynamic table names). Two published tables have real write volume
-- and ZERO subscribers:
--   table_hole_cards (110,823 writes this stats window - every hole card
--   dealt, decoded for nobody; also a needless exposure surface) and
--   daily_challenge_dashboard_revisions (4,636 writes).
ALTER PUBLICATION supabase_realtime DROP TABLE public.table_hole_cards;
ALTER PUBLICATION supabase_realtime DROP TABLE public.daily_challenge_dashboard_revisions;
