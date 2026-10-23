-- Dan 2026-10-22: "for the time being, only 10% of the bbj collected goes to
-- the main bbj, 30% to back up bbj and 60% to promo wallet."
--
-- ca_bbj_policy is the allocator's one source (fn_bbj_allocate reads it on
-- every raked hand). Both the standard and the pivot rows move to the same
-- 10 / 30 / 60, so the split no longer changes at the 100,000 pivot. Promo is
-- the remainder, as it always is, and is never stored as a rate.
-- The same night 20,000.00 moved from the Midway Union main bank to its promo
-- bank through fn_bbj_move_between_banks (ca_bbj_bucket_moves op_id
-- dan-2026-10-22-union-main-to-promo-20000).
-- Superseded the same night by 20261023030641, which keeps 10 / 30 / 60 for
-- the Midway Union pool only; the proof is that rule's row.
-- @live-proof: EXISTS (SELECT 1 FROM public.ca_bbj_pool_policy WHERE standard_main = 0.10 AND standard_backup = 0.30 AND pivot_main = 0.10 AND pivot_backup = 0.30)

UPDATE public.ca_bbj_policy
   SET standard_main = 0.10,
       standard_backup = 0.30,
       pivot_main = 0.10,
       pivot_backup = 0.30,
       note = 'Dan 2026-10-22: for the time being every drop is 10% main / 30% backup / 60% promo, below and above the 100,000 pivot alike. Promo is always the remainder. Mirrors server/src/config/RakeConfig.ts; the database is the allocator.',
       updated_at = now()
 WHERE id = 1;

-- Prove it against the allocator, not the table: a 10,000 drop on an empty and
-- on a pivoted main bank must both split 1,000 / 3,000 / 6,000.
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.fn_bbj_allocate(10000, 0);
  IF (r.main_portion, r.backup_portion, r.promo_portion) IS DISTINCT FROM (1000.00, 3000.00, 6000.00) THEN
    RAISE EXCEPTION 'standard split is %/%/%, expected 1000/3000/6000', r.main_portion, r.backup_portion, r.promo_portion;
  END IF;
  SELECT * INTO r FROM public.fn_bbj_allocate(10000, 1000000);
  IF (r.main_portion, r.backup_portion, r.promo_portion) IS DISTINCT FROM (1000.00, 3000.00, 6000.00) THEN
    RAISE EXCEPTION 'pivot split is %/%/%, expected 1000/3000/6000', r.main_portion, r.backup_portion, r.promo_portion;
  END IF;
END $$;
