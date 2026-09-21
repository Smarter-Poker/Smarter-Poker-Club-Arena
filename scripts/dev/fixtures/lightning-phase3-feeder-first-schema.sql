-- Isolated PostgreSQL contract fixture, never a production migration.
--
-- The PRE-migration shape of everything 20260921025523 touches, and - this is
-- what makes this fixture different from its two predecessors - the LIVE
-- FUNCTION BODIES the migration reads out of the catalogue.
--
-- THE MIGRATION UNDER TEST DOES NOT CARRY THE CODE IT CHANGES. Sections 2, 3
-- and 4 of it call pg_get_functiondef on three installed functions, assert an
-- anchor occurs EXACTLY ONCE in each, replace() it, and EXECUTE the result. So
-- the anchors are the fixture's real contract: every one of them below is
-- copied byte for byte out of the migration's own v_find strings, including
-- the indentation and the comment lines that form part of them. Change a space
-- in the four blocks marked ANCHOR and the migration refuses to apply with
-- "the live body carries ... 0 times, not once", which is the migration
-- working correctly and the fixture being wrong.
--
-- WHAT IS FAITHFUL AND WHAT IS MINIMAL. The three patched bodies are reduced
-- to the shortest thing that carries the anchors, carries the strings the
-- migration's survival checks look for, and ACTUALLY RUNS: the create path
-- really inserts a cash_games row and really opens a table, the cluster writer
-- really inserts a tables row and an event, and the tick really builds the
-- census, really runs R3 and really runs the ROLES promotion arm, because the
-- harness tests the behaviour of those two steps rather than their text. The
-- tick's other nine steps (must-move planning, the balancer, seat changes,
-- breaks, the opening hold, the state machine) are NOT implemented; the
-- strings the migration asserts they left behind are carried in the comment
-- block that stands in their place, which is exactly what those assertions
-- read, since pg_get_functiondef returns comments too.
--
-- The two readers - fn_cash_clusters_to_tick and fn_cash_game_must_move_list -
-- are installed in their PRE-migration form (the role = 'main' AND
-- main_index = 1 question), because the migration re-creates them wholesale
-- and a fixture that already asked the new question would prove nothing.
-- fn_cash_cluster_front_table is deliberately ABSENT: the migration creates it.
--
-- Columns no reader under test touches are omitted. The ones that decide an
-- answer are not: tables.is_deleted, tables.status and tables.created_at
-- (clock_timestamp, not now(), so that "oldest" is a real ordering inside one
-- transaction), cash_games.lightning_enabled and cash_games.cluster_mode.

-- Supabase's grant targets. The migration REVOKEs from anon/authenticated and
-- GRANTs to service_role, so all three must exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. THE UNION, THE CLUSTER, THE TABLE
-- ---------------------------------------------------------------------------

-- The create path's v_union comes from here. In production it is a two-table
-- lookup through fn_club_union_context; here it is the trivial seeded row,
-- because nothing under test depends on which union a game belongs to, only
-- that the union lookup line is where it is (it is the anchor the migration
-- hangs the lightning_enabled validation on).
CREATE TABLE public.unions (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id  uuid NOT NULL,
  name     text NOT NULL
);

