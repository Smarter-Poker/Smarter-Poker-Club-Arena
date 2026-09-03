-- ============================================================================
-- 20260823040000_book_the_fee_era_spins.sql
-- TIER: 3  |  AFFECTS: spin_reserve_ledger (+4,232 rows), spin_bonus_pools
--                      (balance, total_deposited, total_drawn, spin_count)
--           MONEY PATH. Read the whole header before changing anything.
--
-- WHY
--
-- 2,116 Spins RAN and were never booked to spin_reserve_ledger. Not because
-- anything failed - because two filters agreed:
--
--   fn_spin_sweep_unbooked ... AND COALESCE(t.buy_in_fee, 0) = 0
--   v_spin_reserve_health  ... AND COALESCE(t.buy_in_fee, 0) = 0  (unbooked_24h)
--
-- Every Spin created before 2026-08-20 19:23 UTC carried a fee, so the backstop
-- refused to settle them AND the counter that exists to notice unsettled games
-- did not count them. The one shape of broken game nothing could fix was the
-- one shape nothing could see. Migration 20260822230000 made that loud and
-- stopped new ones; this migration repairs the ones already there.
--
-- WHY NOT JUST CALL fn_spin_settle_game
--
-- That is the obvious move and it is wrong here. Measured before writing this:
--
--   863 of the 2,116 games ALREADY have rake_records, totalling 665.70.
--
-- fn_spin_settle_game writes a rake_record every time. Replaying it would
-- double-count house rake on those 863, and would date 2,116 rake rows TODAY
-- for games that ran days ago, corrupting rake reporting for the current
-- period. It is the right function for a live game and the wrong one for a
-- historical repair, so this migration books the reserve movements ONLY and
-- does not touch rake_records at all. There is a post-apply assertion that
-- proves it did not.
--
-- WHAT IT DOES, PER GAME, IN CHRONOLOGICAL ORDER
--
--   reserve_in = buy_in * seats - rake      credited to the owner's pool
--   prize      = buy_in * multiplier        debited from it
--
-- exactly the arithmetic fn_spin_settle_game uses, with the same rake bands.
-- The owner is resolved with fn_spin_reserve_owner, so a club that belongs to a
-- union books against the UNION's pool - the whole point of the 2026-08-22
-- ownership migration.
--
-- MEASURED IN A ROLLED-BACK DRY RUN BEFORE APPLYING
--
--   games            2,116        owners            1  (Midway Union)
--   reserve_in      12,431.04     prize_out  11,488.00     net  +943.04
--   balance     24,415.58 -> 25,358.62     lowest point along the way 24,404.54
--   ceiling         30,000       breached?  no    surplus returns  0
--   shortfalls      0
--
-- The shortfall count is the one that mattered. fn_spin_settle_game writes a
-- kind='adjustment' row when the pool cannot cover a prize, v_spin_reserve_health
-- counts those as shortfall_events with NO time window, and spin-sweep pages on
-- any non-zero count. The pool currently has zero adjustment rows. A backfill
-- that produced even one would have put a permanent red light on the operator
-- dashboard for a game that ran days ago. The largest prize in the whole set is
-- 75.00 against a balance of 24,000, so none can occur - asserted below anyway.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--
--   - No rake_records. See above.
--   - No adjustment/shortfall rows.
--   - No player balances are touched. Those games paid out at the time; this
--     repairs the RESERVE's record of them, not the players'.
--   - The 3 null-multiplier Spins (dea62e98, a374cdd3, 78181713) are skipped:
--     with no multiplier there is no defensible prize to book. They need
--     fn_spin_repair_missing_multiplier, which is a separate question about why
--     the draw never happened.
--
-- ROLLBACK
--
--   BEGIN;
--     WITH removed AS (
--       DELETE FROM public.spin_reserve_ledger
--        WHERE note LIKE 'fee-era backfill%'
--        RETURNING club_id, amount
--     )
--     UPDATE public.spin_bonus_pools p
--        SET balance          = p.balance - (SELECT COALESCE(sum(amount),0) FROM removed WHERE club_id = p.club_id),
--            total_deposited  = p.total_deposited - 12431.04,
--            total_drawn      = p.total_drawn - 11488.00,
--            spin_count       = p.spin_count - 2116
--      WHERE p.club_id IN (SELECT club_id FROM removed);
--   COMMIT;
--
--   The figures are hard-coded on purpose: they are the audited totals of THIS
--   apply, and a rollback should reverse exactly this and nothing that happened
--   afterwards.
-- ============================================================================

