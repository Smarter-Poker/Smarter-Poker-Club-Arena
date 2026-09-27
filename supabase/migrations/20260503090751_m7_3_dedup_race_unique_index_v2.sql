-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503090751 "m7_3_dedup_race_unique_index_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f5fe298474f5417294047c9e272443e4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- M7.3 v2: narrower unique index — only LIVE states (queued, processing).
-- The trigger already short-circuits when a completed job for the same URL
-- exists, so multiple completed jobs don't need DB-level enforcement.

-- Cancel any remaining live duplicates
WITH ranked AS (
  SELECT j.id AS job_id,
         ROW_NUMBER() OVER (PARTITION BY j.youtube_url ORDER BY j.created_at, j.id) AS rn
  FROM video_transcode_jobs j
  WHERE j.source_type='youtube' AND j.status IN ('queued','processing')
)
UPDATE video_transcode_jobs SET status='cancelled', completed_at=NOW(),
       error_message='cancelled_race_dup_m73v2'
WHERE id IN (SELECT job_id FROM ranked WHERE rn > 1);

-- Narrower partial unique index — live states only
CREATE UNIQUE INDEX IF NOT EXISTS uniq_video_transcode_jobs_yt_url_live
  ON video_transcode_jobs (youtube_url)
  WHERE source_type='youtube' AND status IN ('queued','processing');

-- Race-tolerant trigger
CREATE OR REPLACE FUNCTION fn_social_reels_yt_queue_job()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  IF NEW.source_type IS DISTINCT FROM 'youtube' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM video_transcode_jobs
             WHERE reel_id = NEW.id AND status IN ('queued','processing')) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM video_transcode_jobs j JOIN social_reels sr ON sr.id=j.reel_id
             WHERE sr.video_url = NEW.video_url AND j.status IN ('queued','processing','completed')) THEN
    RETURN NEW;
  END IF;
  BEGIN
    INSERT INTO video_transcode_jobs (
      reel_id, user_id, source_url, youtube_url, source_type,
      status, target_format, target_bitrate
    ) VALUES (NEW.id, NEW.author_id, NEW.video_url, NEW.video_url, 'youtube',
              'queued', 'h264_1080p', 2500000);
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RETURN NEW;
END;
$fn$;
