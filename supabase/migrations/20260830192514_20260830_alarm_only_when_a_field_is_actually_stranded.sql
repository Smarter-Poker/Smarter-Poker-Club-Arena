-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830192514; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- =====================================================================
-- THE ALARM MUST NOT CRY WOLF
-- =====================================================================
-- 20260830191330 made 'table_closed_under_live_tournament' able to write for
-- the first time. Within four minutes it had logged five events -- every one
-- of them seats_protected = 0.
--
-- Those are not incidents. A tournament consolidates as players bust: an empty
-- table closing under a RUNNING tournament is table balancing working
-- correctly. An alarm that fires on routine consolidation is one nobody reads,
-- which is precisely how the original alarm became worthless.
--
-- The signal worth waking someone for is a close that strands a SEATED field --
-- the 2026-08-30 shape, where 71 tables closed under 411 live players. So the
-- log now fires only when seats_protected > 0. The seat-protection logic itself
-- is unchanged and still runs for every close.
--
-- ROLLBACK: restore the function body from 20260830191330.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.fn_on_table_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_terminal_now  boolean;
    v_terminal_before boolean;
    v_tournament_live boolean := false;
    v_seats int;
BEGIN
    v_terminal_now := lower(coalesce(NEW.status,'')) IN ('closed','completed','cancelled','finished');
    v_terminal_before := lower(coalesce(OLD.status,'')) IN ('closed','completed','cancelled','finished');

    -- Read the TOURNAMENT's status, never the table's: the table's status is
    -- the column we are reacting to, and it is exactly the thing that has just
    -- been written by something we may not trust.
    IF NEW.tournament_id IS NOT NULL THEN
        SELECT upper(coalesce(t.status,'')) NOT IN ('COMPLETED','CANCELLED')
          INTO v_tournament_live
          FROM public.tournaments t
         WHERE t.id = NEW.tournament_id;
        v_tournament_live := coalesce(v_tournament_live, false);
    END IF;

    -- A table that has just closed releases its own seats -- unless the
    -- tournament it belongs to is still live, in which case the close is
    -- somebody else's mistake and the field plays on.
    IF v_terminal_now AND NOT v_terminal_before AND NOT v_tournament_live THEN
        UPDATE public.table_seats
           SET left_at = coalesce(NEW.updated_at, now())
         WHERE table_id = NEW.id
           AND left_at IS NULL;
    END IF;

    -- LOUD, but only when it means something: a close that strands players who
    -- are still seated. An empty table closing under a live tournament is
    -- ordinary consolidation and is deliberately not logged.
    IF v_terminal_now AND NOT v_terminal_before AND v_tournament_live THEN
        SELECT count(*)::int INTO v_seats
          FROM public.table_seats s
         WHERE s.table_id = NEW.id AND s.left_at IS NULL;

        IF v_seats > 0 THEN
            BEGIN
                INSERT INTO public.engine_recovery_events (table_id, event, detail, hand_count)
                VALUES (
                    NEW.id,
                    'table_closed_under_live_tournament',
                    jsonb_build_object(
                        'tournament_id', NEW.tournament_id,
                        'old_status', OLD.status,
                        'new_status', NEW.status,
                        'seats_protected', v_seats
                    )::text,
                    v_seats
                );
            EXCEPTION WHEN OTHERS THEN
                -- The log is a courtesy. It must never block a write.
                NULL;
            END;
        END IF;
    END IF;

    IF v_terminal_now <> v_terminal_before AND NEW.club_id IS NOT NULL THEN
        PERFORM public.fn_refresh_club_activity_counts(NEW.club_id);
    END IF;

    RETURN NEW;
END;
$function$;

-- Clear the five consolidation entries this alarm should never have made.
DELETE FROM public.engine_recovery_events
 WHERE event = 'table_closed_under_live_tournament'
   AND coalesce(hand_count, 0) = 0;

-- Self-test: a SEATED live table must still log, an EMPTY one must not.
DO $$
DECLARE v_seated uuid; v_logged int;
BEGIN
    SELECT t.id INTO v_seated
      FROM public.tables t
      JOIN public.tournaments tn ON tn.id = t.tournament_id
     WHERE upper(coalesce(tn.status,'')) = 'RUNNING'
       AND t.status = 'running'
       AND EXISTS (SELECT 1 FROM public.table_seats s
                    WHERE s.table_id = t.id AND s.left_at IS NULL)
     LIMIT 1;

    IF v_seated IS NULL THEN
        RAISE EXCEPTION 'No seated live tournament table available to self-test the alarm.';
    END IF;

    UPDATE public.tables SET status = 'closed' WHERE id = v_seated;

    SELECT count(*) INTO v_logged FROM public.engine_recovery_events
     WHERE table_id = v_seated AND event = 'table_closed_under_live_tournament';
    IF v_logged = 0 THEN
        RAISE EXCEPTION 'Alarm failed to fire on a STRANDED field - the signal is lost.';
    END IF;

    -- Revert the probe entirely.
    DELETE FROM public.engine_recovery_events
     WHERE table_id = v_seated AND event = 'table_closed_under_live_tournament';
    UPDATE public.tables SET status = 'running' WHERE id = v_seated;

    IF (SELECT count(*) FROM public.table_seats
         WHERE table_id = v_seated AND left_at IS NULL) = 0 THEN
        RAISE EXCEPTION 'Probe released seats on table % - the guard is not holding.', v_seated;
    END IF;

    RAISE NOTICE 'Alarm fires on a stranded field and stays quiet on consolidation; probe reverted.';
END $$;
