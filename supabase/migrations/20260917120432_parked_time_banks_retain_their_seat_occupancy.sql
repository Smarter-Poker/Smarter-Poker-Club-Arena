-- 20260917120432_parked_time_banks_retain_their_seat_occupancy.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '90s';

-- An unmarked legacy seat default cannot prove an initialized time bank.
-- Keep the marker with the existing engine-only park snapshot, including the
-- exact occupancy, completed-hand boundary, timestamp and accounting basis.
ALTER TABLE public.engine_presence_parked
  ADD COLUMN IF NOT EXISTS time_bank_snapshot jsonb;
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid='public.engine_presence_parked'::regclass
      AND attname='time_bank_snapshot' AND atttypid='jsonb'::regtype AND NOT attnotnull
  ) THEN
    RAISE EXCEPTION 'Parked time bank column has incompatible schema';
  END IF;
  IF has_table_privilege('anon','public.engine_presence_parked','SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('authenticated','public.engine_presence_parked','SELECT,INSERT,UPDATE,DELETE')
    OR NOT has_table_privilege('service_role','public.engine_presence_parked','SELECT,INSERT,UPDATE') THEN
    RAISE EXCEPTION 'Parked time banks require the existing engine-only table privileges';
  END IF;
END;
$guard$;
COMMENT ON COLUMN public.engine_presence_parked.time_bank_snapshot IS
  'Versioned same-write timestamp, hand number and occupancy-bound time banks. Null for legacy writers. Never inferred from table_seats defaults.';

COMMIT;
