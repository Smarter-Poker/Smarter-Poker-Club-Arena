-- CORRECTION 1 to 20260830_notify_money_flows_server_side, same day.
--
-- Probing the new triggers inside a rolled-back transaction (CLAUDE.md 11.5)
-- raised TWO notifications to the agent for one cash-out:
--   [cashout_request]   "Cashout Request"   <- tr_notify_agent_on_cashout, PRE-EXISTING
--   [cashout_requested] "Cash-Out Requested" <- fn_notify_cashout, mine
--
-- I had not checked the table for an existing notifier before adding one. The
-- only reason it surfaced is that the probe printed every row rather than
-- asserting the rows I expected to see.
--
-- Superseded the same day by 20260830_drop_redundant_cashout_notify_trigger,
-- which removes the cash-out trigger entirely. Kept so the applied history in
-- supabase.migrations matches the files in this repo.
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
        ELSE v_title := NULL;
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
