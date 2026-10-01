-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721151736 "daemon_state_hwm_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 abb4a42eaa9f95da763acc6ee49995e8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE TABLE IF NOT EXISTS public.daemon_state (
  daemon          text PRIMARY KEY,
  high_water_mark timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.daemon_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='daemon_state'
  ) THEN
    RAISE EXCEPTION 'daemon_state not created';
  END IF;
END $$;
