-- Migration: add tournaments.final_table_triggered
-- Context: TournamentTimerService reads/writes a `final_table_triggered` flag to
-- fire the final-table transition exactly once per tournament. The column was
-- missing, so `.select('final_table_triggered')` 42703-errored the whole query
-- (silent no-op — the final-table event could re-fire). This adds the flag.
--
-- Applied to production via Supabase MCP on 2026-07-29; committed here to keep the
-- migration history and the phantom-column CI manifest in sync.

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS final_table_triggered boolean NOT NULL DEFAULT false;
