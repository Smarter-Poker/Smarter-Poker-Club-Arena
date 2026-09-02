-- PHASE 3 OF 6 - MULTI-DAY FLIGHT ADVANCEMENT
--
-- There is nothing to audit, and that is the finding. Multi-day does not
-- exist on this platform, and the phase's real work turned out to be the
-- guard that says so, which was covering half of what it needed to.
--
-- WHAT IS ACTUALLY THERE (measured 2026-09-02):
--
--   815 events carry is_xmtt = true, and is_xmtt DOES NOT MEAN MULTI-DAY.
--   It is set as `is_xmtt: !!schedule.union_id` - it means UNION event. I had
--   been reading it as a multi-day flag, and it is not one.
--
--   Across every tournament ever created on this platform:
--     parent_tournament_id ........ 0
--     survivors_advance_to ........ 0
--     flight_end_chips_snapshot ... 0
--     flight_number ............... 0
--     day_number > 1 .............. 0
--     total_days > 1 .............. 0
--
--   Nothing in the client, the engine or the database writes any of those five
--   structure columns. The only two functions that even mention them are
--   fn_generate_recurring_home_games (a local v_day_number for day-of-week, a
--   different table entirely) and fn_uncollected_entry_check, which READS them
--   for its day-2 exemption.
--
-- So no chips cross a flight boundary and no money crosses one, because there
-- are no flights. The 2026-08-26 work that replaced the lying "Multi-Day MTT"
-- toggle with "NOT AVAILABLE YET" and added
-- trg_tournaments_refuse_unbuilt_multi_day was correct and is still holding.
-- Verified live rather than taken from the comment, in a transaction that was
-- rolled back:
--
--     is_multi_day = true ... REFUSED, SQLSTATE 0A000
--     total_days   = 3 ...... REFUSED, SQLSTATE 0A000
--
-- THE PART THAT WAS WRONG. The same probe, on the same row, in the same
-- transaction:
--
--     day_number = 2 .................. NOT GUARDED
--     parent_tournament_id = ... ...... NOT GUARDED
--     survivors_advance_to = ... ...... NOT GUARDED
--     flight_number = 2 ............... NOT GUARDED
--     flight_end_chips_snapshot = ... . NOT GUARDED
--
-- The trigger fires on `UPDATE OF is_multi_day, total_days` - the two columns
-- that paint the LOBBY BADGE - and leaves open the five that would actually
-- STRUCTURE a flight. The badge is not the danger. A half-built flight is:
-- an event with a parent and a day number, no badge to warn anybody, and
-- nothing on the platform that advances a survivor or moves a pool.
--
-- AND IT WOULD HAVE REACHED INTO MY OWN WORK. fn_uncollected_entry_check
-- (Phase 2) exempts a seat from the was-this-entry-paid-for question when its
-- event looks like a day past the first. Setting `day_number = 2` - which
-- nothing refused until this migration - would have switched that exemption
-- on and excused seats from the check, for a Day 2 that does not exist.
--
-- A GUARD OVER HALF A FEATURE IS NOT HALF A GUARD. It is a gate on the front
-- door of a building with five open windows, and the label on the front door
-- is what makes everyone believe the building is locked.
--
-- WHEN DAY 2 IS BUILT: drop this trigger and its function in the same commit,
-- and delete the day-2 exemption's "unreachable by construction" note in
-- fn_uncollected_entry_check, because it will become reachable and correct.
--
-- ROLLBACK
--   CREATE OR REPLACE FUNCTION public.fn_tournaments_refuse_unbuilt_multi_day()
--   with only the is_multi_day / total_days test, and re-create the trigger as
--   BEFORE INSERT OR UPDATE OF is_multi_day, total_days.

CREATE OR REPLACE FUNCTION public.fn_tournaments_refuse_unbuilt_multi_day()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_field text := NULL;
BEGIN
  /* THE BADGE COLUMNS - what the lobby reads. These were already refused. */
  IF COALESCE(NEW.is_multi_day, false) IS TRUE THEN
    v_field := 'is_multi_day';
  ELSIF COALESCE(NEW.total_days, 1) > 1 THEN
    v_field := 'total_days';

  /* THE STRUCTURE COLUMNS - what would actually make a flight, and what was
     open until 2026-09-02. A row carrying these has no badge, so nothing warns
     anybody, and nothing on the platform advances a survivor or moves a pool
     between days. It would also switch on the day-2 exemption inside
     fn_uncollected_entry_check, excusing seats from the was-this-paid-for
     question on the strength of a Day 2 that does not exist. */
  ELSIF COALESCE(NEW.day_number, 1) > 1 THEN
    v_field := 'day_number';
  ELSIF NEW.parent_tournament_id IS NOT NULL THEN
    v_field := 'parent_tournament_id';
  ELSIF NEW.survivors_advance_to IS NOT NULL THEN
    v_field := 'survivors_advance_to';
  ELSIF NEW.flight_number IS NOT NULL THEN
    v_field := 'flight_number';
  ELSIF NEW.flight_end_chips_snapshot IS NOT NULL THEN
    v_field := 'flight_end_chips_snapshot';
  END IF;

  IF v_field IS NOT NULL THEN
    RAISE EXCEPTION
      'Multi day tournaments are not built yet (refused on %). There is no day '
      'end, no Day 2 resume and no flight merge, so this event would play down '
      'to a single winner in one session while the lobby promised otherwise, '
      'and a half built flight would excuse its seats from the uncollected '
      'entry check. Leave multi day off. Drop this trigger in the commit that '
      'implements Day 2.', v_field
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END
$function$;

