-- Isolated PostgreSQL contract fixture, never a production migration.
--
-- The PRE-migration shape for LIGHTNING PHASE 4 (20260921064717), the one live
-- eligible population and the thresholds it is judged by.
--
-- WHAT THIS FILE IS AND WHAT IT DELEGATES.
--
-- The migration under test creates FOUR functions - fn_cash_cluster_live_eligible
-- (the one predicate, a scalar), fn_cash_cluster_population (the breakdown
-- around that number), fn_cash_cluster_lightning_thresholds and
-- fn_cash_cluster_pool_health - and REPLACES a fifth,
-- fn_cash_cluster_lightning_state. Between them they read eighteen relations
-- none of them creates. Four REAL migration files in this repository create
-- thirteen of those, so the harness applies those four rather than
-- transcribing them:
--
--   20260920235343  the seven Lightning relations - lightning_pool_session,
--                   lightning_pool_slot, lightning_instance,
--                   lightning_reservation, lightning_blind_ledger,
--                   lightning_hand, lightning_hand_player - and
--                   cash_cluster_events.cluster_epoch.
--   20260921025504  public.cash_cluster_epoch, and the cluster_epoch column
--                   and composite foreign keys that make a Lightning row name
--                   the seating regime it ran under. fn_cash_cluster_population
--                   filters the pool session, the reservation and the hand on
--                   `cluster_epoch = g.cluster_epoch`, so the epoch dimension
--                   has to be the real one.
--   20260921025523  the feeder-first cluster writer and fn_cash_cluster_front_table.
--   20260921044045  trg_cash_games_epoch_follows_its_game, which is what gives
--                   a Cluster created by this HARNESS a cash_cluster_epoch row.
--                   Without it every lightning_pool_session in section 11
--                   would violate lightning_pool_session_runs_in_a_declared_epoch
--                   and the harness would be inserting epoch rows by hand -
--                   which is the very thing 20260921044045 exists to stop
--                   anyone having to do.
--
-- And it delegates the rest of the PRE-migration estate - the union, the
-- cluster, the table, the chair, the roster, the event ledger, the census type,
-- fn_cash_cluster_census itself, auth.uid(), the three Supabase grant targets,
-- and the five pre-25523/pre-044045 function bodies whose byte-exact anchors
-- those two migrations read - to
-- scripts/dev/fixtures/lightning-phase3-remediation-schema.sql, which the
-- harness applies FIRST and which builds every one of them already.
--
-- THAT DELEGATION IS DELIBERATE AND IT IS THE SAME TRADE THE PHASE 3
-- REMEDIATION HARNESS MAKES WITH ITS THREE PREDECESSOR MIGRATIONS. 20260921025523
-- and 20260921044045 patch five installed bodies by substitution against text
-- they assert occurs EXACTLY ONCE. A second hand-copy of that text in this file
-- would be a second place for it to drift from the migrations that produced it,
-- and the failure it would produce - "the live body carries ... 0 times, not
-- once" - would be this fixture being wrong rather than Phase 4 being wrong.
-- There is one copy of those anchors in the repository and this file is not it.
--
-- SO WHAT IS LEFT FOR THIS FILE IS EXACTLY THE FIVE THINGS NOTHING ELSE MAKES.
--
--   1. table_seats.is_sitting_out and table_seats.horse_id. The Phase 3
--      fixture's chair has neither, and they are two of the five columns the
--      seat predicate reads. is_sitting_out is NULLABLE with a false default,
--      exactly as 001_club_arena_schema.sql declares it, because the migration
--      writes `coalesce(ts.is_sitting_out, false)` and a NOT NULL column would
--      make that coalesce untestable. horse_id carries no foreign key here:
--      public.horses is not in this chain, and what is under test is Law 10.5 -
--      that a seat with a horse_id counts exactly like one without - not
--      referential integrity against a fleet table.
--   2. public.cash_game_waitlist (20260905010000's shape). "Waitlist-only does
--      NOT count", and a relation that does not exist cannot prove that.
--   3. public.cash_player_session (20260904120000's shape). The REPLACED
--      fn_cash_cluster_lightning_state counts its open rows for the Cluster as
--      open_cluster_sessions - a field the migration's own read-back asserts
--      survived the replacement - and the Phase 3 fixture's reduced body
--      answered a literal 0 and needed no such table.
--   4. THE TWO BANDS. The migration's own post-apply block refuses to commit
--      unless a cluster exists on each side of the `handedness <= 6` boundary,
--      and it reads 18 / 12 off one and 27 / 18 off the other. The Phase 3
--      fixture seeds four nine-handed clusters, which is half of that. This
--      file adds five more - handedness 2, 5, 6, 7 and 6 again - so that both
--      bands are populated, the boundary itself is populated on BOTH sides, and
--      every one of them has a live Main 1.
--   5. NOTHING SEATED, AND NOTHING CONFIGURED. Not one table_seats row, and no
--      cluster carrying ruleset_snapshot -> lightning.
--
--      The configuration half is load-bearing: the migration's post-apply block
--      reads the mandated defaults off `WHERE handedness <= 6 LIMIT 1` and off
--      `WHERE handedness > 6 LIMIT 1`, both UNORDERED, so one configured
--      cluster in either band would make which row that LIMIT returned decide
--      whether the file applies at all.
--
--      The unseated half no longer is. An earlier cut also asserted
--      `to_on = 18` on that same unordered row - a property of the DATA, which
--      one seated player would have turned into a refusal to apply - and that
--      check has been replaced by a relationship asked of EVERY cluster. The
--      fixture stays unseated anyway, because every board in this contract
--      should be built AFTER the migration, by the harness, where the harness
--      can assert on it.

-- ---------------------------------------------------------------------------
-- 0. THE BASE FIXTURE REALLY RAN, AND THE REAL MIGRATIONS HAVE NOT
-- ---------------------------------------------------------------------------
-- This file is a delta. A delta applied to the wrong base is worse than no
-- fixture at all, because most of it would still succeed.

DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(x.want, ', ' ORDER BY x.want) INTO v_missing
    FROM unnest(ARRAY['cash_games','tables','table_seats','table_waitlist',
                      'cash_seat_moves','cash_cluster_events','unions']) AS x(want)
   WHERE to_regclass('public.' || x.want) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'FIXTURE: % is absent, so lightning-phase3-remediation-schema.sql was not applied before this file', v_missing;
  END IF;
  IF to_regproc('public.fn_cash_cluster_census') IS NULL THEN
    RAISE EXCEPTION 'FIXTURE: fn_cash_cluster_census is absent, and the population is asserted to agree with it table for table';
  END IF;
  IF to_regtype('public.cash_cluster_census_row') IS NULL THEN
    RAISE EXCEPTION 'FIXTURE: the census composite type is absent';
  END IF;
  -- And the four real migrations have NOT run yet: this file has to come
  -- before them, because 20260921025504 puts foreign keys on relations that
  -- 20260920235343 creates and both want an estate to backfill against.
  IF to_regclass('public.lightning_pool_session') IS NOT NULL THEN
    RAISE EXCEPTION 'FIXTURE: the Lightning relations already exist, so this delta is being applied after the migrations it must precede';
  END IF;
  IF to_regclass('public.cash_cluster_epoch') IS NOT NULL THEN
    RAISE EXCEPTION 'FIXTURE: cash_cluster_epoch already exists, so this delta is being applied out of order';
  END IF;
  IF (SELECT count(*) FROM public.cash_games) < 1 THEN
    RAISE EXCEPTION 'FIXTURE: the base fixture seeded no cluster at all';
  END IF;
  IF (SELECT count(*) FROM public.table_seats) <> 0 THEN
    RAISE EXCEPTION 'FIXTURE: the base fixture seeded a chair, and Phase 4 requires an unseated estate at apply time';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. THE TWO COLUMNS OF THE CHAIR THE SEAT PREDICATE READS AND THE BASE
--    FIXTURE HAS NOT GOT
-- ---------------------------------------------------------------------------
-- 001_club_arena_schema.sql: `is_sitting_out BOOLEAN DEFAULT false`. Nullable,
-- and left nullable here for that reason: `coalesce(ts.is_sitting_out, false)`
-- is the migration's own spelling and a NOT NULL column would make the coalesce
-- dead text that no assertion could reach.
ALTER TABLE public.table_seats
  ADD COLUMN IF NOT EXISTS is_sitting_out boolean DEFAULT false;

-- 20260125900_missing_tables.sql adds this as `horse_id UUID REFERENCES
-- horses(id) ON DELETE SET NULL`. The reference is dropped here and only here:
-- public.horses is not in this chain, and Law 10.5 is a statement about the
-- COUNT, not about the fleet. 20260913173936 stamps this column from the
-- canonical occupant profile on insert, which is why a horse's seat carries
-- BOTH user_id and horse_id and why the harness seats them that way.
ALTER TABLE public.table_seats
  ADD COLUMN IF NOT EXISTS horse_id uuid;

COMMENT ON COLUMN public.table_seats.horse_id IS
  'Fixture shape of the live column, without its REFERENCES public.horses: a horse''s seat carries both user_id and horse_id, because 20260913173936 stamps this one from the occupant profile named by that one.';

-- ---------------------------------------------------------------------------
-- 2. THE GAME WAITLIST (20260905010000, verbatim in what the population reads)
-- ---------------------------------------------------------------------------
-- "Waitlist-only does NOT count." fn_cash_cluster_population reads game_id and
-- status and adds the count to excluded.waitlist_only and to nothing else.

CREATE TABLE IF NOT EXISTS public.cash_game_waitlist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id     uuid NOT NULL REFERENCES public.cash_games(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  status      text NOT NULL DEFAULT 'waiting'
              CHECK (status IN ('waiting', 'notified', 'seated', 'cancelled', 'expired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cash_game_waitlist_one_open
  ON public.cash_game_waitlist (game_id, user_id) WHERE status IN ('waiting', 'notified');
ALTER TABLE public.cash_game_waitlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_game_waitlist FROM anon;
GRANT SELECT ON public.cash_game_waitlist TO authenticated;
GRANT ALL ON public.cash_game_waitlist TO service_role;

-- ---------------------------------------------------------------------------
-- 3. THE CASH SESSION (20260904120000, reduced to what is read and constrained)
-- ---------------------------------------------------------------------------
-- The continuous economic identity. fn_cash_cluster_lightning_state counts the
-- rows of it that are open for the Cluster, and lightning_pool_session names
-- one in cash_player_session_id - deliberately NOT as a foreign key, which
-- 20260920235343 says in its own comment, so the harness seats a session for
-- every pool session out of honesty rather than out of necessity.

CREATE TABLE IF NOT EXISTS public.cash_player_session (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id         uuid NOT NULL,
  club_id           uuid,
  scope_type        text NOT NULL CHECK (scope_type IN ('table', 'cluster')),
  scope_id          uuid NOT NULL,
  table_id          uuid NOT NULL,
  variant           text,
  sb                numeric(14,2),
  bb                numeric(14,2),
  baseline          numeric(14,2) NOT NULL DEFAULT 0,
  stay_clock_ms     integer NOT NULL DEFAULT 600000,
  rejoin_window_ms  integer NOT NULL DEFAULT 7200000,
  stay_remaining_ms integer NOT NULL DEFAULT 600000,
  stay_running      boolean NOT NULL DEFAULT false,
  stay_last_tick_at timestamptz NOT NULL DEFAULT now(),
  opened_at         timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  closed_reason     text,
  -- cluster_id is the column fn_cash_cluster_lightning_state reads by name.
  -- In the live estate it arrived with the Slice 6 cutover alongside
  -- scope_type = 'cluster'; both are carried here because the reader under
  -- test names the column and the check names the scope.
  cluster_id        uuid,
  CONSTRAINT cash_player_session_clock_floor CHECK (stay_clock_ms >= 600000),
  CONSTRAINT cash_player_session_window_floor CHECK (rejoin_window_ms >= 7200000),
  CONSTRAINT cash_player_session_remaining_nonneg CHECK (stay_remaining_ms >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS cash_player_session_one_open
  ON public.cash_player_session (player_id, scope_type, scope_id)
  WHERE closed_at IS NULL;

ALTER TABLE public.cash_player_session ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cash_player_session FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.cash_player_session TO service_role;

-- ---------------------------------------------------------------------------
-- 4. THE TWO BANDS, AND THE BOUNDARY ITSELF, EACH WITH A LIVE MAIN 1
-- ---------------------------------------------------------------------------
-- The migration's post-apply block will not commit unless a cluster exists on
-- each side of `handedness <= 6`, and it reads the mandated defaults off one of
-- each. The base fixture's four clusters are all nine-handed, which is one
-- side. These five are the other side and the boundary:
--
--   handedness 2   heads-up, the floor of cash_games_handedness_check
--   handedness 5   inside the six-max band
--   handedness 6   THE BOUNDARY, on the six-max side of it
--   handedness 6   a second one, so that a test which changes the ruleset of
--                  one boundary cluster still leaves a default one to read
--   handedness 7   THE BOUNDARY, on the full-ring side of it - the number the
--                  specification's "9-max/full-ring" wording does not name and
--                  the `<= 6` spelling decides
--
-- Every one of them gets a live Main 1, because 20260921044045's own read-back
-- counts clusters that have one and refuses to commit at zero, and because a
-- cluster with no table is a shape this contract never means to measure.
--
-- Each carries created_at a second apart: fn_cash_clusters_to_tick orders by
-- it, and "oldest" has to be a real ordering rather than one transaction
-- timestamp shared by five rows.

INSERT INTO public.cash_games
  (id, club_id, union_id, name, template_name, variant, sb, bb, handedness,
   ruleset_snapshot, created_by, must_move, cluster_mode, cluster_epoch, created_at)
SELECT ('c4000000-0000-0000-0000-' || lpad(b.n::text, 12, '0'))::uuid,
       'cb000000-0000-0000-0000-000000000001',
       'c0000000-0000-0000-0000-0000000000f1',
       'Band ' || b.handed::text || '-max ' || b.n::text,
       'classic', 'nlh', 1.00, 2.00, b.handed,
       ('{"seats": ' || b.handed::text || '}')::jsonb,
       '00000000-0000-0000-0000-0000000000aa',
       true, 'must_move', 0,
       timestamptz '2026-09-01 10:00:00+00' + (b.n::text || ' seconds')::interval
  FROM (VALUES (1, 2), (2, 5), (3, 6), (4, 6), (5, 7)) AS b(n, handed);

INSERT INTO public.tables
  (id, club_id, union_id, name, game_variant, small_blind, big_blind, max_players,
   status, created_by, cluster_id, role, main_index, lifecycle, opened_at, live_at, created_at)
SELECT ('a4000000-0000-0000-0000-' || lpad(b.n::text, 12, '0'))::uuid,
       g.club_id, g.union_id, g.name, g.variant, g.sb, g.bb, g.handedness,
       'waiting', g.created_by, g.id, 'main', 1, 'live',
       g.created_at, g.created_at, g.created_at
  FROM (VALUES (1), (2), (3), (4), (5)) AS b(n)
  JOIN public.cash_games g ON g.id = ('c4000000-0000-0000-0000-' || lpad(b.n::text, 12, '0'))::uuid;

-- ---------------------------------------------------------------------------
-- 5. THE FIXTURE IS THE SHAPE THE MIGRATION NEEDS, SAID OUT LOUD
-- ---------------------------------------------------------------------------
-- Every one of these is a precondition of the migration's own post-apply block.
-- Asserted here rather than discovered there, because a failure there reads as
-- "Phase 4 is broken" and a failure here reads as "this fixture is".

DO $$
DECLARE v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.cash_games WHERE handedness <= 6;
  IF v_n < 1::bigint THEN
    RAISE EXCEPTION 'FIXTURE: no six-max cluster, and the migration refuses to commit without one';
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_games WHERE handedness > 6;
  IF v_n < 1::bigint THEN
    RAISE EXCEPTION 'FIXTURE: no full-ring cluster, and the migration refuses to commit without one';
  END IF;
  -- The boundary is populated on both sides of itself, which is what makes
  -- "the band is <= 6" a statement rather than a restatement of the defaults.
  IF NOT EXISTS (SELECT 1 FROM public.cash_games WHERE handedness = 6)
     OR NOT EXISTS (SELECT 1 FROM public.cash_games WHERE handedness = 7) THEN
    RAISE EXCEPTION 'FIXTURE: the handedness 6 / 7 boundary is not populated on both sides';
  END IF;
  -- NOTHING carries a lightning ruleset. Every one of the clusters the
  -- migration's `WHERE handedness <= 6 LIMIT 1` might pick has to read the
  -- mandated defaults, and a configured one would make which row that LIMIT
  -- returned decide whether the file applies.
  SELECT count(*) INTO v_n FROM public.cash_games WHERE ruleset_snapshot -> 'lightning' IS NOT NULL;
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FIXTURE: % cluster(s) already carry a lightning ruleset', v_n;
  END IF;
  -- Nothing has left must_move: the migration's last read-back counts that and
  -- this phase converts nothing.
  SELECT count(*) INTO v_n FROM public.cash_games WHERE cluster_mode <> 'must_move';
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FIXTURE: % cluster(s) are not must_move before a phase that converts nothing', v_n;
  END IF;
  -- And the estate is still unseated, so every board in this contract is one
  -- the harness built after the migration and can assert on.
  SELECT count(*) INTO v_n FROM public.table_seats;
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FIXTURE: % chair(s) are seeded, and every board in this contract is meant to be built after the migration', v_n;
  END IF;
  -- Every seeded cluster has a live Main 1: 20260921044045's read-back counts
  -- them and refuses at zero.
  SELECT count(*) INTO v_n
    FROM public.cash_games g
   WHERE NOT EXISTS (SELECT 1 FROM public.tables t
                      WHERE t.cluster_id = g.id AND t.role = 'main' AND t.main_index = 1
                        AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false);
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FIXTURE: % cluster(s) have no live Main 1', v_n;
  END IF;
  -- The two columns the seat predicate reads and this file added really landed,
  -- and is_sitting_out is still NULLABLE so that the coalesce around it is
  -- reachable by an assertion.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'table_seats'
                    AND column_name = 'is_sitting_out' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'FIXTURE: table_seats.is_sitting_out is absent or NOT NULL, and the migration coalesces it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'table_seats'
                    AND column_name = 'horse_id') THEN
    RAISE EXCEPTION 'FIXTURE: table_seats.horse_id is absent, and Law 10.5 is the most important thing in this contract';
  END IF;
END $$;
