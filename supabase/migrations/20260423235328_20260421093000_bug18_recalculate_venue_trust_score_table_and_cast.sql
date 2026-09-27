-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423235328 "20260421093000_bug18_recalculate_venue_trust_score_table_and_cast"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d282bcc162d166e6be059e77f826182f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-18: recalculate_venue_trust_score has two drift issues:
--   1) Targets `public.venues` (which has id uuid, no trust_score column)
--      but the real trust_score lives on `public.poker_venues` (id integer).
--   2) Parameter p_venue_id is text but both join columns
--      (venue_reviews.venue_id, poker_venues.id) are integer — missing
--      explicit ::integer casts cause 42883.
--
-- Impact: trust score never updates when a venue gets a new review. The
-- Poker Near Me ranking that reads poker_venues.trust_score silently
-- shows stale scores. Not money-impacting but a discovery quality bug.
--
-- Fix: target poker_venues + add integer casts. Keep signature text for
-- backward compatibility with any app caller that passes the venue id
-- as a string (e.g. from a URL param).

CREATE OR REPLACE FUNCTION public.recalculate_venue_trust_score(p_venue_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_avg   numeric;
  v_count integer;
  v_vid   integer;
BEGIN
  -- Reject if the caller passed a non-integer string (defensive)
  BEGIN
    v_vid := p_venue_id::integer;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'INVALID_VENUE_ID'
          USING HINT = 'p_venue_id must parse as integer';
  END;

  SELECT AVG(rating)::numeric(3,2), COUNT(*)
    INTO v_avg, v_count
    FROM public.venue_reviews
   WHERE venue_id = v_vid;

  -- Only update if there are reviews (preserve old trust_score for zero-review venues)
  IF v_count > 0 THEN
    UPDATE public.poker_venues
       SET trust_score = v_avg
     WHERE id = v_vid;
  END IF;
END;
$function$;
