-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830212532; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Wire fn_cashout_seats_for_closing_table into the two paths that were
-- releasing cash seats and keeping the chips.
--
-- Measured before this change: fn_unaccounted_seat_exits over 24 hours returned
-- 1,036 exits worth 432,100.90 chips, all on cash tables, all exit_kind='left'.
--
-- Both call sites keep every existing behaviour and gain one step: pay the
-- players BEFORE their seats are released. The refund runs first on purpose —
-- once left_at is set the seat is no longer selectable as active and the stack
-- is unreachable.
--
-- The tournament path is untouched. fn_cashout_seats_for_closing_table returns
-- immediately for a table with a tournament_id, because a tournament stack is
-- not wallet money and is settled by the payout structure.

-- 1. The status-change trigger.
CREATE OR REPLACE FUNCTION public.fn_on_table_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
        /* PAY BEFORE RELEASING (2026-08-30). This released the seats and kept
           the chips: 1,036 exits worth 432,100.90 chips in a single day, every
           one a cash table. The refund has to happen first — after left_at is
           set the seat is no longer active and the stack cannot be reached.
           No-ops for tournament tables. */
        PERFORM public.fn_cashout_seats_for_closing_table(
                  NEW.id, 'table ' || coalesce(NEW.status,'closed'));

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
$fn$;

-- 2. The direct clear.
CREATE OR REPLACE FUNCTION public.fn_clear_table_seats(
  p_table_id uuid,
  p_reopen   boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_cleared integer := 0;
BEGIN
  /* PAY BEFORE RELEASING — same rule, same reason as the status-change
     trigger. This function cleared a table's seats outright, so any cash
     player still sitting lost their stack. No-ops for tournament tables. */
  PERFORM public.fn_cashout_seats_for_closing_table(p_table_id, 'seats cleared');

  UPDATE public.table_seats
     SET left_at = now(), is_sitting_out = false
   WHERE table_id = p_table_id AND left_at IS NULL;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  UPDATE public.tables
     SET current_players = 0,
         status = CASE WHEN p_reopen AND status <> 'closed' THEN 'waiting' ELSE status END
   WHERE id = p_table_id;

  RETURN v_cleared;
END;
$fn$;
