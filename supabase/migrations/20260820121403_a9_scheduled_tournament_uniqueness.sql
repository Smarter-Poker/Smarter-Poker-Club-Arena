-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820121403 "a9_scheduled_tournament_uniqueness"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c46645cadcee21c399397cdccbf4c94e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- A9: TournamentRecurringService dedupes scheduled events with a check-then-create.
--
--   const existing = await this.getActiveCount(config.type, config.name);
--   if (existing > 0) continue;
--
-- Two ticks that overlap — or two engine containers — both read zero and both
-- create. Nothing in the database said "only one of these at a time", so the
-- guard was advisory only.
--
-- Evidence it fires: over the last 7 days, "Coffee Break Freeroll (PLO4)" was
-- created twice 2.6 SECONDS apart, and "1 Chip Spin NLH (3x)" twice 3.8s apart.
--
-- Scoped deliberately to MTT/XMTT. Those are SCHEDULED events where "one live
-- instance per name" is the actual business rule the code is trying to enforce.
-- SNG and SPIN are on-demand formats that legitimately run many same-named
-- instances at once, so constraining them would break normal operation — their
-- near-simultaneous creations in that same window (101 for "1 Chip Spin NLH
-- (2x)") are correct behaviour, not duplicates.
--
-- Verified no current violation in this scope before creating the index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_tournament_one_live_per_name
  ON public.tournaments (tournament_type, name)
  WHERE status IN ('ANNOUNCED', 'REGISTERING')
    AND tournament_type IN ('MTT', 'XMTT');

COMMENT ON INDEX public.uq_scheduled_tournament_one_live_per_name IS
  'A9: makes the TournamentRecurringService duplicate guard real. The service checks getActiveCount() before creating, which is a TOCTOU; this turns a losing race into a rejected insert instead of a duplicate scheduled event. Deliberately excludes SNG/SPIN, which are on-demand and legitimately concurrent.';
