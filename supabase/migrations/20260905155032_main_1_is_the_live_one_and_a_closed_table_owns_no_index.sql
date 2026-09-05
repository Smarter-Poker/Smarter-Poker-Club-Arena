-- ═══════════════════════════════════════════════════════════════════════════
--  A CLOSED TABLE OWNS NO INDEX, AND A CLUSTER CANNOT RUN AWAY
--  2026-09-05 - stops the cluster table runaway, structurally
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT HAPPENED. `NLH 0.05/0.10 Classic` created 2,994 tables between 13:01
-- and 15:29 UTC on 2026-09-05 - one every five seconds - ending with 26,721
-- seats holding 50 players. Two facts had to be true together:
--
--   1. `fn_cash_cluster_tick` rule R3 ("an enabled game always has Main 1
--      open") looks up `main_index = 1 ... ORDER BY created_at LIMIT 1`, with
--      no preference for a row that is actually alive.
--   2. The renumber pass at the bottom of the same function walks
--      `v_census`, and `fn_cash_cluster_census` EXCLUDES closed tables - so a
--      table that closed while holding `main_index = 1` keeps it forever,
--      invisible to the only pass that would take it away.
--
-- The cluster therefore held TWO rows at index 1: a corpse from 21:38 the
-- previous evening, and the live game from 22:08. R3 read the corpse, saw
-- `lifecycle = 'closed'`, and opened a replacement. The renumber then gave
-- that replacement the next free index (2,986 by the end) - never 1 - so the
-- next tick found the same corpse and did it again, forever. R3 sits ABOVE
-- the OPEN rule's `v_live_tables < v_table_cap` check, so the nine-table cap
-- never applied to any of it.
--
-- WHY IT COST MORE THAN DISK. `fn_cash_cluster_census` builds its array with
-- two correlated subqueries per table, inside a tick that holds
-- `SELECT ... FOR UPDATE` on the game row. At three thousand tables every
-- tick scanned all of them, and `atomic_table_buyin` and the engine's
-- `ClusterController` wake RPC started returning 57014 against the 8s
-- service_role ceiling - 241 wake failures in thirty minutes. The runaway is
-- therefore also why horses could not buy in anywhere on the floor.
--
-- WHY THIS IS A TRIGGER AND NOT AN EDIT TO R3.
--
-- R3 is forty lines inside a 33KB function that six migrations have touched
-- today alone. An ordering clause added there is correct and is also exactly
-- the kind of line a later rewrite drops without noticing, because nothing
-- about `ORDER BY created_at` looks load-bearing. The invariant it was
-- protecting - AT MOST ONE ROW ANSWERS TO A GIVEN main_index - is a property
-- of the data, so it is enforced on the data. R3's query then cannot return
-- the wrong row because the wrong row cannot exist.
--
-- Two triggers, both cheap, both `BEFORE`:
--
--   A. A cluster main that closes or is deleted RELEASES its `main_index`.
--      This is the exact hole the census left open.
--   B. A cluster may not exceed its own declared table cap. R3 bypassed the
--      cap because the cap lived in a different branch of the function; here
--      it lives on the INSERT, so EVERY path is bound by it - the tick, a
--      repair pass, an operator, and anything written next year. It returns
--      NULL (the insert is skipped) rather than raising, because a raise
--      inside `fn_cash_cluster_tick` would abort a transaction that also
--      carries seat moves and roster writes, and a refused table must never
--      cost a player their seat. The refusal is recorded, so a cluster
--      pressing against its cap is visible instead of silent.
--
-- The live incident was stopped at 15:29 UTC by retiring the corpse
-- (`is_deleted = true`, through the sanctioned `app.managed_game_lifecycle`
-- path, asserted empty of seats and chips and asserted that a live Main 1
-- survived it). This migration is what stops it recurring.
--
-- Tier 3 by CLAUDE.md section 2: ONE transaction, so ONE PostgREST schema
-- reload. No DROP, no ALTER COLUMN TYPE, no RPC signature change.
--
-- ROLLBACK
--   DROP TRIGGER IF EXISTS trg_tables_closed_main_releases_index ON public.tables;
--   DROP TRIGGER IF EXISTS trg_tables_cluster_table_ceiling ON public.tables;
--   DROP FUNCTION IF EXISTS public.fn_closed_cluster_main_releases_index();
--   DROP FUNCTION IF EXISTS public.fn_cluster_table_ceiling();
--   -- the backfilled main_index values are not restored: they belonged to
--   -- closed tables and are what caused the incident.

BEGIN;

-- ── A. A CLOSED OR DELETED CLUSTER MAIN RELEASES ITS INDEX ─────────────────
CREATE OR REPLACE FUNCTION public.fn_closed_cluster_main_releases_index()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.cluster_id IS NOT NULL
     AND NEW.main_index IS NOT NULL
     AND (NEW.lifecycle = 'closed' OR coalesce(NEW.is_deleted, false) = true)
  THEN
    NEW.main_index := NULL;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_tables_closed_main_releases_index ON public.tables;
CREATE TRIGGER trg_tables_closed_main_releases_index
  BEFORE INSERT OR UPDATE OF lifecycle, is_deleted ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_closed_cluster_main_releases_index();

-- ── B. A CLUSTER MAY NOT EXCEED ITS OWN DECLARED CEILING ───────────────────
-- The tick's own arithmetic is `cap_mains + 1` (+1 again when a second feeder
-- is allowed). Two of slack on top of that, because this is a backstop for a
-- runaway and not a second opinion on the tick's planning: a legitimate race
-- between the OPEN rule and a repair pass must not lose a table to it.
CREATE OR REPLACE FUNCTION public.fn_cluster_table_ceiling()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_live integer;
  v_ceiling integer;
