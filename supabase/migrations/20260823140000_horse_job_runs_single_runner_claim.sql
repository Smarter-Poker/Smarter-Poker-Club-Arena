-- ═══════════════════════════════════════════════════════════════════════════
-- V13.1 NIGHTLY JOB CLAIM (2026-08-23)
--
-- The engine now runs leader/standby: TWO containers boot the full engine
-- path, and both therefore start the nightly league and self-tuner. Verified
-- on the host - club-arena-engine and club-arena-engine-2 both hydrate
-- HorseMind and both run GameServer cleanup at boot.
--
-- Without a claim, both instances run the same night's work: twice the league
-- CPU, and two concurrent 120,000-row scans for the self-tuner. The results
-- themselves are safe (both writers upsert on their natural keys) but the load
-- is not, and it doubles again with every additional replica.
--
-- This is the smallest correct mechanism: INSERT the claim first. The primary
-- key makes exactly one instance win; the loser sees a conflict and stands
-- down. A claim older than a day is irrelevant because the key includes the
-- date, so no cleanup job is needed.
--
-- Service-role only: RLS enabled with NO policies.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.horse_job_runs (
  job        text NOT NULL,
  run_date   date NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  PRIMARY KEY (job, run_date)
);

ALTER TABLE public.horse_job_runs ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS horse_job_runs_claimed_at_idx
  ON public.horse_job_runs (claimed_at DESC);

COMMENT ON TABLE public.horse_job_runs IS
  'One row per (nightly job, date). The INSERT is the lock: exactly one engine instance wins the claim and runs the job.';
