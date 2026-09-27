-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820132045 "commander_print_jobs_queue"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a5bd16c89e422fa5be3c2326d47e39fd of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Commander Print Job Queue
--
-- WHY: every receipt in the app is window.open() + window.print() fired from
-- whichever device happened to perform the action. If the popup is blocked the
-- helper does `if (!pw) return;` and the seat moves are ALREADY committed, so
-- players get relocated with no card and no record. There is also no reprint,
-- no audit, and a bust performed on a table tablet prints nothing at all
-- because the tablet discards the auto_break payload.
--
-- This queue decouples "a receipt is owed" from "a device printed it". The
-- server enqueues on break/bust/buy-in; the floor print station claims and
-- prints. Nothing is lost to a blocked popup and anything can be reprinted.

CREATE TABLE IF NOT EXISTS commander_print_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id integer NOT NULL,
  tournament_id uuid REFERENCES commander_tournaments(id) ON DELETE SET NULL,
  job_type text NOT NULL CHECK (job_type = ANY (ARRAY[
    'seat_change'::text, 'table_break'::text, 'buyin'::text, 'rebuy'::text,
    'addon'::text, 'payout'::text, 'chip_race'::text, 'custom'::text
  ])),
  status text NOT NULL DEFAULT 'queued' CHECK (status = ANY (ARRAY[
    'queued'::text, 'printing'::text, 'printed'::text, 'voided'::text
  ])),
  title text,
  -- receipts: array of card payloads rendered by the print station.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  receipt_count integer NOT NULL DEFAULT 0,
  source text,
  table_number integer,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  printed_at timestamptz,
  printed_by uuid,
  reprint_of uuid REFERENCES commander_print_jobs(id) ON DELETE SET NULL,
  error text
);

CREATE INDEX IF NOT EXISTS idx_commander_print_jobs_queue
  ON commander_print_jobs (venue_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commander_print_jobs_tournament
  ON commander_print_jobs (tournament_id, created_at DESC);

ALTER TABLE commander_print_jobs ENABLE ROW LEVEL SECURITY;

-- Service role only: every reader/writer is a server route holding a verified
-- staff session. No anon or authenticated policy is granted on purpose.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'commander_print_jobs' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY service_role_all ON commander_print_jobs
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Realtime so the print station lights up the instant a break happens.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = 'commander_print_jobs'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE commander_print_jobs;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_name = 'commander_print_jobs') THEN
    RAISE EXCEPTION 'commander_print_jobs not created';
  END IF;
END $$;

-- ROLLBACK:
-- DROP TABLE IF EXISTS commander_print_jobs CASCADE;
