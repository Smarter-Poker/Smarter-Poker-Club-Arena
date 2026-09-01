-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830180715; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  A TABLE CLOSE CANNOT UNSEAT A LIVE TOURNAMENT FIELD (Dan 2026-08-30)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- On 2026-08-30 the 20K GTD Sunday $200 Deep Stack seated 111 players across
-- 13 tables, dealt 79 hands, and then stopped dead. Every player saw a felt
-- with seated opponents, no cards, no button, and the word "Spectating".
--
-- The chain: the RETIRED World Hub legacy engine (GameController._recoverTables)
-- claimed the 13 brand-new tournament tables because its recovery query took the
-- 100 most recently created open tables with no tournament filter. Ten minutes
-- later _cleanupStaleTables closed each one as "stale and empty" -- empty being
-- true only of the legacy engine's own in-memory Table object, which never holds
-- the real players. This trigger then did what it says on the tin and released
-- every seat on every closed table: 111 seats stamped between 17:21:16 and
-- 17:21:58, one table at a time. Club Arena's loadSeatedPlayers ends
-- `.is('left_at', null)`, so the deal loop found zero active players and parked
-- in idle_not_enough_players forever.
--
-- THE LEGACY ENGINE IS BEING SHUT OFF SEPARATELY. This migration exists because
-- that fix is one writer and this is the shared amplifier: EVERY path that can
-- set a table's status to closed -- an admin panel, auto-close-tables, a horse
-- fleet shutdown, a future one nobody has written yet -- reaches the whole
-- field through this trigger. A seat release should follow the GAME ending, not
-- a row's status column changing while the game is still being dealt.
--
-- WHAT CHANGES: exactly one condition. A table whose tournament is still live
-- keeps its seats. Everything else is untouched:
--
--   * a CASH table (tournament_id IS NULL) releases its seats exactly as before
--     -- that is the ordinary, correct behaviour and the vast majority of rows;
--   * a table belonging to a COMPLETED or CANCELLED tournament releases its
--     seats exactly as before;
--   * the tournament-finish path is unaffected and remains the right way to
--     empty a field -- trg_release_seats_on_tournament_finish and
--     fn_clear_table_seats fire on the tournament's own transition, which is
--     the event that genuinely means "these seats are over".
--
-- So this does not strand seats: it defers them to the ending that actually
-- ends the game. A tournament that finishes still clears every seat.
--
-- Table balancing is also unaffected -- it moves a player by writing left_at on
-- the specific seat row it is moving, never by closing a table underneath a
-- live field.

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
BEGIN
    v_terminal_now := lower(coalesce(NEW.status,'')) IN ('closed','completed','cancelled','finished');
    v_terminal_before := lower(coalesce(OLD.status,'')) IN ('closed','completed','cancelled','finished');

    -- Is this felt part of a tournament that is still being played? Read the
    -- TOURNAMENT's status, never the table's: the table's status is the column
    -- we are reacting to, and it is exactly the thing that has just been
    -- written by something we may not trust.
    IF NEW.tournament_id IS NOT NULL THEN
        SELECT upper(coalesce(t.status,'')) NOT IN ('COMPLETED','CANCELLED')
          INTO v_tournament_live
          FROM public.tournaments t
         WHERE t.id = NEW.tournament_id;
        v_tournament_live := coalesce(v_tournament_live, false);
    END IF;

    -- A table that has just closed releases its own seats. Stamped with the
    -- table's own update time rather than now(), so the seat's history says
    -- when the table ended, not when this trigger happened to run.
    --
    -- Unless the tournament it belongs to is still live, in which case the
    -- close is somebody else's mistake and the field plays on. The tournament's
    -- own finish trigger releases these seats when the game is genuinely over.
    IF v_terminal_now AND NOT v_terminal_before AND NOT v_tournament_live THEN
        UPDATE public.table_seats
           SET left_at = coalesce(NEW.updated_at, now())
         WHERE table_id = NEW.id
           AND left_at IS NULL;
    END IF;

    -- LOUD, because a close arriving at a live tournament table is always a
    -- bug somewhere upstream and the seats surviving must not hide it. Written
    -- to the existing recovery log rather than a new table so it shows up
    -- wherever engine incidents are already read.
    IF v_terminal_now AND NOT v_terminal_before AND v_tournament_live THEN
        BEGIN
            INSERT INTO public.engine_recovery_events (table_id, event_type, details)
            VALUES (
                NEW.id,
                'table_closed_under_live_tournament',
                jsonb_build_object(
                    'tournament_id', NEW.tournament_id,
                    'old_status', OLD.status,
                    'new_status', NEW.status,
                    'seats_protected', (
                        SELECT count(*) FROM public.table_seats s
                         WHERE s.table_id = NEW.id AND s.left_at IS NULL
                    )
                )
            );
        EXCEPTION WHEN OTHERS THEN
            -- The log is a courtesy. It must never be able to block a write, and
            -- must never be the reason a status change fails.
            NULL;
        END;
    END IF;

    -- Refresh the club's counters on any open/close transition.
    IF v_terminal_now <> v_terminal_before AND NEW.club_id IS NOT NULL THEN
        PERFORM public.fn_refresh_club_activity_counts(NEW.club_id);
    END IF;

    RETURN NEW;
END;
$function$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_on_table_status_change'
           AND tgrelid = 'public.tables'::regclass
    ) THEN
        RAISE EXCEPTION 'trg_on_table_status_change is missing from public.tables -- the guard has nothing to attach to';
    END IF;
END $$;
