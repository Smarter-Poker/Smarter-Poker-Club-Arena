-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819235600 "batch_credit_rpcs_own_statement_timeout"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5a66becb81db6828d9fac3ce10e10a83 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- FOLLOW-UP to rakeback_settler_batch_credit_rpcs, from watching it run.
--
-- The batch functions inherit the caller's statement_timeout (~8s), and a
-- 500-item commission batch exceeds it: production logged five
-- "canceling statement due to statement timeout" events at 23:38:05/20/28/36/45
-- matching five HTTP 500s from fn_credit_agent_commissions_batch. A timeout
-- aborts the WHOLE call, so those items were counted failed and skipped —
-- and the settler's cursor then advanced past them.
--
-- Two changes: the functions now set their own generous timeout (the same
-- pattern ca_drain_club_rebuild already uses), and the client sends smaller
-- chunks. Per-item exception isolation is unchanged, so a genuinely bad item
-- still fails alone rather than taking the batch with it.
--
-- The skipped rows are recoverable precisely because every underlying write is
-- idempotent: rewinding the settler cursor re-processes them with the engine's
-- own exact equal-share arithmetic rather than a hand-reconstructed guess.

ALTER FUNCTION public.fn_credit_agent_commissions_batch(jsonb) SET statement_timeout = '300s';
ALTER FUNCTION public.fn_apply_rakeback_player_stats_batch(jsonb) SET statement_timeout = '300s';
