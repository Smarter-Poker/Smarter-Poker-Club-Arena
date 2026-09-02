-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828030748; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Money-path audit 2026-08-27, lane: rebuys.
--
-- HIGH - the client holds the rebuy modal for 120s; the server waits 5.
-- TablePage.tsx:2539 sets BUST_HOLD_MODAL_MS = 120_000, while the elimination
-- sweep runs on its own 5-second clock and stamps the player eliminated. A player
-- who takes six seconds to read the price gets "No live seat for this rebuy" for a
-- rebuy they were entitled to, and the tournament has already assigned them a
-- finishing position.
--
-- src/types/club.types.ts:395 declares `rebuy_prompt_active: boolean` with the
-- comment "Rebuy dialog is showing for this player". It is written by nothing and
-- read by nothing, and NO SUCH COLUMN EXISTS in the database - the type is a
-- description of a feature that was never built.
--
-- Built here, as a deadline rather than a flag. A boolean cannot expire: if the
-- client sets it true and then crashes, the seat is pinned open forever and the
-- tournament cannot finish. A timestamptz is self-healing - the prompt lapses on
-- its own and the sweep reclaims the seat with no cleanup path required.
--
-- Contract for the engine and the client:
--   * on bust, the server sets rebuy_prompt_until = now() + the offered window;
--   * the elimination sweep SKIPS any player whose prompt has not yet lapsed;
--   * accepting or declining clears it, so a decline releases the table
--     immediately instead of waiting out the clock;
--   * nothing can pin a seat longer than the deadline the server itself wrote.

ALTER TABLE public.tournament_players
  ADD COLUMN IF NOT EXISTS rebuy_prompt_until timestamptz;

COMMENT ON COLUMN public.tournament_players.rebuy_prompt_until IS
  'Server-owned deadline for an open rebuy prompt. The elimination sweep must not '
  'eliminate a player while now() < rebuy_prompt_until. Cleared on accept or decline. '
  'NULL means no prompt is open.';

-- Partial index: the sweep asks "is anyone still deciding?" on a short cycle, and
-- only a handful of rows are ever non-null.
CREATE INDEX IF NOT EXISTS idx_tournament_players_rebuy_prompt_open
  ON public.tournament_players (tournament_id, rebuy_prompt_until)
  WHERE rebuy_prompt_until IS NOT NULL;