-- POST-PHASE-1 SHAPE. cluster_mode, lightning_enabled and cluster_epoch were
-- added by 20260920172736 and this migration's section 4 depends on
-- lightning_enabled being NOT NULL DEFAULT false so that g.lightning_enabled
-- resolves without an extra query in the tick's hot path.
CREATE TABLE public.cash_games (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id           uuid NOT NULL,
  union_id          uuid,
  name              text NOT NULL,
  template_name     text,
  variant           text NOT NULL,
  sb                numeric(14,2) NOT NULL CHECK (sb > 0),
  bb                numeric(14,2) NOT NULL CHECK (bb > sb),
  handedness        integer NOT NULL CHECK (handedness BETWEEN 2 AND 9),
  ruleset_snapshot  jsonb NOT NULL,
  created_by        uuid,
  enabled           boolean NOT NULL DEFAULT true,
  state             text NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'dormant')),
  must_move         boolean NOT NULL DEFAULT true,
  cluster_mode      text NOT NULL DEFAULT 'must_move'
                      CONSTRAINT cash_games_cluster_mode_known
                      CHECK (cluster_mode IN ('must_move', 'lightning')),
  lightning_enabled boolean NOT NULL DEFAULT false,
  cluster_epoch     integer NOT NULL DEFAULT 0
                      CONSTRAINT cash_games_cluster_epoch_nonneg CHECK (cluster_epoch >= 0),
  opening_hold_since        timestamptz,
  opening_hold_rested_until timestamptz,
  last_tick_at      timestamptz,
  last_tick_actions jsonb,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- created_at is clock_timestamp() and not now(): the whole ROLES step, the
-- front-table definition and the census ordering are "oldest first", and a
-- harness that opens three tables inside one DO block would give all three the
-- same transaction timestamp and make every one of those orderings arbitrary.
CREATE TABLE public.tables (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id         uuid,
  union_id        uuid,
  name            text,
  game_variant    text,
  small_blind     numeric(14,2),
  big_blind       numeric(14,2),
  max_players     integer,
  status          text,
  current_players integer NOT NULL DEFAULT 0,
  created_by      uuid,
  tournament_id   uuid,
  cluster_id      uuid REFERENCES public.cash_games(id),
  role            text CHECK (role IN ('main', 'feeder')),
  main_index      integer CHECK (main_index >= 1),
  lifecycle       text CHECK (lifecycle IN ('opening', 'live', 'breaking', 'closed')),
  promote_pending boolean NOT NULL DEFAULT false,
  is_deleted      boolean NOT NULL DEFAULT false,
  opened_at       timestamptz,
  live_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX tables_by_cluster ON public.tables (cluster_id) WHERE is_deleted = false;

CREATE TABLE public.table_seats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id    uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  user_id     uuid,
  seat_number integer,
  stack       numeric(14,2),
  joined_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  left_at     timestamptz,
  CONSTRAINT table_seats_table_id_seat_number_key UNIQUE (table_id, seat_number)
);

CREATE UNIQUE INDEX idx_unique_active_user_per_table
  ON public.table_seats (table_id, user_id)
  WHERE left_at IS NULL;

-- The must-move lobby's left-hand side: who joined this GAME, in what order.
CREATE TABLE public.cash_game_roster (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id   uuid NOT NULL REFERENCES public.cash_games(id),
  user_id   uuid NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  left_at   timestamptz
);

-- The census reads this for its `reserved` count. Nothing in this harness
-- notifies anyone, so it stays empty; it exists because fn_cash_cluster_census
-- is carried over verbatim and would not compile without it.
CREATE TABLE public.table_waitlist (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id        uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  user_id         uuid,
  status          text,
  hold_expires_at timestamptz
);

