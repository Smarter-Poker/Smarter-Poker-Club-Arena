-- ============================================================================
-- 20260823060000_settle_the_three_aged_out_spins.sql
-- TIER: 3  |  AFFECTS: spin_reserve_ledger (+6 rows), spin_bonus_pools,
--                      rake_records (+3 rows). MONEY PATH.
--
-- THE LAST THREE
--
-- dea62e98, a374cdd3 and 78181713 ran on 2026-08-21 17:44 UTC and were the
-- subject of a standing note in
-- .agent/audits/2026-08-22-union-level-spin-reserve-wallet.md, which predicted
-- their fate exactly:
--
--   "fn_spin_sweep_unbooked requires spin_multiplier > 0, so it skips them and
--    they will show in unbooked_24h until they age out, then be unbooked
--    forever."
--
-- Half of that has since been fixed by somebody else: fn_spin_repair_missing_
-- multiplier (PR #248) reconstructed all three multipliers, and each now reads
-- 3.0000. The other half came true. The sweep looks back 30 minutes; these are
-- 34 hours old, so nothing would ever have looked at them again.
--
-- WHY fn_spin_settle_game HERE, WHEN THE FEE-ERA BACKFILL DELIBERATELY AVOIDED IT
--
-- The two repairs look similar and are not. Measured before writing this:
--
--   rake_records for these three : 0
--   spin_reserve_ledger rows     : 0
--   buy_in_fee                   : 0.00
--
-- Nothing about them has been booked anywhere, and their economics match the
-- live settlement function exactly. The fee-era backfill had to avoid
-- fn_spin_settle_game because 863 of those games already carried rake records
-- and replaying it would have double-counted; here there is nothing to
-- double-count, and the rake is genuinely missing and should be written.
--
-- So this calls the sanctioned path. It is, precisely, what the sweep would
-- have done if it had seen them in time.
--
-- The one thing asserted beyond success is that no settlement produces an
-- operator_shortfall: that writes a kind='adjustment' row, which
-- v_spin_reserve_health counts with no time window and spin-sweep pages on. The
-- prizes here are 3, 6 and 9 chips against a pool holding tens of thousands, so
-- it cannot happen - and is checked rather than assumed.
--
-- ROLLBACK
--
--   DELETE FROM public.spin_reserve_ledger WHERE tournament_id IN (...the 3...);
--   DELETE FROM public.rake_records        WHERE tournament_id IN (...the 3...);
--   -- then reverse the pool by the net of the deleted ledger rows.
--
--   Reversing is almost certainly wrong: these games really were played and
--   really did move money. The ledger not knowing that was the bug.
-- ============================================================================

DO $$
DECLARE
  g record; res jsonb; n int := 0;
  ids uuid[] := ARRAY['dea62e98-7cd9-404f-966f-b9fe3c7a94d8',
                      'a374cdd3-b10e-4725-bab5-ff6e90bb2af5',
                      '78181713-fa93-4a52-93d8-e73bbf97851e']::uuid[];
BEGIN
  FOR g IN
    SELECT t.id, t.club_id, t.buy_in_amount AS b, t.current_players AS seats,
           t.spin_multiplier::numeric AS mult
      FROM public.tournaments t
     WHERE t.id = ANY(ids)
       AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l WHERE l.tournament_id = t.id)
     ORDER BY t.started_at
  LOOP
    res := public.fn_spin_settle_game(
      g.id, g.club_id, g.b, g.seats, g.mult,
      CASE WHEN g.b <= 5 THEN 0.08 WHEN g.b <= 10 THEN 0.07
           WHEN g.b <= 50 THEN 0.06 ELSE 0.05 END);

    IF COALESCE((res->>'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'settlement refused for %: %', g.id, res;
    END IF;
    IF COALESCE((res->>'operator_shortfall')::numeric, 0) <> 0 THEN
      RAISE EXCEPTION 'settling % produced a shortfall of % - that would page an operator about a game from last week',
        g.id, res->>'operator_shortfall';
    END IF;
    n := n + 1;
  END LOOP;

  IF n = 0 THEN
    RAISE NOTICE 'nothing to settle - the three aged-out spins were already booked';
  END IF;

  -- The real assertion: no Spin anywhere is left unbooked for a reason the
  -- sweep could have fixed. An hour of grace so a game that just finished and
  -- is waiting for the next sweep cycle is not mistaken for a stranded one.
  IF EXISTS (
    SELECT 1 FROM public.tournaments t
     WHERE t.variant = 'spin'
       AND t.status IN ('RUNNING','COMPLETED')
       AND COALESCE(t.spin_multiplier, 0) > 0
       AND t.club_id IS NOT NULL
       AND COALESCE(t.current_players, 0) > 0
       AND t.started_at < now() - interval '1 hour'
       AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l WHERE l.tournament_id = t.id)
  ) THEN
    RAISE EXCEPTION 'a settleable Spin older than an hour is still unbooked';
  END IF;
END $$;

-- ============================================================================
-- APPLY HISTORY
--
-- Applied to production 2026-08-23 as `settle_the_three_aged_out_spins`.
-- Verified immediately after: 6 ledger rows for the three, 0 settleable Spins
-- older than an hour still unbooked anywhere, shortfall_events 0,
-- economy_invariants() 12 checks 0 failing.
--
-- Together with 20260823040000 this closes the reserve ledger completely: there
-- is no longer a single Spin in the platform's history that ran and was never
-- booked.
-- ============================================================================
