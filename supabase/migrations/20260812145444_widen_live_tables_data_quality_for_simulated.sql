-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812145444 "widen_live_tables_data_quality_for_simulated"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 956d85816894886e08a9d463fc0a1a2c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Widen venue_live_tables.data_quality to permit 'simulated'.
--
-- WHY: every row the Bravo simulator publishes is MODELLED from weeks of
-- historical observations - no page is fetched, and scrape_html_hash is
-- deliberately NULL to say so. The CHECK constraint offered no honest value,
-- so the daemon was forced to stamp 'scraped_verified' on all of them. Any
-- query, export or partner integration trusting that column was being told a
-- modelled number was observed.
--
-- scripts/bravo-simulator-daemon.py already writes 'simulated' and detects a
-- CHECK rejection (SQLSTATE 23514), downgrading once per process and
-- pre-relabelling every remaining chunk so no rows are lost. It is currently
-- running in that fallback mode; this migration lets it use the honest label.
--
-- NO API CHANGE REQUIRED: verified across pages/api that nothing filters
-- venue_live_tables on data_quality. Every .eq('data_quality',
-- 'scraped_verified') targets venue_daily_tournaments, a different table.
-- live-tables.js derives simulated-ness from scrape_batch_id LIKE 'sim-%'
-- and already publishes data_mode='estimated', so the user-facing surface is
-- already honest; this fixes the storage layer to match it.
--
-- Purely additive: no existing row changes, nothing is dropped.

ALTER TABLE public.venue_live_tables
  DROP CONSTRAINT IF EXISTS venue_live_tables_data_quality_check;

ALTER TABLE public.venue_live_tables
  ADD CONSTRAINT venue_live_tables_data_quality_check
  CHECK (data_quality = ANY (ARRAY['scraped_verified', 'stale', 'expired', 'simulated']));

-- --- POST-APPLY ASSERTIONS --------------------------------------------
DO $postcheck$
DECLARE
    v_def text;
BEGIN
    SELECT pg_get_constraintdef(con.oid) INTO v_def
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'venue_live_tables'
       AND con.conname = 'venue_live_tables_data_quality_check';

    IF v_def IS NULL THEN
        RAISE EXCEPTION 'post-apply failed: constraint missing after rebuild';
    END IF;

    -- The honest label must now be accepted.
    IF position('simulated' in v_def) = 0 THEN
        RAISE EXCEPTION 'post-apply failed: simulated not permitted: %', v_def;
    END IF;

    -- The existing labels must survive - dropping one would reject live rows.
    IF position('scraped_verified' in v_def) = 0
       OR position('stale' in v_def) = 0
       OR position('expired' in v_def) = 0 THEN
        RAISE EXCEPTION 'post-apply failed: an existing label was lost: %', v_def;
    END IF;
END
$postcheck$;
