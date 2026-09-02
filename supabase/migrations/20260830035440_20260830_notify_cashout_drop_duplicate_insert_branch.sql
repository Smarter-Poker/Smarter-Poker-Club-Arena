-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830035440; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- CORRECTION to 20260830_notify_money_flows_server_side, same day, found by
-- probing the new triggers inside a rolled-back transaction before trusting
-- them (CLAUDE.md 11.5 — never spend real chips to test a rule).
--
-- The probe raised TWO notifications to the agent for one cash-out:
--   [cashout_request]   "💰 Cashout Request"  <- tr_notify_agent_on_cashout, PRE-EXISTING
--   [cashout_requested] "Cash-Out Requested"  <- fn_notify_cashout, mine
--
-- `tr_notify_agent_on_cashout` (AFTER INSERT WHEN status='pending') already
-- owned that event and has since before this work started. I did not check for
-- an existing notifier on the table before adding mine, and the only reason it
-- was caught is that the probe printed every row rather than asserting the ones
-- I expected.
--
-- The INSERT branch is removed and the trigger narrowed to UPDATE OF status.
-- The UPDATE branches stay: nothing on this platform told a player their
-- cash-out was approved, completed, declined, expired or cancelled, which is
-- the actual gap in #1498.
CREATE OR REPLACE FUNCTION public.fn_notify_cashout()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_amount text := to_char(COALESCE(NEW.amount, 0), 'FM999,999,999,990');
  v_title text; v_body text;
BEGIN
  BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
      CASE NEW.status
        WHEN 'approved'  THEN v_title := 'Cash-Out Approved';  v_body := 'Your cash-out of ' || v_amount || ' chips was approved';
        WHEN 'completed' THEN v_title := 'Cash-Out Complete';   v_body := v_amount || ' chips have been paid out';
        WHEN 'rejected'  THEN v_title := 'Cash-Out Declined';   v_body := COALESCE(NULLIF(btrim(NEW.agent_note), ''), 'Your cash-out of ' || v_amount || ' chips was declined');
        WHEN 'expired'   THEN v_title := 'Cash-Out Expired';    v_body := 'Your cash-out of ' || v_amount || ' chips expired before it was actioned';
        WHEN 'cancelled' THEN v_title := 'Cash-Out Cancelled';  v_body := 'Your cash-out of ' || v_amount || ' chips was cancelled';
        ELSE v_title := NULL;  -- pending / cancelling / completing are in-flight
      END CASE;

      IF v_title IS NOT NULL THEN
        PERFORM public.fn_raise_notification(
          NEW.player_id, 'cashout_' || NEW.status, v_title, v_body, '/wallet',
          jsonb_build_object('cashoutRequestId', NEW.id, 'clubId', NEW.club_id));
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_notify_cashout failed for cashout %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_cashout ON public.cashout_requests;
CREATE TRIGGER trg_notify_cashout AFTER UPDATE OF status ON public.cashout_requests
  FOR EACH ROW EXECUTE FUNCTION public.fn_notify_cashout();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'cashout_requests' AND t.tgname = 'trg_notify_cashout'
      AND pg_get_triggerdef(t.oid) ILIKE '%INSERT%'
  ) THEN
    RAISE EXCEPTION 'trg_notify_cashout still fires on INSERT; tr_notify_agent_on_cashout already owns that event';
  END IF;
END $$;
