-- ===========================================================================
-- LANE D, second half: A DIAMOND BALANCE CANNOT GO NEGATIVE
-- Diamond Accounting Standard DR1 / D13. Companion to
-- `20260903003327_diamond_d_purchase_clearing.sql`, applied immediately after
-- it and never before it.
-- ===========================================================================
--
-- WHY THIS IS ITS OWN MIGRATION
--
-- The first attempt put this ALTER at the end of the Lane D migration. That
-- transaction already held its lock on `diamond_purchases` and then asked for
-- ACCESS EXCLUSIVE on `profiles`; a live session holding `profiles` and
-- waiting on `auth.users` was on the other side of it, and Postgres killed the
-- migration with `40P01: deadlock detected`. Nothing was applied - the whole
-- transaction rolled back, verified afterwards (0 new tables, 0 new indexes,
-- 0 registered migration rows).
--
-- `profiles` is the hottest table on the platform: 1,308 rows touched by every
-- login, every signup trigger, every seat and every balance write. The swarm
-- brief already rules that a hot-table change gets its own migration. This is
-- that migration, and it does exactly one thing, so the ACCESS EXCLUSIVE
-- window is a few milliseconds and it holds no other table's lock while it
-- waits.
--
-- WHY THE ORDER MATTERS
--
-- `20260903040000` rewrites `reconcile_diamond_purchase_refund` so it clamps
-- its clawback at the balance and books the remainder in `diamond_debts`. That
-- has to land FIRST. If the constraint existed while the old function was
-- still live, a chargeback larger than a player's balance would raise 23514 in
-- the Stripe webhook instead of being processed, Stripe would retry it
-- forever, and the refund would never complete. Function first, constraint
-- second: there is no window in which a live refund can be refused.
--
-- WHY VALIDATE IS SAFE HERE
--
-- Measured on 2026-09-03 before writing this file: 0 of 1,308 profiles hold a
-- negative `diamonds` value, and 0 hold NULL. Every function in `pg_proc` that
-- subtracts from `profiles.diamonds` was read and is guarded:
--
--   transfer_diamonds_deduct      WHERE ... AND diamonds >= deduct_amount
--   send_stream_gift              WHERE ... AND diamonds >= p_amount
--   send_wallet_diamond_transfer  WHERE ... AND diamonds >= p_amount
--   deduct_diamonds               SELECT ... FOR UPDATE, then a pre-check that
--                                 cannot race because the row is locked
--   fn_atomic_buyin               same shape
--   fn_purchase_time_banks        same shape (and separately broken: it writes
--                                 to a `reason` column that does not exist, so
--                                 every call already raises 42703; Lane A owns
--                                 that repair)
--
-- The only unguarded negative writer was `reconcile_diamond_purchase_refund`,
-- which the companion migration fixed. So this constraint cannot turn a
-- currently-succeeding call into a 23514; it closes the one door that was open.
--
-- VALIDATE takes SHARE UPDATE EXCLUSIVE and scans 1,308 rows, which is
-- instant. With `lock_timeout` at 4s a contended attempt fails cleanly and
-- this file can simply be applied again.
--
-- ROLLBACK
--   ALTER TABLE public.profiles DROP CONSTRAINT profiles_diamonds_nonnegative;
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '4s';

DO $preflight$
DECLARE v_neg integer; v_refund_fixed boolean;
BEGIN
  SELECT count(*) INTO v_neg FROM public.profiles WHERE diamonds < 0;
  IF v_neg > 0 THEN
    RAISE EXCEPTION 'ABORT: % profiles hold a negative diamond balance. Those are money and are Dan''s to resolve, not a migration''s.', v_neg;
  END IF;

  SELECT prosrc LIKE '%diamond_debts%' INTO v_refund_fixed
    FROM pg_proc
   WHERE proname = 'reconcile_diamond_purchase_refund'
     AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_refund_fixed, false) THEN
    RAISE EXCEPTION 'ABORT: reconcile_diamond_purchase_refund still writes negatives. Apply 20260903003327_diamond_d_purchase_clearing first; this constraint must never exist while that function does.';
  END IF;

  RAISE NOTICE 'Pre-flight clean: 0 negative diamond balances, and the refund path already books debts instead of negatives.';
END;
$preflight$;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_diamonds_nonnegative;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_diamonds_nonnegative CHECK (diamonds >= 0) NOT VALID;
ALTER TABLE public.profiles
  VALIDATE CONSTRAINT profiles_diamonds_nonnegative;

COMMENT ON CONSTRAINT profiles_diamonds_nonnegative ON public.profiles IS
  'DR1 / D13. A diamond balance is never negative. A chargeback larger than the balance books the remainder in diamond_debts. Every other subtractor of profiles.diamonds was read at pg_proc on 2026-09-03 and is guarded, either by a WHERE ... AND diamonds >= amount or by a pre-check under FOR UPDATE.';

DO $assert$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.profiles'::regclass
     AND conname = 'profiles_diamonds_nonnegative'
     AND contype = 'c' AND convalidated;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'ASSERT FAILED: profiles_diamonds_nonnegative is not present and validated';
  END IF;
  RAISE NOTICE 'profiles_diamonds_nonnegative is present and validated.';
END;
$assert$;

COMMIT;
