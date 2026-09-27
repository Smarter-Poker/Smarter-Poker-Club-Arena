-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819002850 "20260819_cashout_status_check_allow_rejected_and_expired"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b1d121ac5ca69179961f4f847ee54628 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- cashout_requests_status_check did not permit the statuses the code writes.
--
-- Allowed set was: pending, approved, cancelled, completed, completing,
-- cancelling. But:
--   fn_reject_cashout        writes 'rejected'
--   fn_expire_stale_cashouts writes 'expired'
--
-- Both therefore raised 23514 check_violation on EVERY call - the reject path
-- and the auto-expiry job could never complete. The expiry job is live
-- (CashoutService.ts:459), so the first stale request would have thrown.
--
-- Found by actually EXERCISING the path in a rolled-back probe rather than
-- reading the source: the escrow-refund probe failed with
--   new row for relation "cashout_requests" violates check constraint
--   "cashout_requests_status_check" ... (..., rejected, ...)
--
-- The code's state machine is the correct one - 'rejected' and 'expired' are
-- real terminal states a cashout must be able to reach - so the constraint is
-- what gets widened, not the code.
-- ============================================================================

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid='public.cashout_requests'::regclass
     AND conname='cashout_requests_status_check';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Pre-flight: cashout_requests_status_check not found.';
  END IF;
  IF v_def ~ 'rejected' AND v_def ~ 'expired' THEN
    RAISE EXCEPTION 'Pre-flight: constraint already allows rejected+expired - nothing to do.';
  END IF;
  RAISE NOTICE 'Pre-flight: widening %', v_def;
END $$;

ALTER TABLE public.cashout_requests
  DROP CONSTRAINT cashout_requests_status_check;

ALTER TABLE public.cashout_requests
  ADD CONSTRAINT cashout_requests_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'approved'::text,
    'rejected'::text,     -- fn_reject_cashout        (escrow refunded to player)
    'expired'::text,      -- fn_expire_stale_cashouts (escrow refunded to player)
    'cancelled'::text,
    'cancelling'::text,
    'completed'::text,
    'completing'::text
  ]));

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid='public.cashout_requests'::regclass
     AND conname='cashout_requests_status_check';

  IF v_def !~ 'rejected' THEN RAISE EXCEPTION 'Post-apply: rejected still not allowed.'; END IF;
  IF v_def !~ 'expired'  THEN RAISE EXCEPTION 'Post-apply: expired still not allowed.';  END IF;
  -- The pre-existing states must survive, or in-flight rows become unwritable.
  IF v_def !~ 'pending' OR v_def !~ 'approved' OR v_def !~ 'cancelled'
     OR v_def !~ 'completed' OR v_def !~ 'completing' OR v_def !~ 'cancelling' THEN
    RAISE EXCEPTION 'Post-apply: an original status was dropped: %', v_def;
  END IF;
  RAISE NOTICE 'Post-apply OK: %', v_def;
END $$;

-- ROLLBACK:
--   ALTER TABLE public.cashout_requests DROP CONSTRAINT cashout_requests_status_check;
--   ALTER TABLE public.cashout_requests ADD CONSTRAINT cashout_requests_status_check
--     CHECK (status = ANY (ARRAY['pending','approved','cancelled','completed','completing','cancelling']));
--   (reject + auto-expiry will hard-fail again)
