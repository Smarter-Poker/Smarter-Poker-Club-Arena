-- The five-cent tolerance, applied on its own a few minutes after
-- 20260901140000, and folded into that file so it reads as one change. The
-- function body there is byte-identical to what this apply left in production
-- (md5 c8c2e7eca158e7278967a0be875c8147, 8810 bytes, checked 2026-09-01), so
-- rather than repeat 180 lines here, this file records WHY it exists and what
-- else it did.
--
-- WHY. fn_payout_guarantee_check compares what a place is worth against what
-- the holder's wallet received, and it computed "worth" as the flat
-- pool * percentage. The engine allocates in whole cents and gives the last
-- paid place the remainder, so a place can legitimately land a cent or two off
-- that figure. The first live run reported the ninth place of a $100 Freeroll
-- as short by 0.02 and it was not short. One cent of tolerance became five.
-- A player paid nothing still trips the check at any tolerance.
--
-- WHAT ELSE. The alerts already raised on that false positive, and the fifteen
-- vacant-place alerts that migration 20260901133441 had just repaired, are
-- resolved here rather than left standing against work that is done.

UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now()
 WHERE source = 'fn_payout_guarantee_check'
   AND resolved IS NOT TRUE
   AND (context->>'kind' = 'vacant_paid_place'
        OR (context->>'kind' = 'earner_not_paid'
            AND (context->>'short')::numeric <= 0.05));
