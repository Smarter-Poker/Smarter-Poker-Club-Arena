-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812151203 "provenance_trigger_admits_manual_research"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 948a99f37898dd20d74855384d7ec983 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- enforce_scrape_provenance(): admit 'manual_research' alongside the scraper
-- vocabulary, so the trigger stops contradicting the CHECK constraints it
-- duplicates.
--
-- WHY: migration allow_manual_research_data_quality_on_tour_tables widened the
-- CHECK on poker_series, but the widening was DEAD CODE - this BEFORE INSERT
-- trigger hardcodes the same three-value list and rejects the row before the
-- CHECK is ever evaluated. tour_stop_events has no such trigger, which is why
-- the tour-stop inserts succeeded and the series inserts did not.
--
-- The guard's real purpose is "no unattributed data", and that is PRESERVED
-- exactly: the scrape_html_hash / scrape_timestamp requirement above is
-- untouched, and every row this admits carries both
-- (scrape_html_hash='phase7b-manual-research-20260808', scrape_timestamp=now())
-- plus source and source_url. What was wrong was equating "attributed" with
-- "scraped": the 2026-27 tour calendar was compiled from each tour's OFFICIAL
-- published schedule and adversarially re-checked. Forcing those rows to claim
-- 'scraped_verified' to satisfy the guard would make the guard the CAUSE of a
-- false provenance claim - the same failure just corrected on
-- venue_live_tables, where modelled simulator output asserted it was verified.
--
-- Attached to: charity_events_schedule, poker_events, poker_series,
-- poker_tour_series_events, tournament_series, venue_daily_tournaments.
-- This only ADDS a permitted value; nothing previously legal becomes illegal,
-- and no existing row is rewritten.

CREATE OR REPLACE FUNCTION public.enforce_scrape_provenance()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    IF NEW.scrape_html_hash IS NULL OR NEW.scrape_timestamp IS NULL THEN
        RAISE EXCEPTION 'CRITICAL VIOLATION: Cannot insert/update without scrape_html_hash and scrape_timestamp. (15-Layer Scrapling Web Scraper Integrity Standard)';
    END IF;

    -- 'manual_research' = compiled from an official published schedule and
    -- re-verified by hand. Attributed, but deliberately NOT claiming to be a
    -- scrape, so freshness and automation-coverage audits can tell them apart.
    IF NEW.data_quality NOT IN ('scraped_verified', 'stale', 'expired', 'manual_research') THEN
        RAISE EXCEPTION 'CRITICAL VIOLATION: data_quality must be scraped_verified, stale, expired, or manual_research.';
    END IF;

    RETURN NEW;
END;
$function$;

-- --- POST-APPLY ASSERTIONS --------------------------------------------
DO $postcheck$
DECLARE
    v_src text;
BEGIN
    SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'enforce_scrape_provenance';

    IF v_src IS NULL THEN
        RAISE EXCEPTION 'post-apply failed: enforce_scrape_provenance missing';
    END IF;

    -- The new value must be admitted.
    IF position('manual_research' in v_src) = 0 THEN
        RAISE EXCEPTION 'post-apply failed: manual_research not admitted by the trigger';
    END IF;

    -- The attribution guard must NOT have been weakened - this is the part
    -- that actually stops junk data, and it is the reason the trigger exists.
    IF position('scrape_html_hash IS NULL' in v_src) = 0
       OR position('scrape_timestamp IS NULL' in v_src) = 0 THEN
        RAISE EXCEPTION 'post-apply failed: the hash/timestamp attribution guard was lost';
    END IF;

    -- The original vocabulary must still be accepted.
    IF position('scraped_verified' in v_src) = 0
       OR position('stale' in v_src) = 0
       OR position('expired' in v_src) = 0 THEN
        RAISE EXCEPTION 'post-apply failed: an existing data_quality value was dropped';
    END IF;

    -- The trigger must still be attached where it was.
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname = 'poker_series' AND NOT t.tgisinternal
           AND t.tgfoid = 'public.enforce_scrape_provenance()'::regprocedure
    ) THEN
        RAISE EXCEPTION 'post-apply failed: trigger no longer attached to poker_series';
    END IF;
END
$postcheck$;
