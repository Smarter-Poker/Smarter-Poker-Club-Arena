-- 20260924043232_the_bagged_status_check_is_validated.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- MULTI-DAY TOURNAMENTS, RELEASE R3b: VALIDATE THE WIDENED STATUS CHECK.
--
-- 20260924043224 added tournaments_status_check with 'BAGGED' as NOT VALID so
-- that its transaction held ACCESS EXCLUSIVE only for the catalog change. Every
-- existing row carries one of the seven older statuses, which the new check
-- also admits, so validation cannot fail on history. VALIDATE CONSTRAINT takes
-- SHARE UPDATE EXCLUSIVE: ordinary reads and writes of tournaments continue
-- while it scans. Separate transaction on purpose.
--
-- No function, trigger, grant or row changes. No money.
--
-- @live-proof: (SELECT c.convalidated AND pg_get_constraintdef(c.oid) LIKE '%''BAGGED''::text%' FROM pg_constraint c WHERE c.conrelid = 'public.tournaments'::regclass AND c.conname = 'tournaments_status_check')

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'public.tournaments'::regclass
                    AND c.conname = 'tournaments_status_check'
                    AND pg_get_constraintdef(c.oid) =
                        'CHECK ((status = ANY (ARRAY[''ANNOUNCED''::text, ''REGISTERING''::text, ''LATE_REG''::text, ''RUNNING''::text, ''COMPLETING''::text, ''COMPLETED''::text, ''CANCELLED''::text, ''BAGGED''::text]))) NOT VALID') THEN
    RAISE EXCEPTION 'MULTI_DAY_STATUS_CHECK_NOT_AS_ADDED (20260924043224 must precede this)'
      USING ERRCODE = '55000';
  END IF;
END
$pre$;

ALTER TABLE public.tournaments VALIDATE CONSTRAINT tournaments_status_check;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'public.tournaments'::regclass
                    AND c.conname = 'tournaments_status_check'
                    AND c.convalidated) THEN
    RAISE EXCEPTION 'MULTI_DAY_STATUS_CHECK_NOT_VALIDATED' USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
