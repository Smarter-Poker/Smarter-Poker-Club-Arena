-- CORRECTION 2, same day. I was wrong twice about cash-outs.
--
-- `pushQuietly` in src/services/CashoutService.ts says "the in-app notification
-- the RPC already wrote inside the money transaction". My probe used raw
-- UPDATEs, so it exercised my trigger and never went near the RPCs; it could
-- not see the collision. Asking the catalogue instead:
--
--   fn_cashout_approve       -> writes notifications, type 'cashout_approved'
--   fn_cashout_release       -> 'cashout_cancelled' / 'cashout_denied'
--   fn_cashout_request       -> 'cashout_request_escrow'
--   fn_expire_stale_cashouts -> 'cashout_expired_refund'
--
-- 'cashout_approved' and 'cashout_cancelled' are EXACTLY the strings my trigger
-- emitted, so on the real RPC paths every player would have been told twice
-- that their money moved.
--
-- Cash-outs were never part of the #1498 gap. They have been notifying
-- correctly, server-side, inside the money transaction, all along; retiring
-- OneSignal only made the client's redundant courtesy a no-op.
--
-- WHAT REMAINS AND WHY:
--   trg_notify_dispute        - fn_resolve_dispute writes no notification; checked.
--   trg_notify_credit_request - no RPC and no trigger wrote one; checked.
DROP TRIGGER IF EXISTS trg_notify_cashout ON public.cashout_requests;
DROP FUNCTION IF EXISTS public.fn_notify_cashout();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_cashout' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'trg_notify_cashout still present'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_notify_agent_on_cashout' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'tr_notify_agent_on_cashout was removed; that is the pre-existing agent notification'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_dispute' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'trg_notify_dispute missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_credit_request' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'trg_notify_credit_request missing'; END IF;
END $$;
