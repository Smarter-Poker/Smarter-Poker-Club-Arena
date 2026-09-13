-- An arena table is governed by the Diamond boundary, not by a cluster.
--
-- THE CONTRADICTION THIS RESOLVES
-- Gate 7 (20260905034937) added tables_cash_needs_a_game: an open cash table
-- must carry a tournament_id or a cluster_id. It was added for a real reason,
-- recorded in its own header: 105 open cash tables were sitting outside a
-- cluster, and "every rule in Gates 0-6 - the stay clock and the winner's
-- floor, must-move in join order, the seat change, the snapshot as the rule,
-- one card per game - stops at those tables". An unclustered CHIP table is
-- ungoverned, and that is what the constraint exists to prevent.
--
-- The Phase 6 Diamond boundary refuses any table that HAS a cluster id, because
-- the cluster model is chip-shaped: fn_cash_apply_ruleset rewrites rake to
-- 'existing' and run-it to 'opt_in' on every tick, seat moves carry chip
-- continuity sessions, and must-move is a chip flow. Both rules are right, and
-- together they are unsatisfiable: no Diamond cash table can be written at all.
-- Every one of the 4,961 live cash tables in production is clustered, and the
-- arena has none. Phase 6 was certified only in an isolated database, which is
-- built from scratch by its fixture and therefore has no such constraint.
--
-- WHY AN ARENA TABLE IS NOT THE CASE GATE 7 WAS WRITTEN ABOUT
-- The rules Gate 7 was protecting are the cluster's, and the Diamond boundary
-- refuses every one of them outright: no straddles, no rake, no jackpot, no
-- bombs, no run it twice, no insurance, no must-move, no seat change. An arena
-- table is not ungoverned; it is governed by a STRICTER rule that is checked in
-- more places than the cluster's - assertDiamondCashTable at load and again on
-- every settings refresh, fn_poker_diamond_buyin at admission, and
-- fn_poker_diamond_settle_cash_hand at settlement. "Ungoverned" was the harm.
-- This is the opposite of it.
--
-- WHAT RUNS THE TABLE, SINCE THE CLUSTER CONTROLLER WILL NOT
-- GameServer.ensureCashTableEngine, which handlers/state.ts calls on GET /state
-- and GET /actions. The cluster controller's own header says it uses
-- "ensureCashTableEngine, the same door the Start button uses", so an arena
-- table wakes on demand exactly as a clustered one does when a player opens it.
-- The controller is an elastic-capacity layer for chip clubs, not the only way
-- a cash table runs. The arena runs a fixed, staff-created ladder instead:
-- there is nothing to open on demand and nothing to close when empty.
--
-- SCOPE. One disjunct, naming the platform Diamond arena by its own id. A CHECK
-- constraint cannot read another table, so the id is a literal, the same one
-- src/lib/constants.ts already pins as DIAMOND_ARENA_CLUB_ID. If that id ever
-- changed, this exemption would simply stop applying and arena tables would be
-- refused again, which is the safe direction for it to fail in. Every existing
-- row that passed the old constraint still passes this one: the only change is
-- an added OR.
--
-- ROLLBACK:
--   ALTER TABLE public.tables DROP CONSTRAINT IF EXISTS tables_cash_needs_a_game;
--   ALTER TABLE public.tables ADD CONSTRAINT tables_cash_needs_a_game CHECK (
--     tournament_id IS NOT NULL OR cluster_id IS NOT NULL
--     OR status = ANY (ARRAY['closed'::text, 'deleted'::text])
--     OR COALESCE(is_deleted, false) OR club_id IS NULL OR game_variant IS NULL
--     OR COALESCE(small_blind, 0::numeric) <= 0::numeric
--     OR COALESCE(big_blind, 0::numeric) <= COALESCE(small_blind, 0::numeric)
--   ) NOT VALID;
--   ALTER TABLE public.tables VALIDATE CONSTRAINT tables_cash_needs_a_game;

ALTER TABLE public.tables DROP CONSTRAINT IF EXISTS tables_cash_needs_a_game;

ALTER TABLE public.tables ADD CONSTRAINT tables_cash_needs_a_game CHECK (
  tournament_id IS NOT NULL
  OR cluster_id IS NOT NULL
  OR status = ANY (ARRAY['closed'::text, 'deleted'::text])
  OR COALESCE(is_deleted, false)
  OR club_id IS NULL
  OR game_variant IS NULL
  OR COALESCE(small_blind, 0::numeric) <= 0::numeric
  OR COALESCE(big_blind, 0::numeric) <= COALESCE(small_blind, 0::numeric)
  -- The platform Diamond arena. Governed by the Diamond boundary, run on
  -- demand by ensureCashTableEngine, and never by the cluster controller.
  OR club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid
) NOT VALID;

ALTER TABLE public.tables VALIDATE CONSTRAINT tables_cash_needs_a_game;

COMMENT ON CONSTRAINT tables_cash_needs_a_game ON public.tables IS
  'Gate 7: an open cash table must be owned by a tournament or a cluster, so '
  'the cluster rules cannot stop at it. The platform Diamond arena is exempt '
  'because the Diamond boundary refuses every one of those rules outright and '
  'replaces them with a stricter check applied at load, at every settings '
  'refresh, at admission and at settlement; its tables are a fixed staff ladder '
  'woken on demand by ensureCashTableEngine.';
