-- 20260921025523_lightning_phase_3_a_lightning_capable_game_opens_as_a_feeder.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- LIGHTNING 2.0, PHASE 3: FEEDER-FIRST MUST-MOVE STATE.
--
-- The specification calls this its single most important product rule and
-- marks it a HARD REQUIREMENT:
--
--     When a host creates a new Lightning-capable cash game/Cluster:
--       1. Create exactly ONE Cluster.
--       2. Create exactly ONE initial physical cash table.
--       3. That table has role = FEEDER.
--       4. Because there is not yet enough population for Lightning, the
--          Cluster operates in MUST-MOVE mode.
--       5. The initial feeder must obey the normal table engine and normal
--          cash seating rules.
--
-- This estate does the opposite today, in two places, and the second is the
-- one that matters:
--
--   * fn_cash_game_create_impl_20260905 opens every Cluster's first table as
--     ('main', 1).
--   * fn_cash_cluster_tick's ROLES step promotes a lone live feeder back to
--     'main', main_index 1 within one tick - five seconds - through its
--     no_live_main arm. So changing only the creation path would be undone
--     automatically and the game would look correct for under five seconds.
--
-- THE SPECIFICATION CONTRADICTS ITSELF ONCE, AND THIS IS THE READING TAKEN.
--
-- Line 150 says the initial table has role = FEEDER. Line 427, describing the
-- same MUST-MOVE period, says "1 table is Main/Feeder according to the
-- existing table model" and then "The newest physical table is Feeder. Older
-- physical tables are Mains." Both cannot be literally true of a Cluster with
-- three tables: the oldest of them must be Main 1 or must-move has nothing to
-- move players ONTO, and the specification's own MODE A rules require exactly
-- that ("must-move FIFO applies", "shortest eligible Main receives movers").
--
-- The reading taken here is the narrowest one that satisfies both, and it is
-- the starting-condition reading the specification's own phase heading asks
-- for ("Implement the critical starting condition"):
--
--     WHILE A LIGHTNING-CAPABLE CLUSTER HAS EXACTLY ONE LIVE TABLE, THAT
--     TABLE IS A FEEDER. FROM THE SECOND TABLE ONWARD, ORDINARY MUST-MOVE
--     ROLES APPLY UNCHANGED - OLDEST IS MAIN 1, NEWEST IS THE FEEDER.
--
-- So the promotion is not disabled for Lightning clusters; it is deferred
-- until there is a second table for it to be the Main OF. Every other
-- must-move rule - FIFO, shortest eligible Main, reserved seats, no
-- mid-hand teleport, seat changes, the feeder-opening hold, the break
-- rules - is untouched, which is what "normal table operation, normal
-- must-move" in the phase's Verify list requires.
--
-- WHY THE FLAG TRAVELS IN p_overrides AND NOT IN A NEW PARAMETER.
--
-- fn_cash_game_create_impl_20260905 is pinned by regprocedure at three sites
-- (20260909035303:87, 20260909181309:131 and :189). Its argument list cannot
-- move without breaking a replay from scratch at all three. p_overrides is
-- already a jsonb the caller controls, and - verified against the live body,
-- not assumed - it has no unknown-key rejection of any kind: no key
-- whitelist, no jsonb_object_keys scan, no set difference. An unrecognised
-- key is silently dropped today, so adding a read site is additive and
-- nothing that passes the old shape changes behaviour.
--
-- WHAT A FEEDER-FIRST CLUSTER IS CALLED.
--
-- fn_cash_cluster_open_table names a feeder `left(g.name, 50) || ' Feeder'`.
-- That is right for the second table of a Cluster and wrong for the first,
-- which IS the game on the board: the lobby would print "NLH 1/2 Action
-- Feeder" as the name of the game. The name CASE gains one arm for the
-- cluster's first table, using the v_n table count the function already
-- computes on the line above and has never used. When the ROLES step later
-- promotes that table to Main 1 it sets `name = g.name` itself, so the name
-- is stable across the promotion rather than changing under the players.
--
-- ONE DEFINITION OF A CLUSTER'S FRONT TABLE.
--
-- Three readers ask "which table stands for this game": the tick worklist
-- (fn_cash_clusters_to_tick.main1_table_id, which the ClusterController uses
-- to count eligible horses and to decide whether an engine must exist), the
-- must-move lobby (fn_cash_game_must_move_list, whose whole job is to list
-- everyone who is NOT in the main game), and the board itself. All three
-- asked it as `role = 'main' AND main_index = 1`, which answers NULL for a
-- feeder-first Cluster - and a NULL there means the ClusterController counts
-- zero eligible horses and never spins an engine, so the Cluster would be
-- created and then never tick, never open a second table, and never reach a
-- Lightning threshold at all.
--
-- fn_cash_cluster_front_table is that one definition: Main 1 when the Cluster
-- has a live one, otherwise its oldest live table. For all 166 existing
-- Clusters, every one of which has a live Main 1, it returns exactly what the
-- old subselect returned.
--
-- THE FRONT-TABLE DEFINITION IS UNCONDITIONAL, AND THAT IS A CHOICE.
--
-- fn_cash_cluster_front_table does not ask whether a Cluster is Lightning-
-- capable. It answers "Main 1, else the oldest live table" for every Cluster,
-- which means an ORDINARY must-move Cluster that transiently has a live feeder
-- and no live Main 1 - exactly the situation the tick's own no_live_main arm
-- exists to repair - now reports that feeder where it used to report NULL, and
-- its players leave the must-move list for at most one tick.
--
-- That is a widening beyond Lightning and it is deliberate. A conditional
-- front table would have to read cash_games on every call and would leave the
-- ordinary Cluster answering NULL in precisely the window where the
-- ClusterController most needs a table: a NULL main1_table_id means zero
-- eligible horses and no engine check, for a game that has live players on a
-- live feeder. One definition that is always right beats two that disagree.
--
-- MEASURED AGAINST PRODUCTION, 2026-09-21 03:20 UTC, before writing this:
--   166 clusters total
--   108 have a live Main 1        -> new answer identical to the old one
--    58 have no live table at all -> both answers NULL
--     0 have a live table and no live Main 1 -> nobody's answer moves on apply
-- The count is re-measured at apply time in section 6 and reported as a NOTICE
-- rather than refused, because a changed answer there is the improvement, not
-- a fault. scripts/dev/test-lightning-phase3-feeder-first.sh is what proves
-- the changed answer is the right one.
--
-- WHAT THIS DOES NOT DO.
--
-- Nothing here counts population, compares a threshold, or converts anything.
-- lightning_enabled is a capability flag and cluster_mode stays 'must_move'.
-- The population predicate is spec Phase 4 and the conversion is spec Phase 5.
-- A Cluster created with lightning_enabled = true is, after this migration,
-- an ordinary must-move Cluster that happens to have started as a feeder -
-- which is precisely what acceptance test F01 asks for:
--   Cluster created / state = MUST_MOVE / exactly one initial physical feeder
--   / Lightning not active / no Lightning instances.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT to_regproc('public.fn_cash_cluster_front_table') IS NOT NULL)
-- @live-proof: (SELECT position('lightning_enabled' in pg_get_functiondef('public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)'::regprocedure)) > 0)
-- @live-proof: (SELECT position($$public.fn_cash_cluster_open_table(v_game_id, 'feeder', NULL, 'live', v_uid)$$ in pg_get_functiondef('public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)'::regprocedure)) > 0)
-- @live-proof: (SELECT position($$public.fn_cash_cluster_open_table(v_game_id, 'main', 1, 'live', v_uid)$$ in pg_get_functiondef('public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('LIGHTNING_NEEDS_MUST_MOVE' in pg_get_functiondef('public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('lone_feeder_is_the_cluster' in pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure)) > 0)
-- @live-proof: (SELECT position($$jsonb_build_object('feeder_became_main1', t.id)$$ in pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure)) > 0)
-- @live-proof: (SELECT position($$public.fn_cash_cluster_open_table(g.id, 'feeder', NULL, 'live', NULL)$$ in pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('fn_cash_cluster_front_table' in pg_get_functiondef('public.fn_cash_clusters_to_tick()'::regprocedure)) > 0)
-- @live-proof: (SELECT position('fn_cash_cluster_front_table' in pg_get_functiondef('public.fn_cash_game_must_move_list(uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('the cluster''s first table stands for the game' in pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE public.fn_cash_cluster_front_table(g.id) IS DISTINCT FROM (SELECT t.id FROM public.tables t WHERE t.cluster_id = g.id AND t.role = 'main' AND t.main_index = 1 AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false ORDER BY t.created_at LIMIT 1) AND EXISTS (SELECT 1 FROM public.tables t2 WHERE t2.cluster_id = g.id AND t2.role = 'main' AND t2.main_index = 1 AND t2.lifecycle <> 'closed' AND coalesce(t2.is_deleted, false) = false)))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM information_schema.role_routine_grants WHERE routine_schema = 'public' AND routine_name = 'fn_cash_cluster_front_table' AND grantee IN ('anon','authenticated','PUBLIC')))

BEGIN;

-- Nothing here takes a table-level exclusive lock: five function bodies are
-- replaced and no relation is altered, and PostgreSQL lets a call that is
-- already executing finish against the old definition. lock_timeout is set
-- anyway so that a catalogue lock held by another migration refuses this one
-- in seconds rather than holding it open against a live tick.
SET LOCAL lock_timeout = '8s';

-- ===========================================================================
-- 1. ONE DEFINITION OF A CLUSTER'S FRONT TABLE
-- ===========================================================================
-- Main 1 when the Cluster has a live one; otherwise its oldest live table.
-- SECURITY INVOKER deliberately: both callers below are already SECURITY
-- DEFINER, so this runs with their privileges and adds no new reach of its
-- own. The browser roles hold nothing on it.
--
-- The ORDER BY is the whole function. `(t.role = 'main' AND t.main_index = 1)
-- DESC` puts a live Main 1 first when one exists - true sorts after false
-- ascending, so DESC puts true first - and t.created_at decides among the
-- rest, which is what "oldest live table" means and what the ROLES step is
-- about to make Main 1 anyway. t.id breaks a tie between two tables created
-- in the same microsecond so the answer is never arbitrary.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_front_table(p_game_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT t.id
    FROM public.tables t
   WHERE t.cluster_id = p_game_id
     AND t.lifecycle <> 'closed'
     AND coalesce(t.is_deleted, false) = false
   ORDER BY (t.role = 'main' AND t.main_index = 1) DESC, t.created_at, t.id
   LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_front_table(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_front_table(uuid) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_front_table(uuid) IS
  'The one table that stands for a Cluster: its live Main 1 when it has one, otherwise its oldest live table. A Lightning-capable Cluster begins as a single feeder and has no Main 1 at all, and every reader that asked for role = main AND main_index = 1 answered NULL for it - which in the tick worklist meant zero eligible horses and no engine, so the Cluster would never have ticked. For a Cluster that does have a live Main 1 this returns exactly what that predicate returned.';

-- ===========================================================================
-- 2. THE CREATION PATH OPENS A FEEDER WHEN THE GAME IS LIGHTNING-CAPABLE
-- ===========================================================================
-- Asserted substitution against the live body. The body is a base definition
-- (20260905010500, as fn_cash_game_create) plus patches from 20260909035303
-- and 20260909181309, so the file on disk is not what is running; every
-- anchor below was read out of pg_get_functiondef and is asserted to occur
-- exactly once before anything is replaced.

DO $do$
DECLARE
  v_fn  text := 'public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)';
  v_src text; v_new text; v_find text; v_repl text;
  v_n   integer;
BEGIN
  v_src := pg_get_functiondef(v_fn::regprocedure);

  IF position('LIGHTNING_NEEDS_MUST_MOVE' in v_src) > 0 THEN
    RAISE NOTICE 'fn_cash_game_create_impl_20260905 already opens a feeder for a Lightning-capable game; nothing to do';
    RETURN;
  END IF;

  -- (a) DECLARE v_lightning.
  v_find := '  v_def jsonb; v_snap jsonb; v_o jsonb := coalesce(p_overrides, ''{}''::jsonb);' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the live body carries the override declaration % times, not once; read it before re-running', v_n;
  END IF;
  v_repl := v_find || '  v_lightning boolean := false;' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  -- (b) Read and validate the flag, then carry it onto the cash_games row.
  --     The whole INSERT block is the anchor so that the column list and the
  --     value list can only move together.
  v_find :=
    '    INSERT INTO public.cash_games' || chr(10) ||
    '      (club_id, union_id, name, template_name, variant, sb, bb, handedness, ruleset_snapshot, created_by, must_move)' || chr(10) ||
    '    VALUES' || chr(10) ||
    '      (p_club_id, v_union, v_name, v_t, v_v, p_sb, p_bb, v_seats, v_snap, v_uid, v_must_move)' || chr(10) ||
    '    RETURNING id INTO v_game_id;' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the live body carries the cash_games insert % times, not once; read it before re-running', v_n;
  END IF;
  v_repl :=
    '    INSERT INTO public.cash_games' || chr(10) ||
    '      (club_id, union_id, name, template_name, variant, sb, bb, handedness, ruleset_snapshot, created_by, must_move, lightning_enabled)' || chr(10) ||
    '    VALUES' || chr(10) ||
    '      (p_club_id, v_union, v_name, v_t, v_v, p_sb, p_bb, v_seats, v_snap, v_uid, v_must_move, v_lightning)' || chr(10) ||
    '    RETURNING id INTO v_game_id;' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  -- The validation goes immediately before the BEGIN that guards the insert,
  -- so an invalid override is refused before any row is written. The anchor
  -- is the union lookup that precedes it, which occurs once.
  v_find := '  SELECT u.id INTO v_union' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the live body carries the union lookup % times, not once; read it before re-running', v_n;
  END IF;
  v_repl :=
    '  -- LIGHTNING 2.0 PHASE 3. The flag rides in p_overrides because this' || chr(10) ||
    '  -- function is pinned by regprocedure at three sites and its argument' || chr(10) ||
    '  -- list cannot move. jsonb_typeof rather than a cast: ::boolean on a' || chr(10) ||
    '  -- non-boolean raises 22P02 out of a DECLARE-free context and the caller' || chr(10) ||
    '  -- would see a type error instead of a named refusal.' || chr(10) ||
    '  IF v_o ? ''lightning_enabled'' THEN' || chr(10) ||
    '    IF jsonb_typeof(v_o->''lightning_enabled'') <> ''boolean'' THEN' || chr(10) ||
    '      RAISE EXCEPTION ''OVERRIDE_INVALID: lightning_enabled must be true or false'';' || chr(10) ||
    '    END IF;' || chr(10) ||
    '    v_lightning := (v_o->>''lightning_enabled'')::boolean;' || chr(10) ||
    '  END IF;' || chr(10) ||
    '  -- A Lightning game IS a Cluster: it grows tables, moves players between' || chr(10) ||
    '  -- them and converts a population into a pool. A manual (R9) table has no' || chr(10) ||
    '  -- controller and lives and dies with its host, so it can never get there.' || chr(10) ||
    '  IF v_lightning AND NOT v_must_move THEN' || chr(10) ||
    '    RAISE EXCEPTION ''LIGHTNING_NEEDS_MUST_MOVE: a Lightning-capable game is a Cluster; a manual table is not one'';' || chr(10) ||
    '  END IF;' || chr(10) ||
    chr(10) ||
    v_find;
  v_src := replace(v_src, v_find, v_repl);

  -- (c) The first table.
  v_find :=
    '  -- Main 1 through the one cluster writer. A must-move game''s Main 1 is kept' || chr(10) ||
    '  -- open by the controller (R3); a manual table lives and dies with its host.' || chr(10) ||
    '  v_table_id := public.fn_cash_cluster_open_table(v_game_id, ''main'', 1, ''live'', v_uid);' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the live body carries the Main 1 open % times, not once; read it before re-running', v_n;
  END IF;
  v_repl :=
    '  -- The first table through the one cluster writer. A must-move game''s' || chr(10) ||
    '  -- Main 1 is kept open by the controller (R3); a manual table lives and' || chr(10) ||
    '  -- dies with its host.' || chr(10) ||
    '  --' || chr(10) ||
    '  -- LIGHTNING 2.0 PHASE 3, the hard requirement: a Lightning-capable' || chr(10) ||
    '  -- Cluster''s ONE initial physical table has role = FEEDER. It becomes' || chr(10) ||
    '  -- Main 1 the moment a second table opens beside it, through the tick''s' || chr(10) ||
    '  -- ordinary ROLES step, which is what keeps must-move unchanged.' || chr(10) ||
    '  IF v_lightning THEN' || chr(10) ||
    '    v_table_id := public.fn_cash_cluster_open_table(v_game_id, ''feeder'', NULL, ''live'', v_uid);' || chr(10) ||
    '  ELSE' || chr(10) ||
    '    v_table_id := public.fn_cash_cluster_open_table(v_game_id, ''main'', 1, ''live'', v_uid);' || chr(10) ||
    '  END IF;' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  -- (d) The caller is told, so a test and a client can both see it.
  v_find :=
    '  RETURN jsonb_build_object(''ok'', true, ''game_id'', v_game_id, ''table_id'', v_table_id,' || chr(10) ||
    '                            ''name'', v_name, ''must_move'', v_must_move, ''snapshot'', v_snap);' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the live body carries the return object % times, not once; read it before re-running', v_n;
  END IF;
  v_repl :=
    '  RETURN jsonb_build_object(''ok'', true, ''game_id'', v_game_id, ''table_id'', v_table_id,' || chr(10) ||
    '                            ''name'', v_name, ''must_move'', v_must_move,' || chr(10) ||
    '                            ''lightning_enabled'', v_lightning, ''snapshot'', v_snap);' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  -- EVERY SIBLING GUARD MUST HAVE SURVIVED. These are the refusals the two
  -- earlier patch migrations added and the base function's own validation;
  -- a replace that ate one of them would be invisible until a host hit it.
  IF position('OVERRIDE_LOCKED' in v_src) = 0
     OR position('ONE_GAME_PER_BLIND_CATEGORY' in v_src) = 0
     OR position('GAME_EXISTS' in v_src) = 0
     OR position('OVERRIDE_INVALID: overrides must be an object' in v_src) = 0
     OR position('OVERRIDE_INVALID: bombs must be an object' in v_src) = 0
     OR position('OVERRIDE_INVALID: options must be an object' in v_src) = 0 THEN
    RAISE EXCEPTION 'a sibling guard did not survive the edit to fn_cash_game_create_impl_20260905';
  END IF;

  EXECUTE v_src;
END $do$;

-- ===========================================================================
-- 3. THE CLUSTER WRITER NAMES A FIRST-TABLE FEEDER AFTER THE GAME
-- ===========================================================================

DO $do$
DECLARE
  v_fn  text := 'public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)';
  v_src text; v_find text; v_repl text; v_n integer;
BEGIN
  v_src := pg_get_functiondef(v_fn::regprocedure);

  IF position('the cluster''s first table stands for the game' in v_src) > 0 THEN
    RAISE NOTICE 'fn_cash_cluster_open_table already names a first-table feeder after the game; nothing to do';
    RETURN;
  END IF;

  v_find :=
    '  v_name := CASE' || chr(10) ||
    '    WHEN p_role = ''main'' AND p_main_index = 1 THEN g.name' || chr(10) ||
    '    WHEN p_role = ''main'' THEN left(g.name, 50) || '' Main '' || p_main_index' || chr(10) ||
    '    ELSE left(g.name, 50) || '' Feeder'' END;' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the live body carries the table-name CASE % times, not once; read it before re-running', v_n;
  END IF;

  -- v_n above is this migration's counter; the v_n INSIDE the function is the
  -- table count the function itself computes on the line before this CASE and
  -- has never read. A Lightning-capable Cluster's first table is a feeder and
  -- it IS the game on the board, so it carries the game's name - and the ROLES
  -- step sets name = g.name when it later promotes that same row, so the name
  -- does not change under the players.
  v_repl :=
    '  v_name := CASE' || chr(10) ||
    '    WHEN p_role = ''main'' AND p_main_index = 1 THEN g.name' || chr(10) ||
    '    WHEN p_role = ''main'' THEN left(g.name, 50) || '' Main '' || p_main_index' || chr(10) ||
    '    -- the cluster''s first table stands for the game, whatever its role' || chr(10) ||
    '    WHEN v_n = 0 THEN g.name' || chr(10) ||
    '    ELSE left(g.name, 50) || '' Feeder'' END;' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  IF position('ROLE_INVALID' in v_src) = 0
     OR position('MAIN_INDEX_INVALID' in v_src) = 0
     OR position('LIFECYCLE_INVALID' in v_src) = 0
     OR position('GAME_NOT_FOUND' in v_src) = 0 THEN
    RAISE EXCEPTION 'a sibling guard did not survive the edit to fn_cash_cluster_open_table';
  END IF;

  EXECUTE v_src;
END $do$;

-- ===========================================================================
-- 4. THE TICK LEAVES A LIGHTNING CLUSTER'S LONE FEEDER ALONE
-- ===========================================================================
-- Two edits, both narrow.
--
-- (a) The ROLES step's no_live_main arm promotes the oldest live feeder to
--     Main 1 when no main is live. That arm exists because a game with players
--     on a feeder and no Main has nothing to move them onto, and it is right
--     in every case but one: a Lightning-capable Cluster whose ONE table is
--     that feeder, where there is nothing to move anyone onto either way and
--     promoting it is exactly what Phase 3 forbids. So the arm gains a third
--     conjunct and stops firing only in that single-table case. The moment a
--     second table opens, the arm fires again and the Cluster is an ordinary
--     must-move game with a Main 1 and a feeder.
--
-- (b) R3 reopens Main 1 when a Cluster has no live table at all. For a
--     Lightning-capable Cluster the table it reopens is a feeder, for the same
--     reason the created one is.
--
-- g is loaded by `SELECT * INTO g FROM public.cash_games ... FOR UPDATE` at the
-- top of the function, and lightning_enabled is NOT NULL DEFAULT false on that
-- table since 20260920172736, so it is already in scope and already non-null.
-- No extra query reaches the hot path: this tick runs every five seconds for
-- every cluster.

DO $do$
DECLARE
  v_fn  text := 'public.fn_cash_cluster_tick(uuid,integer)';
  v_src text; v_find text; v_repl text; v_n integer;
BEGIN
  v_src := pg_get_functiondef(v_fn::regprocedure);

  IF position('lone_feeder_is_the_cluster' in v_src) > 0 THEN
    RAISE NOTICE 'fn_cash_cluster_tick already leaves a Lightning cluster''s lone feeder alone; nothing to do';
    RETURN;
  END IF;

  -- (a) the promotion arm
  v_find :=
    '  IF NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle IN (''live'', ''opening'') AND c.role = ''main'')' || chr(10) ||
    '     AND EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle = ''live'' AND c.role = ''feeder'') THEN' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the live tick carries the no_live_main promotion arm % times, not once; read it before re-running', v_n;
  END IF;
  v_repl :=
    '  IF NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle IN (''live'', ''opening'') AND c.role = ''main'')' || chr(10) ||
    '     AND EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle = ''live'' AND c.role = ''feeder'')' || chr(10) ||
    '     -- LIGHTNING 2.0 PHASE 3 (lone_feeder_is_the_cluster): a Lightning-' || chr(10) ||
    '     -- capable Cluster''s ONE table is a feeder, by specification. There is' || chr(10) ||
    '     -- nothing for a Main to receive movers FROM while it is the only table,' || chr(10) ||
    '     -- so the promotion loses nothing by waiting; the moment a second table' || chr(10) ||
    '     -- opens this arm fires and ordinary must-move roles resume.' || chr(10) ||
    '     AND NOT (coalesce(g.lightning_enabled, false)' || chr(10) ||
    '              AND (SELECT count(*) FROM unnest(v_census) c WHERE c.lifecycle IN (''live'', ''opening'')) = 1) THEN' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  -- (b) the R3 reopen
  v_find :=
    '    PERFORM public.fn_cash_cluster_open_table(g.id, ''main'', 1, ''live'', NULL);' || chr(10) ||
    '    v_actions := v_actions || jsonb_build_object(''main1'', ''opened'');' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the live tick carries the R3 Main 1 reopen % times, not once; read it before re-running', v_n;
  END IF;
  v_repl :=
    '    IF coalesce(g.lightning_enabled, false) THEN' || chr(10) ||
    '      PERFORM public.fn_cash_cluster_open_table(g.id, ''feeder'', NULL, ''live'', NULL);' || chr(10) ||
    '      v_actions := v_actions || jsonb_build_object(''feeder1'', ''opened'');' || chr(10) ||
    '    ELSE' || chr(10) ||
    '      PERFORM public.fn_cash_cluster_open_table(g.id, ''main'', 1, ''live'', NULL);' || chr(10) ||
    '      v_actions := v_actions || jsonb_build_object(''main1'', ''opened'');' || chr(10) ||
    '    END IF;' || chr(10);
  v_src := replace(v_src, v_find, v_repl);

  -- EVERY SIBLING STEP MUST HAVE SURVIVED. One string per tick step, taken
  -- from the step's own event kind or action key, so a replace that swallowed
  -- a step is refused here instead of quietly shipping a tick that no longer
  -- breaks tables, plans moves, opens feeders or renumbers mains.
  IF position('feeder_became_main1' in v_src) = 0
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
-- 5. THE TWO READERS ASK THE ONE DEFINITION
-- ===========================================================================
-- Re-created in full rather than patched: both are short LANGUAGE sql bodies
-- whose whole content is the question being changed, and a full statement is
-- easier to read against than a substitution that rewrites most of it.

-- The tick worklist. Everything but the front-table subselect is carried over
-- byte for byte from 20260909181653, including the commentary that explains
-- why a disabled game is admitted on either liveness field, because that
-- reasoning is still load-bearing and deleting it would lose it.
CREATE OR REPLACE FUNCTION public.fn_cash_clusters_to_tick()
 RETURNS TABLE(game_id uuid, club_id uuid, main1_table_id uuid, state text, enabled boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT g.id, g.club_id,
         -- LIGHTNING 2.0 PHASE 3. This was a subselect for role = 'main' AND
         -- main_index = 1, which answers NULL for a Lightning-capable Cluster
         -- whose one table is a feeder. The ClusterController reads this column
         -- to count eligible horses and to decide whether an engine must exist,
         -- so a NULL here means the Cluster is created and then never ticks.
         -- The column keeps its name because eleven call sites in
         -- server/src/cluster/ClusterController.ts spell it.
         public.fn_cash_cluster_front_table(g.id),
         g.state, g.enabled
    FROM public.cash_games g
   WHERE g.must_move
     -- A DISABLED GAME IS ADMITTED ON EITHER LIVENESS FIELD (2026-09-09).
     -- This used to require status IN ('waiting','running','active') as well,
     -- and 20260906011113 removed the status half because a table stranded at
     -- lifecycle='live' / status='closed' was excluded from the repair written
     -- for it. The MIRROR of that stranding - lifecycle='closed' with
     -- status='waiting' - then fell into the same hole against the half that
     -- was left, and `status_followed_lifecycle` (which lives inside the tick)
     -- could never reach it. Two FLO8 0.50/1 games sat that way with
     -- last_tick_at NULL: never ticked once.
     -- So the question is asked of BOTH fields: any table that is non-terminal
     -- by either one is a table the tick has something to say about. One tick
     -- makes them agree and the game leaves this list again.
     AND (g.enabled OR EXISTS (SELECT 1 FROM public.tables t
                                WHERE t.cluster_id = g.id
                                  AND coalesce(t.is_deleted, false) = false
                                  AND (t.lifecycle <> 'closed'
                                       OR lower(coalesce(t.status, '')) NOT IN
                                            ('closed', 'completed', 'cancelled', 'finished'))))
   ORDER BY g.created_at;
$function$;

REVOKE ALL ON FUNCTION public.fn_cash_clusters_to_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_clusters_to_tick() TO service_role;

-- The must-move lobby lists everyone who is NOT in the main game. That was
-- spelled as "not on Main 1", which for a feeder-first Cluster listed every
-- seated player - including the ones sitting in the only game there is.
CREATE OR REPLACE FUNCTION public.fn_cash_game_must_move_list(p_game_id uuid)
RETURNS TABLE(pos integer, user_id uuid, alias text, table_id uuid, table_name text,
              role text, main_index integer, joined_at timestamptz)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT (row_number() OVER (ORDER BY r.joined_at, r.id))::integer AS pos,
         r.user_id, public.fn_player_display_name(r.user_id) AS alias,
         t.id, t.name, t.role, t.main_index, r.joined_at
    FROM public.cash_game_roster r
    JOIN public.table_seats ts ON ts.user_id = r.user_id AND ts.left_at IS NULL
    JOIN public.tables t ON t.id = ts.table_id AND t.cluster_id = r.game_id AND t.lifecycle <> 'closed'
   WHERE r.game_id = p_game_id AND r.left_at IS NULL
     -- LIGHTNING 2.0 PHASE 3: the front table, not "Main 1". Identical for
     -- every Cluster that has a live Main 1; for one that does not, the oldest
     -- live table is the main game and its players are not movers.
     AND t.id IS DISTINCT FROM public.fn_cash_cluster_front_table(p_game_id)
   ORDER BY r.joined_at, r.id;
$$;

REVOKE ALL ON FUNCTION public.fn_cash_game_must_move_list(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_must_move_list(uuid) TO service_role;

-- ===========================================================================
-- 6. POST-APPLY READ-BACK FROM THE CATALOGUE
-- ===========================================================================
-- Not from the variables above: those say what was sent, and this asks what
-- the database kept. A substitution that produced a body PostgreSQL parsed
-- differently than intended would pass every check so far and fail here.

DO $assert$
DECLARE
  v_create text := pg_get_functiondef('public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)'::regprocedure);
  v_tick   text := pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure);
  v_open   text := pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure);
  v_work   text := pg_get_functiondef('public.fn_cash_clusters_to_tick()'::regprocedure);
  v_list   text := pg_get_functiondef('public.fn_cash_game_must_move_list(uuid)'::regprocedure);
  v_front  uuid;
  v_bad    bigint;
BEGIN
  IF position($x$public.fn_cash_cluster_open_table(v_game_id, 'feeder', NULL, 'live', v_uid)$x$ in v_create) = 0 THEN
    RAISE EXCEPTION 'the live create path does not open a feeder for a Lightning-capable game';
  END IF;
  IF position($x$public.fn_cash_cluster_open_table(v_game_id, 'main', 1, 'live', v_uid)$x$ in v_create) = 0 THEN
    RAISE EXCEPTION 'the live create path lost the ordinary Main 1 open; every non-Lightning game would be created without a table';
  END IF;
  -- The column and the value are on different lines of the INSERT, so they are
  -- asserted separately; a single string spanning them can never occur.
  IF position('must_move, lightning_enabled)' in v_create) = 0
     OR position('v_must_move, v_lightning)' in v_create) = 0 THEN
    RAISE EXCEPTION 'the live create path does not carry the flag onto the cash_games row';
  END IF;
  IF position('LIGHTNING_NEEDS_MUST_MOVE' in v_create) = 0
     OR position('OVERRIDE_INVALID: lightning_enabled must be true or false' in v_create) = 0 THEN
    RAISE EXCEPTION 'the live create path lost one of the two Lightning refusals';
  END IF;

  IF position('lone_feeder_is_the_cluster' in v_tick) = 0 THEN
    RAISE EXCEPTION 'the live tick does not carry the lone-feeder exception';
  END IF;
  IF position($x$public.fn_cash_cluster_open_table(g.id, 'feeder', NULL, 'live', NULL)$x$ in v_tick) = 0 THEN
    RAISE EXCEPTION 'the live tick does not reopen a Lightning cluster''s one table as a feeder';
  END IF;
  IF position($x$public.fn_cash_cluster_open_table(g.id, 'main', 1, 'live', NULL)$x$ in v_tick) = 0 THEN
    RAISE EXCEPTION 'the live tick lost the ordinary R3 Main 1 reopen';
  END IF;
  IF position('feeder_became_main1' in v_tick) = 0 THEN
    RAISE EXCEPTION 'the live tick lost the promotion it is supposed to have merely deferred';
  END IF;

  IF position('WHEN v_n = 0 THEN g.name' in v_open) = 0 THEN
    RAISE EXCEPTION 'the live cluster writer does not name a first table after its game';
  END IF;

  IF position('fn_cash_cluster_front_table' in v_work) = 0 THEN
    RAISE EXCEPTION 'the live tick worklist does not ask the one front-table definition';
  END IF;
  IF position('fn_cash_cluster_front_table' in v_list) = 0 THEN
    RAISE EXCEPTION 'the live must-move list does not ask the one front-table definition';
  END IF;

  -- THE ANSWER DID NOT MOVE FOR ANY EXISTING CLUSTER. For every cash_games row
  -- that has a live Main 1, the new function must return that exact table; the
  -- 166 clusters live today all have one, so this is a real comparison and not
  -- a vacuous one.
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
    RAISE EXCEPTION 'the front-table definition changed the answer for % existing cluster(s) that have a live Main 1', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.cash_games g
   WHERE EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g.id AND t.role = 'main'
                   AND t.main_index = 1 AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false);
  IF v_bad < 1 THEN
    RAISE EXCEPTION 'no live cluster has a Main 1, so the comparison above proved nothing';
  END IF;

  -- AND THE WIDENING IS COUNTED, NOT ASSUMED. Every cluster with a live table
  -- and no live Main 1 is one whose main1_table_id moves from NULL to that
  -- table. It was 0 when this was written. It is reported rather than refused
  -- because the new answer is the improvement; what must not happen is that it
  -- changes silently.
  SELECT count(*) INTO v_bad
    FROM public.cash_games g
   WHERE EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g.id
                   AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false)
     AND NOT EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g.id AND t.role = 'main'
                   AND t.main_index = 1 AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false);
  RAISE NOTICE 'front table: % cluster(s) have a live table and no live Main 1, and report that table where they reported NULL', v_bad;

  -- And a cluster with no table at all answers NULL rather than raising.
  SELECT public.fn_cash_cluster_front_table('00000000-0000-0000-0000-000000000000'::uuid) INTO v_front;
  IF v_front IS NOT NULL THEN
    RAISE EXCEPTION 'the front-table definition invented a table for a cluster that does not exist';
  END IF;
END $assert$;

COMMIT;
