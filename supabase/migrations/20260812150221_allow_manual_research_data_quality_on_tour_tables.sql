-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812150221 "allow_manual_research_data_quality_on_tour_tables"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fa59e43bf5e1b437f52073dbd6be4d8f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Permit data_quality='manual_research' on tour_stop_events and poker_series.
--
-- WHY: the 2026-27 tour calendar (84 stops: WSOP Circuit, WPT, MSPT, RunGood,
-- PokerGO, Venetian and others) was compiled by reading each tour's OFFICIAL
-- published schedule and adversarially re-checking it, not by a scraper. Both
-- tables allowed only scraper vocabularies ('scraped_verified','stale',
-- 'expired' [,'pending']), so there was no truthful label for a hand-verified
-- row.
--
-- The tempting shortcut - stamping these 'scraped_verified' so they fit - was
-- explicitly rejected. That is a false provenance claim on 168 rows, and it is
-- the identical bug just corrected on venue_live_tables, where modelled
-- simulator output had been asserting it was a verified scrape. A constraint
-- should not be able to force code to lie about where data came from.
--
-- 'manual_research' is deliberately distinct from 'scraped_verified': these
-- rows are trustworthy but human-sourced, and anything auditing freshness or
-- automation coverage must be able to tell the two apart. Rows also carry
-- scrape_html_hash='phase7b-manual-research-20260808' and
-- source='phase7b-tour-research' so provenance is unambiguous from any angle.
--
-- Purely additive: every existing value stays legal, no row is rewritten.

ALTER TABLE public.tour_stop_events
  DROP CONSTRAINT IF EXISTS tour_stop_events_data_quality_check;
ALTER TABLE public.tour_stop_events
  ADD CONSTRAINT tour_stop_events_data_quality_check
  CHECK (data_quality = ANY (ARRAY['scraped_verified', 'stale', 'expired', 'pending', 'manual_research']));

ALTER TABLE public.poker_series
  DROP CONSTRAINT IF EXISTS chk_poker_series_data_quality;
ALTER TABLE public.poker_series
  ADD CONSTRAINT chk_poker_series_data_quality
  CHECK (data_quality = ANY (ARRAY['scraped_verified', 'stale', 'expired', 'manual_research']));

-- --- POST-APPLY ASSERTIONS --------------------------------------------
DO $postcheck$
DECLARE
    v_tse text;
    v_ps  text;
BEGIN
    SELECT pg_get_constraintdef(con.oid) INTO v_tse
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'tour_stop_events' AND con.conname = 'tour_stop_events_data_quality_check';

    SELECT pg_get_constraintdef(con.oid) INTO v_ps
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'poker_series' AND con.conname = 'chk_poker_series_data_quality';

    IF v_tse IS NULL OR v_ps IS NULL THEN
        RAISE EXCEPTION 'post-apply failed: a constraint is missing after rebuild';
    END IF;

    IF position('manual_research' in v_tse) = 0 OR position('manual_research' in v_ps) = 0 THEN
        RAISE EXCEPTION 'post-apply failed: manual_research not permitted (tse=%, ps=%)', v_tse, v_ps;
    END IF;

    -- Pre-existing vocabularies must survive, or live rows become illegal.
    IF position('scraped_verified' in v_tse) = 0 OR position('pending' in v_tse) = 0
       OR position('stale' in v_tse) = 0 OR position('expired' in v_tse) = 0 THEN
        RAISE EXCEPTION 'post-apply failed: tour_stop_events lost a value: %', v_tse;
    END IF;
    IF position('scraped_verified' in v_ps) = 0
       OR position('stale' in v_ps) = 0 OR position('expired' in v_ps) = 0 THEN
        RAISE EXCEPTION 'post-apply failed: poker_series lost a value: %', v_ps;
    END IF;

    -- Every existing row must still satisfy its constraint.
    IF EXISTS (SELECT 1 FROM public.tour_stop_events
                WHERE data_quality IS NOT NULL
                  AND data_quality <> ALL (ARRAY['scraped_verified','stale','expired','pending','manual_research'])) THEN
        RAISE EXCEPTION 'post-apply failed: existing tour_stop_events rows violate the new constraint';
    END IF;
END
$postcheck$;
