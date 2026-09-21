-- Isolated PostgreSQL contract fixture, never a production migration.
--
-- The PRE-migration shape for the LIGHTNING PHASE 3 REMEDIATION
-- (20260921044045). That migration does not run on bare ground and it does not
-- carry the code it changes: FIVE of its nine sections read an installed
-- function body out of the catalogue with pg_get_functiondef, assert an anchor
-- occurs EXACTLY ONCE in it, replace() that anchor and EXECUTE the result. So
-- the anchors are this fixture's real contract. Every one of them below is
-- copied byte for byte out of the live migrations that produced them, and a
-- single changed space makes the migration refuse to apply with "the live
-- body carries ... 0 times, not once" - which is the migration working
-- correctly and this fixture being wrong.
--
-- WHAT THIS FILE CREATES AND WHAT IT DELEGATES.
--
-- The harness applies FOUR real migration files on top of this one, in order,
-- before the migration under test:
--
--   20260920235343  the seven Lightning relations, and cash_cluster_events.
--                   cluster_epoch. The remediation adds two indexes to
--                   lightning_pool_session and lightning_instance and has a
--                   @live-proof on both, so they must be the real ones.
--   20260921025504  public.cash_cluster_epoch itself, with its primary key,
--                   its cash_cluster_epoch_current UNIQUE partial index, its
--                   mode vocabulary and its genesis backfill. The whole
--                   BLOCKER this remediation exists to fix is that nothing
--                   maintains that table, so the table has to be the real one
--                   rather than a hand-copy free to drift.
--   20260921025523  the POST-25523 bodies of fn_cash_cluster_open_table (the
--                   `WHEN v_n = 0 THEN g.name` arm, with the comment line the
--                   remediation's anchor includes) and fn_cash_cluster_tick
--                   (lone_feeder_is_the_cluster), plus the first cut of
--                   fn_cash_cluster_front_table that the remediation re-cuts.
--                   This file therefore carries the PRE-25523 bodies of those
--                   two functions and lets 25523 produce the post ones: there
--                   is then exactly one copy of that text in the repository.
--
-- So what has to pre-exist here is only what none of those four creates and
-- the remediation reads:
--
--   1. The cluster, the table, the chair, the roster, the event ledger, the
--      census type and the census itself.
--   2. The THREE seat-change readers the remediation converts -
--      fn_cash_game_lobby, fn_cash_seat_change_request and
--      fn_cash_seat_change_plan - in their live pre-remediation form. These
--      are the "three readers it missed"; 20260921025523 never touched them,
--      so no earlier file in this chain installs them.
--   3. fn_cash_cluster_open_table and fn_cash_cluster_tick in their PRE-25523
--      form, carrying 25523's anchors, so that 25523 can produce the bodies
--      20260921044045 then reads.
--   4. fn_cash_game_create_impl_20260905, likewise pre-25523: it is the second
--      half of the epoch-on-create proof, a Cluster born through the estate's
--      own creation path rather than by a bare INSERT.
--   5. fn_cash_cluster_lightning_state, which the lobby's own anchor line
--      calls, and fn_player_display_name, which the must-move list calls.
--   6. auth.uid(), because fn_cash_game_lobby answers "me" and the harness has
--      to be able to ask as a seated player, as a player on the other table,
--      and as somebody with no chair at all.
--
-- THREE THINGS IN HERE ARE LOAD-BEARING RATHER THAN DECORATIVE.
--
--   1. FOUR SEEDED CLUSTERS, each with a live Main 1, and no more. The
--      migration's post-apply read-back asserts that the re-cut
--      fn_cash_cluster_front_table returns exactly that Main 1 for every
--      cash_games row that has one, and refuses to commit if NONE does - a
--      non-vacuity guard, which is what it has to be. An earlier cut of the
--      file demanded a hundred, which made it unapplicable to a fresh db
--      reset, a preview branch or any CI database; this fixture is
--      deliberately single-digit so that the harness measures the guard that
--      replaced it. Each seeded cluster is the simplest shape there is - one
--      live Main 1, nothing else - so that every more interesting board is
--      built AFTER the migration, by the harness, where it can be asserted on.
--   2. tables.created_at is clock_timestamp() and not now(). "The oldest live
--      table" decides the front table, the break candidate and the census
--      order, and a harness that opens three tables inside one DO block would
--      give all three the same transaction timestamp and make every one of
--      those orderings arbitrary.
--   3. cash_cluster_events carries NO cluster_epoch column here. 20260920235343
--      is what adds it and 20260921025504 is what puts a BEFORE INSERT trigger
--      on it; a fixture that pre-created the column would make that ALTER a
--      no-op and leave the trigger sitting on a column nothing had added.

-- ---------------------------------------------------------------------------
-- 0. SUPABASE'S GRANT TARGETS, pgcrypto, AND auth.uid()
-- ---------------------------------------------------------------------------
-- Every migration in this chain REVOKEs from anon/authenticated and GRANTs to
-- service_role, so all three roles must exist. Guarded, so re-running the
-- fixture against a cluster that already has them is not an error.
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

-- Four of the seven Lightning relations declare `id uuid PRIMARY KEY DEFAULT
-- gen_random_uuid()`, and so do half the tables below. PostgreSQL 13+ carries
-- that function in core, but the estate's own databases get it from pgcrypto,
-- so it is requested by name and guarded rather than assumed.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The lobby asks who is calling. In production that is Supabase's auth.uid(),
-- reading the JWT claim GUC; here it is the same GUC and the same name, so the
-- harness can say who it is with set_config and the lobby body is the live one
-- rather than one rewritten around a constant.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $fixture$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$fixture$;

-- ---------------------------------------------------------------------------
-- 1. THE UNION, THE CLUSTER, THE TABLE, THE CHAIR
-- ---------------------------------------------------------------------------

CREATE TABLE public.unions (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id  uuid NOT NULL,
  name     text NOT NULL
);

-- POST-PHASE-1 SHAPE. cluster_mode, lightning_enabled and cluster_epoch were
-- added by 20260920172736, and cluster_mode carries that migration's own ten-
-- state vocabulary rather than a two-value one: cash_cluster_epoch repeats
-- exactly this list in cash_cluster_epoch_mode_check, and the harness moves a
-- cluster through more than one of them.
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
  cap_mains         integer,
  allow_second_feeder boolean NOT NULL DEFAULT false,
  cluster_mode      text NOT NULL DEFAULT 'must_move'
                      CONSTRAINT cash_games_cluster_mode_check
                      CHECK (cluster_mode IN (
                        'created', 'opening', 'must_move', 'pending_on', 'lightning',
                        'pending_off', 'draining', 'paused', 'frozen', 'dead')),
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

-- The index the re-cut front table is written to keep the condition of: the
-- migration's whole second reason for abandoning the single ORDER BY is that
-- `Index Cond: (cluster_id = g.id AND role = 'main' AND main_index = 1)` had
-- become `Index Cond: (cluster_id = g.id)` plus a Sort.
CREATE INDEX tables_by_cluster ON public.tables (cluster_id) WHERE is_deleted = false;
CREATE INDEX tables_main_one_by_cluster ON public.tables (cluster_id, role, main_index)
  WHERE is_deleted = false;

CREATE TABLE public.table_seats (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id       uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  user_id        uuid,
  seat_number    integer,
  stack          numeric(14,2),
  leave_pending  boolean NOT NULL DEFAULT false,
  joined_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  left_at        timestamptz,
  CONSTRAINT table_seats_table_id_seat_number_key UNIQUE (table_id, seat_number)
);

CREATE UNIQUE INDEX idx_unique_active_user_per_table
  ON public.table_seats (table_id, user_id)
  WHERE left_at IS NULL;

-- The must-move lobby's left-hand side: who joined this GAME, in what order,
-- and whether they have spent the one seat change a stay is worth. The
-- planner's `seat_change_used_at = NULL` - a string the migration's survival
-- check reads by name - writes that allowance back.
CREATE TABLE public.cash_game_roster (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id             uuid NOT NULL REFERENCES public.cash_games(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL,
  joined_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  seat_change_used_at timestamptz,
  left_at             timestamptz
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

-- 20260905060000's shape, verbatim in the columns anything under test reads.
CREATE TABLE public.cash_seat_change_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       uuid NOT NULL REFERENCES public.cash_games(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  from_table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  to_table_id   uuid REFERENCES public.tables(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'requested'
                CHECK (status = ANY (ARRAY['requested'::text, 'moved'::text, 'cancelled'::text])),
  note          text,
  move_id       uuid,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at   timestamptz
);
CREATE UNIQUE INDEX idx_cash_seat_change_requests_open
  ON public.cash_seat_change_requests (game_id, user_id) WHERE status = 'requested';

-- 20260905010000's shape plus the swap_move_id the planner links a pair with.
CREATE TABLE public.cash_seat_moves (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id        uuid NOT NULL REFERENCES public.cash_games(id) ON DELETE CASCADE,
  player_id      uuid NOT NULL,
  from_table_id  uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  to_table_id    uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  reason         text NOT NULL CHECK (reason IN ('must_move', 'break', 'seat_change')),
  state          text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'cancelled', 'expired')),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at     timestamptz NOT NULL DEFAULT clock_timestamp() + interval '60 seconds',
  executed_at    timestamptz,
  announced_at   timestamptz,
  ready_at       timestamptz,
  to_seat_number integer,
  swap_move_id   uuid,
  note           text
);
CREATE UNIQUE INDEX cash_seat_moves_one_pending_per_player
  ON public.cash_seat_moves (player_id) WHERE state = 'pending';

-- The one ledger the cluster writer, the tick and the planner all append to.
-- cluster_epoch is deliberately ABSENT: 20260920235343 adds that column and
-- 20260921025504 puts a BEFORE INSERT trigger on it.
CREATE TABLE public.cash_cluster_events (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id   uuid NOT NULL,
  table_id  uuid,
  kind      text NOT NULL,
  payload   jsonb NOT NULL DEFAULT '{}'::jsonb,
  at        timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX cash_cluster_events_by_game ON public.cash_cluster_events (game_id, at DESC);

-- ---------------------------------------------------------------------------
-- 2. THE CENSUS (20260905030000, verbatim)
-- ---------------------------------------------------------------------------
-- The composite type is the tick's and the planner's whole view of the board,
-- and five of the six anchors the remediation edits unnest() it by name, so
-- the field list matters: id, role, main_index, lifecycle, created_at, seated,
-- open_unreserved and breaking are all read by an arm under test.

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
-- shortest thing that resolves: every answer here is asserted on user_id and
-- table_id, never on the alias.
CREATE OR REPLACE FUNCTION public.fn_player_display_name(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $fixture$
  SELECT 'player-' || right(p_user_id::text, 4);
$fixture$;

-- 20260920172736's authoritative mode reader, reduced: the live body also
-- counts open cash_player_session rows for the Cluster, and this harness has
-- no sessions. It is here because the lobby's FIRST anchor is the line that
-- calls it, and because the remediation's survival check asserts that line is
-- still there after it has inserted front_table_id beside it.
CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_state(p_game_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fixture$
  SELECT jsonb_build_object(
           'game_id',               g.id,
           'cluster_mode',          g.cluster_mode,
           'cluster_epoch',         g.cluster_epoch,
           'lightning_enabled',     g.lightning_enabled,
           'must_move',             g.must_move,
           'enabled',               g.enabled,
           'handedness',            g.handedness,
           'open_cluster_sessions', 0)
    FROM public.cash_games g
   WHERE g.id = p_game_id;
$fixture$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. THE ONE CLUSTER WRITER, PRE-25523 (20260905050000, reduced)
-- ---------------------------------------------------------------------------
-- Every table in the estate is opened through this function and no other. The
-- live body sets fifty-odd columns off the ruleset snapshot; the ones below
-- are the ones a reader under test looks at. The four refusals are kept by
-- NAME because both 20260921025523 and the remediation assert they survived
-- the edit.
--
-- ANCHOR (20260921025523 section 3): the v_name CASE. That migration inserts
-- the `WHEN v_n = 0 THEN g.name` arm and its comment line, producing the body
-- the REMEDIATION then anchors on - the comment line plus the v_n count above
-- it. So this file carries the PRE-25523 CASE and nothing else: there is one
-- copy of the post-25523 text in the repository and it is in 20260921025523.
--
-- The v_n on the line above the CASE is the all-time table count the live
-- function has always computed and, until 25523, never read. Counting EVERY
-- row - closed and deleted included - is the MAJOR the remediation fixes.

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
-- 4. THE SEAT-CHANGE PLANNER (20260909181259, reduced)
-- ---------------------------------------------------------------------------
-- The first of the three readers 20260921025523 said it had migrated and had
-- not. Carried close to verbatim, because all three of the remediation's
-- anchors here are whole predicate lines and because the harness tests what
-- the planner DOES - which request it cancels, which table it routes onto and
-- which partner it swaps with - rather than the text it ends up carrying.
--
-- ANCHOR 1 (remediation section 7): the became-Main-1 EXISTS, whose closing
-- `) THEN` is part of the search string.
-- ANCHOR 2: the target filter, anchored together with the WHERE line above it.
-- ANCHOR 3: the swap filter, anchored together with the breaking/lifecycle
-- line above it. Anchors 2 and 3 end in BYTE-IDENTICAL lines, which is exactly
-- why the migration anchors each with its predecessor; a fixture that indented
-- either differently would make one of them occur twice and the other never.
--
-- `main_index = 1` occurs in this body EXACTLY THREE TIMES, once per anchor.
-- The remediation's post-apply read-back refuses to commit if a single
-- occurrence survives its three replacements, so a fourth one anywhere - in a
-- comment, in a column list, in a sibling predicate - would make this fixture
-- unable to carry the migration it exists to test.

CREATE OR REPLACE FUNCTION public.fn_cash_seat_change_plan(p_game_id uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fixture$
DECLARE
  r record; p record;
  v_census public.cash_cluster_census_row[];
  v_target uuid;
  v_moves integer := 0;
  v_move_a uuid; v_move_b uuid;
  v_seat_a integer; v_seat_b integer;
BEGIN
  v_census := public.fn_cash_cluster_census(p_game_id, p_now);

  FOR r IN SELECT q.* FROM public.cash_seat_change_requests q
            WHERE q.game_id = p_game_id AND q.status = 'requested'
            ORDER BY q.created_at, q.id
  LOOP
    -- Still in that chair?
    IF NOT EXISTS (SELECT 1 FROM public.table_seats ts
                    WHERE ts.table_id = r.from_table_id AND ts.user_id = r.user_id AND ts.left_at IS NULL) THEN
      UPDATE public.cash_seat_change_requests
         SET status = 'cancelled', resolved_at = p_now, note = 'left_table'
       WHERE id = r.id;
      -- AND THE BUTTON COMES BACK. This request is being cancelled for a
      -- reason that is not the player's doing and did not move them where they
      -- asked, so it must not spend the one change they get for this game.
      UPDATE public.cash_game_roster
         SET seat_change_used_at = NULL
       WHERE game_id = p_game_id AND user_id = r.user_id AND left_at IS NULL;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (p_game_id, r.from_table_id, 'seat_change_returned',
              jsonb_build_object('player_id', r.user_id, 'reason', 'left_table'));
      CONTINUE;
    END IF;
    -- THE MAIN GAME HAS NO SEAT CHANGE (2026-09-09). The door refuses a
    -- request FROM the main game and the swap below refuses a partner in it,
    -- but a request already listed from a feeder that the ROLES step then
    -- renumbered was still executed off the main game. Same event as
    -- left_table: the table they asked from is not the table they asked from
    -- any more, so the button comes back.
    IF EXISTS (SELECT 1 FROM unnest(v_census) c
                WHERE c.id = r.from_table_id AND c.role = 'main' AND c.main_index = 1) THEN
      UPDATE public.cash_seat_change_requests
         SET status = 'cancelled', resolved_at = p_now, note = 'now_on_main_one'
       WHERE id = r.id;
      UPDATE public.cash_game_roster
         SET seat_change_used_at = NULL
       WHERE game_id = p_game_id AND user_id = r.user_id AND left_at IS NULL;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (p_game_id, r.from_table_id, 'seat_change_returned',
              jsonb_build_object('player_id', r.user_id, 'reason', 'now_on_main_one'));
      CONTINUE;
    END IF;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.table_seats ts
                               WHERE ts.table_id = r.from_table_id AND ts.user_id = r.user_id AND ts.left_at IS NULL
                                 AND coalesce(ts.stack, 0) > 0 AND coalesce(ts.leave_pending, false) = false);
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = r.user_id AND m.state = 'pending');

    -- A chair: the table they asked for, or (any) the shortest other table
    -- that is not the main game and not closing.
    SELECT c.id INTO v_target FROM unnest(v_census) c
     WHERE c.id <> r.from_table_id AND NOT c.breaking AND c.lifecycle IN ('live', 'opening')
       AND NOT (c.role = 'main' AND c.main_index = 1)
       AND (r.to_table_id IS NULL OR c.id = r.to_table_id)
       AND c.open_unreserved
           - (SELECT count(*) FROM public.cash_seat_moves m
               WHERE m.to_table_id = c.id AND m.state = 'pending' AND m.swap_move_id IS NULL) > 0
     ORDER BY c.seated ASC, c.created_at ASC LIMIT 1;
    IF v_target IS NOT NULL THEN
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
      VALUES (p_game_id, r.user_id, r.from_table_id, v_target, 'seat_change')
      RETURNING id INTO v_move_a;
      UPDATE public.cash_seat_change_requests
         SET status = 'moved', resolved_at = p_now, move_id = v_move_a, note = 'seat_open'
       WHERE id = r.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (p_game_id, v_target, 'move_planned',
              jsonb_build_object('player_id', r.user_id, 'from_table_id', r.from_table_id, 'reason', 'seat_change'));
      v_moves := v_moves + 1;
      CONTINUE;
    END IF;

    -- A swap: the oldest other request whose table I would take and who would
    -- take mine. Both chairs are occupied, so both moves are linked and land
    -- together.
    SELECT q.*, ts.seat_number AS their_seat INTO p
      FROM public.cash_seat_change_requests q
      JOIN unnest(v_census) c ON c.id = q.from_table_id
      JOIN public.table_seats ts ON ts.table_id = q.from_table_id AND ts.user_id = q.user_id AND ts.left_at IS NULL
     WHERE q.game_id = p_game_id AND q.status = 'requested' AND q.id <> r.id
       AND q.from_table_id <> r.from_table_id
       AND (r.to_table_id IS NULL OR q.from_table_id = r.to_table_id)
       AND (q.to_table_id IS NULL OR q.to_table_id = r.from_table_id)
       AND NOT c.breaking AND c.lifecycle = 'live'
       AND NOT (c.role = 'main' AND c.main_index = 1)
       AND coalesce(ts.stack, 0) > 0 AND coalesce(ts.leave_pending, false) = false
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = q.user_id AND m.state = 'pending')
     ORDER BY q.created_at, q.id LIMIT 1;
    IF FOUND THEN
      SELECT ts.seat_number INTO v_seat_a FROM public.table_seats ts
       WHERE ts.table_id = r.from_table_id AND ts.user_id = r.user_id AND ts.left_at IS NULL;
      v_seat_b := p.their_seat;
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason, to_seat_number)
      VALUES (p_game_id, r.user_id, r.from_table_id, p.from_table_id, 'seat_change', v_seat_b)
      RETURNING id INTO v_move_a;
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason, to_seat_number, swap_move_id)
      VALUES (p_game_id, p.user_id, p.from_table_id, r.from_table_id, 'seat_change', v_seat_a, v_move_a)
      RETURNING id INTO v_move_b;
      UPDATE public.cash_seat_moves SET swap_move_id = v_move_b WHERE id = v_move_a;
      UPDATE public.cash_seat_change_requests
         SET status = 'moved', resolved_at = p_now, move_id = v_move_a, note = 'swap'
       WHERE id = r.id;
      UPDATE public.cash_seat_change_requests
         SET status = 'moved', resolved_at = p_now, move_id = v_move_b, note = 'swap'
       WHERE id = p.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (p_game_id, p.from_table_id, 'swap_planned',
              jsonb_build_object('player_id', r.user_id, 'with_player_id', p.user_id,
                                 'from_table_id', r.from_table_id, 'to_table_id', p.from_table_id));
      v_moves := v_moves + 2;
    END IF;
  END LOOP;
  RETURN v_moves;
END;
$fixture$;

REVOKE ALL ON FUNCTION public.fn_cash_seat_change_plan(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_change_plan(uuid, timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. THE SEAT-CHANGE DOOR (20260905064237, reduced)
-- ---------------------------------------------------------------------------
-- The second reader. p_user_id is taken at face value here; the live body
-- honours it only for fn_caller_is_engine() and otherwise uses auth.uid(),
-- which is a question about who may ask and not about what is asked.
--
-- ANCHOR 1 (remediation section 6): the from-Main-1 IF, two spaces in.
-- ANCHOR 2: the to-Main-1 IF, four spaces in, inside the destination branch.
-- ANCHOR 3: the other-table EXISTS predicate, which becomes IS DISTINCT FROM
-- rather than NOT (=) because the front table answers NULL for a cluster whose
-- every table has closed, and `NOT (t.id = NULL)` is NULL - which would empty
-- the EXISTS and refuse everyone with SEAT_CHANGE_NO_OTHER_TABLE.
--
-- All SEVEN refusals are reachable and named, because the remediation asserts
-- each of them by name survived its three replacements. `main_index = 1`
-- occurs EXACTLY THREE TIMES, once per anchor, for the same reason as in the
-- planner above.

CREATE OR REPLACE FUNCTION public.fn_cash_seat_change_request(p_game_id uuid, p_user_id uuid, p_to_table_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fixture$
DECLARE
  g record; me record; dst record; q record; ro record; v_id uuid;
BEGIN
  -- The same lock the tick takes: a request and a tick never plan the same
  -- chair twice.
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND: %', p_game_id; END IF;
  IF NOT g.must_move THEN
    RAISE EXCEPTION 'SEAT_CHANGE_MANUAL_GAME: a manual table has no seat change' USING ERRCODE = 'check_violation';
  END IF;

  SELECT ts.table_id, ts.seat_number, ts.stack, t.role, t.main_index, t.lifecycle, t.name
    INTO me
    FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
   WHERE ts.user_id = p_user_id AND ts.left_at IS NULL AND t.cluster_id = g.id AND t.lifecycle <> 'closed'
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_IN_GAME: you are not seated in this game' USING ERRCODE = 'check_violation';
  END IF;
  IF me.role = 'main' AND me.main_index = 1 THEN
    RAISE EXCEPTION 'SEAT_CHANGE_NOT_FROM_MAIN: the main game has no seat change' USING ERRCODE = 'check_violation';
  END IF;
  IF me.lifecycle = 'breaking' THEN
    RAISE EXCEPTION 'SEAT_CHANGE_TABLE_CLOSING: this table is closing and the game is already moving you' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = p_user_id AND m.state = 'pending') THEN
    RAISE EXCEPTION 'MOVE_PENDING: you are already being moved' USING ERRCODE = 'check_violation';
  END IF;

  -- Idempotent: the open request is the answer.
  SELECT * INTO q FROM public.cash_seat_change_requests
   WHERE game_id = g.id AND user_id = p_user_id AND status = 'requested';
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'request_id', q.id, 'from_table_id', q.from_table_id,
                              'to_table_id', q.to_table_id, 'idempotent', true);
  END IF;

  SELECT * INTO ro FROM public.cash_game_roster WHERE game_id = g.id AND user_id = p_user_id AND left_at IS NULL;
  IF NOT FOUND THEN
    -- A chair that predates the roster: put them on it now, at the chair's time.
    INSERT INTO public.cash_game_roster (game_id, user_id, joined_at)
    SELECT g.id, p_user_id, coalesce(min(ts.joined_at), clock_timestamp()) FROM public.table_seats ts
     WHERE ts.user_id = p_user_id AND ts.table_id = me.table_id AND ts.left_at IS NULL
    RETURNING * INTO ro;
  END IF;
  IF ro.seat_change_used_at IS NOT NULL THEN
    RAISE EXCEPTION 'SEAT_CHANGE_USED: you have used your seat change for this game' USING ERRCODE = 'check_violation';
  END IF;

  IF p_to_table_id IS NOT NULL THEN
    SELECT * INTO dst FROM public.tables WHERE id = p_to_table_id;
    IF NOT FOUND OR dst.cluster_id IS DISTINCT FROM g.id OR coalesce(dst.is_deleted, false)
       OR dst.lifecycle NOT IN ('live', 'opening') THEN
      RAISE EXCEPTION 'SEAT_CHANGE_TABLE_UNAVAILABLE: that table is not open in this game' USING ERRCODE = 'check_violation';
    END IF;
    IF dst.role = 'main' AND dst.main_index = 1 THEN
      RAISE EXCEPTION 'SEAT_CHANGE_NEVER_TO_MAIN: the main game fills in must-move order only' USING ERRCODE = 'check_violation';
    END IF;
    IF dst.id = me.table_id THEN
      RAISE EXCEPTION 'SEAT_CHANGE_SAME_TABLE: you are already at that table' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.tables t
                    WHERE t.cluster_id = g.id AND t.id <> me.table_id AND coalesce(t.is_deleted, false) = false
                      AND t.lifecycle IN ('live', 'opening') AND NOT (t.role = 'main' AND t.main_index = 1)) THEN
      RAISE EXCEPTION 'SEAT_CHANGE_NO_OTHER_TABLE: there is no other table to change to yet' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  INSERT INTO public.cash_seat_change_requests (game_id, user_id, from_table_id, to_table_id)
  VALUES (g.id, p_user_id, me.table_id, p_to_table_id) RETURNING id INTO v_id;
  UPDATE public.cash_game_roster SET seat_change_used_at = clock_timestamp() WHERE id = ro.id;
  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
  VALUES (g.id, me.table_id, 'seat_change_requested',
          jsonb_build_object('player_id', p_user_id, 'to_table_id', p_to_table_id));
  RETURN jsonb_build_object('ok', true, 'request_id', v_id, 'from_table_id', me.table_id,
                            'to_table_id', p_to_table_id, 'idempotent', false);
END;
$fixture$;

REVOKE ALL ON FUNCTION public.fn_cash_seat_change_request(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_change_request(uuid, uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. THE TWO READERS 20260921025523 DID CONVERT, IN THEIR PRE-25523 FORM
-- ---------------------------------------------------------------------------
-- Both ask "which table stands for this game" as `role = 'main' AND
-- main_index = 1`. 20260921025523 re-creates both wholesale to ask
-- fn_cash_cluster_front_table instead, so they are installed here in the OLD
-- form: a fixture that already asked the new question would make that
-- migration's section 5 unfalsifiable, and the remediation reads the answers
-- both of them give.

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
-- 7. THE LOBBY (20260906163151 + the Phase 1 lightning line, reduced)
-- ---------------------------------------------------------------------------
-- The third reader, and the one a player actually sees: MustMoveLobbyModal
-- renders "You Are In The Main Game." from me.on_main_one and offers the Seat
-- Change button from me.seat_change.available, and on a Cluster whose one
-- table is a feeder both were false - no status line at all, beside a button
-- that could not work.
--
-- ANCHOR 1 (remediation section 5): the lightning line in the returned object,
-- four spaces in. front_table_id is inserted directly beneath it.
-- ANCHOR 2: the on_main_one line, six spaces in.
-- ANCHOR 3: the availability predicate, which occurs ONCE - and only once,
-- because the migration counts it AFTER anchor 2 has been replaced and the
-- on_main_one line no longer carries `me.role = 'main'`.
--
-- The replacement for anchor 2 is a plain `=` and not IS DISTINCT FROM, and
-- the migration says why in its own comment: an unseated caller has a NULL
-- me.table_id, and on_main_one must stay JSON null for them rather than
-- becoming false. That three-valued answer is what the harness pins.
--
-- v_tables, the must-move list and the pending move are carried because the
-- remediation asserts that must_move_position, seat_change and pending_move
-- all survived its edits; they are reduced to the fields an assertion reads.

CREATE OR REPLACE FUNCTION public.fn_cash_game_lobby(p_game_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fixture$
DECLARE
  g record;
  me record;
  v_uid uuid := auth.uid();
  v_tables jsonb;
  v_list jsonb;
  v_me jsonb;
  v_req record;
  v_move record;
  v_roster record;
  v_position integer;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND: %', p_game_id; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'name', t.name, 'role', t.role, 'main_index', t.main_index,
           'lifecycle', t.lifecycle, 'status', t.status, 'max_players', coalesce(t.max_players, 9),
           'seated', (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = t.id AND ts.left_at IS NULL)
         ) ORDER BY (t.role = 'feeder'), t.main_index NULLS LAST, t.created_at), '[]'::jsonb)
    INTO v_tables
    FROM public.tables t
   WHERE t.cluster_id = g.id AND coalesce(t.is_deleted, false) = false
     AND t.status IN ('waiting', 'running', 'active')
     AND t.lifecycle <> 'closed';

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'position', l.pos, 'user_id', l.user_id, 'alias', l.alias,
           'table_id', l.table_id, 'table_name', l.table_name) ORDER BY l.pos), '[]'::jsonb)
    INTO v_list
    FROM public.fn_cash_game_must_move_list(g.id) l;

  IF v_uid IS NOT NULL THEN
    SELECT ts.table_id, ts.seat_number, ts.stack, t.role, t.main_index, t.lifecycle
      INTO me
      FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
     WHERE ts.user_id = v_uid AND ts.left_at IS NULL AND t.cluster_id = g.id AND t.lifecycle <> 'closed'
     LIMIT 1;
    SELECT * INTO v_roster FROM public.cash_game_roster r
     WHERE r.game_id = g.id AND r.user_id = v_uid AND r.left_at IS NULL;
    SELECT l.pos INTO v_position FROM public.fn_cash_game_must_move_list(g.id) l WHERE l.user_id = v_uid;
    SELECT * INTO v_req FROM public.cash_seat_change_requests q
     WHERE q.game_id = g.id AND q.user_id = v_uid AND q.status = 'requested';
    SELECT m.id, m.to_table_id, m.reason, m.announced_at, m.ready_at, m.swap_move_id, t.name AS to_table_name
      INTO v_move
      FROM public.cash_seat_moves m JOIN public.tables t ON t.id = m.to_table_id
     WHERE m.game_id = g.id AND m.player_id = v_uid AND m.state = 'pending' AND m.expires_at > clock_timestamp()
     ORDER BY m.created_at DESC LIMIT 1;

    v_me := jsonb_build_object(
      'user_id', v_uid,
      'seated', me.table_id IS NOT NULL,
      'table_id', me.table_id, 'seat_number', me.seat_number, 'stack', me.stack,
      'role', me.role, 'main_index', me.main_index, 'lifecycle', me.lifecycle,
      'on_main_one', (me.role = 'main' AND me.main_index = 1),
      'joined_game_at', v_roster.joined_at,
      'must_move_position', v_position,
      'seat_change', jsonb_build_object(
         -- The button: seated somewhere other than the main game, not used,
         -- nothing pending, and the table is not already closing under them.
         'available', (me.table_id IS NOT NULL AND NOT (me.role = 'main' AND me.main_index = 1)
                       AND v_roster.seat_change_used_at IS NULL AND v_req.id IS NULL AND v_move.id IS NULL
                       AND me.lifecycle NOT IN ('breaking', 'closed')),
         'used_at', v_roster.seat_change_used_at,
         'request', CASE WHEN v_req.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', v_req.id, 'to_table_id', v_req.to_table_id, 'created_at', v_req.created_at) END),
      'pending_move', CASE WHEN v_move.id IS NULL THEN NULL ELSE jsonb_build_object(
         'id', v_move.id, 'to_table_id', v_move.to_table_id, 'to_table_name', v_move.to_table_name,
         'reason', v_move.reason, 'announced', v_move.announced_at IS NOT NULL,
         'swap', v_move.swap_move_id IS NOT NULL, 'held', v_move.ready_at IS NOT NULL) END);
  END IF;

  RETURN jsonb_build_object(
    'game', jsonb_build_object('id', g.id, 'name', g.name, 'template_name', g.template_name,
                               'variant', g.variant, 'sb', g.sb, 'bb', g.bb, 'handedness', g.handedness,
                               'state', g.state, 'must_move', g.must_move, 'enabled', g.enabled,
                               'last_tick_at', g.last_tick_at),
    'lightning', public.fn_cash_cluster_lightning_state(g.id),
    'tables', v_tables,
    'must_move_list', v_list,
    'seat_changes_requested', (SELECT count(*) FROM public.cash_seat_change_requests q
                                WHERE q.game_id = g.id AND q.status = 'requested'),
    'me', v_me,
    'as_of', clock_timestamp());
END;
$fixture$;

REVOKE ALL ON FUNCTION public.fn_cash_game_lobby(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_lobby(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. THE CLUSTER CONTROLLER'S TICK, PRE-25523 (20260906015029, reduced)
-- ---------------------------------------------------------------------------
-- The live tick runs eleven steps. THREE of them matter here and all three are
-- implemented for real, because the harness tests what they DO:
--
--   R3     an enabled game always has a live table; anything that closed the
--          last one is undone here.
--   ROLES  the oldest live table is Main 1, and a lone live feeder with no
--          live main is promoted into that role. 20260921025523 defers that
--          promotion while a Lightning-capable Cluster's feeder is its ONLY
--          table, which is what makes a feeder-first board exist at all.
--   BREAK  the thinnest live table that is not the game itself is the break
--          candidate. This is the step the REMEDIATION converts.
--
-- ANCHOR (20260921025523 section 4a): the two-line IF that opens the ROLES
-- promotion arm. ANCHOR (25523 section 4b): the PERFORM/action pair inside the
-- R3 ELSIF.
--
-- TWO ANCHORS FOR THE REMEDIATION'S SECTION 8, because it does not only change
-- the predicate, it HOISTS the front-table read out of it: the declaration
-- line `  g record; t record; r record;`, where `  v_front uuid;` is inserted
-- beneath it, and the two-line candidate scan, where the assignment is
-- inserted immediately ABOVE. `r` is declared and unused here for the same
-- reason the eight unimplemented steps are named in a comment - the live tick
-- has it, and the anchor is the whole line.
--
-- THE ASSIGNMENT LANDS AFTER THE ROLES STEP, which is where the inline call it
-- replaces was evaluated. That is not a detail: the ROLES step WRITES to
-- public.tables, so a Cluster with a live Main 2 and an older feeder has one
-- front table before it runs and a different one after, and a hoist placed a
-- few lines earlier would give the break step the wrong board.
--
-- The break step is written the way the live one is and stops where the live
-- one stops being relevant: it names a candidate and records it. The live step
-- then asks `IF v_remaining_tables >= 1` before it sets lifecycle = 'breaking',
-- and that guard is the accident the remediation is about - it is what stopped
-- a feeder-first Cluster breaking its own only table, rather than the
-- candidate predicate that was written for the job. Recording the candidate
-- rather than executing it is what lets the harness see the predicate's answer
-- instead of the guard's.
--
-- The eight steps this fixture does NOT implement are named in the comment
-- block that stands in their place, because the migrations' survival checks
-- read pg_get_functiondef and a comment is part of a function definition.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick(p_game_id uuid, p_eligible_horses integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fixture$
DECLARE
  g record; t record; r record;
  v_census public.cash_cluster_census_row[];
  v_actions jsonb := '[]'::jsonb;
  v_now timestamptz := clock_timestamp();
  v_seated_total integer := 0;
  v_live_tables integer := 0;
  v_main1 record;
  v_candidate record;
  v_idx integer;
  v_n integer;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT g.must_move THEN RETURN jsonb_build_object('ok', false, 'reason', 'manual_game'); END IF;

  -- THE STEPS THIS FIXTURE DOES NOT IMPLEMENT, named so that the survival
  -- checks in 20260921025523 and 20260921044045 can see that a replace() did
  -- not swallow one. Both migrations assert a list of strings is still present
  -- in the body they are about to install, one per tick step, taken from that
  -- step's own event kind or action key:
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
  -- None of the four is touched by either migration and none of them can
  -- change the answer to any question this harness asks, because this fixture
  -- never seats a player on a table with an open Main seat beside it and never
  -- opens a table in the 'opening' lifecycle.

  -- The lifecycle and the status must agree, or the worklist and the census
  -- disagree about whether a table is alive.
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
  -- BOARD, NOT THE OLDEST ROW (2026-09-05, 14:45).
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

  -- BREAK (1.3 s9.5). The thinnest live table that is not the game itself is
  -- the candidate to consolidate away; the game's own table is never broken.
  SELECT * INTO v_candidate FROM unnest(v_census) c
   WHERE NOT (c.role = 'main' AND c.main_index = 1) AND c.lifecycle = 'live'
   ORDER BY c.seated ASC, c.created_at ASC LIMIT 1;
  IF v_candidate.id IS NOT NULL THEN
    v_actions := v_actions || jsonb_build_object('break_candidate', v_candidate.id);
  END IF;

  UPDATE public.cash_games SET last_tick_at = v_now, last_tick_actions = v_actions WHERE id = g.id;

  RETURN jsonb_build_object('ok', true, 'game_id', g.id, 'seated_total', v_seated_total,
                            'tables', v_live_tables, 'buyers', 0, 'actions', v_actions);
END;
$fixture$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 9. THE CREATION PATH, PRE-25523 (20260905010500 + two 20260909 patches)
-- ---------------------------------------------------------------------------
-- Reduced to its skeleton plus 20260921025523's four anchors and the six
-- sibling refusals that migration asserts survived. It is here for ONE reason
-- that belongs to the remediation: a Cluster born through the estate's own
-- creation path, rather than by a bare INSERT, must also get its genesis epoch
-- row. The trigger is on the table and not on the writer, which is the whole
-- argument for putting it there, and this is what proves it.
--
-- v_uid is a constant rather than auth.uid(): who may create a game is not
-- what any assertion here is about.

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
  -- THERE IS NO UNKNOWN-KEY REJECTION, and 20260921025523 depends on that: it
  -- carries the Lightning flag in p_overrides precisely because an
  -- unrecognised key is silently dropped today.
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
-- 10. THE ESTATE AS IT STANDS BEFORE THE MIGRATION
-- ---------------------------------------------------------------------------
-- FOUR ordinary Clusters, each with one live Main 1 and nothing else. See
-- point 1 of the header: the migration's post-apply read-back asserts the
-- re-cut front table returns exactly that Main 1 for every cash_games row that
-- has one, and refuses to commit if none does. On a database whose only
-- cluster had an older feeder in front of its Main 1 it would be asserting its
-- own answer against itself, so the seeded shape is the simplest there is, and
-- every interesting board is built AFTER the migration by the harness, where
-- the harness can assert on it. FOUR and not four hundred: the harness asserts
-- that the migration applied to a single-digit estate, which is the regression
-- test for the hundred-cluster guard the file used to carry.
--
-- Each seeded cluster gets its own created_at a second apart, because
-- fn_cash_clusters_to_tick orders by it and "oldest" must be a real ordering.

INSERT INTO public.unions (id, club_id, name)
VALUES ('c0000000-0000-0000-0000-0000000000f1', 'cb000000-0000-0000-0000-000000000001', 'Fixture Union');

INSERT INTO public.cash_games
  (id, club_id, union_id, name, template_name, variant, sb, bb, handedness,
   ruleset_snapshot, created_by, must_move, created_at)
SELECT ('ca000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       'cb000000-0000-0000-0000-000000000001',
       'c0000000-0000-0000-0000-0000000000f1',
       'Legacy NLH ' || i::text || '/' || (i * 2)::text || ' Classic',
       'classic', 'nlh', i::numeric, (i * 2)::numeric, 9,
       '{"seats": 9}'::jsonb, '00000000-0000-0000-0000-0000000000aa', true,
       timestamptz '2026-09-01 09:00:00+00' + (i::text || ' seconds')::interval
  FROM generate_series(1, 4) AS i;

INSERT INTO public.tables
  (id, club_id, union_id, name, game_variant, small_blind, big_blind, max_players,
   status, created_by, cluster_id, role, main_index, lifecycle, opened_at, live_at, created_at)
SELECT ('ab000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       g.club_id, g.union_id, g.name, g.variant, g.sb, g.bb, 9,
       'waiting', g.created_by, g.id, 'main', 1, 'live',
       g.created_at, g.created_at, g.created_at
  FROM generate_series(1, 4) AS i
  JOIN public.cash_games g ON g.id = ('ca000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid;
