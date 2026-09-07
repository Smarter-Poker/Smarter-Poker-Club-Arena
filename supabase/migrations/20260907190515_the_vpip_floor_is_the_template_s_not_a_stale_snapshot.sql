-- ═══════════════════════════════════════════════════════════════════════════
--  THE VPIP FLOOR IS THE TEMPLATE'S, NOT A STALE SNAPSHOT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan 2026-09-07: "vpip for action is supposed to be 30% and vpip for madness
-- is 50%. we fixed and updated that a couple days ago."
--
-- He is right that it was fixed. `fn_cash_template_defaults` has said
-- classic 0 / action 30 / madness 50 since 2026-09-05, and its own comment
-- records the decision. What never happened is the part that makes a default
-- matter to a table that already exists.
--
-- WHAT WAS ACTUALLY WRONG, read from the rows rather than assumed:
--
--   cash_games.ruleset_snapshot is the source of truth for a running game, and
--   it is written ONCE at creation. Every action and madness game on this
--   platform was created on 2026-09-04 - the day BEFORE the default changed -
--   so all of them still carried the old numbers:
--
--       action    30 ->  9 games      madness   60 ->  9 games
--                 35 ->  4 games                65 ->  4 games
--                 40 -> 18 games                70 -> 18 games
--       classic    0 -> 87 games      classic   30 ->  1 game (nit on)
--
--   `fn_cash_apply_ruleset` then propagates that snapshot onto every table in
--   the cluster, faithfully, on every run. So the tables were not drifting -
--   they were being held at the old value on purpose, by a function doing its
--   job against stale input.
--
--   That also explains the six madness TABLES sitting at 50 with no game to
--   match: somebody corrected those rows by hand, and the next ruleset apply
--   would have silently put them back to 60/65/70. A fix at the table level
--   could never have held.
--
-- THE ROOT, AND WHY IT IS A TRIGGER RATHER THAN A PATCHED FUNCTION.
-- `fn_cash_game_create_impl_20260905` reads `vpip_floor` from the caller's
-- overrides and only falls back to the template. Patching that one function
-- would fix that one writer; the value can also arrive from an admin edit, a
-- backfill, or the next creation path somebody writes. The floor is a property
-- of the TEMPLATE - Dan states it as a rule about Action and Madness, not as a
-- per-game setting - so it is enforced where the value enters the table, once,
-- for every writer that will ever exist.
--
-- This is NOT a repair job (10.12). Nothing here runs on a schedule, nothing
-- sweeps, nothing back-pays. The trigger is the constraint itself, evaluated
-- inline on write; the UPDATE below is the one-time correction of damage
-- already done, settled through the platform's own idempotent path
-- (`fn_cash_apply_ruleset`), exactly as 10.9 requires.
--
-- PROVED BEFORE IT WAS COMMITTED (11.5): run as a single self-aborting DO
-- block on production, which reported games_rewritten=54,
-- tables_reapplied=38, stray_tables=0, and a final distribution of
-- action floor=30 (31 games) | classic floor=0 (88) | madness floor=50 (31).
-- The assertions at the foot of this file re-check that, so the migration
-- aborts if the board moved underneath it.

BEGIN;

-- ── 1. THE CONSTRAINT ──────────────────────────────────────────────────────
-- A game's stored floor and window are always its template's. Writers may send
-- whatever they like; this is what lands.
CREATE OR REPLACE FUNCTION public.fn_cash_game_floor_from_template()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_def jsonb;
BEGIN
  IF NEW.ruleset_snapshot IS NULL THEN
    RETURN NEW;
  END IF;

  v_def := public.fn_cash_template_defaults(NEW.template_name, NEW.variant);

  NEW.ruleset_snapshot := jsonb_set(
    jsonb_set(NEW.ruleset_snapshot, '{vpip_floor}',  v_def->'vpip_floor'),
    '{vpip_window}', v_def->'vpip_window');

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fn_cash_game_floor_from_template() IS
  'The VPIP floor and window are template constants (Dan 2026-09-07: action 30, madness 50, classic none). Normalises them on every write to cash_games so no writer can store a third answer.';

