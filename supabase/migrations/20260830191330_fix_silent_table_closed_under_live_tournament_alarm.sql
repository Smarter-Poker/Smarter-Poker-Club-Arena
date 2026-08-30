-- =====================================================================
-- THE "LOUD" ALARM WAS SILENT (three defects, one alarm)
-- =====================================================================
-- Applied to production 2026-08-30 19:13 UTC via Supabase apply_migration.
--
-- fn_on_table_status_change logs 'table_closed_under_live_tournament' when a
-- close lands on a live tournament table. It could never write a single row:
--
--   1. it inserted into a column named `event_type`; the column is `event`
--   2. it inserted into a column named `details`;    the column is `detail`
--   3. engine_recovery_events_event_check allowed only four watchdog event
--      values, so even correctly-named columns would have been rejected
--
-- All three raised inside the function's own "the log is a courtesy"
-- EXCEPTION handler and were swallowed.
--
-- Consequence, measured 2026-08-30: the retired legacy engine closed 71 live
-- tournament tables carrying 411 seated players, the engine then discovered
-- zero tables and dealt ~0 hands, and the one alarm designed to make that
-- impossible to miss recorded nothing. The incident had to be found by reading
-- pg_stat_statements.
--
-- The seat-protection logic is unchanged. Only the alarm is repaired.
--
-- ROLLBACK: restore the four-value CHECK and the prior function body.
-- =====================================================================

ALTER TABLE public.engine_recovery_events
    DROP CONSTRAINT IF EXISTS engine_recovery_events_event_check;

ALTER TABLE public.engine_recovery_events
    ADD CONSTRAINT engine_recovery_events_event_check
    CHECK (event = ANY (ARRAY[
        'watchdog_rearm_clock'::text,
        'watchdog_forced_action'::text,
        'watchdog_kill_rebuild'::text,
        'paused_too_long'::text,
        'table_closed_under_live_tournament'::text
    ]));

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

    -- LOUD, because a close arriving at a live tournament table is always a
    -- bug somewhere upstream and the seats surviving must not hide it.
    IF v_terminal_now AND NOT v_terminal_before AND v_tournament_live THEN
        BEGIN
            SELECT count(*)::int INTO v_seats
              FROM public.table_seats s
             WHERE s.table_id = NEW.id AND s.left_at IS NULL;

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

    IF v_terminal_now <> v_terminal_before AND NEW.club_id IS NOT NULL THEN
        PERFORM public.fn_refresh_club_activity_counts(NEW.club_id);
    END IF;

    RETURN NEW;
END;
$function$;

-- Prove the alarm actually writes now, and leave nothing behind.
DO $$
DECLARE v_tbl uuid; v_logged int;
BEGIN
    SELECT t.id INTO v_tbl
      FROM public.tables t JOIN public.tournaments tn ON tn.id = t.tournament_id
     WHERE upper(coalesce(tn.status,'')) = 'RUNNING' AND t.status = 'running'
     LIMIT 1;

    IF v_tbl IS NULL THEN
        RAISE EXCEPTION 'No live tournament table available to self-test the alarm.';
    END IF;

    UPDATE public.tables SET status = 'closed' WHERE id = v_tbl;

    SELECT count(*) INTO v_logged
      FROM public.engine_recovery_events
     WHERE table_id = v_tbl AND event = 'table_closed_under_live_tournament';

    IF v_logged = 0 THEN
        RAISE EXCEPTION 'Alarm still silent after fix - insert did not land.';
    END IF;

    DELETE FROM public.engine_recovery_events
     WHERE table_id = v_tbl AND event = 'table_closed_under_live_tournament';
    UPDATE public.tables SET status = 'running' WHERE id = v_tbl;

    IF (SELECT count(*) FROM public.table_seats WHERE table_id = v_tbl AND left_at IS NULL) = 0 THEN
        RAISE EXCEPTION 'Probe released seats on table % - the live-tournament guard is not holding.', v_tbl;
    END IF;

    RAISE NOTICE 'Alarm verified firing on table %; probe reverted, field intact.', v_tbl;
END $$;
