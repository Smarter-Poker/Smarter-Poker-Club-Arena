-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821034733 "release_seats_on_table_close_and_maintain_club_counts"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d06c5729f95bccb758c405b3811da7a5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- TIER 2. Two related problems with one cause: nothing reacts to a table
-- closing.
--
-- 1. SEAT LEAK. On 2026-08-20 there were 1,427 seats with left_at IS NULL
--    attached to tables whose status was already closed — 185 real users
--    marked "seated" at tables that ended two days earlier. That backlog has
--    since been cleared, so this is the RECURRENCE fix, not the cleanup: a
--    table entering a terminal state now releases its own seats, in the same
--    transaction, instead of leaving them for someone to notice later.
--
-- 2. DEAD COLUMNS. clubs.active_players and clubs.active_tables are 0 for
--    every club on the platform and nothing has ever maintained them. They are
--    the obvious names for the number the club cards show, sitting permanently
--    wrong, waiting for someone to wire a card to them. Either they carry a
--    real number or they should not exist; this makes them real.
--
-- ON VOLUME: the counts are refreshed when a TABLE opens or closes, not on
-- every seat change. Seat churn is what got the realtime listener removed in
-- 2026-07 ("for write volume") and a per-seat trigger would reintroduce
-- exactly that. So these columns are accurate at table boundaries and can lag
-- mid-session by design. fn_batch_active_player_counts stays the authority for
-- anything live, and the comment on the columns says so.

CREATE OR REPLACE FUNCTION public.fn_refresh_club_activity_counts(p_club_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
    UPDATE public.clubs c
       SET active_tables = sub.live_tables,
           active_players = sub.live_players
      FROM (
        SELECT cl.id AS club_id,
               count(DISTINCT t.id) FILTER (
                 WHERE lower(coalesce(t.status,'')) NOT IN ('closed','completed','cancelled','finished')
               ) AS live_tables,
               count(DISTINCT ts.user_id) FILTER (
                 WHERE ts.left_at IS NULL
                   AND coalesce(ts.is_away,false) = false
                   AND lower(coalesce(t.status,'')) NOT IN ('closed','completed','cancelled','finished')
               ) AS live_players
          FROM public.clubs cl
          LEFT JOIN public.tables t ON t.club_id = cl.id
          LEFT JOIN public.table_seats ts ON ts.table_id = t.id
         WHERE p_club_id IS NULL OR cl.id = p_club_id
         GROUP BY cl.id
      ) sub
     WHERE c.id = sub.club_id;
$function$;

COMMENT ON FUNCTION public.fn_refresh_club_activity_counts(uuid) IS
    'Recomputes clubs.active_players / active_tables. Called when a table opens or closes. NOT live to the second — fn_batch_active_player_counts is the authority for a current number.';

CREATE OR REPLACE FUNCTION public.fn_on_table_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_terminal_now  boolean;
    v_terminal_before boolean;
BEGIN
    v_terminal_now := lower(coalesce(NEW.status,'')) IN ('closed','completed','cancelled','finished');
    v_terminal_before := lower(coalesce(OLD.status,'')) IN ('closed','completed','cancelled','finished');

    -- A table that has just closed releases its own seats. Stamped with the
    -- table's own update time rather than now(), so the seat's history says
    -- when the table ended, not when this trigger happened to run.
    IF v_terminal_now AND NOT v_terminal_before THEN
        UPDATE public.table_seats
           SET left_at = coalesce(NEW.updated_at, now())
         WHERE table_id = NEW.id
           AND left_at IS NULL;
    END IF;

    -- Refresh the club's counters on any open/close transition.
    IF v_terminal_now <> v_terminal_before AND NEW.club_id IS NOT NULL THEN
        PERFORM public.fn_refresh_club_activity_counts(NEW.club_id);
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_on_table_status_change ON public.tables;
CREATE TRIGGER trg_on_table_status_change
    AFTER UPDATE OF status ON public.tables
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION public.fn_on_table_status_change();

-- Backfill every club once, so the columns stop being zero immediately.
SELECT public.fn_refresh_club_activity_counts(NULL);

DO $$
DECLARE
    leaked integer;
    zeroed integer;
BEGIN
    SELECT count(*) INTO leaked
      FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
     WHERE ts.left_at IS NULL
       AND lower(coalesce(t.status,'')) IN ('closed','completed','cancelled','finished');
    IF leaked > 0 THEN
        RAISE EXCEPTION 'post-apply failed: % seat(s) still open on closed tables', leaked;
    END IF;

    SELECT count(*) INTO zeroed FROM public.clubs
     WHERE active_players IS NULL OR active_tables IS NULL;
    IF zeroed > 0 THEN
        RAISE EXCEPTION 'post-apply failed: % club(s) left with null activity counts', zeroed;
    END IF;
END $$;
