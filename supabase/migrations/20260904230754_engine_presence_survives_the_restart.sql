-- 20260904230754_engine_presence_survives_the_restart.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (disconnect audit item 2, 2026-09-04):
--
-- The engine restarts at :55 every hour. Each table parks BETWEEN hands
-- before the cut-over, so at boot there is never an incomplete
-- hand_state_snapshots row - and that row is the only place the presence
-- FSM (DisconnectEngine) was ever persisted. checkCrashRecovery() returns
-- early without one, so every seat booted CONNECTED with its strike count,
-- away-blind budget, sit-out reason and /away stamp reset. A player who had
-- dropped at :50 got a fresh 30s clock on every orbit after :00, and a seat
-- that had spent one blind of its two-blind budget got a new budget.
--
-- hand_state_snapshots cannot carry it: 2.8M rows / 7.7 GB with no index on
-- (table_id) for completed rows, so "the latest snapshot for this table" is
-- a sequential scan, and writing a fake incomplete row at park is read by
-- TournamentManager.waitForHandComplete as a hand in flight. One row per
-- table, keyed by table, is what this is.
--
-- The engine (service role) upserts the row when a table parks and reads it
-- once at boot; restoreFsmStates() never clobbers a seat that has already
-- re-registered, and the row is ignored past its freshness window so a
-- stale one can never describe a table that has moved on. No browser reads
-- or writes it.
--
-- One transaction: one CREATE TABLE, its comment, its grants. One reload.

BEGIN;

CREATE TABLE IF NOT EXISTS public.engine_presence_parked (
  table_id uuid PRIMARY KEY,
  -- The same shape hand_state_snapshots.disconnect_states carries:
  -- { <user_id>: { state, sinceMs, graceDeadlineMs, sitOutSinceMs, ... } }
  disconnect_states jsonb NOT NULL DEFAULT '{}'::jsonb,
  parked_at timestamptz NOT NULL DEFAULT now(),
  engine_instance text
);

COMMENT ON TABLE public.engine_presence_parked IS
  'Per-table presence FSM written by the engine when the table parks for the hourly restart and read once at the next boot (DisconnectEngine.restoreFsmStates). Ignored when older than the freshness window. Engine only.';

REVOKE ALL ON TABLE public.engine_presence_parked FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.engine_presence_parked TO service_role;

COMMIT;
