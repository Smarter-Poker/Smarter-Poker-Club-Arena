-- Isolated PostgreSQL contract fixture, never a production migration.
--
-- The PRE-migration shape for the LIGHTNING PHASE 2 REMEDIATION
-- (20260921025504). That migration does not run on bare ground: it runs on top
-- of 20260920235343, whose seven relations it rekeys. So the schema it must
-- find is this file PLUS the whole of 20260920235343 applied over it, and the
-- harness applies that migration itself rather than transcribing its 647 lines
-- here. There is then exactly one copy of the phase-2 DDL in the repository,
-- and an edit to it cannot silently diverge from a hand-copied fixture.
--
-- What has to pre-exist is therefore only what 20260920235343 does NOT create
-- and the remediation reads:
--
--   1. public.cash_games. The genesis backfill reads (id, cluster_epoch,
--      cluster_mode, created_at) out of it, and
--      cash_cluster_epoch_belongs_to_a_cluster references its primary key.
--      Columns no assertion under test touches are omitted; lightning_enabled
--      is kept because it is the flag the estate reads beside cluster_mode
--      (20260920172736), and a fixture that dropped it would invite a backfill
--      written against a shape production does not have.
--   2. public.cash_cluster_events WITHOUT cluster_epoch, exactly as the phase-2
--      fixture carries it: 20260920235343 is what adds that column, and the
--      remediation is what puts a BEFORE INSERT trigger on it. A fixture that
--      pre-created the column would make the phase-2 ALTER a no-op and leave
--      the trigger sitting on a column nothing under test had added.
--   3. The three Supabase grant targets, and the ALTER DEFAULT PRIVILEGES that
--      makes every REVOKE in both migrations load-bearing.
--   4. gen_random_uuid(). Three of the seven phase-2 relations default their
--      primary key to it.
--
-- FOUR THINGS IN HERE ARE LOAD-BEARING RATHER THAN DECORATIVE, and a fixture
-- that omitted any of them would let a mutation of the remediation pass
-- unnoticed:
--
--   1. ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated.
--      This project carries exactly that (see the grant preambles in
--      20260807_m17_admin_money_rpcs.sql and 20260919173446, which call it out
--      by name for FUNCTIONS; TABLES is the same mechanism). Without it,
--      public.cash_cluster_epoch is born owner-only, the migration's
--      `REVOKE ALL ... FROM PUBLIC, anon, authenticated` is a no-op, and
--      DELETING that REVOKE would still leave the harness green. With it, the
--      new epoch authority is born readable and writable by the two
--      browser-facing roles and the REVOKE is the only thing that closes it.
--
--      service_role is DELIBERATELY ABSENT from that default ACL, and that is
--      the one place this fixture is not the live catalog verbatim. An aclitem
--      produced by ALTER DEFAULT PRIVILEGES is byte-identical to one produced
--      by an explicit GRANT (both read service_role=arwdDxt/owner), so a
--      fixture that inherited the grant could not tell the two apart, and
--      deleting `GRANT ALL ON TABLE ... TO service_role` from the migration
--      would be invisible. Omitting service_role here makes the migration's own
--      GRANT the only possible source of that access. The harness asserts both
--      halves of this arrangement, so neither can rot into a no-op.
--
--   2. FOUR cash_games rows, NO TWO ALIKE in any column the genesis backfill
--      copies. The backfill is
--          SELECT g.id, g.cluster_epoch, g.cluster_mode, 'genesis', g.created_at
--      and every one of those three copied columns is unfalsifiable against a
--      uniform seed: with every cluster at epoch 0 the literal 0 passes, with
--      every cluster in must_move the literal 'must_move' passes, and with one
--      created_at the constant clock_timestamp() passes. So one cluster is at
--      cluster_epoch = 2, one is in cluster_mode = 'lightning', and all four
--      carry a different created_at.
--
--   3. Three pre-migration rows in cash_cluster_events, in the insert shapes
--      20260920235343 promises it does not break. They are written before that
--      migration adds cluster_epoch, so nothing here can name the column; after
--      it they must all read 0, and after the REMEDIATION they must still read
--      0, because the trigger is BEFORE INSERT and an ALTER must not rewrite
--      rows that already exist.
--
--   4. cash_cluster_events.game_id carries NO foreign key, exactly as in
--      production. The remediation's trigger does a lookup on it and must
--      TOLERATE a miss; a fixture that made the column referential would make
--      that branch unreachable and the tolerance untestable.

-- ---------------------------------------------------------------------------
-- 0. SUPABASE'S GRANT TARGETS
-- ---------------------------------------------------------------------------
-- Both migrations REVOKE from anon/authenticated and GRANT to service_role, so
-- all three must exist. Guarded, so re-running the fixture against a cluster
-- that already has them is not an error.
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

-- The reason every migration in this estate names anon and authenticated in a
-- REVOKE instead of trusting the default. service_role is intentionally not
-- listed; see the header.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated;

-- Supabase's `postgres` is a member of the three API roles, which is what lets
-- information_schema.role_table_grants -- the view the migration's own
-- @live-proof reads -- report their grants. Reproduced so the harness reads the
-- same view against the same role shape.
DO $$
BEGIN
  EXECUTE format('GRANT anon, authenticated, service_role TO %I', current_user);
