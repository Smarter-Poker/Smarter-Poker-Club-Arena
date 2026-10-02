-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503081630 "social_posts_video_to_reel_mirror"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e77bbf0574d3eff9719e3c1981292a07 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ════════════════════════════════════════════════════════════════════════════
-- M6: social_posts → social_reels auto-mirror trigger + bulk backfill
-- ════════════════════════════════════════════════════════════════════════════
--
-- The Reels.jsx feed pulls from social_posts directly (limit 20 per load),
-- but my YouTube → native MP4 pipeline only acts on social_reels. Result:
-- 10,271 public horse-posted YouTube videos appear in the Reels feed as
-- raw YouTube iframes, which is exactly the latency bug Operation TikTok
-- Reels was meant to fix.
--
-- This migration:
--   1. Adds a trigger on social_posts that auto-creates a social_reels
--      mirror whenever a video post with a YouTube URL is inserted.
--   2. Backfills 10,271 mirrors for the existing public video posts.
--   3. The existing trigger on social_reels (trg_social_reels_yt_intercept
--      + trg_social_reels_yt_queue_job) then automatically tags each
--      mirror and queues a conversion job in video_transcode_jobs.
--
-- After this runs, the worker has ~10K new jobs in queue. At 3-way
-- concurrency that's ~85h drain. Bump MAX_CONCURRENT_YT to 6 in
-- /etc/sp-yt-transcode.env to halve it (handoff covers this).
--
-- Dedup gotcha: until the worker rewrites BOTH social_reels.video_url AND
-- social_posts.media_urls[0] to the new Supabase URL, the same content
-- can appear twice in the Reels feed (once via social_reels with native
-- URL, once via social_posts with YouTube URL — different video_urls,
-- both pass the URL-set dedup). The worker code change is in the M6
-- handoff to fix that. Until that ships, M4 player still renders both
-- correctly (each as its own slot), just with cosmetic duplication.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Trigger on social_posts ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_social_posts_video_to_reel_mirror()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_first_url TEXT;
  v_thumb     TEXT;
BEGIN
  -- Only act on video posts
  IF NEW.content_type IS DISTINCT FROM 'video' THEN RETURN NEW; END IF;

  -- Extract first media URL (jsonb array → text)
  IF NEW.media_urls IS NULL OR jsonb_typeof(NEW.media_urls) <> 'array' OR jsonb_array_length(NEW.media_urls) = 0 THEN
    RETURN NEW;
  END IF;
  v_first_url := NEW.media_urls->>0;
  IF v_first_url IS NULL THEN RETURN NEW; END IF;

  -- Only YouTube URLs need a reel mirror for conversion. Native Supabase
  -- URLs already work fine in the existing HEVC pipeline path (which
  -- back-props to social_reels via source_post_id).
  IF v_first_url NOT ILIKE '%youtube.com%' AND v_first_url NOT ILIKE '%youtu.be%' THEN
    RETURN NEW;
  END IF;

  -- Idempotent: skip if a reel mirror already exists
  IF EXISTS (SELECT 1 FROM social_reels WHERE source_post_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  v_thumb := NEW.thumbnail_url;

  -- Create the mirror. The existing trg_social_reels_yt_intercept BEFORE
  -- INSERT trigger will tag this row with source_type='youtube',
  -- media_status='queued', etc. The AFTER INSERT trigger then queues a
  -- conversion job.
  INSERT INTO social_reels (
    author_id, video_url, thumbnail_url, caption, source_post_id, is_public
  ) VALUES (
    NEW.author_id, v_first_url, v_thumb, NEW.content, NEW.id, COALESCE(NEW.visibility = 'public', true)
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block social_posts insert because the mirror failed
  RAISE WARNING 'fn_social_posts_video_to_reel_mirror skipped post % (%)', NEW.id, SQLERRM;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_social_posts_video_to_reel_mirror ON social_posts;
CREATE TRIGGER trg_social_posts_video_to_reel_mirror
  AFTER INSERT ON social_posts
  FOR EACH ROW
  EXECUTE FUNCTION fn_social_posts_video_to_reel_mirror();

-- ─── 2. Bulk backfill: mirror every existing public video post ──────────────
-- One row per missing mirror. The reels triggers fire row-by-row, queueing
-- conversion jobs. ~10K rows → ~20K trigger fires → handles fine in PG.
INSERT INTO social_reels (author_id, video_url, thumbnail_url, caption, source_post_id, is_public)
SELECT
  sp.author_id,
  sp.media_urls->>0,
  sp.thumbnail_url,
  sp.content,
  sp.id,
  true
FROM social_posts sp
WHERE sp.visibility = 'public'
  AND sp.content_type = 'video'
  AND (
    (sp.media_urls->>0) ILIKE '%youtube.com%'
    OR (sp.media_urls->>0) ILIKE '%youtu.be%'
  )
  AND NOT EXISTS (SELECT 1 FROM social_reels sr WHERE sr.source_post_id = sp.id);

-- ─── 3. Verify counts ───────────────────────────────────────────────────────
DO $do$
DECLARE
  v_total_mirrors INT;
  v_total_jobs    INT;
BEGIN
  SELECT COUNT(*) INTO v_total_mirrors
  FROM social_reels WHERE source_type='youtube';

  SELECT COUNT(*) INTO v_total_jobs
  FROM video_transcode_jobs WHERE source_type='youtube' AND status='queued';

  RAISE NOTICE 'YouTube reel mirrors: %', v_total_mirrors;
  RAISE NOTICE 'Conversion jobs queued: %', v_total_jobs;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_social_posts_video_to_reel_mirror') THEN
    RAISE EXCEPTION 'social_posts mirror trigger not installed';
  END IF;
END $do$;
