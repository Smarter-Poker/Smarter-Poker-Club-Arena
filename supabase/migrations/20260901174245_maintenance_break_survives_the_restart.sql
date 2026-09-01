-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901174245; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The maintenance break outlives the process that declared it (Dan 2026-09-01).
-- Full rationale in supabase/migrations/20260902080000_maintenance_break_survives_the_restart.sql
-- Single transaction per the production DDL policy: one migration, one schema
-- cache reload, not one per statement.

CREATE TABLE IF NOT EXISTS public.engine_maintenance_break (
  id                BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  phase             TEXT NOT NULL CHECK (phase IN ('last_hand', 'counting_down')),
  announced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  break_started_at  TIMESTAMPTZ,
  break_ends_at     TIMESTAMPTZ,
  reason            TEXT NOT NULL DEFAULT 'Scheduled Engine Maintenance',
  declared_by       TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT counting_down_has_an_end
    CHECK (phase <> 'counting_down' OR break_ends_at IS NOT NULL)
);

COMMENT ON TABLE public.engine_maintenance_break IS
  'Single-row platform maintenance break. Written by the engine at :53 before the hourly :55 restart window and deleted when the break ends. Survives the restart on purpose: the booting engine re-parks its tables until break_ends_at, and browsers seeing 4404 during rehydration read it to show a break screen instead of a dead table. Never gate a table on tables.status = paused instead - cash_tables_needing_engine would abandon the table.';

ALTER TABLE public.engine_maintenance_break ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS maintenance_break_is_public ON public.engine_maintenance_break;
CREATE POLICY maintenance_break_is_public
  ON public.engine_maintenance_break
  FOR SELECT
  TO anon, authenticated
  USING (TRUE);

GRANT SELECT ON public.engine_maintenance_break TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_maintenance_break_state()
RETURNS TABLE (
  phase            TEXT,
  break_ends_at    TIMESTAMPTZ,
  remaining_ms     INTEGER,
  reason           TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    b.phase,
    b.break_ends_at,
    GREATEST(
      0,
      LEAST(
        15 * 60 * 1000,
        COALESCE(EXTRACT(EPOCH FROM (b.break_ends_at - NOW())) * 1000, 0)
      )
    )::INTEGER AS remaining_ms,
    b.reason
  FROM public.engine_maintenance_break b
  WHERE
    (b.phase = 'last_hand' AND b.announced_at > NOW() - INTERVAL '4 minutes')
    OR (b.phase = 'counting_down' AND b.break_ends_at > NOW());
$$;

COMMENT ON FUNCTION public.fn_maintenance_break_state() IS
  'The live maintenance break, or no rows when none is running. Self-expiring: a stale row left behind by a crashed engine reports nothing rather than stranding players on a break screen.';

GRANT EXECUTE ON FUNCTION public.fn_maintenance_break_state() TO anon, authenticated, service_role;