END $$;

-- lightning_pool_session, lightning_pool_slot, lightning_instance and
-- lightning_reservation all declare `id uuid PRIMARY KEY DEFAULT
-- gen_random_uuid()`. PostgreSQL 13+ carries that function in core, but the
-- estate's own databases get it from pgcrypto, so it is requested by name and
-- guarded rather than assumed.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. THE CLUSTER (20260904160500 slice 1, + the three Lightning columns from
--    20260920172736 phase 1)
-- ---------------------------------------------------------------------------
-- Only the columns the remediation reads or keys on. cluster_epoch is the
-- single mutable integer the whole migration exists to give a durable referent
-- to, and cluster_mode is the vocabulary cash_cluster_epoch_mode_check repeats.

CREATE TABLE IF NOT EXISTS public.cash_games (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_mode      text NOT NULL DEFAULT 'created',
  cluster_epoch     integer NOT NULL DEFAULT 0,
  lightning_enabled boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. THE CLUSTERS THAT ALREADY EXIST
-- ---------------------------------------------------------------------------
-- Four rows, no two alike in any column the genesis backfill copies. See point
-- 2 of the header: a uniform seed makes every one of the three copied columns
-- satisfiable by a constant, and the backfill would pass with g.cluster_mode
-- replaced by 'must_move', with g.cluster_epoch replaced by 0, or with
-- g.created_at replaced by clock_timestamp().
--
--   0001  must_move  epoch 0   the ordinary cluster, and the one the pool,
--                              instance and hand families are built under
--   0002  lightning  epoch 0   the mode proof, and the SECOND cluster every
--                              cross-cluster refusal below is aimed at
--   0003  draining   epoch 2   the epoch proof: a cluster that has already
--                              been converted twice
--   0004  created    epoch 0   the cluster the event trigger is bumped on, kept
--                              separate so the bump disturbs no other section

INSERT INTO public.cash_games (id, cluster_mode, cluster_epoch, lightning_enabled, created_at)
VALUES ('c1a50000-0000-0000-0000-000000000001', 'must_move', 0, false, '2026-09-01T09:00:00Z'),
       ('c1a50000-0000-0000-0000-000000000002', 'lightning', 0, true,  '2026-09-02T10:30:00Z'),
       ('c1a50000-0000-0000-0000-000000000003', 'draining',  2, true,  '2026-09-03T11:45:00Z'),
       ('c1a50000-0000-0000-0000-000000000004', 'created',   0, false, '2026-09-04T12:15:00Z');

-- ---------------------------------------------------------------------------
-- 3. THE CLUSTER EVENT LEDGER (20260905010000 cluster columns slice 2)
-- ---------------------------------------------------------------------------
-- Verbatim pre-migration shape: (id, game_id, table_id, kind, payload, at).
-- cluster_epoch is deliberately ABSENT -- 20260920235343 adds it, and the
-- remediation puts the BEFORE INSERT trigger on top of it.
--
-- game_id carries no foreign key here because it carries none in production,
-- and that is load-bearing: the remediation's trigger looks the cluster up and
-- must tolerate a miss, which is unreachable if the column is referential.
--
-- kind carries no CHECK in production, which is why the migration can say new
-- Lightning event kinds need no migration; the fixture keeps that true so the
-- seeded rows below can use fixture-specific kinds.

CREATE TABLE IF NOT EXISTS public.cash_cluster_events (
  id        bigserial PRIMARY KEY,
  game_id   uuid NOT NULL,
  table_id  uuid,
  kind      text NOT NULL,
  payload   jsonb NOT NULL DEFAULT '{}'::jsonb,
  at        timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS cash_cluster_events_by_game ON public.cash_cluster_events (game_id, at DESC);
ALTER TABLE public.cash_cluster_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_cluster_events FROM anon, authenticated;
GRANT ALL ON public.cash_cluster_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.cash_cluster_events_id_seq TO service_role;

-- ---------------------------------------------------------------------------
-- 4. EVENTS THAT ALREADY EXIST
-- ---------------------------------------------------------------------------
-- Written before either migration runs, in three of the four insert shapes
-- 20260920235343 promises it does not break: (game_id, kind), plus table_id and
-- payload, plus an explicit `at`. None of them can name cluster_epoch, because
-- the column does not exist yet. After the phase-2 migration every one of these
-- rows must read cluster_epoch = 0; after the REMEDIATION they must still read
-- 0, because the trigger fires BEFORE INSERT and an existing row is not an
-- insert.

INSERT INTO public.cash_cluster_events (game_id, kind)
VALUES ('c1a50000-0000-0000-0000-000000000001', 'fixture_pre_migration_opened');

INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
VALUES ('c1a50000-0000-0000-0000-000000000001', 'ab150000-0000-0000-0000-000000000001',
        'fixture_pre_migration_seated', '{"seat": 3}'::jsonb);

INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, at)
VALUES ('c1a50000-0000-0000-0000-000000000002', NULL,
        'fixture_pre_migration_closed', '{"reason": "drained"}'::jsonb,
        '2026-09-20T10:40:00Z');
