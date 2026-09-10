/* A CLOSED TABLE CLOSES ITS SESSIONS (2026-09-10)

   cash_player_session carries a player's stay clock, baseline and rejoin
   window for one table. It is opened when they sit (fn_cash_session_open) and
   closed when they leave (fn_cash_session_close). Those two paths are correct.

   THE LEAK IS TABLE TEARDOWN. When a cash table closes, its seats are removed
   and its status becomes 'closed' - and nothing closes the sessions scoped to
   it. Measured 2026-09-10 01:05 UTC: 40 open sessions belong to players who
   hold no seat on that table; 38 of the 40 are on tables whose status is
   'closed', and 29 of those have no seat rows left at all. Over six hours 657
   sessions opened and 497 closed. They accumulate for as long as the platform
   runs.

   Those leftovers are what collides. A seat move re-points the player's live
   session to the destination, and cash_player_session_one_open is UNIQUE on
   (player, scope, table) WHERE open - so a leftover on the destination makes
   two open rows and the whole post-hand leave_pending step throws. The re-point
   was guarded earlier tonight; this closes the source that feeds it.

   THE FIX is a trigger on the authoritative event. When a table's status
   becomes 'closed', or it is marked deleted, every open session scoped to it is
   closed as 'table_closed' in the same transaction. No teardown path can
   forget, because the teardown IS the trigger. A seat move does not touch
   tables.status, so it cannot fire this. Tournament tables never have a
   cash_player_session (fn_cash_session_open returns NULL for them), so there
   is nothing for it to close there.

   'table_closed' is deliberately not routed through fn_cash_session_close:
   that path writes rejoin-window and VPIP-eviction bars for a player who LEFT.
   A player whose game ended under them did not leave, and gets no bar.

   The 40 already orphaned are closed here once, with the same reason, because
   their tables are already closed and the trigger cannot reach the past. That
   is a one-time correction shipped with its cause, not a repair job (10.12). */
DO $mig$
DECLARE v_before int; v_after int; v_closed int;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  SELECT count(*) INTO v_before FROM public.cash_player_session s
   WHERE s.closed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts
                      WHERE ts.user_id=s.player_id AND ts.table_id=s.scope_id AND ts.left_at IS NULL);

  CREATE OR REPLACE FUNCTION public.trg_fn_close_sessions_when_table_closes()
  RETURNS trigger LANGUAGE plpgsql SET search_path='public' AS $f$
  BEGIN
    /* A CLOSED TABLE CLOSES ITS SESSIONS (2026-09-10). See the migration of
       the same name. Fires on the transition INTO closed/deleted only, so a
       no-op status write on an already-closed table does nothing. */
    IF (NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed')
       OR (COALESCE(NEW.is_deleted,false) AND NOT COALESCE(OLD.is_deleted,false)) THEN
      UPDATE public.cash_player_session
         SET closed_at = clock_timestamp(), closed_reason = 'table_closed'
       WHERE scope_type = 'table' AND scope_id = NEW.id AND closed_at IS NULL;
    END IF;
    RETURN NEW;
  END $f$;

  DROP TRIGGER IF EXISTS zz_close_sessions_when_table_closes ON public.tables;
  CREATE TRIGGER zz_close_sessions_when_table_closes
    AFTER UPDATE OF status, is_deleted ON public.tables
    FOR EACH ROW EXECUTE FUNCTION public.trg_fn_close_sessions_when_table_closes();

  /* The unique index leads on player_id; give the trigger's own UPDATE a
     scope-led path over the open set so a table close never scans it. */
  CREATE INDEX IF NOT EXISTS cash_player_session_open_by_scope
    ON public.cash_player_session (scope_id) WHERE closed_at IS NULL;

  /* One-time correction of what teardown already left behind. */
  UPDATE public.cash_player_session s
     SET closed_at = clock_timestamp(), closed_reason = 'table_closed'
   WHERE s.closed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts
                      WHERE ts.user_id=s.player_id AND ts.table_id=s.scope_id AND ts.left_at IS NULL);
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  SELECT count(*) INTO v_after FROM public.cash_player_session s
   WHERE s.closed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts
                      WHERE ts.user_id=s.player_id AND ts.table_id=s.scope_id AND ts.left_at IS NULL);

  IF v_after <> 0 THEN
    RAISE EXCEPTION 'post-condition failed: % session(s) still open with no seat. Nothing written.', v_after;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='zz_close_sessions_when_table_closes'
                    AND tgrelid='public.tables'::regclass) THEN
    RAISE EXCEPTION 'post-condition failed: the trigger is not installed. Nothing written.';
  END IF;

  RAISE NOTICE 'orphaned sessions %->% (% closed as table_closed); trigger armed on tables', v_before, v_after, v_closed;
END $mig$;
