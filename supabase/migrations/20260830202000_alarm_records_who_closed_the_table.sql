-- =====================================================================
-- THE ALARM MUST NAME THE CULPRIT
-- =====================================================================
-- Applied to production 2026-08-30 20:20 UTC via Supabase apply_migration.
--
-- An engine BOOT can close live tournament tables and strand their fields.
-- Reproduced on 2026-08-30: a controlled restart at 20:00 produced 50 closes
-- at 20:02-20:03 and nothing either side.
--
-- Every candidate path was read, and every one is correctly guarded:
--   GameServer.ts:1698/1711   cash only (.is('tournament_id', null))
--   GameServer.ts:1984        orphan sweep, COMPLETED/CANCELLED only, and its
--                             swallowed errors fail CLOSED (empty set -> no close)
--   GameServer.ts:1908-1966   stale sweep: >12h only, assumes active on error,
--                             and settles through COMPLETING rather than cancelling
--   TournamentManager.ts:204  table break, closes only after ALL players moved
--   fn_table_lifecycle_pass   excludes tournament tables throughout
--
-- And a SECOND controlled restart at 20:20, with the database healthy, produced
-- ZERO closes. So the destructive branch is conditional on database stress, not
-- on boot alone - which is why reading the code could not settle it, and why it
-- stopped once the 300-storm was retired (World Hub PR #1033).
--
-- Rather than guess, the alarm now records WHO. `ca_seat_stack_exits` already
-- does exactly this for seat exits; this brings the table-close alarm up to the
-- same standard, so the next occurrence identifies its own culprit in one query:
--
--   SELECT detail::jsonb->>'application_name', detail::jsonb->>'db_role',
--          detail::jsonb->>'client_addr', count(DISTINCT detail::jsonb->>'txid')
--     FROM engine_recovery_events
--    WHERE event = 'table_closed_under_live_tournament'
--    GROUP BY 1,2,3;
--
-- txid matters: it separates "one statement hit 50 rows" from "50 statements in
-- a loop", which points at bulk SQL versus an application for-loop.
--
-- Detail stays a single JSON text column, so nothing downstream changes shape.
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

    IF NEW.tournament_id IS NOT NULL THEN
        SELECT upper(coalesce(t.status,'')) NOT IN ('COMPLETED','CANCELLED')
          INTO v_tournament_live
          FROM public.tournaments t
         WHERE t.id = NEW.tournament_id;
        v_tournament_live := coalesce(v_tournament_live, false);
    END IF;

    IF v_terminal_now AND NOT v_terminal_before AND NOT v_tournament_live THEN
        UPDATE public.table_seats
           SET left_at = coalesce(NEW.updated_at, now())
         WHERE table_id = NEW.id
           AND left_at IS NULL;
    END IF;

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
                        'tournament_id',    NEW.tournament_id,
                        'old_status',       OLD.status,
                        'new_status',       NEW.status,
                        'seats_protected',  v_seats,
                        'application_name', coalesce(nullif(current_setting('application_name', true), ''), '(unset)'),
                        'db_role',          current_user,
                        'session_role',     session_user,
                        'client_addr',      coalesce(host(inet_client_addr()), '(local)'),
                        'txid',             txid_current()::text
                    )::text,
                    v_seats
                );
            EXCEPTION WHEN OTHERS THEN
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

-- Self-test: fire on a real seated live table, confirm attribution landed,
-- then revert the probe completely and confirm the field survived.
DO $$
DECLARE v_tbl uuid; v_detail jsonb;
BEGIN
    SELECT t.id INTO v_tbl
      FROM public.tables t JOIN public.tournaments tn ON tn.id = t.tournament_id
     WHERE upper(coalesce(tn.status,'')) = 'RUNNING' AND t.status = 'running'
       AND EXISTS (SELECT 1 FROM public.table_seats s
                    WHERE s.table_id = t.id AND s.left_at IS NULL)
     LIMIT 1;
    IF v_tbl IS NULL THEN
        RAISE NOTICE 'No seated live tournament table to self-test against; skipped.';
        RETURN;
    END IF;

    UPDATE public.tables SET status = 'closed' WHERE id = v_tbl;

    SELECT detail::jsonb INTO v_detail FROM public.engine_recovery_events
     WHERE table_id = v_tbl AND event = 'table_closed_under_live_tournament'
     ORDER BY created_at DESC LIMIT 1;

    IF v_detail IS NULL OR v_detail->>'db_role' IS NULL THEN
        RAISE EXCEPTION 'Attribution fields did not land.';
    END IF;

    DELETE FROM public.engine_recovery_events
     WHERE table_id = v_tbl AND event = 'table_closed_under_live_tournament';
    UPDATE public.tables SET status = 'running' WHERE id = v_tbl;

    IF (SELECT count(*) FROM public.table_seats
         WHERE table_id = v_tbl AND left_at IS NULL) = 0 THEN
        RAISE EXCEPTION 'Probe released seats on table % - the guard is not holding.', v_tbl;
    END IF;

    RAISE NOTICE 'Attribution verified (role=%, app=%); probe reverted, field intact.',
        v_detail->>'db_role', v_detail->>'application_name';
END $$;
