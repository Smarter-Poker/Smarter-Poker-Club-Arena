-- ═══════════════════════════════════════════════════════════════════════════
--  #1498 — THE SIX FLOWS THAT BELIEVED THEY WERE NOTIFYING PEOPLE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG
-- ─────────────────────────────────────────────────────────────────────────
-- Eight call sites in the Club Arena client called
-- `pushNotificationService.sendToUser(...)`. That method relayed to a Supabase
-- edge function which relayed to OneSignal. OneSignal was retired on
-- 2026-08-19, so from that day every one of those calls delivered nothing,
-- returned `false`, and was never checked by its caller.
--
-- It cannot be fixed on the client, and that is by design. Verified against
-- production 2026-08-29: `notifications` has RLS enabled with exactly one
-- INSERT policy, `service_role` only; `push_outbox` grants the browser
-- nothing. The old edge function did no authorisation at all, so pointing it
-- at a live transport would have turned a dead relay into a spam and phishing
-- vector.
--
-- THE PATH THAT ACTUALLY WORKS
-- ─────────────────────────────────────────────────────────────────────────
--   INSERT INTO notifications
--     -> trg_mirror_notification_to_push_outbox  (already exists)
--     -> push_outbox
--     -> /api/cron/push-dispatch  (every minute, applies the consent gate)
--
-- So each flow raises its own notification from the trusted context that
-- performs the action. These are triggers on the three tables the actions
-- write, which is strictly better than the client call they replace: a
-- Commander approving a cash-out from the staff UI, an admin RPC, or a
-- back-office script all notify identically, because the notification is
-- attached to the state change rather than to one button.
--
-- ALL THREE TABLES ARE EMPTY (checked 2026-08-29: disputes 0, credit_requests
-- 0, cashout_requests 0). Nobody has been harmed yet, and nothing here has to
-- backfill. It means these features will notify correctly the first time they
-- are ever used, instead of silently not.
--
-- SAFETY PROPERTY THAT MATTERS MOST
-- ─────────────────────────────────────────────────────────────────────────
-- A notification must NEVER be able to roll back the money action that caused
-- it. Every trigger body is wrapped in its own BEGIN/EXCEPTION block that
-- swallows and RAISE WARNINGs. A failure to tell somebody about their cash-out
-- must not un-cash-out them.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- Helper: one place that knows how to raise a notification.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_raise_notification(
  p_user_id uuid,
  p_type    text,
  p_title   text,
  p_message text,
  p_link    text DEFAULT NULL,
  p_data    jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- No recipient, no notification. Silently, because a null here means the
  -- row genuinely has nobody to tell (an unassigned dispute, a cash-out with
  -- no agent) and that is not an error worth failing a money path over.
  IF p_user_id IS NULL OR p_title IS NULL OR btrim(p_title) = '' THEN
    RETURN;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, message, link, data)
  VALUES (p_user_id, p_type, p_title, p_message, p_link, COALESCE(p_data, '{}'::jsonb));
  -- trg_mirror_notification_to_push_outbox takes it from here.
END;
$$;

COMMENT ON FUNCTION public.fn_raise_notification IS
  'Raise an in-app notification from a trusted server context. The existing '
  'mirror trigger forwards it to push_outbox and /api/cron/push-dispatch '
  'applies the consent gate. Added 2026-08-30 for #1498.';