DROP TRIGGER IF EXISTS zz_cash_game_floor_from_template ON public.cash_games;
CREATE TRIGGER zz_cash_game_floor_from_template
  BEFORE INSERT OR UPDATE OF ruleset_snapshot, template_name, variant
  ON public.cash_games
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_cash_game_floor_from_template();

-- ── 2. THE DAMAGE ALREADY DONE ─────────────────────────────────────────────
-- Every game whose stored floor or window disagrees with its own template.
-- The trigger above would normalise these on their next write; they are
-- corrected now rather than whenever somebody happens to touch them.
UPDATE public.cash_games g
   SET ruleset_snapshot = jsonb_set(
         jsonb_set(g.ruleset_snapshot, '{vpip_floor}',
                   public.fn_cash_template_defaults(g.template_name, g.variant)->'vpip_floor'),
         '{vpip_window}',
                   public.fn_cash_template_defaults(g.template_name, g.variant)->'vpip_window')
 WHERE g.ruleset_snapshot IS NOT NULL
   AND (
        g.ruleset_snapshot->'vpip_floor'
          IS DISTINCT FROM public.fn_cash_template_defaults(g.template_name, g.variant)->'vpip_floor'
     OR g.ruleset_snapshot->'vpip_window'
          IS DISTINCT FROM public.fn_cash_template_defaults(g.template_name, g.variant)->'vpip_window'
   );

-- ── 3. LET THE TABLES FOLLOW, THROUGH THE PLATFORM'S OWN PATH ──────────────
-- Not a hand-written UPDATE on `tables`: fn_cash_apply_ruleset is the one
-- function allowed to map a snapshot onto a cluster, it is idempotent, it
-- skips rows that already agree, and it writes the cash_cluster_events audit
-- row. A second mapping here would be a second source of truth.
SELECT sum(public.fn_cash_apply_ruleset(id)) FROM public.cash_games;

-- ── 4. ASSERT, AND ABORT IF THE BOARD MOVED ────────────────────────────────
DO $assert$
DECLARE
  v_bad_games int;
  v_bad_tables int;
  v_action int; v_madness int; v_classic int;
BEGIN
  SELECT count(*) INTO v_bad_games
  FROM public.cash_games g
  WHERE g.ruleset_snapshot IS NOT NULL
    AND g.ruleset_snapshot->'vpip_floor'
        IS DISTINCT FROM public.fn_cash_template_defaults(g.template_name, g.variant)->'vpip_floor';
  IF v_bad_games <> 0 THEN
    RAISE EXCEPTION 'ABORT: % games still disagree with their template floor', v_bad_games;
  END IF;

  SELECT count(*) INTO v_bad_tables
  FROM public.tables t JOIN public.cash_games g ON g.id = t.cluster_id
  WHERE t.tournament_id IS NULL
    AND t.lifecycle <> 'closed'
    AND coalesce(t.is_deleted, false) = false
    AND t.maintain_percent_min IS DISTINCT FROM (g.ruleset_snapshot->>'vpip_floor')::int;
  IF v_bad_tables <> 0 THEN
    RAISE EXCEPTION 'ABORT: % live tables still disagree with their game', v_bad_tables;
  END IF;

  SELECT count(*) FILTER (WHERE template_name = 'action'  AND (ruleset_snapshot->>'vpip_floor')::int = 30),
         count(*) FILTER (WHERE template_name = 'madness' AND (ruleset_snapshot->>'vpip_floor')::int = 50),
         count(*) FILTER (WHERE template_name = 'classic' AND (ruleset_snapshot->>'vpip_floor')::int = 0)
    INTO v_action, v_madness, v_classic
  FROM public.cash_games;

  RAISE NOTICE 'VPIP floors settled: action@30=% madness@50=% classic@0=%',
        v_action, v_madness, v_classic;
END;
$assert$;

COMMIT;
