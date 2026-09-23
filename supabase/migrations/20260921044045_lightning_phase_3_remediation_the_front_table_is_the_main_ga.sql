-- 20260921044045_lightning_phase_3_remediation_the_front_table_is_the_main_ga.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- LIGHTNING 2.0 - PHASE 3 REMEDIATION. An adversarial audit of 20260921025504
-- and 20260921025523, run against the live catalogue after both were applied,
-- found one blocker and two majors. Both files stay exactly as they were
-- applied; this one repairs what they got wrong.
--
-- BLOCKER: NOTHING KEPT THE EPOCH INVARIANT TRUE.
--
-- 20260921025504 created public.cash_cluster_epoch, backfilled 166 genesis
-- rows, declared in its own @live-proof that EVERY cash_games row has an open
-- epoch row - and then left that a one-shot. Nothing in the estate writes to
-- the table. The first Cluster created after it applied would have had no
-- epoch row, and because the same migration made lightning_pool_session and
-- lightning_instance reference (cluster_id, cluster_epoch), the first Phase 4
-- or Phase 5 write for that Cluster would have raised 23503 on
-- lightning_pool_session_runs_in_a_declared_epoch. Every Lightning-capable
-- game created from that moment would have been un-Lightningable until
-- somebody backfilled by hand - which is to say, precisely the games Phase 3
-- exists to create.
--
-- An invariant that nothing maintains is not an invariant. The epoch now
-- FOLLOWS its game: an AFTER trigger on cash_games writes the genesis row when
-- a Cluster is created, and moves the history forward when cash_games.
-- cluster_epoch changes. Phase 5 then bumps one integer and the history is
-- correct by construction rather than by remembering.
--
-- MAJOR: R3 REOPENED A FEEDER AND CALLED IT "<game> Feeder".
--
-- 20260921025523 gave fn_cash_cluster_open_table an arm reading
-- `WHEN v_n = 0 THEN g.name`, where v_n is `count(*) FROM public.tables WHERE
-- cluster_id = p_game_id` - EVERY row, closed and deleted included. On the
-- creation path v_n is 0 and the arm fires. On the R3 reopen path - the tick
-- reopening a Cluster's one table after it closed - the closed row is still
-- there, so v_n >= 1 and the name falls through to `left(g.name, 50) ||
-- ' Feeder'`. The lone-feeder guard added by the same migration then stops the
-- ROLES step promoting it, so it never self-heals, and fn_cash_cluster_front_
-- table returns it: the lobby prints "NLH 1/2 Action Feeder" as the name of
-- the game, which is verbatim the defect that migration says it fixed. The
-- count now asks how many tables are LIVE, which is 0 on both paths and >= 1
-- for every later feeder. The comment line the arm carries is unchanged
-- because 20260921025523's eleventh @live-proof pins it.
--
-- MAJOR: "THREE READERS" WAS SIX.
--
-- 20260921025523 said three readers ask which table stands for a game and
-- migrated all three. The catalogue says six. The three it missed all govern
-- the SEAT CHANGE, and on a feeder-first Cluster each is wrong in a different
-- direction:
--
--   * fn_cash_game_lobby emits `on_main_one` and `seat_change.available` from
--     `me.role = 'main' AND me.main_index = 1`. On a Cluster whose one table
--     is a feeder that is false, so MustMoveLobbyModal renders neither "You
--     Are In The Main Game." nor a must-move position - the only player in the
--     only game there is reads no status line at all - and offers a Seat
--     Change button that cannot work.
--   * fn_cash_seat_change_request refuses a request FROM Main 1
--     (SEAT_CHANGE_NOT_FROM_MAIN) and TO Main 1 (SEAT_CHANGE_NEVER_TO_MAIN).
--     Neither fires. Pressing the button raises SEAT_CHANGE_NO_OTHER_TABLE
--     instead, and once a second table exists a player can spend their
--     once-per-stay seat change to LEAVE the table that is the game.
--   * fn_cash_seat_change_plan cancels a request from a table that became
--     Main 1, and refuses to route anyone onto Main 1. Neither fires, so the
--     planner will seat a player ONTO the front table out of must-move order,
--     which is the one thing "the main game fills in must-move order only"
--     forbids.
--
-- All three now ask fn_cash_cluster_front_table, which for every one of the
-- 166 live Clusters returns exactly the Main 1 they were already finding.
--
-- AND THE BREAK STEP, WHICH WAS SAFE BY ACCIDENT.
--
-- fn_cash_cluster_tick's BREAK step picks a candidate `WHERE NOT (c.role =
-- 'main' AND c.main_index = 1)`, which on a feeder-first Cluster admits the
-- one table the game has. It is saved today only by the next guard,
-- `IF v_remaining_tables >= 1`, which is false when there is nothing else
-- left. Being saved by a different clause than the one written for the job is
-- not a rule, so the candidate predicate is converted too.
--
-- TWO READERS DELIBERATELY NOT CONVERTED, AND WHY.
--
--   * fn_cash_cluster_tick's must-move draw widens a MAIN 1 seat to draw from
--     the whole board (`t.main_index = 1 AND c.id <> t.id`). A feeder-first
--     Cluster has no Main 1, so the widening simply does not apply, and the
--     ordinary feeder-to-main draw resumes the moment the ROLES step names
--     one. Converting it would change which table a Main 2 seat may draw from,
--     which is a must-move rule and not a Lightning one.
--   * fn_cash_cluster_balance carries no main_index predicate in its live
--     body at all - it moves from the fullest table to the emptiest, and with
--     one table it does nothing. The law test that pins that predicate reads a
--     frozen migration file, not the catalogue.
--
-- THE FRONT TABLE ITSELF IS RE-CUT, FOR THREE REASONS AT ONCE.
--
--   1. `ORDER BY (t.role = 'main' AND t.main_index = 1) DESC` is NULLS FIRST
--      by default, and that expression is NULL - not false - for a row with
--      role 'main' and a NULL main_index. Such a row would have outranked the
--      real Main 1. There are none live today; there were 3,085 closed ones.
--   2. The single ORDER BY lost the index condition the old subselect had.
--      Measured on production: the tick worklist went from 6.13 ms / 1,265
--      buffers to 13.97 ms / 2,644, because `Index Cond: (cluster_id = g.id
--      AND role = 'main' AND main_index = 1)` became `Index Cond: (cluster_id
--      = g.id)` plus a Sort. It runs every five seconds.
--   3. It admitted a BREAKING table as a Cluster's front, and the tick's own
--      2026-09-09 repair works by renumbering a breaking main out of the live
--      range precisely so the old reader would stop returning it.
--
-- Three coalesced index lookups fix all three: the Main 1 lookup first, which
-- short-circuits for all 108 Clusters that have one and restores the index
-- condition; then the oldest live non-breaking table; then, only if a Cluster
-- is entirely breaking, the oldest live table of any kind. No boolean is
-- sorted, so there is no NULL to sort first.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.cash_games'::regclass AND tgname = 'trg_cash_games_epoch_follows_its_game' AND NOT tgisinternal))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e WHERE e.cluster_id = g.id AND e.epoch = g.cluster_epoch AND e.ended_at IS NULL)))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch a JOIN public.cash_cluster_epoch b ON b.cluster_id = a.cluster_id AND b.epoch > a.epoch WHERE b.started_at < coalesce(a.ended_at, 'infinity'::timestamptz)))
-- @live-proof: (SELECT count(*) = 0 FROM (SELECT cluster_id FROM public.cash_cluster_epoch WHERE started_by = 'genesis' GROUP BY cluster_id HAVING count(*) > 1) x)
-- @live-proof: (SELECT position('CLUSTER_EPOCH_GOES_FORWARD' in pg_get_functiondef('public.fn_cash_cluster_epoch_follows_its_game()'::regprocedure)) > 0)
-- @live-proof: (SELECT position('coalesce(' in pg_get_functiondef('public.fn_cash_cluster_front_table(uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('DESC' in pg_get_functiondef('public.fn_cash_cluster_front_table(uuid)'::regprocedure)) = 0)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE public.fn_cash_cluster_front_table(g.id) IS DISTINCT FROM (SELECT t.id FROM public.tables t WHERE t.cluster_id = g.id AND t.role = 'main' AND t.main_index = 1 AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false ORDER BY t.created_at LIMIT 1) AND EXISTS (SELECT 1 FROM public.tables t2 WHERE t2.cluster_id = g.id AND t2.role = 'main' AND t2.main_index = 1 AND t2.lifecycle <> 'closed' AND coalesce(t2.is_deleted, false) = false)))
-- @live-proof: (SELECT position('the cluster''s first table stands for the game' in pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('lifecycle <> ''closed'' AND coalesce(is_deleted, false) = false' in pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('front_table_id' in pg_get_functiondef('public.fn_cash_game_lobby(uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('fn_cash_cluster_front_table' in pg_get_functiondef('public.fn_cash_game_lobby(uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('fn_cash_cluster_lightning_state' in pg_get_functiondef('public.fn_cash_game_lobby(uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('fn_cash_cluster_front_table' in pg_get_functiondef('public.fn_cash_seat_change_request(uuid,uuid,uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('SEAT_CHANGE_NOT_FROM_MAIN' in pg_get_functiondef('public.fn_cash_seat_change_request(uuid,uuid,uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('SEAT_CHANGE_NEVER_TO_MAIN' in pg_get_functiondef('public.fn_cash_seat_change_request(uuid,uuid,uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('fn_cash_cluster_front_table' in pg_get_functiondef('public.fn_cash_seat_change_plan(uuid,timestamp with time zone)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('now_on_main_one' in pg_get_functiondef('public.fn_cash_seat_change_plan(uuid,timestamp with time zone)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('fn_cash_cluster_front_table' in pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('lone_feeder_is_the_cluster' in pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure)) > 0)
-- @live-proof: (SELECT to_regclass('public.lightning_pool_session_by_epoch') IS NOT NULL AND to_regclass('public.lightning_instance_by_epoch') IS NOT NULL)

BEGIN;

-- The tick locks cash_games before it writes cash_cluster_events; this takes
-- the same lock first, for the same reason 20260921025504 does, and holds
-- nothing else. lock_timeout bounds each acquisition.
SET LOCAL lock_timeout = '8s';
LOCK TABLE public.cash_games IN EXCLUSIVE MODE;

-- ===========================================================================
-- 1. THE EPOCH FOLLOWS ITS GAME
-- ===========================================================================
-- Three events, one function.
--
--   INSERT       a new Cluster is born at its own cluster_epoch, under its own
--                cluster_mode, and that is its genesis epoch.
--   epoch moves  the open epoch ends and the new one opens, carrying the mode
--                the Cluster is in at that moment and the reason, if the
--                caller set one. Backwards is refused: an epoch that could be
--                reused would make every historical Lightning row ambiguous,
--                which is the whole reason the epoch became a row.
--   mode moves   the OPEN epoch's mode follows. A FINISHED epoch's mode never
--                changes, which is why cash_cluster_epoch carries its own copy
--                rather than joining cash_games.
--
-- The reason is read from ca.epoch_reason, a SET LOCAL a conversion sets in
-- its own transaction, exactly like ca.break_window_migration_override. It is
-- never required; an unexplained bump files as 'unstated' rather than being
-- refused, because refusing it would make the history LESS complete, not more.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_epoch_follows_its_game()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by, started_at)
    VALUES (NEW.id, NEW.cluster_epoch, NEW.cluster_mode, 'genesis', NEW.created_at)
    ON CONFLICT (cluster_id, epoch) DO NOTHING;
    RETURN NULL;
  END IF;

  IF NEW.cluster_epoch IS DISTINCT FROM OLD.cluster_epoch THEN
    IF NEW.cluster_epoch < OLD.cluster_epoch THEN
      RAISE EXCEPTION 'CLUSTER_EPOCH_GOES_FORWARD: cluster % cannot move from epoch % back to %',
        NEW.id, OLD.cluster_epoch, NEW.cluster_epoch
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.cash_cluster_epoch
       SET ended_at = clock_timestamp()
     WHERE cluster_id = NEW.id AND ended_at IS NULL;
    INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by)
    VALUES (NEW.id, NEW.cluster_epoch, NEW.cluster_mode,
            coalesce(nullif(current_setting('ca.epoch_reason', true), ''), 'unstated'));
    RETURN NULL;
  END IF;

  IF NEW.cluster_mode IS DISTINCT FROM OLD.cluster_mode THEN
    UPDATE public.cash_cluster_epoch
       SET mode = NEW.cluster_mode
     WHERE cluster_id = NEW.id AND ended_at IS NULL;
  END IF;
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_epoch_follows_its_game() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fn_cash_cluster_epoch_follows_its_game() IS
  'Keeps public.cash_cluster_epoch true of public.cash_games without anyone having to remember: the genesis row on INSERT, a closed row and a new open one when cluster_epoch moves forward, and the open row''s mode when cluster_mode moves. 20260921025504 created the table, backfilled it once and declared the invariant in a proof, and nothing maintained it - so the first Cluster created after it had no epoch row and could never have written a Lightning row at all.';

DROP TRIGGER IF EXISTS trg_cash_games_epoch_follows_its_game ON public.cash_games;
CREATE TRIGGER trg_cash_games_epoch_follows_its_game
  AFTER INSERT OR UPDATE OF cluster_epoch, cluster_mode ON public.cash_games
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_cash_cluster_epoch_follows_its_game();

-- THE CATCH-UP, IN THREE STATEMENTS BECAUSE ONE CANNOT DO IT.
--
-- Two different things can have gone wrong in the window where nothing
-- maintained the table: a Cluster CREATED in it has no epoch row at all, and a
-- Cluster whose epoch MOVED in it still has an open row at the epoch it has
-- left. The second is the one a single INSERT cannot repair. ON CONFLICT takes
-- one arbiter, and the primary key (cluster_id, epoch) is not the index that
-- would be violated: cash_cluster_epoch_current is UNIQUE on (cluster_id)
-- WHERE ended_at IS NULL, so inserting the new epoch beside a stale open one
-- raises 23505 and rolls the whole migration back - on exactly the damage it
-- exists to repair. Reproduced on a throwaway backend before this was written.
--
-- So it is three statements: the stale open rows are closed, a Cluster born in
-- the window gets a genesis, and a Cluster whose epoch moved in it gets a
-- successor dated from when its predecessor ended. Expected to touch nothing on
-- production; written because "expected nothing" is not a reason to leave a hole.
UPDATE public.cash_cluster_epoch e
   SET ended_at = clock_timestamp()
  FROM public.cash_games g
 WHERE g.id = e.cluster_id
   AND e.ended_at IS NULL
   AND e.epoch IS DISTINCT FROM g.cluster_epoch;

-- A CLUSTER BORN IN THE WINDOW gets a genesis, dated when it was born.
INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by, started_at)
SELECT g.id, g.cluster_epoch, g.cluster_mode, 'genesis', g.created_at
  FROM public.cash_games g
 WHERE NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e WHERE e.cluster_id = g.id)
ON CONFLICT (cluster_id, epoch) DO NOTHING;

-- A CLUSTER WHOSE EPOCH MOVED IN THE WINDOW gets a successor, and it is not a
-- genesis. Two things follow from that and the first draft got both wrong by
-- writing one INSERT for both cases:
--
--   * started_by is 'recovered', not 'genesis'. Two rows claiming to be one
--     Cluster's genesis is a contradiction on the face of the table, and
--     20260921025504's own column comment says this field carries the
--     conversion reason after the first epoch.
--   * started_at is when its PREDECESSOR ENDED - the timestamp the UPDATE
--     above just wrote - and never the Cluster's created_at. Dated from
--     creation, the successor would start twenty days before the epoch it
--     succeeds finished, and the two would overlap for the whole life of the
--     first. cash_cluster_epoch_ends_after_it_starts cannot see that: it
--     compares a row against itself, not against its siblings.
INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by, started_at)
SELECT g.id, g.cluster_epoch, g.cluster_mode, 'recovered',
       coalesce((SELECT max(e.ended_at) FROM public.cash_cluster_epoch e WHERE e.cluster_id = g.id),
                clock_timestamp())
  FROM public.cash_games g
 WHERE EXISTS (SELECT 1 FROM public.cash_cluster_epoch e WHERE e.cluster_id = g.id)
   AND NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e
                    WHERE e.cluster_id = g.id AND e.epoch = g.cluster_epoch AND e.ended_at IS NULL)
ON CONFLICT (cluster_id, epoch) DO UPDATE
  -- greatest(), not EXCLUDED outright: re-opening a row that already existed
  -- must not move its start EARLIER than it was recorded, and must not leave
  -- it earlier than the epoch it now succeeds ended. Without this the computed
  -- start is discarded on the conflict path and the overlap assertion below
  -- refuses the whole migration rather than repairing the estate.
  SET ended_at = NULL,
      mode = EXCLUDED.mode,
      started_at = greatest(cash_cluster_epoch.started_at, EXCLUDED.started_at);

DO $$
DECLARE v_missing bigint;
BEGIN
  SELECT count(*) INTO v_missing
    FROM public.cash_games g
   WHERE NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e
                      WHERE e.cluster_id = g.id AND e.epoch = g.cluster_epoch AND e.ended_at IS NULL);
  IF v_missing IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION '% cluster(s) still have no open epoch row', v_missing;
  END IF;

  -- AND NO CLUSTER'S EPOCHS OVERLAP IN TIME. Nothing enforces this as a
  -- constraint - an EXCLUDE over a tstzrange would need btree_gist for the
  -- uuid half - so it is asserted here, where a catch-up that dated a
  -- successor from its Cluster's birth would be caught. The trigger keeps it
  -- true from here on: a successor's started_at defaults to clock_timestamp()
  -- in the same statement that closes its predecessor.
  SELECT count(*) INTO v_missing
    FROM public.cash_cluster_epoch a
    JOIN public.cash_cluster_epoch b
      ON b.cluster_id = a.cluster_id AND b.epoch > a.epoch
   WHERE b.started_at < coalesce(a.ended_at, 'infinity'::timestamptz);
  IF v_missing IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION '% pair(s) of epochs overlap in time; an epoch cannot begin before the one it succeeds has ended', v_missing;
  END IF;
END $$;

-- ===========================================================================
-- 2. THE TWO REFERENTIAL CHECKS GET AN INDEX
-- ===========================================================================
-- lightning_pool_session_runs_in_a_declared_epoch and its instance twin are
-- ON DELETE RESTRICT, so deleting a cash_games row cascades to
-- cash_cluster_epoch and then has to prove no Lightning row names that epoch.
-- The only leading-cluster_id indexes on those two relations are PARTIAL -
-- `WHERE exited_at IS NULL` and `WHERE state IN (...)` - so an exited session
-- or a completed instance is outside both and the check would sequentially
-- scan. Both relations are empty, so these cost nothing to add now.

CREATE INDEX IF NOT EXISTS lightning_pool_session_by_epoch
  ON public.lightning_pool_session (cluster_id, cluster_epoch);

CREATE INDEX IF NOT EXISTS lightning_instance_by_epoch
  ON public.lightning_instance (cluster_id, cluster_epoch);

-- ===========================================================================
-- 3. THE FRONT TABLE, RE-CUT
-- ===========================================================================
-- Three coalesced lookups instead of one sort. Identical answer for every
-- Cluster that has a live Main 1, which is what the sixth proof above asserts
-- and what 20260921025523's own ninth proof already asserts against a fixed
-- expression - so a regression here fails two independent files.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_front_table(p_game_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT coalesce(
    -- The Cluster's Main 1, on the index that already exists for it.
    (SELECT t.id FROM public.tables t
      WHERE t.cluster_id = p_game_id AND t.role = 'main' AND t.main_index = 1
        AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false
      ORDER BY t.created_at, t.id LIMIT 1),
    -- Otherwise its oldest live table that is not breaking. A breaking table
    -- refuses every player it is sent (TABLE_CLOSING), so it must not be what
    -- the controller keys its eligible-horse map on.
    (SELECT t.id FROM public.tables t
      WHERE t.cluster_id = p_game_id
        AND t.lifecycle NOT IN ('closed', 'breaking') AND coalesce(t.is_deleted, false) = false
      ORDER BY t.created_at, t.id LIMIT 1),
    -- And only if every table it has is breaking, the oldest of those: a game
    -- that still exists is better represented by a closing table than by
    -- nothing at all.
    (SELECT t.id FROM public.tables t
      WHERE t.cluster_id = p_game_id
        AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false
      ORDER BY t.created_at, t.id LIMIT 1));
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_front_table(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_front_table(uuid) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_front_table(uuid) IS
  'The one table that stands for a Cluster: its live Main 1 when it has one, otherwise its oldest live table that is not breaking, otherwise its oldest breaking one. A Lightning-capable Cluster begins as a single feeder and has no Main 1 at all, and every reader that asked for role = main AND main_index = 1 answered NULL for it. Three coalesced lookups rather than one ORDER BY: the first keeps the index condition the old subselect had, and no boolean is sorted, so a row with role main and a NULL main_index cannot sort ahead of the real Main 1.';

-- ===========================================================================
-- 4. THE CLUSTER WRITER COUNTS LIVE TABLES
-- ===========================================================================

DO $do$
DECLARE v_src text; v_find text; v_repl text; v_n integer;
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure);
  IF position('lifecycle <> ''closed'' AND coalesce(is_deleted, false) = false' in v_src) > 0 THEN
    RAISE NOTICE 'fn_cash_cluster_open_table already counts live tables; nothing to do';
    RETURN;
  END IF;
  v_find :=
    '  -- "NLH 1/2 Classic" for Main 1, "NLH 1/2 Classic Main 2", "... Feeder".' || chr(10) ||
    '  SELECT count(*) INTO v_n FROM public.tables WHERE cluster_id = p_game_id;' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the live writer carries the table count % times, not once; read it before re-running', v_n;
  END IF;
  v_repl :=
    '  -- "NLH 1/2 Classic" for Main 1, "NLH 1/2 Classic Main 2", "... Feeder".' || chr(10) ||
    '  -- LIVE tables only. R3 reopens a closed cluster''s one table with the' || chr(10) ||
    '  -- closed row still present, so an all-time count made a reopened lone' || chr(10) ||
    '  -- feeder "<game> Feeder" and the lone-feeder guard then stopped the ROLES' || chr(10) ||
    '  -- step ever renaming it (2026-09-21 remediation).' || chr(10) ||
    '  SELECT count(*) INTO v_n FROM public.tables WHERE cluster_id = p_game_id' || chr(10) ||
    '     AND lifecycle <> ''closed'' AND coalesce(is_deleted, false) = false;' || chr(10);
  v_src := replace(v_src, v_find, v_repl);
  IF position('the cluster''s first table stands for the game' in v_src) = 0
     OR position('ROLE_INVALID' in v_src) = 0 OR position('MAIN_INDEX_INVALID' in v_src) = 0
     OR position('LIFECYCLE_INVALID' in v_src) = 0 OR position('GAME_NOT_FOUND' in v_src) = 0 THEN
    RAISE EXCEPTION 'a sibling guard did not survive the edit to fn_cash_cluster_open_table';
  END IF;
  EXECUTE v_src;
END $do$;

-- ===========================================================================
-- 5. THE LOBBY SAYS WHICH TABLE IS THE GAME, AND JUDGES BY IT
-- ===========================================================================
-- front_table_id is added to the payload as well as used inside it, because
-- the browser asks the same question: MustMoveLobbyModal decides which tables
-- may be requested, and src/services/cashGameLobby.ts names them. Neither can
-- answer it from a row alone, for exactly the reason the database could not.

DO $do$
DECLARE v_src text; v_find text; v_repl text; v_n integer;
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_game_lobby(uuid)'::regprocedure);
  IF position('fn_cash_cluster_front_table' in v_src) > 0 THEN
    RAISE NOTICE 'fn_cash_game_lobby already asks the front table; nothing to do';
    RETURN;
  END IF;

  v_find := chr(10) || '    ''lightning'', public.fn_cash_cluster_lightning_state(g.id),' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the live lobby carries the lightning line % times, not once', v_n; END IF;
  v_repl := chr(10) || '    ''lightning'', public.fn_cash_cluster_lightning_state(g.id),' || chr(10) ||
            '    ''front_table_id'', public.fn_cash_cluster_front_table(g.id),' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  v_find := chr(10) || '      ''on_main_one'', (me.role = ''main'' AND me.main_index = 1),' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the live lobby carries on_main_one % times, not once', v_n; END IF;
  -- Plain = rather than IS DISTINCT FROM: an unseated caller has a NULL
  -- me.table_id and this must stay NULL for them, which is what the lobby has
  -- always emitted and what the audit fixtures assert.
  v_repl := chr(10) || '      ''on_main_one'', (me.table_id = public.fn_cash_cluster_front_table(g.id)),' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  v_find := 'NOT (me.role = ''main'' AND me.main_index = 1)';
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the live lobby carries the availability predicate % times, not once', v_n; END IF;
  v_repl := 'me.table_id IS DISTINCT FROM public.fn_cash_cluster_front_table(g.id)';
  v_src := replace(v_src, v_find, v_repl);

  IF position('fn_cash_cluster_lightning_state' in v_src) = 0
     OR position('must_move_position' in v_src) = 0
     OR position('seat_change' in v_src) = 0
     OR position('pending_move' in v_src) = 0 THEN
    RAISE EXCEPTION 'a sibling field did not survive the edit to fn_cash_game_lobby';
  END IF;
  EXECUTE v_src;
END $do$;

-- ===========================================================================
-- 6. THE SEAT-CHANGE DOOR REFUSES THE FRONT TABLE
-- ===========================================================================

DO $do$
DECLARE v_src text; v_find text; v_repl text; v_n integer;
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_seat_change_request(uuid,uuid,uuid)'::regprocedure);
  IF position('fn_cash_cluster_front_table' in v_src) > 0 THEN
    RAISE NOTICE 'fn_cash_seat_change_request already asks the front table; nothing to do';
    RETURN;
  END IF;

  v_find := chr(10) || '  IF me.role = ''main'' AND me.main_index = 1 THEN' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the live door carries the from-main test % times, not once', v_n; END IF;
  v_repl := chr(10) || '  IF me.table_id = public.fn_cash_cluster_front_table(g.id) THEN' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  v_find := chr(10) || '    IF dst.role = ''main'' AND dst.main_index = 1 THEN' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the live door carries the to-main test % times, not once', v_n; END IF;
  v_repl := chr(10) || '    IF dst.id = public.fn_cash_cluster_front_table(g.id) THEN' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  -- IS DISTINCT FROM, not NOT (=): fn_cash_cluster_front_table answers NULL
  -- for a cluster whose every table has closed, and `NOT (t.id = NULL)` is
  -- NULL, which would empty the EXISTS and refuse everyone with
  -- SEAT_CHANGE_NO_OTHER_TABLE.
  v_find := 'NOT (t.role = ''main'' AND t.main_index = 1)';
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the live door carries the other-table test % times, not once', v_n; END IF;
  v_repl := 't.id IS DISTINCT FROM public.fn_cash_cluster_front_table(g.id)';
  v_src := replace(v_src, v_find, v_repl);

  IF position('SEAT_CHANGE_NOT_FROM_MAIN' in v_src) = 0
     OR position('SEAT_CHANGE_NEVER_TO_MAIN' in v_src) = 0
     OR position('SEAT_CHANGE_TABLE_CLOSING' in v_src) = 0
     OR position('SEAT_CHANGE_SAME_TABLE' in v_src) = 0
     OR position('SEAT_CHANGE_NO_OTHER_TABLE' in v_src) = 0
     OR position('SEAT_CHANGE_TABLE_UNAVAILABLE' in v_src) = 0
     OR position('NOT_IN_GAME' in v_src) = 0 THEN
    RAISE EXCEPTION 'a refusal did not survive the edit to fn_cash_seat_change_request';
  END IF;
  EXECUTE v_src;
END $do$;

-- ===========================================================================
-- 7. THE SEAT-CHANGE PLANNER NEVER ROUTES ONTO THE FRONT TABLE
-- ===========================================================================

DO $do$
DECLARE v_src text; v_find text; v_repl text; v_n integer;
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_seat_change_plan(uuid,timestamp with time zone)'::regprocedure);
  IF position('fn_cash_cluster_front_table' in v_src) > 0 THEN
    RAISE NOTICE 'fn_cash_seat_change_plan already asks the front table; nothing to do';
    RETURN;
  END IF;

  -- READ THE FRONT TABLE ONCE. Both destination filters below scan
  -- unnest(v_census) once per pending request, and PostgreSQL does not cache a
  -- STABLE call across the rows of a scan even when its argument is constant,
  -- so calling it inside the predicate would be one index lookup per census
  -- row per request. A local is read once per call.
  v_find := '  v_seat_a integer; v_seat_b integer;' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the live planner carries its seat declarations % times, not once', v_n; END IF;
  v_repl := '  v_seat_a integer; v_seat_b integer;' || chr(10) || '  v_front uuid;' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  v_find := '  v_census := public.fn_cash_cluster_census(p_game_id, p_now);' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the live planner builds its census % times, not once', v_n; END IF;
  v_repl := '  v_census := public.fn_cash_cluster_census(p_game_id, p_now);' || chr(10) ||
            '  v_front := public.fn_cash_cluster_front_table(p_game_id);' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  -- The EXISTS keeps its unnest(v_census) shape: it also means "and the table
  -- they asked from is still part of the game", which a bare comparison of
  -- r.from_table_id against the front table would drop.
  v_find := 'WHERE c.id = r.from_table_id AND c.role = ''main'' AND c.main_index = 1) THEN';
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the live planner carries the became-main test % times, not once', v_n; END IF;
  v_repl := 'WHERE c.id = r.from_table_id AND c.id = v_front) THEN';
  v_src := replace(v_src, v_find, v_repl);

  -- The two destination filters are byte-identical lines, so each is anchored
  -- together with the line above it.
  v_find := '     WHERE c.id <> r.from_table_id AND NOT c.breaking AND c.lifecycle IN (''live'', ''opening'')' || chr(10) ||
            '       AND NOT (c.role = ''main'' AND c.main_index = 1)' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the live planner carries the target filter % times, not once', v_n; END IF;
  v_repl := '     WHERE c.id <> r.from_table_id AND NOT c.breaking AND c.lifecycle IN (''live'', ''opening'')' || chr(10) ||
            '       AND c.id IS DISTINCT FROM v_front' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  v_find := '       AND NOT c.breaking AND c.lifecycle = ''live''' || chr(10) ||
            '       AND NOT (c.role = ''main'' AND c.main_index = 1)' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the live planner carries the swap filter % times, not once', v_n; END IF;
  v_repl := '       AND NOT c.breaking AND c.lifecycle = ''live''' || chr(10) ||
            '       AND c.id IS DISTINCT FROM v_front' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  IF position('now_on_main_one' in v_src) = 0
     OR position('seat_change_returned' in v_src) = 0
     OR position('seat_change_used_at = NULL' in v_src) = 0
     OR position('swap_move_id' in v_src) = 0 THEN
    RAISE EXCEPTION 'a sibling step did not survive the edit to fn_cash_seat_change_plan';
  END IF;
  EXECUTE v_src;
END $do$;

-- ===========================================================================
-- 8. THE BREAK STEP NEVER PICKS THE FRONT TABLE
-- ===========================================================================

DO $do$
DECLARE v_src text; v_find text; v_repl text; v_n integer;
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure);
  IF position('fn_cash_cluster_front_table' in v_src) > 0 THEN
    RAISE NOTICE 'fn_cash_cluster_tick already asks the front table; nothing to do';
    RETURN;
  END IF;
  -- Same reasoning as the planner: the candidate scan walks unnest(v_census),
  -- so the front table is read into a local first rather than once per row.
  v_find := '  g record; t record; r record;' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the live tick carries its record declarations % times, not once', v_n; END IF;
  v_repl := '  g record; t record; r record;' || chr(10) || '  v_front uuid;' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  v_find := '  SELECT * INTO v_candidate FROM unnest(v_census) c' || chr(10) ||
            '   WHERE NOT (c.role = ''main'' AND c.main_index = 1) AND c.lifecycle = ''live''' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the live tick carries the break candidate filter % times, not once', v_n; END IF;
  v_repl := '  v_front := public.fn_cash_cluster_front_table(g.id);' || chr(10) ||
            '  SELECT * INTO v_candidate FROM unnest(v_census) c' || chr(10) ||
            '   WHERE c.id IS DISTINCT FROM v_front AND c.lifecycle = ''live''' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  IF position('lone_feeder_is_the_cluster' in v_src) = 0
     OR position('feeder_became_main1' in v_src) = 0
     OR position('main_renumbered' in v_src) = 0
     OR position('main1_reopened' in v_src) = 0
     OR position('move_planned' in v_src) = 0
     OR position('feeder_abandoned' in v_src) = 0
     OR position('table_opening_hold' in v_src) = 0
     OR position('fn_cash_seat_change_plan' in v_src) = 0
     OR position('fn_cash_cluster_census' in v_src) = 0
     OR position('status_followed_lifecycle' in v_src) = 0
     OR position('opening_hold_rested_until' in v_src) = 0 THEN
    RAISE EXCEPTION 'a sibling step did not survive the edit to fn_cash_cluster_tick';
  END IF;
  EXECUTE v_src;
END $do$;

-- ===========================================================================
-- 9. POST-APPLY READ-BACK FROM THE CATALOGUE
-- ===========================================================================

DO $assert$
DECLARE
  v_lob  text := pg_get_functiondef('public.fn_cash_game_lobby(uuid)'::regprocedure);
  v_req  text := pg_get_functiondef('public.fn_cash_seat_change_request(uuid,uuid,uuid)'::regprocedure);
  v_pln  text := pg_get_functiondef('public.fn_cash_seat_change_plan(uuid,timestamp with time zone)'::regprocedure);
  v_tck  text := pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure);
  v_opn  text := pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure);
  v_fnt  text := pg_get_functiondef('public.fn_cash_cluster_front_table(uuid)'::regprocedure);
  v_bad  bigint;
BEGIN
  IF position('front_table_id' in v_lob) = 0
     OR position('me.table_id = public.fn_cash_cluster_front_table(g.id)' in v_lob) = 0
     OR position('me.table_id IS DISTINCT FROM public.fn_cash_cluster_front_table(g.id)' in v_lob) = 0 THEN
    RAISE EXCEPTION 'the live lobby does not answer from the front table';
  END IF;
  IF position('me.role = ''main'' AND me.main_index = 1' in v_lob) > 0 THEN
    RAISE EXCEPTION 'the live lobby still judges the caller by Main 1';
  END IF;

  IF position('me.table_id = public.fn_cash_cluster_front_table(g.id)' in v_req) = 0
     OR position('dst.id = public.fn_cash_cluster_front_table(g.id)' in v_req) = 0
     OR position('t.id IS DISTINCT FROM public.fn_cash_cluster_front_table(g.id)' in v_req) = 0 THEN
    RAISE EXCEPTION 'the live seat-change door does not ask the front table in all three places';
  END IF;
  IF position('main_index = 1' in v_req) > 0 THEN
    RAISE EXCEPTION 'the live seat-change door still carries a Main 1 predicate';
  END IF;

  IF (length(v_pln) - length(replace(v_pln, 'public.fn_cash_cluster_front_table(p_game_id)', ''))) /
     length('public.fn_cash_cluster_front_table(p_game_id)') <> 1 THEN
    RAISE EXCEPTION 'the live planner does not read the front table exactly once';
  END IF;
  IF position('  v_front := public.fn_cash_cluster_front_table(p_game_id);' in v_pln) = 0
     OR position('c.id = v_front) THEN' in v_pln) = 0
     OR (length(v_pln) - length(replace(v_pln, 'c.id IS DISTINCT FROM v_front', ''))) /
        length('c.id IS DISTINCT FROM v_front') <> 2 THEN
    RAISE EXCEPTION 'the live planner does not judge all three places against the front table it read';
  END IF;
  IF position('main_index = 1' in v_pln) > 0 THEN
    RAISE EXCEPTION 'the live planner still carries a Main 1 predicate';
  END IF;

  IF position('  v_front := public.fn_cash_cluster_front_table(g.id);' in v_tck) = 0
     OR position('c.id IS DISTINCT FROM v_front AND c.lifecycle = ''live''' in v_tck) = 0 THEN
    RAISE EXCEPTION 'the live break step does not spare the front table';
  END IF;
  IF position('lone_feeder_is_the_cluster' in v_tck) = 0 THEN
    RAISE EXCEPTION 'the live tick lost the lone-feeder exception';
  END IF;

  IF position('AND lifecycle <> ''closed'' AND coalesce(is_deleted, false) = false;' in v_opn) = 0 THEN
    RAISE EXCEPTION 'the live cluster writer still counts closed tables';
  END IF;
  IF position('the cluster''s first table stands for the game' in v_opn) = 0 THEN
    RAISE EXCEPTION 'the live cluster writer lost the comment a merged proof pins';
  END IF;

  IF position('coalesce(' in v_fnt) = 0 OR position('DESC' in v_fnt) > 0 THEN
    RAISE EXCEPTION 'the live front table is not the coalesced form';
  END IF;

  -- THE ANSWER DID NOT MOVE. Every cluster with a live Main 1 must still get
  -- that Main 1; 108 of the 166 have one, so the comparison is not vacuous and
  -- the second query proves that rather than assuming it.
  SELECT count(*) INTO v_bad
    FROM public.cash_games g
    JOIN LATERAL (
      SELECT t.id FROM public.tables t
       WHERE t.cluster_id = g.id AND t.role = 'main' AND t.main_index = 1
         AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false
       ORDER BY t.created_at LIMIT 1
    ) m ON true
   WHERE public.fn_cash_cluster_front_table(g.id) IS DISTINCT FROM m.id;
  IF v_bad IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'the re-cut front table changed the answer for % cluster(s) that have a live Main 1', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.cash_games g
   WHERE EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g.id AND t.role = 'main'
                   AND t.main_index = 1 AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false);
  -- Non-vacuity, not a production headcount. The first draft demanded 100,
  -- which made the migration refuse to apply to a fresh db reset, a preview
  -- branch or any CI database - a guard that stops the file running where it
  -- most needs to. The sibling 20260921025523 asks for one, and so does this.
  IF v_bad < 1 THEN
    RAISE EXCEPTION 'no cluster has a live Main 1, so the comparison above proved nothing';
  END IF;
  RAISE NOTICE 'front table: % cluster(s) have a live Main 1 and all of them still answer it', v_bad;

  -- AND THE EPOCH TRIGGER IS INSTALLED ON THE RIGHT EVENTS. Deliberately a
  -- catalogue read and not a live probe: creating a cash_games row here, even
  -- inside a subtransaction that rolls back, would run every other trigger on
  -- that table against production and contend on the one-game-per-blind-band
  -- index. scripts/dev/test-lightning-phase3-remediation.sh exercises the
  -- trigger for real, on a throwaway backend, where a rollback costs nothing.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.cash_games'::regclass
       AND tgname = 'trg_cash_games_epoch_follows_its_game'
       AND NOT tgisinternal
       AND tgenabled = 'O'
       -- AFTER INSERT OR UPDATE, row level: TRIGGER_TYPE_ROW | _INSERT | _UPDATE
       AND (tgtype & 1) = 1 AND (tgtype & 4) = 4 AND (tgtype & 16) = 16
       AND (tgtype & 2) = 0) THEN
    RAISE EXCEPTION 'the epoch trigger is not installed AFTER INSERT OR UPDATE at row level on public.cash_games';
  END IF;
  IF (SELECT count(*) FROM unnest((SELECT t.tgattr FROM pg_trigger t
                                    WHERE t.tgrelid = 'public.cash_games'::regclass
                                      AND t.tgname = 'trg_cash_games_epoch_follows_its_game'))) <> 2 THEN
    RAISE EXCEPTION 'the epoch trigger does not watch exactly the two columns it is written for';
  END IF;
END $assert$;

COMMIT;
