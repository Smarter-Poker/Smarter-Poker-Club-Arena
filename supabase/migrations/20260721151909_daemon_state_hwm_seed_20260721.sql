-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721151909 "daemon_state_hwm_seed_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4a539573492dead331de69c93778d41c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Seed the RakebackSettler watermark to ~1h ago so the first run after this
-- deploy processes only recently-unsettled records instead of re-scanning the
-- full 7-day fallback window (which would re-increment player_stats once). The
-- settler runs every 30 min, so 1 hour of lookback safely covers anything not
-- yet settled at deploy time.
INSERT INTO public.daemon_state (daemon, high_water_mark)
VALUES ('rakeback_settler', now() - interval '1 hour')
ON CONFLICT (daemon) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.daemon_state WHERE daemon='rakeback_settler') THEN
    RAISE EXCEPTION 'rakeback_settler watermark not seeded';
  END IF;
END $$;
