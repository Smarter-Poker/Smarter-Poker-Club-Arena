-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830035705; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- SECOND CORRECTION, same day. I was wrong twice about cash-outs and right
-- about the other two; this removes the cash-out trigger entirely.
--
-- HOW IT WAS FOUND. `pushQuietly` in club-arena src/services/CashoutService.ts
-- carries the comment "the in-app notification the RPC already wrote inside the
-- money transaction". My probe used raw UPDATEs, so it exercised my trigger and
-- never went near the RPCs, and it therefore could not see the collision. I
-- read the comment, doubted my own result, and asked the catalogue instead:
--
--   fn_cashout_approve        -> writes notifications, type 'cashout_approved'
--   fn_cashout_release        -> writes notifications, 'cashout_cancelled' / 'cashout_denied'
--   fn_cashout_request        -> writes notifications, 'cashout_request_escrow'
--   fn_expire_stale_cashouts  -> writes notifications, 'cashout_expired_refund'
--
-- `cashout_approved` and `cashout_cancelled` are EXACTLY the strings my trigger
-- emitted, so on the real RPC paths every player would have been told twice
-- that their money moved. The cash-out flow was never part of the #1498 gap: it
-- has been notifying correctly, server-side, inside the money transaction, all
-- along. The client's `pushQuietly` was a redundant courtesy on top of it, and
-- retiring OneSignal is what made that courtesy a no-op — not what broke
-- cash-out notifications.
--
-- WHAT REMAINS FROM 20260830_notify_money_flows_server_side:
--   trg_notify_dispute        — fn_resolve_dispute writes NO notification; checked.
--   trg_notify_credit_request — no RPC and no trigger wrote one; checked.
-- Those two are the real gap and they stay.
DROP TRIGGER IF EXISTS trg_notify_cashout ON public.cashout_requests;
DROP FUNCTION IF EXISTS public.fn_notify_cashout();

DO $$
DECLARE v_left int;
BEGIN
  SELECT count(*) INTO v_left FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.relname = 'cashout_requests' AND t.tgname = 'trg_notify_cashout';
  IF v_left > 0 THEN RAISE EXCEPTION 'trg_notify_cashout still present'; END IF;

  -- and the pre-existing agent notifier must survive untouched
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_notify_agent_on_cashout' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'tr_notify_agent_on_cashout was removed; that is the pre-existing agent notification';
  END IF;

  -- the two that ARE the gap must still be there
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_dispute' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'trg_notify_dispute missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_credit_request' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'trg_notify_credit_request missing'; END IF;
END $$;
