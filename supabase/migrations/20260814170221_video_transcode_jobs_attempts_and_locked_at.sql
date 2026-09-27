-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260814170221 "video_transcode_jobs_attempts_and_locked_at"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 319e10429c6479f97bbe6debf1a9cb24 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- video_transcode_jobs: add the two columns yt-pipeline-recovery requires
--
-- FOUND BY: cron telemetry, within TWO MINUTES of it going live
-- (2026-08-14). The wrapper recorded yt-pipeline-recovery as error/http_500
-- on its very first tick; the handler's own JSON said:
--     column video_transcode_jobs.attempts does not exist
--
-- The job runs every 15 minutes from Open Claw and has been failing SILENTLY
-- on every run: its SELECT filters on `attempts` and its requeue UPDATE
-- writes `locked_at` — NEITHER column exists. So the recovery pipeline that
-- exists to un-stick failed video transcodes has never once recovered
-- anything, and stuck transcode jobs stay stuck forever.
--
-- (This is the column-level twin of the phantom-TABLE class CHECK 11 hunts.
-- 42703 on a column is invisible to that gate — telemetry is what caught it.)
--
-- attempts defaults to 0 for all existing rows, so previously-failed jobs
-- become eligible for recovery (< 5 cap) on the next tick — intended: they
-- have never actually been retried.
-- =====================================================================
DO $$
BEGIN
    IF to_regclass('public.video_transcode_jobs') IS NULL THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAILED: video_transcode_jobs missing';
    END IF;
END $$;

ALTER TABLE public.video_transcode_jobs
    ADD COLUMN IF NOT EXISTS attempts  integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS locked_at timestamptz;

COMMENT ON COLUMN public.video_transcode_jobs.attempts IS
  'Recovery requeue count. Incremented by /api/cron/yt-pipeline-recovery on each requeue; jobs stop being requeued at 5. Added 2026-08-14 after cron telemetry caught the recovery job failing 42703 on every tick since it shipped.';

DO $$
BEGIN
    IF (SELECT count(*) FROM information_schema.columns
         WHERE table_schema='public' AND table_name='video_transcode_jobs'
           AND column_name IN ('attempts','locked_at')) <> 2 THEN
        RAISE EXCEPTION 'POST-APPLY FAILED: columns not created';
    END IF;
    RAISE NOTICE 'OK: attempts + locked_at present.';
END $$;
