-- ═══════════════════════════════════════════════════════════════════════════════
-- TABLE CHAT TTL — Auto-prune messages older than 48 hours
-- ═══════════════════════════════════════════════════════════════════════════════
-- Keeps the table_chat table lean by removing stale messages.
-- Run as a Supabase pg_cron job or manually via dashboard.

-- 1. Create the cleanup function
CREATE OR REPLACE FUNCTION cleanup_old_table_chat()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM table_chat
  WHERE created_at < NOW() - INTERVAL '48 hours';
END;
$$;

-- 2. Schedule via pg_cron (runs every 6 hours)
-- NOTE: pg_cron must be enabled in your Supabase project settings.
-- If pg_cron is not available, this can be called manually or via an edge function.
SELECT cron.schedule(
  'cleanup-table-chat',
  '0 */6 * * *',
  $$SELECT cleanup_old_table_chat()$$
);
