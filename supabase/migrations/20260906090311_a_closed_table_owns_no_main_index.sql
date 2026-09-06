-- A CLOSED TABLE OWNS NO MAIN INDEX, AND THE GUARD NOW WATCHES THE RIGHT EVENT
-- (2026-09-06)
--
-- `20260905155400` created `fn_closed_cluster_main_releases_index` to hold one
-- invariant: a cluster table that is closed or deleted carries no
-- `main_index`. It also nulled every row that already broke it. Its own
-- assertion passed when it ran.
--
-- READ 2026-09-06: 2,935 closed tables carry a `main_index` again. Every one
-- of them:
--   - belongs to ONE game, 37ac7634 (NLH 0.05/0.10 Classic), the game whose
--     R3 repair looped and opened 3,000 Main 1 tables between 08:01 and 10:29
--     CDT on 2026-09-05 before `20260905194329` fixed it;
--   - has `role = 'main'` and a `main_index` from 2 to 2993, sequential, which
--     is the shape of a renumber over every table of a game in creation order;
--   - was written at EXACTLY `2026-09-05 10:57:38 CDT`, one statement, three
--     minutes AFTER `20260905155400` had nulled them.
-- No other game has a single such row, and 542 closed cluster tables correctly
-- hold NULL. Nothing has been stamped since.
--
-- WHY THE GUARD DID NOT CATCH IT. The function is correct. The TRIGGER is
-- narrower than the invariant it defends:
--
--   BEFORE INSERT OR UPDATE OF lifecycle, is_deleted
--
-- A renumber writes `main_index` and `name`. It touches neither `lifecycle`
-- nor `is_deleted`, so the trigger never fires and a closed row silently
-- acquires an index. The guard watches the event that CLOSES a table and is
-- blind to the event that STAMPS one, which is the other half of the same
-- invariant. A guard that reads as armed while being unreachable is the exact
-- shape CLAUDE.md warns about in the engine-restart handoff.
--
-- WHAT CHANGES
--   1. The trigger is re-created over `lifecycle, is_deleted, main_index,
--      cluster_id`. Those four are every column whose write can put an index
--      on a closed cluster table: closing it, deleting it, stamping it, or
--      making it a cluster table while it already carries one. The function
--      body is not touched.
--   2. The 2,935 rows are nulled.
--
-- WHY NOT A CHECK CONSTRAINT. It would be stronger, and it is deliberately not
-- here. `public.tables` is 172,072 rows and 110 MB and the cluster controller
-- writes it every five seconds; on 2026-09-05 a `CREATE UNIQUE INDEX` on this
-- same table deadlocked against that tick and rolled a migration back whole.
-- A BEFORE trigger nulls the value before any constraint is evaluated, so a
-- CHECK could only ever fire if the trigger were dropped - it would buy the
-- guarantee that the trigger still exists, at the price of a second
-- ACCESS EXCLUSIVE lock on a hot table. The repo holds that guarantee more
-- cheaply: `tests/aClosedTableOwnsNoMainIndex.law.test.ts` pins the trigger's
-- column list, so it cannot be narrowed again without a red test.
--
-- SAFETY, AND WHY THIS FILE IS TWO TRANSACTIONS. The first attempt put the
-- trigger DDL and the UPDATE in one transaction and DEADLOCKED against the
-- cluster controller: any trigger change on `public.tables` needs an
-- ACCESS EXCLUSIVE lock, the tick holds row locks on that table every five
-- seconds, and a transaction that already holds something else can deadlock
-- rather than simply wait. Nothing applied; it rolled back whole. So:
--
--   TRANSACTION 1 - the data. Touches only rows that are ALREADY closed, which
--   the tick never writes, so it takes no lock the controller wants.
--   TRANSACTION 2 - the DDL, holding NOTHING else. It opens by asking for the
--   table lock explicitly with a short `lock_timeout`, so it either gets a
--   quiet moment between ticks or fails immediately having held nothing, which
--   cannot deadlock. If it times out, re-run this one transaction; the data
--   half is already done and is idempotent anyway.
--
-- Do NOT stamp the version in `schema_migrations` until BOTH transactions have
-- actually succeeded - a false stamp had to be deleted by hand on 2026-09-05.
--
-- Order is deliberate: data first. The window between the two is a few
-- milliseconds, and nothing has stamped a closed row since 2026-09-05 10:57:38
-- because the R3 loop that did it was fixed by `20260905194329`.
--
-- ROLLBACK:
--   DROP TRIGGER trg_tables_closed_main_releases_index ON public.tables;
--   CREATE TRIGGER trg_tables_closed_main_releases_index
--     BEFORE INSERT OR UPDATE OF lifecycle, is_deleted ON public.tables
--     FOR EACH ROW EXECUTE FUNCTION fn_closed_cluster_main_releases_index();
--   (the nulled main_index values are not restored, and must not be: they were
--    the defect.)

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE v_def text;
BEGIN
  SELECT pg_get_triggerdef(oid) INTO v_def
    FROM pg_trigger WHERE tgname = 'trg_tables_closed_main_releases_index';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'trg_tables_closed_main_releases_index is absent - re-apply 20260905155400 first';
  END IF;
