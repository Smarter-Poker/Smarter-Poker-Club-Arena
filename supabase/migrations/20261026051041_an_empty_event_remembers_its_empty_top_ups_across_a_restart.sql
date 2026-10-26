-- 20261026051041_an_empty_event_remembers_its_empty_top_ups_across_a_restart.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (2026-10-26, lease follow-ups phase 3):
--
-- An event nobody entered is cancelled thirty minutes past its start, once a
-- past-start horse top-up has come back empty (server/src/tournament/
-- emptyPastStartEvent.ts, 2026-10-15). The "came back empty" count lived only
-- in the engine's memory (GameServer.pastStartTopUpClock). An engine restart
-- forgets it, so the next engine must ask the horse pool again before it may
-- cancel, and that ask shares four slots with every other past-start and
-- pre-start top-up on the platform, which a restart also resets to "ask now".
--
-- Read from rows, 2026-10-25: "Daily 25 Chip Freezeout" 501008e1 (start
-- 19:00:00 UTC, zero entrants) was cancelled at 19:52:12, 22 minutes after
-- its 19:30 due time; the engine was restarted at that moment (the
-- replacement container started 19:30:11 UTC, engine-01 archive names). The same
-- event the day before (d58c2a8d, no restart) was cancelled at 19:30:09.
-- fn_tournament_metrics counts an empty event as overdue at 40 minutes, so
-- TournamentNeverStarted paged at 19:46:36 and resolved at 19:53:36.
--
-- This table makes the count durable: one row per registration-first event
-- whose past-start top-up added nobody, written by the engine when the top-up
-- settles, read by the discovery pass beside its roster read, deleted when a
-- top-up adds anyone or the event is cancelled. A row that outlives its event
-- is harmless; a FOREIGN KEY to tournaments is deliberately absent (CLAUDE.md
-- production DDL policy 7: a cursor table never carries a foreign key to a hot
-- table).
--
-- Engine only: RLS on, every privilege revoked, service_role granted exactly
-- SELECT/INSERT/UPDATE/DELETE. No function, trigger, cron or money.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $pre$
BEGIN
  IF to_regclass('public.tournament_past_start_top_ups') IS NOT NULL THEN
    RAISE EXCEPTION 'PREIMAGE_CHANGED: public.tournament_past_start_top_ups already exists';
  END IF;
END
$pre$;

CREATE TABLE public.tournament_past_start_top_ups (
  tournament_id uuid PRIMARY KEY,
  -- Consecutive past-start top-ups that added nobody. Reset by deleting the
  -- row when a top-up adds anyone.
  empty_top_ups integer NOT NULL DEFAULT 0 CHECK (empty_top_ups >= 0),
  last_asked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tournament_past_start_top_ups IS
  'Engine-owned: how many past-start horse top-ups of a REGISTERING event came back empty, so the empty-event cancellation (emptyPastStartEvent.ts) survives an engine restart. No FK to tournaments on purpose; an orphan row is harmless.';

ALTER TABLE public.tournament_past_start_top_ups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_past_start_top_ups FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tournament_past_start_top_ups TO service_role;

DO $post$
DECLARE v_rls boolean;
BEGIN
  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.tournament_past_start_top_ups'::regclass;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTIMAGE: row level security is not enabled on tournament_past_start_top_ups';
  END IF;
  IF has_table_privilege('anon', 'public.tournament_past_start_top_ups', 'SELECT')
     OR has_table_privilege('authenticated', 'public.tournament_past_start_top_ups', 'SELECT') THEN
    RAISE EXCEPTION 'POSTIMAGE: a browser role can read tournament_past_start_top_ups';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.tournament_past_start_top_ups', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'POSTIMAGE: service_role cannot read and write tournament_past_start_top_ups';
  END IF;
END
$post$;

COMMIT;
