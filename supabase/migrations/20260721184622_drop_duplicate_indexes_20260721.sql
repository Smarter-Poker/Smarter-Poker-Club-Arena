-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721184622 "drop_duplicate_indexes_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 59424c9ea1299470c1ebedb4a7991c13 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Task #57: drop byte-identical duplicate indexes/constraints (all non-CA social/
-- streaming tables). Verified: no FK depends on any dropped unique constraint.
-- One index/constraint of each pair is kept (the canonical auto-named _key, or the
-- more descriptive _id-suffixed plain index).

-- Pairs where BOTH are unique CONSTRAINTS -> drop the redundant constraint, keep _key.
ALTER TABLE public.blocked_users DROP CONSTRAINT IF EXISTS blocked_users_blocker_blocked_uniq;
ALTER TABLE public.live_bans     DROP CONSTRAINT IF EXISTS live_bans_stream_user_unique;
ALTER TABLE public.live_pins     DROP CONSTRAINT IF EXISTS live_pins_stream_id_unique;

-- Pairs that are plain (non-constraint) indexes -> drop the redundant index.
DROP INDEX IF EXISTS public.idx_diamond_tx_reference_id;   -- keep idx_diamond_transactions_reference_id
DROP INDEX IF EXISTS public.idx_live_gifts_receiver;       -- keep idx_live_gifts_receiver_id
DROP INDEX IF EXISTS public.idx_live_gifts_sender;         -- keep idx_live_gifts_sender_id