BEGIN
  IF NEW.cluster_id IS NULL THEN RETURN NEW; END IF;

  SELECT coalesce(g.cap_mains, 8) + 1 + CASE WHEN g.allow_second_feeder THEN 1 ELSE 0 END + 2
    INTO v_ceiling
    FROM public.cash_games g WHERE g.id = NEW.cluster_id;
  IF v_ceiling IS NULL THEN RETURN NEW; END IF;  -- not a cash cluster: no opinion

  SELECT count(*) INTO v_live FROM public.tables t
   WHERE t.cluster_id = NEW.cluster_id
     AND coalesce(t.is_deleted, false) = false
     AND t.lifecycle <> 'closed';

  IF v_live >= v_ceiling THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (NEW.cluster_id, 'table_refused_at_ceiling',
            jsonb_build_object('live', v_live, 'ceiling', v_ceiling,
                               'role', NEW.role, 'main_index', NEW.main_index));
    RETURN NULL;  -- skip the insert; never raise inside the tick's transaction
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_tables_cluster_table_ceiling ON public.tables;
CREATE TRIGGER trg_tables_cluster_table_ceiling
  BEFORE INSERT ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_cluster_table_ceiling();

-- ── THE INDEXES THE CORPSES ARE HOLDING RIGHT NOW ──────────────────────────
-- Every cluster, not just the one that ran away, so no other game is sitting
-- on the same loaded gun. Safe by construction: a table with a live seat is
-- not closed, and this touches nothing but `main_index`.
UPDATE public.tables SET main_index = NULL, updated_at = now()
 WHERE cluster_id IS NOT NULL AND role = 'main' AND main_index IS NOT NULL
   AND (lifecycle = 'closed' OR coalesce(is_deleted, false) = true);

-- ── ASSERT, OR ABORT ───────────────────────────────────────────────────────
DO $assert$
DECLARE v_dupes integer; v_corpses integer;
BEGIN
  SELECT count(*) INTO v_corpses FROM public.tables
   WHERE cluster_id IS NOT NULL AND role = 'main' AND main_index IS NOT NULL
     AND (lifecycle = 'closed' OR coalesce(is_deleted, false) = true);
  IF v_corpses > 0 THEN
    RAISE EXCEPTION 'ABORT: % closed cluster main(s) still hold an index', v_corpses;
  END IF;

  SELECT count(*) INTO v_dupes FROM (
    SELECT cluster_id FROM public.tables
     WHERE cluster_id IS NOT NULL AND role = 'main' AND main_index IS NOT NULL
       AND coalesce(is_deleted, false) = false AND lifecycle <> 'closed'
     GROUP BY cluster_id, main_index HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'ABORT: % cluster/index pair(s) still answered by two live tables', v_dupes;
  END IF;
END $assert$;

COMMIT;