-- The one ledger the cluster writer and the tick both append to. Section 4 of
-- the harness asserts on the ABSENCE of a 'feeder_promoted_to_main' row, so
-- this table is load-bearing rather than decorative.
CREATE TABLE public.cash_cluster_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       uuid NOT NULL,
  table_id      uuid,
  kind          text NOT NULL,
  payload       jsonb,
  cluster_epoch integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX cash_cluster_events_by_game ON public.cash_cluster_events (game_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. THE CENSUS (20260905030000, verbatim)
-- ---------------------------------------------------------------------------
-- The composite type is the tick's whole view of its own board, and the two
-- anchors the migration edits in section 4(a) unnest() it by name, so the
-- field list matters: id, role, main_index, lifecycle and created_at are all
-- read by the arm under test.

CREATE TYPE public.cash_cluster_census_row AS (
  id uuid,
  role text,
  main_index integer,
  lifecycle text,
  status text,
  created_at timestamptz,
  max_players integer,
  seated integer,
  reserved integer,
  open_unreserved integer,
  breaking boolean
);

-- The open tables of one game as the tick sees them: seated, reserved (a
-- notified waitlist hold), open unreserved seats, and whether it is breaking.
CREATE OR REPLACE FUNCTION public.fn_cash_cluster_census(p_game_id uuid, p_now timestamptz DEFAULT clock_timestamp())
RETURNS public.cash_cluster_census_row[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fixture$
  SELECT coalesce(array_agg(
           (q.id, q.role, q.main_index, q.lifecycle, q.status, q.created_at, q.max_players,
            q.seated, q.reserved, GREATEST(0, q.max_players - q.seated - q.reserved),
            q.lifecycle = 'breaking')::public.cash_cluster_census_row
           ORDER BY q.created_at), '{}'::public.cash_cluster_census_row[])
    FROM (
      SELECT tb.id, tb.role, tb.main_index, tb.lifecycle, tb.status, tb.created_at,
             coalesce(tb.max_players, 9) AS max_players,
             (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL)::integer AS seated,
             (SELECT count(*) FROM public.table_waitlist w
               WHERE w.table_id = tb.id AND w.status = 'notified' AND w.hold_expires_at > p_now)::integer AS reserved
        FROM public.tables tb
       WHERE tb.cluster_id = p_game_id AND coalesce(tb.is_deleted, false) = false
         AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle <> 'closed'
    ) q;
$fixture$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_census(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_census(uuid, timestamptz) TO service_role;

-- The must-move lobby prints an alias rather than a uuid. Reduced to the
-- shortest thing that resolves: the lobby's answer is asserted on user_id and
-- table_id, never on the alias.
CREATE OR REPLACE FUNCTION public.fn_player_display_name(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $fixture$
  SELECT 'player-' || right(p_user_id::text, 4);
$fixture$;

-- ---------------------------------------------------------------------------
-- 3. THE ONE CLUSTER WRITER (20260905050000, reduced)
-- ---------------------------------------------------------------------------
-- Every table in the estate is opened through this function and no other. The
-- live body sets fifty-odd columns off the ruleset snapshot; the ones below
-- are the ones any reader under test looks at. The four refusals are kept by
-- NAME because section 3 of the migration asserts they survived its edit.
--
-- ANCHOR (migration section 3): the v_name CASE, and the v_n count on the line
-- above it that the live function has always computed and never read. The
-- migration's new arm is `WHEN v_n = 0 THEN g.name`, so v_n must be the count
-- of the cluster's tables BEFORE this one is inserted.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_open_table(p_game_id uuid, p_role text, p_main_index integer, p_lifecycle text DEFAULT 'opening'::text, p_created_by uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fixture$
DECLARE
  g record; v_name text; v_table_id uuid; v_n integer;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND: %', p_game_id; END IF;
  IF p_role NOT IN ('main', 'feeder') THEN RAISE EXCEPTION 'ROLE_INVALID: %', p_role; END IF;
  IF p_role = 'main' AND (p_main_index IS NULL OR p_main_index < 1) THEN
    RAISE EXCEPTION 'MAIN_INDEX_INVALID: %', p_main_index;
  END IF;
  IF p_lifecycle NOT IN ('opening', 'live') THEN RAISE EXCEPTION 'LIFECYCLE_INVALID: %', p_lifecycle; END IF;

  -- "NLH 1/2 Classic" for Main 1, "NLH 1/2 Classic Main 2", "... Feeder".
  SELECT count(*) INTO v_n FROM public.tables WHERE cluster_id = p_game_id;
  v_name := CASE
    WHEN p_role = 'main' AND p_main_index = 1 THEN g.name
    WHEN p_role = 'main' THEN left(g.name, 50) || ' Main ' || p_main_index
    ELSE left(g.name, 50) || ' Feeder' END;

  INSERT INTO public.tables (
    club_id, union_id, name, game_variant, small_blind, big_blind, max_players,
    status, current_players, created_by,
    cluster_id, role, main_index, lifecycle, opened_at, live_at, created_at
  ) VALUES (
    g.club_id, g.union_id, v_name, g.variant, g.sb, g.bb, g.handedness,
    'waiting', 0, coalesce(p_created_by, g.created_by),
    p_game_id, p_role, CASE WHEN p_role = 'main' THEN p_main_index END, p_lifecycle,
    clock_timestamp(), CASE WHEN p_lifecycle = 'live' THEN clock_timestamp() END, clock_timestamp()
  ) RETURNING id INTO v_table_id;

  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
  VALUES (p_game_id, v_table_id, CASE WHEN p_role = 'feeder' THEN 'feeder_opened' ELSE 'main_opened' END,
          jsonb_build_object('role', p_role, 'main_index', p_main_index, 'lifecycle', p_lifecycle, 'name', v_name));
  RETURN v_table_id;
END;
$fixture$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_open_table(uuid, text, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_open_table(uuid, text, integer, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. THE CLUSTER CONTROLLER'S TICK (20260906015029, reduced to two steps)
-- ---------------------------------------------------------------------------
-- The live tick runs eleven steps. TWO of them are what Phase 3 edits and both
-- are implemented here for real, because the harness tests what they DO:
--
--   R3    - an enabled game always has a live table; anything that closed the
--           last one is undone here. Phase 3 makes the table it reopens a
--           feeder when the Cluster is Lightning-capable.
--   ROLES - the oldest live table is Main 1 (1.3 s9.2), and a lone live feeder
--           with no live main is promoted into that role. Phase 3 defers that
--           promotion for a Lightning-capable Cluster while the feeder is the
--           ONLY table, which is the single most important rule in the phase.
--
-- ANCHOR (migration section 4(a)): the two-line IF that opens the ROLES
-- promotion arm. ANCHOR (migration section 4(b)): the two-line PERFORM/action
-- pair inside the R3 ELSIF.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick(p_game_id uuid, p_eligible_horses integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fixture$
DECLARE
  g record; t record;
  v_census public.cash_cluster_census_row[];
  v_actions jsonb := '[]'::jsonb;
  v_now timestamptz := clock_timestamp();
  v_seated_total integer := 0;
  v_live_tables integer := 0;
  v_main1 record;
  v_idx integer;
  v_n integer;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT g.must_move THEN RETURN jsonb_build_object('ok', false, 'reason', 'manual_game'); END IF;

  -- THE NINE STEPS THIS FIXTURE DOES NOT IMPLEMENT, named so that the
  -- migration's survival check can see that its replace() did not swallow one.
  -- Section 4 of the migration under test asserts that ten strings are still
  -- present in the body it is about to install, one per tick step, taken from
  -- that step's own event kind or action key. Five of them are carried by the
  -- live code below; the other five are named here, in the place the steps
  -- they belong to would occupy, because the survival check reads
  -- pg_get_functiondef and a comment is part of a function definition:
  --
  --   1. RECONCILE      expires stale rows and calls fn_cash_seat_change_plan
  --                     for the players who asked to change seats.
  --   2. MUST-MOVE      plans the longest-seated feeder player onto each open
  --                     Main seat and logs 'move_planned'.
  --   3. OPENING HOLD   logs 'table_opening_hold' before a new table, and an
  --                     expired hold rests until opening_hold_rested_until.
  --   4. ABANDON        an opening feeder nobody filled logs 'feeder_abandoned'
  --                     rather than being left to rot.
  --
  -- None of the four is touched by Phase 3 and none of them can change the
  -- answer to any question this harness asks, because this fixture never seats
  -- a player on a table with an open Main seat beside it and never opens a
  -- table in the 'opening' lifecycle.

  -- The lifecycle and the status must agree, or the worklist and the census
  -- disagree about whether a table is alive. The live tick spells this the
  -- other way round as well; this half is the one the harness exercises when
  -- it closes a cluster's tables in order to watch R3 reopen one.
  UPDATE public.tables SET status = 'closed', current_players = 0, updated_at = now()
   WHERE cluster_id = g.id AND lifecycle = 'closed' AND coalesce(status, '') <> 'closed'
     AND coalesce(is_deleted, false) = false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (g.id, 'status_followed_lifecycle', jsonb_build_object('tables', v_n));
    v_actions := v_actions || jsonb_build_object('status_followed_lifecycle', v_n);
  END IF;

  v_census := public.fn_cash_cluster_census(g.id, v_now);
  SELECT coalesce(sum(c.seated), 0), count(*) INTO v_seated_total, v_live_tables FROM unnest(v_census) c;

  -- R3: an enabled game always has Main 1 open. THE LOOKUP READS THE LIVE
  -- BOARD, NOT THE OLDEST ROW (2026-09-05, 14:45): a Main 1 that is live or
  -- opening on a waiting/running table is the game's; a game with ANY live
  -- table but no such Main 1 leaves it to the ROLES step below; only a game
  -- with no live table at all opens one.
  SELECT * INTO v_main1 FROM public.tables
   WHERE cluster_id = g.id AND role = 'main' AND main_index = 1 AND coalesce(is_deleted, false) = false
     AND lifecycle IN ('live', 'opening')
   ORDER BY created_at LIMIT 1;
  IF g.enabled AND v_main1.id IS NOT NULL AND v_main1.status NOT IN ('waiting', 'running', 'active') THEN
    UPDATE public.tables SET status = 'waiting', lifecycle = 'live', current_players = 0, updated_at = now()
     WHERE id = v_main1.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, v_main1.id, 'main1_reopened');
    v_actions := v_actions || jsonb_build_object('main1', 'reopened');
    v_census := public.fn_cash_cluster_census(g.id, v_now);
    SELECT coalesce(sum(c.seated), 0), count(*) INTO v_seated_total, v_live_tables FROM unnest(v_census) c;
  ELSIF g.enabled AND v_main1.id IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.tables
                         WHERE cluster_id = g.id AND coalesce(is_deleted, false) = false
                           AND lifecycle IN ('live', 'opening', 'breaking') AND status IN ('waiting', 'running', 'active')) THEN
    PERFORM public.fn_cash_cluster_open_table(g.id, 'main', 1, 'live', NULL);
    v_actions := v_actions || jsonb_build_object('main1', 'opened');
    -- Recount after the repair; the rest of the tick sees the real board.
    v_census := public.fn_cash_cluster_census(g.id, v_now);
    SELECT coalesce(sum(c.seated), 0), count(*) INTO v_seated_total, v_live_tables FROM unnest(v_census) c;
  END IF;

  -- ROLES (1.3 s9.2). Oldest live table is Main 1; mains renumber by age. A
  -- GAME WITH A FEEDER AND NO MAIN (2026-09-05): the oldest live feeder
  -- becomes Main 1, so the players on it have a Main to be on and the R3
  -- repair does not open a second table beside them.
  IF NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle IN ('live', 'opening') AND c.role = 'main')
     AND EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle = 'live' AND c.role = 'feeder') THEN
    SELECT * INTO t FROM unnest(v_census) c WHERE c.lifecycle = 'live' AND c.role = 'feeder' ORDER BY c.created_at LIMIT 1;
    UPDATE public.tables SET role = 'main', main_index = 1, promote_pending = false, name = g.name WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
    VALUES (g.id, t.id, 'feeder_promoted_to_main', jsonb_build_object('main_index', 1, 'reason', 'no_live_main'));
    SELECT coalesce(array_agg(
             (c.id, CASE WHEN c.id = t.id THEN 'main' ELSE c.role END, CASE WHEN c.id = t.id THEN 1 ELSE c.main_index END,
              c.lifecycle, c.status, c.created_at, c.max_players, c.seated, c.reserved, c.open_unreserved, c.breaking)::public.cash_cluster_census_row
             ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
      INTO v_census FROM unnest(v_census) c;
    v_actions := v_actions || jsonb_build_object('feeder_became_main1', t.id);
  END IF;
  v_idx := 0;
  FOR t IN SELECT * FROM unnest(v_census) c WHERE c.lifecycle IN ('live', 'opening') AND c.role = 'main' ORDER BY c.created_at LOOP
    v_idx := v_idx + 1;
    IF t.main_index IS DISTINCT FROM v_idx THEN
      UPDATE public.tables SET main_index = v_idx,
             name = CASE WHEN v_idx = 1 THEN g.name ELSE left(g.name, 50) || ' Main ' || v_idx END
       WHERE id = t.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, t.id, 'main_renumbered', jsonb_build_object('from', t.main_index, 'to', v_idx));
    END IF;
  END LOOP;

  UPDATE public.cash_games SET last_tick_at = v_now, last_tick_actions = v_actions WHERE id = g.id;

  RETURN jsonb_build_object('ok', true, 'game_id', g.id, 'seated_total', v_seated_total,
                            'tables', v_live_tables, 'buyers', 0, 'actions', v_actions);
END;
$fixture$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. THE CREATION PATH (20260905010500 + the two 20260909 patches, reduced)
-- ---------------------------------------------------------------------------
-- The live body is the base definition plus patches from 20260909035303 and
-- 20260909181309, which is why the migration reads it out of the catalogue
-- rather than off disk. Reduced here to its skeleton plus the four ANCHORS the
-- migration replaces and the six sibling refusals it asserts survived:
-- OVERRIDE_LOCKED and ONE_GAME_PER_BLIND_CATEGORY from the two patches,
-- GAME_EXISTS from the insert's own handler, and the base function's three
-- OVERRIDE_INVALID shape checks.
--
-- The two patch refusals are reduced to what a fixture can state - an explicit
-- override key rather than a club-wide blind-category scan - because neither
-- is what this harness is about. They are still REACHABLE, and the harness
-- fires OVERRIDE_LOCKED once, so "the guard survived" is a statement about a
-- guard that works rather than about a string in a comment.
--
-- v_uid is a constant rather than auth.uid(): this fixture has no auth schema
-- and no session, and every assertion here is about roles and tables rather
-- than about who asked.

CREATE OR REPLACE FUNCTION public.fn_cash_game_create_impl_20260905(
  p_club_id    uuid,
  p_template   text,
  p_variant    text,
  p_sb         numeric,
  p_bb         numeric,
  p_handedness integer DEFAULT NULL,
  p_overrides  jsonb   DEFAULT '{}'::jsonb,
  p_name       text    DEFAULT NULL,
  p_must_move  boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fixture$
DECLARE
  v_uid uuid := '00000000-0000-0000-0000-0000000000aa'::uuid;
  v_t text := lower(coalesce(p_template, ''));
  v_v text := lower(coalesce(p_variant, ''));
  v_def jsonb; v_snap jsonb; v_o jsonb := coalesce(p_overrides, '{}'::jsonb);
  v_must_move boolean := coalesce(p_must_move, true);
  v_union uuid;
  v_seats integer := coalesce(p_handedness, 9);
  v_name text;
  v_game_id uuid; v_table_id uuid;
BEGIN
  IF jsonb_typeof(v_o) <> 'object' THEN
    RAISE EXCEPTION 'OVERRIDE_INVALID: overrides must be an object';
  END IF;
  IF v_o ? 'bombs' AND jsonb_typeof(v_o->'bombs') <> 'object' THEN
    RAISE EXCEPTION 'OVERRIDE_INVALID: bombs must be an object';
  END IF;
  IF v_o ? 'options' AND jsonb_typeof(v_o->'options') <> 'object' THEN
    RAISE EXCEPTION 'OVERRIDE_INVALID: options must be an object';
  END IF;
  -- THERE IS NO UNKNOWN-KEY REJECTION, and the migration under test depends on
  -- that: it carries the Lightning flag in p_overrides precisely because an
  -- unrecognised key is silently dropped today. A key whitelist added here
  -- would make this fixture lie about the estate.
  IF v_o ? 'locked_field' THEN
    RAISE EXCEPTION 'OVERRIDE_LOCKED: locked_field is fixed by the template and is not yours to set';
  END IF;
  IF v_o ? 'blind_category_clash' THEN
    RAISE EXCEPTION 'ONE_GAME_PER_BLIND_CATEGORY: this club already runs a game in this blind category';
  END IF;

  v_def := jsonb_build_object('seats', v_seats, 'stay_clock_min', 10, 'rejoin_window_min', 120);
  v_snap := v_def || jsonb_build_object('sb', p_sb, 'bb', p_bb,
    'table_mode', CASE WHEN v_must_move THEN 'must_move' ELSE 'manual' END);

  v_name := btrim(coalesce(p_name, ''));
  IF v_name = '' THEN
    v_name := upper(v_v) || ' ' || p_sb::text || '/' || p_bb::text || ' ' || initcap(v_t);
  END IF;
  v_name := left(replace(replace(v_name, '<', ''), '>', ''), 60);

  SELECT u.id INTO v_union
    FROM public.unions u
   WHERE u.club_id = p_club_id
   ORDER BY u.name
   LIMIT 1;

  BEGIN
    INSERT INTO public.cash_games
      (club_id, union_id, name, template_name, variant, sb, bb, handedness, ruleset_snapshot, created_by, must_move)
    VALUES
      (p_club_id, v_union, v_name, v_t, v_v, p_sb, p_bb, v_seats, v_snap, v_uid, v_must_move)
    RETURNING id INTO v_game_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'GAME_EXISTS: this club already runs % % %', initcap(v_t), upper(v_v), v_name;
  END;

  -- Main 1 through the one cluster writer. A must-move game's Main 1 is kept
  -- open by the controller (R3); a manual table lives and dies with its host.
  v_table_id := public.fn_cash_cluster_open_table(v_game_id, 'main', 1, 'live', v_uid);

  RETURN jsonb_build_object('ok', true, 'game_id', v_game_id, 'table_id', v_table_id,
                            'name', v_name, 'must_move', v_must_move, 'snapshot', v_snap);
END;
$fixture$;

REVOKE ALL ON FUNCTION public.fn_cash_game_create_impl_20260905(uuid, text, text, numeric, numeric, integer, jsonb, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_create_impl_20260905(uuid, text, text, numeric, numeric, integer, jsonb, text, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. THE TWO READERS, IN THEIR PRE-MIGRATION FORM
-- ---------------------------------------------------------------------------
-- Both ask "which table stands for this game" as `role = 'main' AND
-- main_index = 1`, which is the question the migration replaces with
-- fn_cash_cluster_front_table. They are installed in the OLD form on purpose:
-- section 5 of the migration re-creates both wholesale, and a fixture that
-- already asked the new question would make that section unfalsifiable.

CREATE OR REPLACE FUNCTION public.fn_cash_clusters_to_tick()
 RETURNS TABLE(game_id uuid, club_id uuid, main1_table_id uuid, state text, enabled boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fixture$
  SELECT g.id, g.club_id,
         (SELECT t.id FROM public.tables t WHERE t.cluster_id = g.id AND t.role = 'main' AND t.main_index = 1
            AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false ORDER BY t.created_at LIMIT 1),
         g.state, g.enabled
    FROM public.cash_games g
   WHERE g.must_move
     AND (g.enabled OR EXISTS (SELECT 1 FROM public.tables t
                                WHERE t.cluster_id = g.id
                                  AND coalesce(t.is_deleted, false) = false
                                  AND (t.lifecycle <> 'closed'
                                       OR lower(coalesce(t.status, '')) NOT IN
                                            ('closed', 'completed', 'cancelled', 'finished'))))
   ORDER BY g.created_at;
$fixture$;

REVOKE ALL ON FUNCTION public.fn_cash_clusters_to_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_clusters_to_tick() TO service_role;

-- The live body also carries `AND (auth.uid() IS NOT NULL OR
-- public.fn_caller_is_engine())` from 20260905041557. It is dropped here
-- because this fixture has no auth schema, and because the migration's
-- replacement drops it too: the question under test is the table predicate on
-- the line above it and nothing else.
CREATE OR REPLACE FUNCTION public.fn_cash_game_must_move_list(p_game_id uuid)
RETURNS TABLE(pos integer, user_id uuid, alias text, table_id uuid, table_name text,
              role text, main_index integer, joined_at timestamptz)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fixture$
  SELECT (row_number() OVER (ORDER BY r.joined_at, r.id))::integer AS pos,
         r.user_id, public.fn_player_display_name(r.user_id) AS alias,
         t.id, t.name, t.role, t.main_index, r.joined_at
    FROM public.cash_game_roster r
    JOIN public.table_seats ts ON ts.user_id = r.user_id AND ts.left_at IS NULL
    JOIN public.tables t ON t.id = ts.table_id AND t.cluster_id = r.game_id AND t.lifecycle <> 'closed'
   WHERE r.game_id = p_game_id AND r.left_at IS NULL
     AND NOT (t.role = 'main' AND t.main_index = 1)
   ORDER BY r.joined_at, r.id;
$fixture$;

REVOKE ALL ON FUNCTION public.fn_cash_game_must_move_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_must_move_list(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. THE ESTATE AS IT STANDS BEFORE THE MIGRATION
-- ---------------------------------------------------------------------------
-- One club, one union, and ONE ORDINARY CLUSTER THAT ALREADY HAS A LIVE MAIN
-- 1. That cluster is not decoration: section 6 of the migration under test
-- refuses to commit unless at least one cash_games row has a live Main 1
-- ("no live cluster has a Main 1, so the comparison above proved nothing"),
-- and it then asserts that fn_cash_cluster_front_table returns exactly that
-- table for every such row. On an empty database the migration would fail to
-- apply, and on a database whose only cluster had an older feeder in front of
-- its Main 1 the migration would be asserting its own answer against itself.
-- So the seeded cluster is the simplest shape there is - one live Main 1,
-- nothing else - and every more interesting board is built AFTER the migration
-- by the harness, where the harness can assert on it.

INSERT INTO public.unions (id, club_id, name)
VALUES ('c0000000-0000-0000-0000-0000000000f1', 'cb000000-0000-0000-0000-000000000001', 'Fixture Union');

INSERT INTO public.cash_games
  (id, club_id, union_id, name, template_name, variant, sb, bb, handedness,
   ruleset_snapshot, created_by, must_move, created_at)
VALUES
  ('ca000000-0000-0000-0000-0000000000e1', 'cb000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-0000000000f1', 'Legacy NLH 1/2 Classic', 'classic', 'nlh',
   1.00, 2.00, 9, '{"seats": 9}'::jsonb, '00000000-0000-0000-0000-0000000000aa', true,
   clock_timestamp());

INSERT INTO public.tables
  (id, club_id, union_id, name, game_variant, small_blind, big_blind, max_players,
   status, created_by, cluster_id, role, main_index, lifecycle, opened_at, live_at, created_at)
VALUES
  ('ab000000-0000-0000-0000-0000000000e1', 'cb000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-0000000000f1', 'Legacy NLH 1/2 Classic', 'nlh', 1.00, 2.00, 9,
   'waiting', '00000000-0000-0000-0000-0000000000aa',
   'ca000000-0000-0000-0000-0000000000e1', 'main', 1, 'live',
   clock_timestamp(), clock_timestamp(), clock_timestamp());
