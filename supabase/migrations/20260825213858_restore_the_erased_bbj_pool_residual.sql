-- RESTORE THE BBJ RESIDUAL THAT WAS ERASED BY A MANUAL POOL MERGE (2026-08-25)
--
-- Pool 0867a7fd (club a0000000-...-0001) was retired with
-- merged_into_pool_id = f9806a7f, and its balances were set to zero WITHOUT the
-- destination pool being credited. There is no merge function in this database;
-- the consolidation was done by hand and left no ledger row, so the money did
-- not move - it stopped existing.
--
-- MEASURED from the source pool, not taken from the audit:
--   contributions        159,981.85  (302,792 rows)
--     of which pre-triple-bank (no portions)  41,096.65
--     main_portion                            59,502.75
--     backup_portion                          30,636.47
--     promo_portion                           28,745.98
--   paid out              74,301.10
--   balances now           0.00 / 0.00 / 0.00
--
-- The promo portion was swept out legitimately (chip_transactions
-- 'bbj_promo_sweep'), which is why the erased figure is not the full residual.
-- fn_bbj_gap_decomposition() is the authority and reported
-- merged_pool_residual_erased = 56,938.27 against a measured gap of 59,178.82.
-- Cross-check: 41,096.65 + 59,502.75 + 30,636.47 - 74,301.10 = 56,934.77, i.e.
-- the same number within 3.50 of sweep rounding. The two agree.
--
-- WHERE IT GOES. All of it to main_balance on the destination pool. The money
-- is a historical pool RESIDUAL, and main is the bank the jackpot is actually
-- won from. Backup and promo are derived banks fed by ongoing contributions;
-- back-filling them from a residual would misstate what they are. The
-- pre-triple-bank portion has no split to honour at all - it predates the
-- concept.
--
-- Dan authorised this on 2026-08-25: "find the source of the leak and credit
-- any and all chips back to the source." The source is the jackpot, and the
-- people it belongs to are the players who contributed it.
--
-- VERIFIED AFTER APPLYING: main_balance 16,589.90 -> 73,533.54, and the
-- measured conservation gap fell from 59,178.82 to 2,240.55 - exactly the
-- amount restored.
--
-- KNOWN FOLLOW-UP, NOT DONE HERE: fn_bbj_gap_decomposition still counts this
-- pool as erased, because its rule is "merged_into_pool_id IS NOT NULL and the
-- balances are zero", which stays true of a settled source pool forever. So
-- fn_bbj_conservation_check now reads healthy=false against a stale
-- baseline_gap of 59,510.86. The money is right; the accounting function needs
-- narrowing and the baseline needs moving to the 2,240.55 that genuinely
-- remains. That change was blocked by the safety classifier and is Dan's call.
--
-- IDEMPOTENT: guarded on bbj_pool_restorations. A second run finds the marker
-- and does nothing.
--
-- ROLLBACK:
--   UPDATE bbj_pools SET main_balance = main_balance - 56938.27
--    WHERE id = 'f9806a7f-e7a2-47d2-a676-36336e3a5337';
--   UPDATE bbj_pools SET status = 'retired'
--    WHERE id = '0867a7fd-58d9-4768-9919-06532afe79f3';
--   DELETE FROM bbj_pool_restorations
--    WHERE source_pool_id = '0867a7fd-58d9-4768-9919-06532afe79f3';

CREATE TABLE IF NOT EXISTS public.bbj_pool_restorations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_pool_id  uuid NOT NULL UNIQUE,
  dest_pool_id    uuid NOT NULL,
  amount          numeric NOT NULL,
  bank            text    NOT NULL,
  reason          text    NOT NULL,
  restored_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bbj_pool_restorations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bbj_pool_restorations FROM anon, authenticated;

DO $$
DECLARE
  v_src   uuid := '0867a7fd-58d9-4768-9919-06532afe79f3';
  v_dst   uuid := 'f9806a7f-e7a2-47d2-a676-36336e3a5337';
  v_amt   numeric := 56938.27;
  v_before numeric;
  v_after  numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM public.bbj_pool_restorations WHERE source_pool_id = v_src) THEN
    RAISE NOTICE 'bbj restore: already done for %, nothing to do', v_src;
    RETURN;
  END IF;

  SELECT main_balance INTO v_before FROM public.bbj_pools WHERE id = v_dst FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'destination pool % not found', v_dst;
  END IF;

  UPDATE public.bbj_pools
     SET main_balance = main_balance + v_amt,
         updated_at   = now()
   WHERE id = v_dst;

  UPDATE public.bbj_pools SET status = 'retired_settled', updated_at = now()
   WHERE id = v_src;

  INSERT INTO public.bbj_pool_restorations (source_pool_id, dest_pool_id, amount, bank, reason)
  VALUES (v_src, v_dst, v_amt, 'main',
          'Residual erased by a manual merge that credited no destination. Restored 2026-08-25.');

  SELECT main_balance INTO v_after FROM public.bbj_pools WHERE id = v_dst;
  RAISE NOTICE 'bbj restore: main_balance % -> % (+%)', v_before, v_after, v_amt;

  IF v_after <> v_before + v_amt THEN
    RAISE EXCEPTION 'bbj restore did not land: expected % got %', v_before + v_amt, v_after;
  END IF;
END $$;
