-- The online build must precede this transactional migration.
-- Source: scripts/ops/build-video-scrape-status-index-concurrently.sql.
-- Refuse a missing or different index; never block audit writers with a plain build.
SET lock_timeout = '3s';
SET statement_timeout = '5s';
DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.idx_data_audit_video_scrape_latest')
      AND i.indrelid = 'public.data_audit_log'::regclass
      AND i.indisvalid AND i.indisready
      AND pg_get_indexdef(i.indexrelid) = 'CREATE INDEX idx_data_audit_video_scrape_latest ON public.data_audit_log USING btree (created_at DESC) WHERE ((table_name = ''video_library_videos''::text) AND (action = ''scrape''::text))'
  ) THEN
    RAISE EXCEPTION 'Video scrape status index is absent, invalid or differs from the reviewed definition';
  END IF;
END
$proof$;