REVOKE ALL ON FUNCTION public.fn_raise_notification(uuid, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_raise_notification(uuid, text, text, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.fn_raise_notification(uuid, text, text, text, text, jsonb) FROM authenticated;

-- Display name for a user id, best effort. A missing profile must never stop
-- a notification: the copy degrades to "Someone" rather than not sending.
CREATE OR REPLACE FUNCTION public.fn_notify_display_name(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
           NULLIF(btrim(p.username), ''),
           NULLIF(btrim(p.full_name), ''),
           'Someone'
         )
  FROM public.profiles p
  WHERE p.id = p_user_id;
$$;

REVOKE ALL ON FUNCTION public.fn_notify_display_name(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_notify_display_name(uuid) FROM anon;

-- ───────────────────────────────────────────────────────────────────────────
-- DISPUTES
--   filed    -> the club owner        ("Settlement Dispute Filed")
--   resolved -> whoever filed it      ("Dispute Resolved")
-- Copy carried over verbatim from the dead client call sites in
-- src/services/DisputeService.ts so the intent is preserved exactly.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_notify_dispute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      SELECT c.owner_id INTO v_owner FROM public.clubs c WHERE c.id = NEW.club_id;
      PERFORM public.fn_raise_notification(
        v_owner,
        'settlement_dispute_filed',
        'Settlement Dispute Filed',
        COALESCE(NULLIF(btrim(NEW.submitter_name), ''), public.fn_notify_display_name(NEW.submitted_by))
          || ' disputed ' || to_char(COALESCE(NEW.amount, 0), 'FM999,999,999,990')
          || ' chips on ' || COALESCE(NEW.target_type, 'a settlement'),
        '/commander/disputes',
        jsonb_build_object('disputeId', NEW.id, 'clubId', NEW.club_id)
      );

    ELSIF TG_OP = 'UPDATE'
      AND NEW.status = 'resolved'
      AND OLD.status IS DISTINCT FROM NEW.status THEN
      PERFORM public.fn_raise_notification(
        NEW.submitted_by,
        'dispute_resolved',
        'Dispute Resolved',
        COALESCE(NULLIF(btrim(NEW.resolution), ''), 'Your dispute has been resolved'),
        '/wallet',
        jsonb_build_object('disputeId', NEW.id)
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Telling somebody about a dispute must never roll the dispute back.
    RAISE WARNING 'fn_notify_dispute failed for dispute %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_dispute ON public.disputes;
CREATE TRIGGER trg_notify_dispute
  AFTER INSERT OR UPDATE OF status ON public.disputes
  FOR EACH ROW EXECUTE FUNCTION public.fn_notify_dispute();

-- ───────────────────────────────────────────────────────────────────────────
-- CREDIT REQUESTS
--   raised   -> the approver   ("Credit Request")
--   approved -> the requester  ("Credit Line Increased")
--   denied   -> the requester  ("Credit Request Denied")
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_notify_credit_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      PERFORM public.fn_raise_notification(
        NEW.approver_id,
        'credit_request',
        'Credit Request',
        public.fn_notify_display_name(NEW.requester_id)
          || ' requested ' || to_char(COALESCE(NEW.requested_amount, 0), 'FM999,999,999,990')
          || ' chips credit',
        '/agent/credit-requests',
        jsonb_build_object('creditRequestId', NEW.id, 'clubId', NEW.club_id)
      );

    ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
      IF NEW.status = 'approved' THEN
        PERFORM public.fn_raise_notification(
          NEW.requester_id,
          'credit_approved',
          'Credit Line Increased',
          'Your credit line was raised to '
            || to_char(COALESCE(NEW.approved_amount, NEW.requested_amount, 0), 'FM999,999,999,990')
            || ' chips',
          '/wallet',
          jsonb_build_object('creditRequestId', NEW.id)
        );
      ELSIF NEW.status = 'denied' THEN
        PERFORM public.fn_raise_notification(
          NEW.requester_id,
          'credit_denied',
          'Credit Request Denied',
          COALESCE(NULLIF(btrim(NEW.reviewer_notes), ''), 'Your credit request was not approved'),
          '/wallet',
          jsonb_build_object('creditRequestId', NEW.id)
        );
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_notify_credit_request failed for request %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_credit_request ON public.credit_requests;
CREATE TRIGGER trg_notify_credit_request
  AFTER INSERT OR UPDATE OF status ON public.credit_requests
  FOR EACH ROW EXECUTE FUNCTION public.fn_notify_credit_request();

-- ───────────────────────────────────────────────────────────────────────────
-- CASHOUT REQUESTS  -> the player, on every terminal transition.
--
-- The status vocabulary is taken from the live CHECK constraint
-- (cashout_requests_status_check), not from memory:
--   pending, approved, rejected, expired, cancelled, cancelling,
--   completed, completing
-- The two -ing states are in-flight and deliberately silent; a player does not
-- need to be told twice that the same cash-out is happening.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_notify_cashout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amount text := to_char(COALESCE(NEW.amount, 0), 'FM999,999,999,990');
  v_title  text;
  v_body   text;
BEGIN
  BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
      CASE NEW.status
        WHEN 'approved'  THEN v_title := 'Cash-Out Approved';
                              v_body  := 'Your cash-out of ' || v_amount || ' chips was approved';
        WHEN 'completed' THEN v_title := 'Cash-Out Complete';
                              v_body  := v_amount || ' chips have been paid out';
        WHEN 'rejected'  THEN v_title := 'Cash-Out Declined';
                              v_body  := COALESCE(NULLIF(btrim(NEW.agent_note), ''),
                                                  'Your cash-out of ' || v_amount || ' chips was declined');
        WHEN 'expired'   THEN v_title := 'Cash-Out Expired';
                              v_body  := 'Your cash-out of ' || v_amount || ' chips expired before it was actioned';
        WHEN 'cancelled' THEN v_title := 'Cash-Out Cancelled';
                              v_body  := 'Your cash-out of ' || v_amount || ' chips was cancelled';
        ELSE v_title := NULL;  -- pending / cancelling / completing: in-flight, stay quiet
      END CASE;

      IF v_title IS NOT NULL THEN
        PERFORM public.fn_raise_notification(
          NEW.player_id, 'cashout_' || NEW.status, v_title, v_body, '/wallet',
          jsonb_build_object('cashoutRequestId', NEW.id, 'clubId', NEW.club_id)
        );
      END IF;

    ELSIF TG_OP = 'INSERT' AND NEW.agent_id IS NOT NULL THEN
      -- The agent has to action it, so the agent is the one who needs telling.
      PERFORM public.fn_raise_notification(
        NEW.agent_id,
        'cashout_requested',
        'Cash-Out Requested',
        public.fn_notify_display_name(NEW.player_id)
          || ' requested a cash-out of ' || v_amount || ' chips',
        '/commander/cashouts',
        jsonb_build_object('cashoutRequestId', NEW.id, 'clubId', NEW.club_id)
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_notify_cashout failed for cashout %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_cashout ON public.cashout_requests;
CREATE TRIGGER trg_notify_cashout
  AFTER INSERT OR UPDATE OF status ON public.cashout_requests
  FOR EACH ROW EXECUTE FUNCTION public.fn_notify_cashout();

-- ───────────────────────────────────────────────────────────────────────────
-- ASSERTIONS — this migration aborts if its own assumptions are wrong.
-- (supabase/migrations/.template.sql pattern, CLAUDE.md migration-safety.)
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_missing text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_dispute' AND NOT tgisinternal) THEN
    v_missing := v_missing || ' trg_notify_dispute'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_credit_request' AND NOT tgisinternal) THEN
    v_missing := v_missing || ' trg_notify_credit_request'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_cashout' AND NOT tgisinternal) THEN
    v_missing := v_missing || ' trg_notify_cashout'; END IF;

  -- The whole design rests on this one already existing. If it is ever
  -- dropped, these triggers write in-app rows that never become pushes, and
  -- that is exactly the kind of silent half-working state #1498 was about.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_mirror_notification_to_push_outbox' AND NOT tgisinternal
  ) THEN
    v_missing := v_missing || ' trg_mirror_notification_to_push_outbox(PRE-EXISTING)';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'notification wiring incomplete, missing:%', v_missing;
  END IF;
END $$;
