-- #1498, the eighth and last dead call site: BLINDING OFF.
--
-- TournamentAutoSeat.tsx watched table_seats for is_sitting_out / is_away on a
-- tournament seat, showed an in-app banner, and fired
-- pushNotificationService.notifyBlindingOff() at a transport OneSignal's
-- retirement killed on 2026-08-19.
--
-- I previously called this one "engine-side, no DB transition to hang a trigger
-- on". That was wrong, and the client's own comment said so: "That flag on a
-- TOURNAMENT seat is the server's own statement that this player is paying to
-- not be there." It is a column transition on a table. That is a trigger.
--
-- Moving it server-side also fixes the thing the client version could never do:
-- somebody being blinded off is BY DEFINITION not looking at the app, so a
-- notification that only fires while the component is mounted is the one that
-- matters least.
--
-- VOLUME, measured before adding an eleventh trigger to a hot table: 2 sit-outs
-- in 24 hours platform-wide, 1 on a tournament seat. Rare, not a firehose.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5). No is_horse filter, deliberately, and
-- the assertion at the bottom fails the migration if one ever appears. A horse
-- blinding off is a seat paying blinds to not be there exactly like anyone
-- else. It has no browser, so push-dispatch skips it at the consent gate with
-- `no_subscription` the same way it would a human who never enrolled -- that is
-- the gate's decision, not this trigger's.
CREATE OR REPLACE FUNCTION public.fn_notify_blinding_off()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tournament_id uuid;
  v_name text;
  v_stack text := '';
BEGIN
  BEGIN
    IF NOT (COALESCE(NEW.is_sitting_out, false) OR COALESCE(NEW.is_away, false)) THEN RETURN NEW; END IF;
    IF (COALESCE(OLD.is_sitting_out, false) OR COALESCE(OLD.is_away, false)) THEN RETURN NEW; END IF;
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN RETURN NEW; END IF;

    -- Tournaments only. A cash seat that sits out simply stops being dealt in;
    -- it is not paying blinds to be absent, so there is nothing urgent to say.
    SELECT t.tournament_id INTO v_tournament_id FROM public.tables t WHERE t.id = NEW.table_id;
    IF v_tournament_id IS NULL THEN RETURN NEW; END IF;

    SELECT COALESCE(NULLIF(btrim(tn.name), ''), 'Your Tournament')
      INTO v_name FROM public.tournaments tn WHERE tn.id = v_tournament_id;
    v_name := COALESCE(v_name, 'Your Tournament');

    IF COALESCE(NEW.stack, 0) > 0 THEN
      v_stack := ' You have ' || to_char(round(NEW.stack), 'FM999,999,999,990') || ' chips left.';
    END IF;

    -- Copy verbatim from the retired notifyBlindingOff().
    PERFORM public.fn_raise_notification(
      NEW.user_id,
      'tournament_blinding_off',
      'You Are Being Blinded Off',
      'Your seat in ' || v_name || ' is posting blinds without you.' || v_stack || ' Tap to take your seat.',
      '/table/' || NEW.table_id::text,
      jsonb_build_object('tableId', NEW.table_id, 'tournamentId', v_tournament_id, 'action', 'blinding_off')
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_notify_blinding_off failed for seat %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_blinding_off ON public.table_seats;
CREATE TRIGGER trg_notify_blinding_off
  AFTER UPDATE OF is_sitting_out, is_away ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_notify_blinding_off();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_notify_blinding_off' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'trg_notify_blinding_off was not created'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='fn_notify_blinding_off' AND prosrc ILIKE '%is_horse%') THEN
    RAISE EXCEPTION 'fn_notify_blinding_off references is_horse; horses are players (CLAUDE.md 10.5)'; END IF;
END $$;
