-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260507222536 "backfill_transcode_jobs_for_reencode_queue_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 20288641fc2cf8f1b755acf7f5d4e7bd of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- backfill_transcode_jobs_for_reencode_queue_v2
--
-- v1 hit duplicate key on uniq_video_transcode_jobs_yt_url_live because
-- multiple reels share the same original_youtube_url (re-shares of the
-- same YouTube short). The trigger function handles this via
-- EXCEPTION WHEN unique_violation; bulk INSERT can't.
--
-- Fix: DISTINCT ON (video_url) — enqueue ONE job per unique YT URL.
-- When the worker completes that one job, the trigger dedup gate
-- (status IN ('queued','processing','completed')) blocks future
-- duplicate enqueues for the other reels sharing that URL. The other
-- reels will pick up the SAME completed video_url through the
-- m7_2_mirror_all_video_posts mirroring (or whatever shared-URL
-- propagation mechanism the platform uses).
--
-- IDEMPOTENT: skips reels that already have queued/processing/completed jobs.

INSERT INTO video_transcode_jobs (
  reel_id, user_id, source_url, youtube_url, source_type,
  status, target_format, target_bitrate
)
SELECT DISTINCT ON (sr.video_url)
  sr.id, sr.author_id, sr.video_url, sr.video_url, 'youtube',
  'queued', 'h264_1080p', 2500000
FROM social_reels sr
WHERE sr.media_status = 'queued'
  AND sr.source_type = 'youtube'
  AND NOT EXISTS (
    SELECT 1 FROM video_transcode_jobs j
    WHERE j.youtube_url = sr.video_url
      AND j.status IN ('queued','processing','completed')
  )
ORDER BY sr.video_url, sr.created_at DESC;

-- Post-apply telemetry
DO $$
DECLARE
  jobs_queued_now int;
  unique_yt_urls int;
  total_queued_reels int;
BEGIN
  SELECT COUNT(*) INTO jobs_queued_now
  FROM video_transcode_jobs
  WHERE status = 'queued' AND source_type = 'youtube';

  SELECT COUNT(DISTINCT video_url) INTO unique_yt_urls
  FROM social_reels
  WHERE media_status = 'queued' AND source_type = 'youtube';

  SELECT COUNT(*) INTO total_queued_reels
  FROM social_reels
  WHERE media_status = 'queued' AND source_type = 'youtube';

  RAISE NOTICE 'backfill_v2 DONE: % YT jobs queued, % unique URLs across % queued reels',
    jobs_queued_now, unique_yt_urls, total_queued_reels;
END
$$;

