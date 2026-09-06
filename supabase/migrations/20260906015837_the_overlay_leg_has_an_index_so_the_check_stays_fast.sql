-- THE OVERLAY LEG HAS AN INDEX, SO THE CHECK STAYS FAST.
--
-- 20260906015217 taught fn_tournament_conservation_delta to read the guarantee
-- overlay out of chip_ledger. Every other table that function touches is
-- indexed for exactly the lookup it does - rake_records by tournament_id,
-- tournament_payouts by tournament_id, wallet_transactions by
-- (related_entity_id, category) - and chip_ledger, at 1.68M rows, had no index
-- on tournament_id at all. So the new term turned one cheap lookup into a full
-- scan, once per tournament, and fn_tournament_money_conservation - which calls
-- the delta up to a thousand times in its auto-resolve pass alone - timed out
-- on its first run after the change. Caught before the nightly ran; the fix
-- ships in the same hour as the cause.
--
-- The index is deliberately narrow: only the overlay legs into prize_liability,
-- which is 187 rows out of 1.68M, carrying the amount so the subquery never
-- touches the heap. It answers the new term exactly and costs almost nothing to
-- keep.
--
-- CONCURRENTLY, and therefore outside a transaction. chip_ledger is the
-- journal: every money write on the platform appends to it, so a plain CREATE
-- INDEX would hold a lock that refuses buy-ins, payouts and settlements for the
-- length of the build. This is the one migration in the programme that is not
-- wrapped in BEGIN/COMMIT, and it is not wrapped for that reason.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_overlay_by_tournament
  ON public.chip_ledger (tournament_id)
  INCLUDE (amount)
  WHERE tournament_id IS NOT NULL
    AND category = 'overlay'
    AND to_type = 'prize_liability';

COMMENT ON INDEX public.idx_chip_ledger_overlay_by_tournament IS
  'Serves fn_tournament_conservation_delta''s funded_overlay term. Narrow on purpose: overlay legs into prize_liability only.';
