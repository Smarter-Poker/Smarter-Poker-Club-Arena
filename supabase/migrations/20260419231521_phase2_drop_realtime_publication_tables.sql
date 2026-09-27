-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419231521 "phase2_drop_realtime_publication_tables"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 327a73ba1537aae20c9a36718dd49a2a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 2 realtime publication trim (tracks blocker #39)
-- Client-side postgres_changes subscriptions on these 3 tables have been
-- removed across 8 Club Arena pages in commits:
--   Smarter-Poker-Club-Arena@b4f1cea3
--   Smarter-Poker-World-Hub@435a485e4 (dist bundled)
-- World Hub deploy dpl_9y9YRjkLrq1bocRd7YsNyY8znHQo READY on smarter.poker.
-- Refresh paths preserved via masterBus listeners + useVisibilityRefresh.

ALTER PUBLICATION supabase_realtime DROP TABLE public.hand_history;
ALTER PUBLICATION supabase_realtime DROP TABLE public.wallet_transactions;
ALTER PUBLICATION supabase_realtime DROP TABLE public.rake_history;
