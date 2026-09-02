-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830202011; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- =====================================================================
-- THE ALARM MUST NAME THE CULPRIT
-- =====================================================================
-- An engine BOOT closes live tournament tables and strands their fields.
-- Reproduced exactly on 2026-08-30: a controlled restart at 20:00 produced 50
-- closes at 20:02-20:03 and nothing either side. Every resulting ghost seat was
-- truly stranded - the player had no other live seat in that tournament.
--
-- Every candidate path was read and every one is correctly guarded:
--   GameServer.ts:1698/1711   cash only (.is('tournament_id', null))
--   GameServer.ts:1984        orphan sweep, COMPLETED/CANCELLED only
--   TournamentManager.ts:204  table break, closes only after ALL players moved
--   fn_table_lifecycle_pass   excludes tournament tables throughout
-- and the engine does not log these closes, so reading code cannot settle it.
--
-- So the alarm now records WHO. `ca_seat_stack_exits` already does exactly this
-- for seat exits (DB role + application name); this brings the table-close
-- alarm up to the same standard. The next boot identifies its own culprit.
--
-- Captured, all cheap session-locals:
--   application_name  - PostgREST sets this per client; the engine, the World
--                       Hub lambdas and psql are distinguishable
--   db_role           - current_user / session_user (service_role vs authenticated)
--   client_addr       - which host issued it
--   txid              - groups a bulk close into one transaction, which
--                       separates "one statement hit 50 rows" from "50
--                       statements in a loop"
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

    -- A close releases the table's seats, UNLESS its tournament is still live,
    -- in which case the close is somebody else's mistake and the field plays on.
    IF v_terminal_now AND NOT v_terminal_before AND NOT v_tournament_live THEN
        UPDATE public.table_seats
           SET left_at = coalesce(NEW.updated_at, now())
         WHERE table_id = NEW.id
           AND left_at IS NULL;
    END IF;

    -- LOUD, and now NAMED. Only when the close strands players who are still
    -- seated; ordinary consolidation of an empty table is not an incident.
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
                        -- WHO did this
                        'application_name', coalesce(nullif(current_setting('application_name', true), ''), '(unset)'),
                        'db_role',          current_user,
                        'session_role',     session_user,
                        'client_addr',      coalesce(host(inet_client_addr()), '(local)'),
                        'txid',             txid_current()::text
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

-- Self-test: fire it on a real seated live table, confirm the new fields are
-- populated, then revert the probe completely.
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