-- ── Pre-flight ──────────────────────────────────────────────────────────────
DO $$
DECLARE v_pools int; v_adj int;
BEGIN
  SELECT count(*) INTO v_pools FROM public.spin_bonus_pools;
  IF v_pools = 0 THEN
    RAISE EXCEPTION 'no spin_bonus_pools rows - nothing to book against';
  END IF;

  SELECT count(*) INTO v_adj FROM public.spin_reserve_ledger WHERE kind = 'adjustment';
  IF v_adj <> 0 THEN
    RAISE WARNING 'pool already carries % shortfall row(s); this migration adds none', v_adj;
  END IF;

  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger WHERE note LIKE 'fee-era backfill%') THEN
    RAISE EXCEPTION 'the fee-era backfill has already run - it is not idempotent by design, do not run it twice';
  END IF;
END $$;

-- ── The backfill ────────────────────────────────────────────────────────────
DO $$
DECLARE
  g record;
  v_owner uuid; v_in numeric; v_prize numeric; v_rake numeric; v_bal numeric;
  n int := 0; sum_in numeric := 0; sum_out numeric := 0;
  rake_before int; rake_after int; adj_before int; adj_after int;
  bal_before numeric; bal_after numeric;
BEGIN
  /**
   * EVERY BASELINE HERE IS SCOPED TO THIS MIGRATION'S OWN GAMES.
   *
   * The first attempt asserted on a GLOBAL rake_records count and aborted
   * itself: a live Spin settled while the loop was running and wrote a rake
   * record, which is completely normal - the platform books roughly one Spin a
   * minute. A global before/after count cannot tell "I wrote this" from
   * "someone else did", so it fails at random on a busy table.
   *
   * The assertion is worth keeping and had to be made precise instead of
   * loosened. rake_before therefore counts rake_records for EXACTLY the
   * tournaments this loop will touch, which no concurrent game can be a member
   * of (a live Spin has buy_in_fee = 0 and is booked on the spot).
   */
  SELECT count(*) INTO rake_before
    FROM public.rake_records r
   WHERE r.tournament_id IN (
     SELECT t.id FROM public.tournaments t
      WHERE t.variant = 'spin'
        AND COALESCE(t.buy_in_fee, 0) <> 0
        AND t.status IN ('RUNNING','COMPLETED')
        AND COALESCE(t.spin_multiplier, 0) > 0
        AND t.club_id IS NOT NULL
        AND COALESCE(t.current_players, 0) > 0
        AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l WHERE l.tournament_id = t.id)
   );
  SELECT count(*) INTO adj_before  FROM public.spin_reserve_ledger WHERE kind = 'adjustment';
  SELECT sum(balance) INTO bal_before FROM public.spin_bonus_pools;

  FOR g IN
    SELECT t.id, t.club_id, t.buy_in_amount AS b, t.current_players AS seats,
           t.spin_multiplier::numeric AS mult
      FROM public.tournaments t
     WHERE t.variant = 'spin'
       AND COALESCE(t.buy_in_fee, 0) <> 0
       AND t.status IN ('RUNNING','COMPLETED')
       AND COALESCE(t.spin_multiplier, 0) > 0
       AND t.club_id IS NOT NULL
       AND COALESCE(t.current_players, 0) > 0
       AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l WHERE l.tournament_id = t.id)
     ORDER BY t.started_at, t.id
  LOOP
    v_rake  := round(g.b * g.seats * (CASE WHEN g.b <= 5 THEN 0.08
                                           WHEN g.b <= 10 THEN 0.07
                                           WHEN g.b <= 50 THEN 0.06
                                           ELSE 0.05 END), 2);
    v_in    := round(g.b * g.seats, 2) - v_rake;
    v_prize := round(g.b * g.mult, 2);
    v_owner := public.fn_spin_reserve_owner(g.club_id);

    -- Credit the contribution.
    UPDATE public.spin_bonus_pools
       SET balance = balance + v_in,
           total_deposited = total_deposited + v_in,
           spin_count = spin_count + 1,
           updated_at = now()
     WHERE club_id = v_owner
     RETURNING balance INTO v_bal;

    IF v_bal IS NULL THEN
      RAISE EXCEPTION 'no pool row for owner % (tournament %)', v_owner, g.id;
    END IF;

    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
    VALUES (v_owner, g.id, 'contribution', v_in, v_bal, g.mult, g.b, g.seats, v_rake,
            'fee-era backfill: buy-ins less fixed rake');

    -- Debit the prize. A shortfall is impossible here (largest prize 75.00
    -- against a balance in the tens of thousands) and is asserted after the
    -- loop rather than clamped, because a clamp would write the adjustment row
    -- this migration exists to avoid.
    IF v_prize > v_bal THEN
      RAISE EXCEPTION 'prize % exceeds pool balance % on tournament % - refusing to clamp', v_prize, v_bal, g.id;
    END IF;

    UPDATE public.spin_bonus_pools
       SET balance = balance - v_prize,
           total_drawn = total_drawn + v_prize,
           bonus_count = bonus_count + CASE WHEN g.mult >= 10 THEN 1 ELSE 0 END,
           updated_at = now()
     WHERE club_id = v_owner
     RETURNING balance INTO v_bal;

    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
    VALUES (v_owner, g.id, 'jackpot_draw', -v_prize, v_bal, g.mult, g.b, g.seats, v_rake,
            'fee-era backfill: prize pool');

    sum_in  := sum_in + v_in;
    sum_out := sum_out + v_prize;
    n := n + 1;
  END LOOP;

  -- Same set, addressed through the rows just written.
  SELECT count(*) INTO rake_after
    FROM public.rake_records r
   WHERE r.tournament_id IN (
     SELECT DISTINCT l.tournament_id FROM public.spin_reserve_ledger l
      WHERE l.note LIKE 'fee-era backfill%'
   );
  SELECT count(*) INTO adj_after  FROM public.spin_reserve_ledger WHERE kind = 'adjustment';
  SELECT sum(balance) INTO bal_after FROM public.spin_bonus_pools;

  -- ── Assertions. Every one of these is a way this could have gone wrong. ──
  IF n = 0 THEN
    RAISE EXCEPTION 'the backfill matched no games - the filter is wrong or it already ran';
  END IF;
  IF rake_after <> rake_before THEN
    RAISE EXCEPTION 'rake_records for the backfilled games changed by % rows - this migration must not touch rake',
      rake_after - rake_before;
  END IF;
  IF adj_after <> adj_before THEN
    RAISE EXCEPTION 'the backfill created % shortfall row(s), which would page an operator about a game from days ago',
      adj_after - adj_before;
  END IF;
  /**
   * Conservation is checked against THIS migration's ledger rows, not the
   * pool's global delta, for the same concurrency reason: a live Spin settling
   * mid-loop moves the pool legitimately and would break a global comparison
   * while proving nothing about this backfill.
   */
  IF round((SELECT COALESCE(sum(amount), 0) FROM public.spin_reserve_ledger
             WHERE note LIKE 'fee-era backfill%'), 2) <> round(sum_in - sum_out, 2) THEN
    RAISE EXCEPTION 'money is not conserved: backfill ledger sums to % but the loop moved %',
      (SELECT COALESCE(sum(amount), 0) FROM public.spin_reserve_ledger WHERE note LIKE 'fee-era backfill%'),
      round(sum_in - sum_out, 2);
  END IF;
  IF (SELECT count(*) FROM public.spin_reserve_ledger WHERE note LIKE 'fee-era backfill%') <> n * 2 THEN
    RAISE EXCEPTION 'expected % backfill ledger rows, found %',
      n * 2, (SELECT count(*) FROM public.spin_reserve_ledger WHERE note LIKE 'fee-era backfill%');
  END IF;

  RAISE NOTICE 'fee-era backfill: % games, reserve_in %, prize_out %, net %, pool % -> %',
    n, sum_in, sum_out, sum_in - sum_out, bal_before, bal_after;
