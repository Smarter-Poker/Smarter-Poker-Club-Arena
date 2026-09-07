-- DIAMOND ACCOUNTING STANDARD - REVIEW FIX 3 (2026-09-07)
-- The live Stripe refund handler is fn_diamond_purchase_refund (review fix 1). The World Hub
-- webhook calls it since PR fix/diamond-review-refund-path and falls back to the old name only
-- when the new one is missing, so the old name can go. CLAUDE.md 10.12 reads "reconcile" as a
-- repair arm; nothing named that way should describe a live path.
-- Apply ONLY after the World Hub serves the rename (curl https://smarter.poker/api/health and
-- confirm the sha includes that PR). No balance moves.
BEGIN;
SET LOCAL lock_timeout = '4s';
DROP FUNCTION IF EXISTS public.reconcile_diamond_purchase_refund(uuid, integer, integer);
DELETE FROM public.ca_money_rpc_registry WHERE proname = 'reconcile_diamond_purchase_refund';
DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'reconcile_diamond_purchase_refund') THEN
    RAISE EXCEPTION 'assert: the old refund name still exists';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_diamond_purchase_refund') THEN
    RAISE EXCEPTION 'assert: the refund handler is missing';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_diamond_purchase_dispute') LIKE '%reconcile_diamond_purchase_refund%' THEN
    RAISE EXCEPTION 'assert: the dispute RPC still calls the old name';
  END IF;
END $assert$;
COMMIT;
