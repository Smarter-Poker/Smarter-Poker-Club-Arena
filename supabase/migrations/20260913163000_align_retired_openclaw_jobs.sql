-- Recorded from the running OpenClaw dispatcher on 2026-09-13 at 16:18 UTC.
-- Host: openclaw-dispatcher; /opt/openclaw/dispatcher.py
-- SHA256: b15f015a8126c040d6198372bb411a1c8f2829c86c1de150e86155246bc87c63
-- AST inspection: ALL_CRONS has 86 paths; none of these 13 paths is scheduled.
-- /api/cron/horse-posts and all four genuinely failing active routes remain scheduled.
-- Existing v_openclaw_job_staleness and fn_monitoring_health_snapshot already
-- consume ca_retired_cron_jobs. Preserve their thresholds and every active job.
-- Do not manufacture replacement schedules for retired competitive Trivia.
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '15s';

INSERT INTO public.ca_retired_cron_jobs (job_name, retired_at, reason, replaced_by)
SELECT
  '/cron/horse-batch/' || batch::text,
  '2026-09-05 00:00:00+00'::timestamptz,
  'Explicitly retired from the canonical OpenClaw dispatcher on 2026-09-05 by Fleet Content Programme phase 1. All ten fixed batch schedules were replaced by one hourly whole-fleet due-work route. Verified absent from the running ALL_CRONS on 2026-09-13.',
  '/cron/horse-posts (hourly at minute 10)'
FROM generate_series(0, 9) AS batch
ON CONFLICT (job_name) DO NOTHING;

INSERT INTO public.ca_retired_cron_jobs (job_name, retired_at, reason, replaced_by)
VALUES
  (
    '/cron/trivia-pvp-cleanup',
    '2026-09-06 00:00:00+00'::timestamptz,
    'Explicitly retired from the canonical OpenClaw dispatcher on 2026-09-06 because the legacy cleanup made settlement decisions in a separate worker path. The running dispatcher records competitive Trivia as fail-closed pending its single atomic settlement authority. Verified absent from ALL_CRONS on 2026-09-13.',
    NULL
  ),
  (
    '/cron/trivia-tournament-rounds',
    '2026-09-06 00:00:00+00'::timestamptz,
    'Explicitly retired from the canonical OpenClaw dispatcher on 2026-09-06 with the legacy Trivia tournament lifecycle schedules. The running dispatcher records the replacement as future versioned server-owned work, not an active schedule. Verified absent from ALL_CRONS on 2026-09-13.',
    NULL
  ),
  (
    '/cron/trivia-tournaments',
    '2026-09-06 00:00:00+00'::timestamptz,
    'Explicitly retired from the canonical OpenClaw dispatcher on 2026-09-06 with the legacy Trivia tournament lifecycle schedules. The running dispatcher records the replacement as future versioned server-owned work, not an active schedule. Verified absent from ALL_CRONS on 2026-09-13.',
    NULL
  )
ON CONFLICT (job_name) DO NOTHING;

-- No alert-history updates: the watchdog emits truthful per-fingerprint
-- retirement resolutions after its source change is deployed.
COMMIT;

