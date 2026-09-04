-- THE PROMO METER'S BASELINE IS THE BALANCE, NOT A LABEL SEARCH.
--
-- 20260903215830 put the club promo float on the chip meter and rebaselined the
-- then-latest snapshot (21:05:01Z) so the change would not read as a one-time
-- swing. The rebaseline reconstructed the club promo balance as at that moment
-- by unwinding chip_ledger rows with to_label = 'clubs.promo_balance'. There are
-- none: fn_sweep_bbj_promo declares its counterparty and autoskips the clubs
-- trigger, so the sweep's journal row is written by the bbj_pools trigger as
-- bbj_pool -> promo_wallet, from_label 'bbj_pools.promo_balance', to_label NULL.
-- Only the pre-1.3 undeclared rows ever carried that label.
--
-- So the reconstruction found 0.00 of movement and stamped the balance as it
-- stood at migration time, 6,183.05, onto a snapshot taken 53 minutes earlier
-- when it was 5,955.77. The stored baseline is 227.28 too high, and the 22:05
-- snapshot's delta therefore understates the hour by exactly that: it reported
-- +117.44 where the club promo float actually grew by 227.28 on top of it.
--
-- Nothing is wrong with the meter going forward - both endpoints measure the
-- live balance from 22:05 on. This corrects the one bad baseline row and the one
-- interval computed against it, using the sweep transactions as the source of
-- truth rather than a label that was never written.
--
-- Telemetry only. No chips move.

DO $fix$
DECLARE
  v_base   public.ca_supply_snapshots%ROWTYPE;
  v_next   public.ca_supply_snapshots%ROWTYPE;
  v_swept  numeric;
  v_true   numeric;
  v_delta  numeric;
BEGIN
  SELECT * INTO v_base FROM public.ca_supply_snapshots
   WHERE taken_at = timestamptz '2026-09-03 21:05:01.185991+00';
  IF v_base.id IS NULL THEN
    RAISE NOTICE 'PROMO_BASELINE_FIX: the rebaselined snapshot is gone; nothing to correct';
    RETURN;
  END IF;

  SELECT * INTO v_next FROM public.ca_supply_snapshots
   WHERE taken_at > v_base.taken_at ORDER BY taken_at ASC LIMIT 1;
  IF v_next.id IS NULL THEN
    RAISE EXCEPTION 'PROMO_BASELINE_FIX: no later snapshot to reconcile against';
  END IF;

  -- What the club promo float took in between the two snapshots. The sweep is
  -- the only writer of clubs.promo_balance in this window, and it records every
  -- credit as a bbj_promo_sweep chip_transaction with its balance_after.
  SELECT round(COALESCE(sum(amount), 0), 2) INTO v_swept
    FROM public.chip_transactions
   WHERE transaction_type = 'bbj_promo_sweep'
     AND created_at >  v_base.taken_at
     AND created_at <= v_next.taken_at;

  v_true  := round(COALESCE(v_next.club_promo, 0) - v_swept, 2);
  v_delta := round(COALESCE(v_base.club_promo, 0) - v_true, 2);

  IF v_delta = 0 THEN
    RAISE NOTICE 'PROMO_BASELINE_FIX: baseline already correct at %', v_true;
    RETURN;
  END IF;

  -- Cross-check against the first sweep after the baseline: its balance_after
  -- less its own amount IS the float at that moment. If the two disagree by
  -- more than a cent, something else wrote the float and this correction is not
  -- safe to make blind.
  PERFORM 1 FROM (
    SELECT round(balance_after - amount, 2) AS before_first
      FROM public.chip_transactions
     WHERE transaction_type = 'bbj_promo_sweep'
       AND created_at >  v_base.taken_at
       AND created_at <= v_next.taken_at
       AND balance_after IS NOT NULL
     ORDER BY created_at ASC LIMIT 1) x
   WHERE abs(x.before_first - v_true) <= 0.01;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'PROMO_BASELINE_FIX: the sweep rows and the snapshot disagree about the club promo float at %; refusing to guess',
      v_base.taken_at;
  END IF;

  UPDATE public.ca_supply_snapshots
     SET club_promo = v_true,
         total      = total - v_delta
   WHERE id = v_base.id;

  UPDATE public.ca_supply_snapshots
     SET delta_vs_prev = delta_vs_prev + v_delta,
         unexplained   = unexplained   + v_delta
   WHERE id = v_next.id;

  RAISE NOTICE 'PROMO_BASELINE_FIX_OK: baseline club promo % -> %, interval % delta % -> %',
    v_base.club_promo, v_true, v_next.taken_at,
    v_next.delta_vs_prev, v_next.delta_vs_prev + v_delta;
END
$fix$;