END $$;

-- ── Post-apply: the hole is closed ──────────────────────────────────────────
DO $$
DECLARE v_left int;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.tournaments t
   WHERE t.variant = 'spin'
     AND COALESCE(t.buy_in_fee, 0) <> 0
     AND t.status IN ('RUNNING','COMPLETED')
     AND COALESCE(t.spin_multiplier, 0) > 0
     AND t.club_id IS NOT NULL
     AND COALESCE(t.current_players, 0) > 0
     AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l WHERE l.tournament_id = t.id);

  IF v_left <> 0 THEN
    RAISE EXCEPTION '% fee-era spins are still unbooked', v_left;
  END IF;
END $$;

-- ============================================================================
-- APPLY HISTORY
--
-- Applied to production 2026-08-23 as `book_the_fee_era_spins`.
--
-- IT ABORTED ITSELF ON THE FIRST ATTEMPT, AND THAT WAS THE ASSERTION WORKING.
-- The rake check was written as a GLOBAL rake_records before/after count. A
-- live Spin settled while the loop was running and wrote a rake record - the
-- platform books roughly one Spin a minute - so the count moved by 1 and the
-- whole migration rolled back. Verified afterwards that nothing partial
-- survived: 0 backfill rows, 2,116 still unbooked, pool untouched.
--
-- The fix was to make the assertion PRECISE rather than to loosen it. Both the
-- rake check and the money-conservation check are now scoped to this
-- migration's own games and its own ledger rows, which no concurrent Spin can
-- be a member of (a live Spin has buy_in_fee = 0 and is booked on the spot).
--
-- OUTCOME, measured after the successful apply:
--
--   backfill ledger rows      4,232   (2,116 games x 2)
--   reserve_in            12,431.04
--   prize_out            -11,488.00
--   net                     +943.04   exactly the dry-run figure
--   pool balance          25,358.62   exactly the dry-run figure
--   spin_count                4,835
--   fee-era spins still unbooked  0
--   shortfall rows created        0
--   v_spin_reserve_health: unbooked_24h 0, shortfall_events 0
--
-- rake_records for the backfilled games: unchanged, asserted, and the 863 that
-- already carried one were not touched.
-- ============================================================================
