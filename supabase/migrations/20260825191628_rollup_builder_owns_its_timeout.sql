-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825191628; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The builder is a bulk job and needs longer than a page request does.
-- service_role carries no statement_timeout of its own, but PostgREST still
-- applies one per request, so a 20,000-hand chunk was cancelled from outside.
-- A function-level GUC is the honest place for this: it applies for exactly the
-- duration of this call and nothing else, it is visible in \df+ rather than
-- hidden in a caller, and both functions are already revoked from anon and
-- authenticated, so nothing reachable from a browser can start one.
--
-- 10 minutes, not 0. An unbounded backfill that wedges is worse than one that
-- gives up and can be re-run - the builder is resumable by design, since it
-- records rolled_floor and picks up from there.
ALTER FUNCTION public.ca_roll_hand_stats(int)       SET statement_timeout = '10min';
ALTER FUNCTION public.ca_prune_hand_player_stat(int) SET statement_timeout = '10min';
