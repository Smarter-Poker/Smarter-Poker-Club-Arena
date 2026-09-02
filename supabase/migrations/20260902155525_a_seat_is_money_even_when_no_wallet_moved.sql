-- A SEAT IS MONEY EVEN WHEN NO WALLET MOVED (2026-09-02, Phase 4 of 6).
--
-- Phase 4 asks whether every re-entry, add-on and satellite seat reaches the
-- prize pool it was paid into. Three of those four reconcile exactly and are
-- recorded here so nobody re-audits them:
--
--   * REBUY FEES RECONCILE TO THE CENT. Over the three days before this
--     migration, 7,679 `rebuy` debits produced 7,679 `rake_records` rows with
--     source 'process_tournament_rebuy'; 3,859.60 chips charged, 3,859.60
--     booked, 0 tournaments missing a rake row. The fee cannot detach from the
--     charge because both are written inside the same transaction as the
--     wallet debit, under the row lock the function takes on `tournaments`.
--   * ADD-ONS TAKE NO FEE BY DESIGN (v_ratio is 0 for an add-on), so the whole
--     charge is prize money and there is no rake row to miss.
--   * CANCELLATION RETURNS ALL THREE CATEGORIES. Across 225 cancelled events
--     and 399 player-event pairs, entries plus rebuys plus add-ons minus
--     refunds is 0.00 owed and 0.00 over-refunded. That zero was positive-
--     controlled: the identical arithmetic against COMPLETED events flags
--     1,085 of 1,085 pairs, so the matcher discriminates.
--
-- THE FOURTH DOES NOT RECONCILE, AND THIS MIGRATION IS THE FIX.
--
-- A satellite seat is the one way money enters a tournament without a wallet
-- moving. `fn_award_satellite_seat` credits the target's prize_pool with the
-- target's buy_in and its total_rake with the target's fee, and pays the
-- winner in a seat rather than chips. Both sides are real money. Neither side
-- is visible to `fn_tournament_conservation_delta`, whose money_in reads
-- `wallet_transactions` debits only:
--
--   * THE TARGET looks like it "paid out money it never collected", because
--     the seat's prize contribution never appears in money_in while the seat's
--     FEE does appear in the rake term. Measured: "Sunday $200 Deep Stack"
--     reads -4,780.00, of which -4,600.00 is exactly 23 seats x 200.
--   * THE SATELLITE looks like it "retained money it never paid out", because
--     a seat paid as a prize is recorded in `tournament_payouts` and nowhere
--     the delta reads. Measured across all 11 satellites that have ever
--     awarded a seat, the delta equals the seat value paid EXACTLY, to the
--     cent, 11 times out of 11: 1000/1000, 1000/1000, 600/600, 400/400,
--     400/400, and 200/200 six times. Total 4,600.00 on each side.
--
-- The money is conserved in reality. The CHECK is blind, symmetrically, and
-- the two blindnesses are the same 4,600.00 seen from opposite ends.
--
-- WHY THIS IS NOT COSMETIC. Satellites are excluded from the scan altogether
-- (`variant NOT IN ('spin','satellite')`), so their +4,600.00 raises nothing
-- and a satellite that genuinely failed to award or pay would raise nothing
-- either - the Phase 1 shape, a check that cannot see the thing it is for.
-- Meanwhile the one target that receives seats reports a deficit that will
-- never clear, which is how a team learns to ignore a money alert.
--
-- WHAT THIS MIGRATION DOES
--   1. Teaches the delta both halves of a seat: income on the target, payout
--      on the satellite. `tournament_payouts` with source 'satellite_seat' is
--      the canonical witness on both sides - it is written in the same
--      transaction as the seat ("THE SEAT IS THE PAYOUT") and the 23 seats
--      awarded before that block existed were back-filled in Phase 2, so the
--      witness is complete for every seat this platform has ever awarded.
--      ONE witness, not three: unlike the Phase 2 exemptions, a second witness
--      here would DOUBLE COUNT a seat that carries both records.
--   2. Brings satellites into the scan, now that they balance.
--
-- THIS CANNOT RELEASE A SINGLE ADDITIONAL CHIP, and that was established by
-- reading the consumers rather than by executing a money path (11.5 rule 5).
-- Only three things read this delta. `fn_pay_backed_payout_shortfalls` and
-- `fn_hu_shortfall_candidates` both pay only where the delta is ABOVE +0.01,
-- and both already exclude satellites explicitly. The only tournaments whose
-- delta RISES here are satellite targets - exactly one exists, and it moves
-- from -4,780.00 to -180.00, still far below the threshold. The only
-- tournaments whose delta FALLS are the 11 satellites, which both payers
-- already skip, and a lower delta can only ever pay less. The third reader is
-- the scan below, which pays nothing.
--
-- MEASURED OUTCOME, verified read-only before this was written:
--   satellites  14 breaking / +4,490.50  ->  3 breaking / -109.50
--   the target       -4,780.00           ->    -180.00
--
-- THE THREE THAT REMAIN ARE REAL AND ARE NOT MINE TO CLOSE:
--   * -108.00 on a CANCELLED satellite that paid 108.00 in prizes and then
--     refunded all 120.00 of entries. Real money, already gone. Dan's
--     no-clawback ruling (2026-08-28) stands: the players keep it and the
--     hosting club absorbed it. Recorded, not chased.
--   * -1.00 and -0.50 on two completed satellites - exact-cent allocation
--     residue inside the 0.05 tolerance question, which is PHASE 6. Deferred
--     there deliberately, not overlooked.
--   * -180.00 on the target is a "Bubble protection: buy-in returned" credit,
--     paid by the engine (no database function writes that string) with
--     nothing recording the club funding it. Two rows exist platform-wide,
--     189.00 chips total, first 2026-08-25. After this migration that alert is
--     TRUE rather than false: 180.00 was paid that no collection funded. It is
--     the same class as the seat - money out with no money in - but it is
--     engine-side promotional funding and belongs to whoever owns promotions.
--     Named here rather than guessed at.
--
-- NOT DONE HERE, ON PURPOSE: `atomic_tournament_register` still moves money
-- with no ledger row at all, and the `addon` wallet category is shared with
-- cash-game table add-ons (802 rows in three days, described "Table add-on
-- (club wallet)", whose related_entity_id is a TABLE). Neither contaminates
-- this reconciliation - a table id never equals a tournament id - but a future
-- query that filters on category without joining `tournaments` will mix them.

-- ---------------------------------------------------------------------------
-- 1. The delta learns both halves of a seat.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_tournament_conservation_delta(p_tournament_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH m AS (
    SELECT t.id, t.ended_at,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'debit'
           AND w.category IN ('tournament_buyin','rebuy','addon')), 0) AS money_in,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'refund'), 0) AS refunds,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'prize'), 0) AS prizes,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'bounty'), 0) AS bounties,
      COALESCE((SELECT sum(r.rake_amount) FROM public.rake_records r
         WHERE r.tournament_id = t.id AND r.is_tournament), 0) AS rake,
      COALESCE((SELECT o.amount FROM public.tournament_guarantee_overlays o
         WHERE o.tournament_id = t.id), 0) AS funded_overlay,
      -- ACKNOWLEDGED PRE-FUNDING MINTING. Replaces the 2026-08-27T12:00:00Z
      -- date literal that used to live here: same intent, but one auditable row
      -- per event carrying the exact amount instead of a comparison that
      -- silently forgave whatever fell the right side of it. An event with no
      -- baseline row is offset by nothing.
      COALESCE((SELECT b.amount FROM public.tournament_conservation_baseline b
         WHERE b.tournament_id = t.id), 0) AS acknowledged,

      -- A SEAT ARRIVING. The target's pool and rake were both credited by
      -- fn_award_satellite_seat with no wallet debit anywhere, so without this
      -- term the target is charged for a prize it was funded to pay. The seat
      -- names its target in metadata because the payout row belongs to the
      -- SATELLITE that paid it.
      COALESCE((SELECT sum(sp.amount) FROM public.tournament_payouts sp
         WHERE sp.source = 'satellite_seat'
           AND sp.metadata->>'satellite_target_id' = t.id::text), 0) AS seat_income,

      -- A SEAT LEAVING. The satellite really did pay this out; it simply paid
      -- it in a seat rather than in chips, so no 'prize' credit exists to find.
      COALESCE((SELECT sum(sp.amount) FROM public.tournament_payouts sp
         WHERE sp.source = 'satellite_seat'
           AND sp.tournament_id = t.id), 0) AS seat_paid_out
    FROM public.tournaments t WHERE t.id = p_tournament_id
  )
  SELECT round(
      m.money_in - m.refunds - m.rake - m.prizes - m.bounties
    + m.funded_overlay
    + m.acknowledged
    + m.seat_income
    - m.seat_paid_out
  , 2)
  FROM m;
