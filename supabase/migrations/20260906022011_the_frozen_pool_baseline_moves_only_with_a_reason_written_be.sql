-- THE FROZEN POOL BASELINE MOVES ONLY WITH A REASON WRITTEN BESIDE IT.
--
-- fn_ca_quick_reconcile has paged CRITICAL every day since 2026-09-04 -
-- "the dead public.wallets pool changed by an amount no recorded deletion
-- explains" - at exactly -10,700.00 chips, the same figure every time. It is
-- right that it noticed and wrong about what it found.
--
-- WHAT MOVED. On 2026-09-03 at 23:43:27, migration 20260903234327 retired the
-- phantom promo pool: wallets(wallet_type='PROMO'), 107 holders, 10,700.00
-- chips written by create_user_wallets - an orphaned signup trigger handing out
-- a 100-chip welcome bonus into a pool no function in the database reads and
-- fn_ca_supply_snapshot has never counted. That migration zeroed the balances
-- under a one-statement guard override, wrote a financial_alerts row saying so,
-- and deliberately did NOT journal a burn, because a burn row would have told
-- the chip meter that 10,700 real chips left circulation when they had never
-- entered it. All of that is correct and none of it is undone here.
--
-- WHAT IT FORGOT. ca_frozen_pool_baseline still held the pre-retirement total,
-- 732,591,994.33, captured 2026-08-27. The 107 rows updated at 23:43:27.538927
-- are the whole difference, to the cent:
--
--   pre-freeze balances   732,581,294.03
--   recorded departures   +       0.30   (ca_frozen_pool_deletions)
--                         --------------
--                         732,581,294.33   vs baseline 732,591,994.33
--                                             = -10,700.00
--
-- WHY A NEW TABLE AND NOT A NEW NUMBER. Editing the baseline in place is how a
-- guard gets quietly disarmed: the next agent finds a number with no history
-- and cannot tell an authorised retirement from someone covering a leak. So the
-- baseline may still be moved, but only alongside a row that says who moved it,
-- by how much, and under which migration - and a trigger refuses any other
-- change. The guard keeps its full sensitivity: one unexplained chip in or out
-- of the dead pool still pages, immediately, as it should.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ca_frozen_pool_baseline_changes (
  id            bigserial PRIMARY KEY,
  pool          text        NOT NULL,
  amount        numeric     NOT NULL,          -- signed: the change to the baseline
  total_before  numeric     NOT NULL,
  total_after   numeric     NOT NULL,
  reason        text        NOT NULL,
  authorized_by text        NOT NULL,          -- the migration version that did it
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ca_frozen_pool_baseline_changes IS
  'Every movement of ca_frozen_pool_baseline, with the reason and the migration that authorised it. A baseline UPDATE without a matching row is refused.';

ALTER TABLE public.ca_frozen_pool_baseline_changes ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_ca_frozen_baseline_needs_a_reason()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the frozen pool baseline for % is not deleted; move it with a recorded reason', OLD.pool
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.frozen_total IS DISTINCT FROM OLD.frozen_total THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.ca_frozen_pool_baseline_changes c
       WHERE c.pool = NEW.pool
         AND c.total_before = OLD.frozen_total
         AND c.total_after  = NEW.frozen_total
         AND c.recorded_at > now() - interval '1 minute')
    THEN
      RAISE EXCEPTION 'the frozen pool baseline for % may not move from % to % without a row in ca_frozen_pool_baseline_changes written in the same transaction',
        NEW.pool, OLD.frozen_total, NEW.frozen_total USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS zz_ca_frozen_baseline_needs_a_reason ON public.ca_frozen_pool_baseline;
CREATE TRIGGER zz_ca_frozen_baseline_needs_a_reason
  BEFORE UPDATE OR DELETE ON public.ca_frozen_pool_baseline
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_frozen_baseline_needs_a_reason();

DO $move$
DECLARE
  v_before numeric; v_after numeric; v_now numeric; v_left numeric;
BEGIN
  SELECT frozen_total INTO v_before FROM public.ca_frozen_pool_baseline WHERE pool = 'public.wallets';
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'no frozen pool baseline row for public.wallets';
  END IF;
  IF v_before <> 732591994.33 THEN
    RAISE EXCEPTION 'baseline is % - expected 732591994.33; somebody already moved it', v_before;
  END IF;

  -- The measured pool, by the same arithmetic fn_ca_quick_reconcile uses.
  SELECT COALESCE(SUM(balance), 0) INTO v_now FROM public.wallets WHERE created_at < '2026-08-22';
  SELECT COALESCE(SUM(deleted_balance), 0) INTO v_left
    FROM public.ca_frozen_pool_deletions WHERE pool = 'public.wallets';
  v_after := round(v_now + v_left, 2);

  IF round(v_before - v_after, 2) <> 10700.00 THEN
    RAISE EXCEPTION 'the gap is % chips, not the 10,700.00 the phantom promo retirement explains', round(v_before - v_after, 2);
  END IF;

  -- And the 107 rows that carry it are the ones that migration touched.
  IF (SELECT count(*) FROM public.wallets
       WHERE created_at < '2026-08-22' AND updated_at > '2026-08-27'
         AND wallet_type = 'PROMO') <> 107 THEN
    RAISE EXCEPTION 'the 107 retired promo rows are not where 20260903234327 left them';
  END IF;

  INSERT INTO public.ca_frozen_pool_baseline_changes
    (pool, amount, total_before, total_after, reason, authorized_by)
  VALUES ('public.wallets', -10700.00, v_before, v_after,
    'Phantom promo pool retired: 107 holders, 10,700.00 chips written by the orphaned '
    || 'create_user_wallets welcome bonus into a pool nothing reads and the supply meter has '
    || 'never counted. Balances zeroed 2026-09-03 23:43:27 by migration 20260903234327 under an '
    || 'explicit one-statement guard override, with a financial_alerts row and no burn - the '
    || 'chips never entered circulation, so journalling a burn would have invented the same '
    || 'figure as issuance error. The baseline follows that authorised retirement; it is not '
    || 'forgiveness of a leak.',
    '20260906022011');

  UPDATE public.ca_frozen_pool_baseline
     SET frozen_total = v_after,
         note = note || ' | 2026-09-06: moved to ' || v_after
                || ' for the authorised phantom promo retirement (20260903234327). '
                || 'Every movement is recorded in ca_frozen_pool_baseline_changes and a '
                || 'movement without one is refused.'
   WHERE pool = 'public.wallets';

  RAISE NOTICE 'FROZEN_BASELINE_MOVED: % -> % (-10700.00, phantom promo retirement)', v_before, v_after;
END $move$;

-- The three critical alerts this raised are answered.
UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now(),
       resolution = 'verified: the -10,700.00 is the phantom promo pool retired on 2026-09-03 by '
                 || 'migration 20260903234327 - an authorised write-off of chips that were never '
                 || 'inside the measured supply. The baseline had not followed it. Moved to '
                 || '732,581,294.33 with its reason recorded in ca_frozen_pool_baseline_changes '
                 || 'by migration 20260906022011; the guard keeps full sensitivity.'
 WHERE source = 'drift_incident:fn_ca_quick_reconcile:frozen_pool'
   AND resolved IS NOT TRUE;

COMMIT;