/* The trigger must NAME the five new columns, or an UPDATE that touches only
   them never calls the function at all - which is exactly the hole this
   migration exists to close. */
DROP TRIGGER IF EXISTS trg_tournaments_refuse_unbuilt_multi_day ON public.tournaments;
CREATE TRIGGER trg_tournaments_refuse_unbuilt_multi_day
  BEFORE INSERT OR UPDATE OF
    is_multi_day, total_days,
    day_number, parent_tournament_id, survivors_advance_to,
    flight_number, flight_end_chips_snapshot
  ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_tournaments_refuse_unbuilt_multi_day();

COMMENT ON FUNCTION public.fn_tournaments_refuse_unbuilt_multi_day() IS
  'Refuses every column that would badge OR structure a multi-day event, until '
  'Day 2 is built. Widened 2026-09-02: the original covered is_multi_day and '
  'total_days only, leaving day_number, parent_tournament_id, '
  'survivors_advance_to, flight_number and flight_end_chips_snapshot open.';

-- ---------------------------------------------------------------------------
-- PROVE IT, ON A ROW WITH NO REGISTRANTS
-- ---------------------------------------------------------------------------
-- The first probe of this guard was contaminated and is worth recording: it
-- ran against a COMPLETED tournament, where the lifecycle lock ("cannot be
-- modified after a player has registered") refused the write FIRST and made a
-- guard that had never been exercised look like it was working. A row with no
-- registrants is the only honest place to test this one.

DO $$
DECLARE
  v_id uuid; v_state text; v_ok boolean; v_field text;
  v_fields text[] := ARRAY['is_multi_day','total_days','day_number',
                           'parent_tournament_id','survivors_advance_to',
                           'flight_number','flight_end_chips_snapshot'];
  v_sql text;
BEGIN
  SELECT t.id INTO v_id FROM public.tournaments t
   WHERE NOT EXISTS (SELECT 1 FROM public.tournament_players x WHERE x.tournament_id = t.id)
   ORDER BY t.created_at DESC LIMIT 1;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'no unregistered tournament to probe against; the guard is unverified';
  END IF;

  FOREACH v_field IN ARRAY v_fields LOOP
    v_sql := CASE v_field
      WHEN 'is_multi_day'              THEN 'UPDATE public.tournaments SET is_multi_day = true WHERE id = $1'
      WHEN 'total_days'                THEN 'UPDATE public.tournaments SET total_days = 3 WHERE id = $1'
      WHEN 'day_number'                THEN 'UPDATE public.tournaments SET day_number = 2 WHERE id = $1'
      WHEN 'parent_tournament_id'      THEN 'UPDATE public.tournaments SET parent_tournament_id = $1 WHERE id = $1'
      WHEN 'survivors_advance_to'      THEN 'UPDATE public.tournaments SET survivors_advance_to = $1 WHERE id = $1'
      WHEN 'flight_number'             THEN 'UPDATE public.tournaments SET flight_number = 2 WHERE id = $1'
      WHEN 'flight_end_chips_snapshot' THEN 'UPDATE public.tournaments SET flight_end_chips_snapshot = ''{"probe":1}''::jsonb WHERE id = $1'
    END;

    v_ok := false;
    BEGIN
      EXECUTE v_sql USING v_id;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      v_ok := (v_state = '0A000');
    END;

    IF NOT v_ok THEN
      RAISE EXCEPTION
        'the guard did not refuse %, so a flight can still be half built through it', v_field;
    END IF;
  END LOOP;

  RAISE NOTICE 'all seven multi-day columns refused with 0A000';
END $$;

-- ---------------------------------------------------------------------------
-- MEASURED AFTER APPLY, appended so everything above is what actually ran.
--
-- Applied to production as 20260902052302. Function body verified against
-- pg_proc.prosrc by md5: 428b31045fc54a32e6207a6c15200cf5, 1700 bytes.
--
-- THE RISK THIS CARRIED, and how it was checked rather than reasoned about.
-- This trigger fires BEFORE INSERT on a table the platform writes constantly,
-- so a non-null default on any of the five new columns would have broken
-- tournament creation everywhere. The defaults are day_number 1, total_days 1,
-- is_multi_day false and NULL for the other four, so a normal insert passes -
-- but the proof is the live rate, not the schema:
--
--   applied 05:23:02  ->  newest tournament created 05:23:25, 23 seconds later
--   36 tournaments created in the five minutes after, 65 registrations in three