$fn$;

REVOKE ALL ON FUNCTION public.fn_tournament_conservation_delta(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_tournament_conservation_delta(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The scan stops skipping satellites.
--
-- 'spin' stays excluded: its pool is funded by the Reserve Pool rather than by
-- its own collections, so its delta does not mean what it means elsewhere, and
-- it has its own check. 'satellite' was excluded because it could never
-- balance - which is circular, since it could never balance only because the
-- seat it pays was invisible. It balances now, verified on all 28 of them
-- before this ran.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_tournament_money_conservation(
  p_since_days integer DEFAULT 7,
  p_tolerance  numeric DEFAULT 0.05,
  p_limit      integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row       record;
  v_flagged   integer := 0;
  v_scanned   integer := 0;
  v_reported  integer := 0;
  v_resolved  integer := 0;
  v_retained  numeric := 0;
  v_unfunded  numeric := 0;
  v_worst     numeric := 0;
  v_delta     numeric;
  v_ins       integer;
  v_tol       numeric := GREATEST(p_tolerance, 0);
  v_days      integer := GREATEST(p_since_days, 1);
  v_cap       integer := GREATEST(p_limit, 1);
  v_started   timestamptz := clock_timestamp();
BEGIN
  ---------------------------------------------------------------------------
  -- Pass 1: auto-resolve open alerts that have come back inside tolerance.
  -- Unchanged from the original.
  ---------------------------------------------------------------------------
  FOR v_row IN
    SELECT fa.id, (fa.context->>'tournament_id')::uuid AS tid
      FROM public.financial_alerts fa
     WHERE fa.source = 'fn_tournament_money_conservation'
       AND fa.resolved IS NOT TRUE
       AND fa.context->>'tournament_id' IS NOT NULL
     ORDER BY fa.created_at ASC
     LIMIT 1000
  LOOP
    v_delta := public.fn_tournament_conservation_delta(v_row.tid);
    IF v_delta IS NOT NULL AND abs(v_delta) <= v_tol THEN
      UPDATE public.financial_alerts
         SET resolved = true, resolved_at = now()
       WHERE id = v_row.id;
      v_resolved := v_resolved + 1;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- Pass 2: scan the FULL p_since_days window. No LIMIT here -- that was the
  -- defect. Deltas are computed once in the CTE and the offenders are visited
  -- worst-first so that a report truncated by p_limit is still the top of the
  -- problem.
  --
  -- SATELLITES ARE IN THE SCAN NOW (2026-09-02, Phase 4). They were excluded
  -- because they could never balance, which is circular: they could never
  -- balance only because the seat a satellite pays was invisible to the delta.
  -- 'spin' stays out - its pool is funded by the Reserve Pool rather than by
  -- its own collections, and it has its own check.
  ---------------------------------------------------------------------------
  FOR v_row IN
    WITH scan AS (
      SELECT t.id, t.name, t.variant, t.ended_at,
             public.fn_tournament_conservation_delta(t.id) AS delta
        FROM public.tournaments t
       WHERE t.status IN ('COMPLETED','CANCELLED')
         AND t.ended_at > now() - make_interval(days => v_days)
         AND t.ended_at < now() - interval '30 minutes'
         AND COALESCE(t.variant, '') NOT IN ('spin')
         AND COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0
    )
    SELECT s.id, s.name, s.variant, s.delta
      FROM scan s
     ORDER BY abs(s.delta) DESC NULLS LAST, s.ended_at DESC
  LOOP
    v_scanned := v_scanned + 1;
    v_delta := v_row.delta;

    IF v_delta IS NULL OR abs(v_delta) <= v_tol THEN CONTINUE; END IF;

    IF v_delta > 0 THEN v_retained := v_retained + v_delta;
    ELSE                v_unfunded := v_unfunded - v_delta; END IF;
    v_flagged := v_flagged + 1;
    v_worst := GREATEST(v_worst, abs(v_delta));

    -- p_limit caps how many NEW alerts one run may raise. Detection above is
    -- already complete and unconditional; this only throttles the write side.
    IF v_reported < v_cap THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'warning', 'fn_tournament_money_conservation',
             CASE WHEN v_delta > 0
                  THEN 'Tournament retained money it never paid out: '
                  ELSE 'Tournament paid out money it never collected: ' END
               || COALESCE(v_row.name, v_row.id::text),
             jsonb_build_object('tournament_id', v_row.id, 'variant', v_row.variant,
                                'delta', v_delta)
       WHERE NOT EXISTS (
         SELECT 1 FROM public.financial_alerts
          WHERE source = 'fn_tournament_money_conservation'
            AND resolved IS NOT TRUE
            AND context->>'tournament_id' = v_row.id::text);
      GET DIAGNOSTICS v_ins = ROW_COUNT;
      v_reported := v_reported + v_ins;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok',               (v_flagged = 0),
    'check_ran',        true,
    'scanned',          v_scanned,
    'flagged',          v_flagged,
    'reported',         v_reported,
    'report_truncated', (v_reported >= v_cap AND v_flagged > v_reported),
    'window_days',      v_days,
    'tolerance',        v_tol,
    'report_limit',     v_cap,
    'auto_resolved',    v_resolved,
    'retained_chips',   round(v_retained, 2),
    'unfunded_chips',   round(v_unfunded, 2),
    'worst_abs_delta',  round(v_worst, 2),
    'duration_ms',      round(extract(epoch FROM clock_timestamp() - v_started) * 1000)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_tournament_money_conservation(integer, numeric, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_tournament_money_conservation(integer, numeric, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Assertions. Structure and measured outcome - never wall clock, which on
--    this database swings 10x with load and makes a migration flaky by
--    construction.
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  v_income_seen   numeric;
  v_blind_sats    integer;
  v_seat_rows     integer;
  v_orphan_target integer;
  v_still_excl    integer;
BEGIN
  -- (a) THE TERM ACTUALLY MATCHES ROWS. This is the assertion that matters
  --     most: a wrong metadata key would leave seat_income at 0 everywhere,
  --     every other assertion would still pass, and the migration would have
  --     changed nothing while reporting that it fixed the blindness.
  SELECT COALESCE(sum(sp.amount), 0) INTO v_income_seen
    FROM public.tournament_payouts sp
   WHERE sp.source = 'satellite_seat'
     AND sp.metadata->>'satellite_target_id' IS NOT NULL;
  IF v_income_seen <= 0 THEN
    RAISE EXCEPTION
      'seat income term matched nothing: no satellite_seat payout names a target';
  END IF;

  -- (b) EVERY SEAT NAMES A TARGET THAT EXISTS. If a seat named no target the
  --     income would land nowhere and the target side would stay blind.
  SELECT count(*) INTO v_orphan_target
    FROM public.tournament_payouts sp
   WHERE sp.source = 'satellite_seat'
     AND (sp.metadata->>'satellite_target_id' IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.tournaments t
                          WHERE t.id = (sp.metadata->>'satellite_target_id')::uuid));
  IF v_orphan_target > 0 THEN
    RAISE EXCEPTION 'seats whose target is missing or unnamed: %', v_orphan_target;
  END IF;

  -- (c) THE BLINDNESS SIGNATURE IS GONE. A satellite whose delta equalled the
  --     seat value it paid was the exact fingerprint of this bug, 11 times out
  --     of 11. Not one may remain.
  SELECT count(*) INTO v_blind_sats
    FROM public.tournaments t
   WHERE COALESCE(t.variant, '') = 'satellite'
     AND EXISTS (SELECT 1 FROM public.tournament_payouts sp
                  WHERE sp.source = 'satellite_seat' AND sp.tournament_id = t.id)
     AND abs(COALESCE(public.fn_tournament_conservation_delta(t.id), 0)) > 0.05;
  IF v_blind_sats > 0 THEN
    RAISE EXCEPTION
      'satellites that paid seats and still do not balance: % (expected 0)', v_blind_sats;
  END IF;

  -- (d) THE SCAN NO LONGER SKIPS SATELLITES. Matched on the CODE form, not the
  --     bare word - the word appears throughout the commentary above and an
  --     assertion against the bare word would refuse its own migration. That
  --     mistake has been made three times in this workstream.
  SELECT count(*) INTO v_still_excl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_tournament_money_conservation'
     AND p.prosrc LIKE '%NOT IN (''spin'', ''satellite'')%';
  IF v_still_excl > 0 THEN
    RAISE EXCEPTION 'the scan still excludes satellites';
  END IF;

  -- (e) The seat witness still holds every seat ever awarded.
  SELECT count(*) INTO v_seat_rows
    FROM public.tournament_payouts WHERE source = 'satellite_seat';
  IF v_seat_rows < 23 THEN
    RAISE EXCEPTION
      'expected at least the 23 back-filled seat payouts, found %', v_seat_rows;
  END IF;

  RAISE NOTICE 'phase 4: seat income visible = %, seat payout rows = %',
    v_income_seen, v_seat_rows;
END;
$assert$;

-- ---------------------------------------------------------------------------
-- ROLLBACK (not executed; written so it does not have to be invented during an
-- incident). Restores both bodies exactly as they stood before this migration:
-- drop the two seat terms from the delta, and put satellites back into the
-- scan's exclusion list.
--
--   BEGIN;
--     -- delta: remove "+ m.seat_income" and "- m.seat_paid_out" from the final
--     -- SELECT and delete the two COALESCE(...) subqueries that define them.
--     -- The body is otherwise byte-identical to
--     -- 20260828082815_the_pre_funding_minting_becomes_an_acknowledged_baseline.
--     -- scan: restore
--     --   AND COALESCE(t.variant, '') NOT IN ('spin', 'satellite')
--   COMMIT;
--
-- Reverting the scan line ALONE is the smaller, safer half if satellites turn
-- out to be noisy: it stops them alerting without re-blinding the target.
-- ---------------------------------------------------------------------------
