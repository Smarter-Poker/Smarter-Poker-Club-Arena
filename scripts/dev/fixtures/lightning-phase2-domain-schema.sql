-- Isolated PostgreSQL contract fixture, never a production migration.
--
-- The PRE-migration shape of everything 20260920235343 touches, so that the
-- Lightning Phase 2 migration genuinely CREATES and ALTERS something when it is
-- applied on top of this file. Phase 2 is a schema phase: it creates seven new
-- relations out of nothing and adds one column to one existing one. So the only
-- thing that has to pre-exist is public.cash_cluster_events, in its shape as of
-- 20260905010000 (cluster columns slice 2) -- WITHOUT cluster_epoch, which is
-- the whole delta being proved.
--
-- Two things in here are load-bearing rather than decorative, and a fixture
-- that omitted either would let a mutation of the migration pass unnoticed:
--
--   1. ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated.
--      This project carries exactly that (see the grant preambles in
--      20260807_m17_admin_money_rpcs.sql and 20260919173446, which call it out
--      by name for FUNCTIONS; TABLES is the same mechanism). Without it, a
--      brand-new table in `public` is owner-only by default, every
--      `REVOKE ALL ... FROM PUBLIC, anon, authenticated` in the migration is a
--      no-op, and DELETING those REVOKEs would still leave the harness green.
--      With it, a new Lightning table is born readable and writable by the two
--      browser-facing roles, and the REVOKE is the only thing that closes it.
--
--      service_role is DELIBERATELY ABSENT from that default ACL, and that is
--      the one place this fixture is not the live catalog verbatim. The live
--      project's default privileges do name service_role -- which is precisely
--      the problem the migration was changed to fix. An aclitem produced by
--      ALTER DEFAULT PRIVILEGES is byte-identical to one produced by an
--      explicit GRANT (both read service_role=arwdDxt/owner), so a fixture that
--      inherited the grant could not tell the two apart, and deleting
--      `GRANT ALL ON TABLE ... TO service_role` from the migration would be
--      invisible. Omitting service_role here makes the migration's own GRANT
--      the only possible source of that access, which is what lets the harness
--      prove it is STATED rather than inherited. The harness asserts both
--      halves of this arrangement, so neither can rot into a no-op.
--
--   2. Three pre-migration rows in cash_cluster_events. The migration adds
--      `cluster_epoch integer NOT NULL DEFAULT 0` to a 299,817-row production
--      relation and claims the default "is the epoch every existing cluster is
--      at". On an EMPTY table that claim is unfalsifiable: a default of 1, or
--      of NULL, would look identical. These rows are what makes it a statement.
--
-- Columns and grants no assertion under test touches are omitted. The index,
-- the RLS flag and the grants on cash_cluster_events are NOT omitted, because
-- those are exactly the things an ADD COLUMN could disturb.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. SUPABASE'S GRANT TARGETS
-- ─────────────────────────────────────────────────────────────────────────────
-- The migration REVOKEs from anon/authenticated on all seven new tables and
-- GRANTs to service_role, so all three must exist. Guarded, so re-running the
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE CLUSTER EVENT LEDGER (20260905010000 cluster columns slice 2, lines 96-108)
-- ─────────────────────────────────────────────────────────────────────────────
-- Verbatim pre-migration shape: (id, game_id, table_id, kind, payload, at).
-- cluster_epoch is deliberately ABSENT -- the migration adds it.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. EVENTS THAT ALREADY EXIST
-- ─────────────────────────────────────────────────────────────────────────────
-- Written one statement before the migration runs, in the four insert shapes
-- the migration promises it does not break: (game_id, kind), plus table_id,
-- plus payload, plus an explicit `at`. None of them can name cluster_epoch,
-- because the column does not exist yet. That is the point: after the
-- migration every one of these rows must read cluster_epoch = 0, and the
-- column must be NOT NULL, or the "no rewrite, no backfill, nothing to change"
-- argument in the migration header is false.

INSERT INTO public.cash_cluster_events (game_id, kind)
VALUES ('c1a50000-0000-0000-0000-000000000001', 'fixture_pre_migration_opened');

INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
VALUES ('c1a50000-0000-0000-0000-000000000001', 'ab150000-0000-0000-0000-000000000001',
        'fixture_pre_migration_seated', '{"seat": 3}'::jsonb);

INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, at)
VALUES ('c1a50000-0000-0000-0000-000000000002', NULL,
        'fixture_pre_migration_closed', '{"reason": "drained"}'::jsonb,
        '2026-09-20T10:40:00Z');