END
$guard$;

-- TRANSACTION 1: the rows that got through.
UPDATE public.tables
   SET main_index = NULL
 WHERE cluster_id IS NOT NULL
   AND main_index IS NOT NULL
   AND (lifecycle = 'closed' OR coalesce(is_deleted, false) = true);

DO $post1$
DECLARE v_left integer; v_live_main1 integer;
BEGIN
  SELECT count(*) INTO v_left FROM public.tables
   WHERE cluster_id IS NOT NULL AND main_index IS NOT NULL
     AND (lifecycle = 'closed' OR coalesce(is_deleted, false) = true);
  IF v_left > 0 THEN
    RAISE EXCEPTION '% closed cluster table(s) still own a main_index', v_left;
  END IF;

  -- The live board is untouched: every enabled must-move game still has
  -- exactly one Main 1, which is what this column exists to say.
  SELECT count(*) INTO v_live_main1
    FROM public.cash_games g
   WHERE g.enabled AND g.must_move
     AND (SELECT count(*) FROM public.tables t
           WHERE t.cluster_id = g.id AND t.lifecycle <> 'closed'
             AND t.role = 'main' AND t.main_index = 1) <> 1;
  IF v_live_main1 > 0 THEN
    RAISE EXCEPTION '% enabled game(s) do not have exactly one live Main 1 after the clean', v_live_main1;
  END IF;
END
$post1$;

COMMIT;

-- TRANSACTION 2: the guard, holding nothing else.
BEGIN;
SET LOCAL lock_timeout = '4s';

-- Asked for explicitly and FIRST. This transaction holds no other lock, so it
-- can only wait for a quiet moment or fail; it cannot be half of a cycle.
LOCK TABLE public.tables IN ACCESS EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS trg_tables_closed_main_releases_index ON public.tables;
CREATE TRIGGER trg_tables_closed_main_releases_index
  BEFORE INSERT OR UPDATE OF lifecycle, is_deleted, main_index, cluster_id
  ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_closed_cluster_main_releases_index();

COMMENT ON TRIGGER trg_tables_closed_main_releases_index ON public.tables IS
  'A closed or deleted cluster table owns no main_index. Watches main_index and cluster_id as well as lifecycle and is_deleted: a renumber writes only main_index, and the narrower list let 2,935 rows through on 2026-09-05.';

DO $post2$
DECLARE v_def text;
BEGIN
  SELECT pg_get_triggerdef(oid) INTO v_def FROM pg_trigger
   WHERE tgname = 'trg_tables_closed_main_releases_index';
  IF position('main_index' IN v_def) = 0 OR position('cluster_id' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the trigger does not watch main_index and cluster_id: %', v_def;
  END IF;
END
$post2$;

COMMIT;
