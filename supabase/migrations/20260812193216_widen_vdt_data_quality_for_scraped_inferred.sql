-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812193216 "widen_vdt_data_quality_for_scraped_inferred"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3b954ec57eb0a94d88d8499bc3e978fe of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- venue_daily_tournaments: admit 'scraped_inferred'.
--
-- tournament-schedule-daemon.py deliberately distinguishes structured extractions
-- (__NEXT_DATA__ JSON, labelled buy-in fields) => 'scraped_verified'
-- from regex/heuristic block parses                => 'scraped_inferred'.
-- Nothing in the DB permitted the second value, so every heuristically parsed row
-- was rejected (P0001) and the daemon wrote 0 rows.
--
-- The vocabulary is widened rather than relabeling heuristic parses as
-- 'scraped_verified', which would make a regex guess claim the same confidence as
-- a structured extraction -- the same false-provenance shortcut refused for the
-- tour bundle on 2026-08-12 and for 'simulated' on venue_live_tables.

alter table public.venue_daily_tournaments
  drop constraint if exists check_data_quality_provenance;
alter table public.venue_daily_tournaments
  add constraint check_data_quality_provenance
  check (data_quality = any (array['scraped_verified','scraped_inferred','stale','expired','manual_research']));

alter table public.venue_daily_tournaments
  drop constraint if exists chk_venue_daily_tournaments_data_quality;
alter table public.venue_daily_tournaments
  add constraint chk_venue_daily_tournaments_data_quality
  check (data_quality = any (array['scraped_verified','scraped_inferred','stale','expired','manual_research']));

-- The BEFORE INSERT/UPDATE trigger hardcodes the same list and is evaluated
-- before the CHECK, so it must move too or the CHECK change is dead code.
create or replace function public.enforce_scrape_provenance()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
BEGIN
    IF NEW.scrape_html_hash IS NULL OR NEW.scrape_timestamp IS NULL THEN
        RAISE EXCEPTION 'CRITICAL VIOLATION: Cannot insert/update without scrape_html_hash and scrape_timestamp. (15-Layer Scrapling Web Scraper Integrity Standard)';
    END IF;

    -- 'manual_research'   = compiled from an official published schedule and
    --                       re-verified by hand. Attributed, but deliberately NOT
    --                       claiming to be a scrape.
    -- 'scraped_inferred'  = scraped, but extracted by regex/heuristic block parse
    --                       rather than a structured field. Lower confidence than
    --                       'scraped_verified' and must stay distinguishable from it.
    IF NEW.data_quality NOT IN ('scraped_verified', 'scraped_inferred', 'stale', 'expired', 'manual_research') THEN
        RAISE EXCEPTION 'CRITICAL VIOLATION: data_quality must be scraped_verified, scraped_inferred, stale, expired, or manual_research.';
    END IF;

    RETURN NEW;
END;
$function$;
