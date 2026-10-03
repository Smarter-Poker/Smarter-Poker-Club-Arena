-- 20261003082023_three_retired_open_claw_routes_stop_reading_as_silent
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-03 08:20:23 UTC.
--
-- THREE RETIRED OPEN CLAW ROUTES STOP READING AS SILENT (2026-10-03)
--
-- OpenClawFleetLongSilence (critical, SMS), OpenClawJobsHaveGoneSilent and
-- CronJobsReportingSuccessWhileDoingNothing have fired since 2026-09-14. Open
-- Claw itself is NOT retired: the dispatcher on openclaw-dispatcher runs, and
-- 30 of its 59 logged jobs succeeded in the two hours to 08:13 UTC. Each
-- firing job was read against the RUNNING dispatcher (/opt/openclaw/dispatcher.py,
-- sha256 5adb4a11ca9a042ba73b84dfda8c9e8cf61fd939f33e59b19d2b574acb09f2c1,
-- AST: ALL_CRONS has 86 paths) on 2026-10-03 08:25 UTC:
--
--   /cron/clawbot-orchestrator  NOT in ALL_CRONS; last run 2026-09-15 07:00,
--                               and the route is gone from World Hub main. It
--                               alone drives OpenClawFleetLongSilence
--                               (25,993 minutes).                  RETIRED
--   /cron/horse/0               NOT in ALL_CRONS; last run 2026-09-06
--                               ("skipped: engine_disabled").       RETIRED
--   /cron/video-library-reels   /api/cron/video-library-reels IS scheduled,
--                               but since the 2026-09-23 owner decision it
--                               runs as the script job video_library_to_reels.py
--                               (journal 2026-10-02 07:00: "Script job
--                               /api/cron/video-library-reels -> ...
--                               video_library_to_reels.py"); the horse-authored
--                               workers route that logged under this name is
--                               deliberately never called (World Hub
--                               scripts/openclaw-cron-dispatcher.py, the
--                               2026-09-21 D1 / 2026-09-23 note). Last row
--                               2026-09-26.                         RETIRED
--
-- Registered in ca_retired_cron_jobs, the table v_openclaw_job_staleness and
-- fn_monitoring_health_snapshot already exclude (20260904185338). No alert
-- rule, threshold or active job changes.
--
-- NOT RETIRED, because they are real defects in active World Hub jobs and
-- the alerts are right to show them:
--   /cron/pokernews-videos          HTTP 500 "PokerNews content_author is not
--                                   configured" and RSS fetch 404.
--   /cron/training-cache-drift-audit HTTP 500, statement timeout at ~8 s.
--   /cron/phase9-content            "skipped: mode_disabled" (the hand_clip
--                                   mode row ships disabled pending owner
--                                   approval).
--
-- @live-proof: (SELECT count(*) FROM public.ca_retired_cron_jobs WHERE job_name IN ('/cron/clawbot-orchestrator','/cron/horse/0','/cron/video-library-reels')) = 3

BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '15s';

INSERT INTO public.ca_retired_cron_jobs (job_name, retired_at, reason, replaced_by)
VALUES
  ('/cron/clawbot-orchestrator', '2026-09-15 07:00:00+00'::timestamptz,
   'Absent from the running OpenClaw dispatcher ALL_CRONS (sha256 5adb4a11..., 86 paths) on 2026-10-03; last run 2026-09-15 07:00 UTC; the route no longer exists on World Hub main.',
   NULL),
  ('/cron/horse/0', '2026-09-06 23:20:15+00'::timestamptz,
   'Absent from the running OpenClaw dispatcher ALL_CRONS (sha256 5adb4a11..., 86 paths) on 2026-10-03; last run 2026-09-06 returned skipped: engine_disabled.',
   NULL),
  ('/cron/video-library-reels', '2026-09-26 07:00:01+00'::timestamptz,
   'The horse-authored workers route is deliberately never called (World Hub dispatcher 2026-09-21 D1 and 2026-09-23 owner decision). /api/cron/video-library-reels runs instead as the script job video_library_to_reels.py, which publishes as the official system account and does not log under this name.',
   'script job video_library_to_reels.py on openclaw-dispatcher (daily 07:00 UTC)')
ON CONFLICT (job_name) DO NOTHING;

DO $post$
BEGIN
  IF (SELECT count(*) FROM public.ca_retired_cron_jobs
       WHERE job_name IN ('/cron/clawbot-orchestrator','/cron/horse/0','/cron/video-library-reels')) <> 3 THEN
    RAISE EXCEPTION 'expected the three retired routes to be registered';
  END IF;
END
$post$;

COMMIT;
