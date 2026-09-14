-- Execute once on a direct autocommit session with 3s lock and 120s statement deadlines.
-- Then apply the ledger migration, which requires this exact index to be valid.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_data_audit_video_scrape_latest
  ON public.data_audit_log (created_at DESC)
  WHERE table_name = 'video_library_videos' AND action = 'scrape';
