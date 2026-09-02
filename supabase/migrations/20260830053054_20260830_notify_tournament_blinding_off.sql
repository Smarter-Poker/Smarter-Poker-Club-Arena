-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830053054; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  #1498, last call site: BLINDING OFF
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The eighth and final dead call site. TournamentAutoSeat.tsx watched
-- table_seats for is_sitting_out / is_away on a tournament seat, showed an
-- in-app banner, and fired pushNotificationService.notifyBlindingOff() at a
-- transport OneSignal's retirement killed on 2026-08-19.
--
-- I previously called this one "engine-side, no DB transition to hang a trigger
-- on". That was wrong, and the client's own comment says so:
--
--   "The engine flags a seat `is_sitting_out` after consecutive timeouts and
--    `is_away` on a disconnect, and it keeps taking that player's blinds and
--    antes either way. That flag on a TOURNAMENT seat is the server's own
--    statement that this player is paying to not be there."
--
-- It is a column transition on a table. That is exactly a trigger.
--
-- VOLUME, measured before adding an eleventh trigger to a hot table: 2 sit-outs
-- in the last 24 hours across the whole platform, 1 of them on a tournament
-- seat. This is a rare event, not a firehose.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5). There is deliberately NO is_horse filter
-- here. A horse that is blinding off is a seat paying blinds to not be there,
-- exactly like anyone else, and filtering them out of a notification a human
-- would get is the precise shape of bug that law exists to stop. A horse has no
-- browser and therefore no push subscription, so /api/cron/push-dispatch skips
-- it at the gate with `no_subscription` — the same way it would for a human who
-- never enrolled. That is the gate's decision to make, not this trigger's.
CREATE OR REPLACE FUNCTION public.fn_notify_blinding_off()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tournament_id uuid;
  v_name text;
  v_stack text := '';
BEGIN
  BEGIN
    -- Only the moment they GO away, never the moment they come back, and never
    -- a repeat while they stay away.
    IF NOT (COALESCE(NEW.is_sitting_out, false) OR COALESCE(NEW.is_away, false)) THEN
      RETURN NEW;
    END IF;
    IF (COALESCE(OLD.is_sitting_out, false) OR COALESCE(OLD.is_away, false)) THEN
      RETURN NEW;
    END IF;
    -- A seat they have already left is not blinding off.
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN NEW;
    END IF;

    -- Tournaments only. A cash seat that sits out simply stops being dealt in;
    -- it is not paying blinds to be absent, so there is nothing urgent to say.
    SELECT t.tournament_id INTO v_tournament_id FROM public.tables t WHERE t.id = NEW.table_id;
    IF v_tournament_id IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT COALESCE(NULLIF(btrim(tn.name), ''), 'Your Tournament')
      INTO v_name FROM public.tournaments tn WHERE tn.id = v_tournament_id;
    v_name := COALESCE(v_name, 'Your Tournament');

    IF COALESCE(NEW.stack, 0) > 0 THEN
      v_stack := ' You have ' || to_char(round(NEW.stack), 'FM999,999,999,990') || ' chips left.';
    END IF;

    -- Copy carried over verbatim from notifyBlindingOff() so the intent that
    -- was already written and reviewed is preserved exactly.
    PERFORM public.fn_raise_notification(
      NEW.user_id,
      'tournament_blinding_off',
      'You Are Being Blinded Off',
      'Your seat in ' || v_name || ' is posting blinds without you.' || v_stack || ' Tap to take your seat.',
      '/table/' || NEW.table_id::text,
      jsonb_build_object('tableId', NEW.table_id, 'tournamentId', v_tournament_id, 'action', 'blinding_off')
    );
  EXCEPTION WHEN OTHERS THEN
    -- Never let a notification interfere with the engine writing a seat.
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
  -- No is_horse anywhere in this function. CLAUDE.md 10.5.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='fn_notify_blinding_off' AND prosrc ILIKE '%is_horse%') THEN
    RAISE EXCEPTION 'fn_notify_blinding_off references is_horse; horses are players (CLAUDE.md 10.5)'; END IF;
END $$;
