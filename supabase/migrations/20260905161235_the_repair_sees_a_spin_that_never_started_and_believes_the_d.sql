-- 20260905161235_the_repair_sees_a_spin_that_never_started_and_believes_the_d.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- Four COMPLETED spins have carried `spin_multiplier IS NULL` since
-- 2026-09-01. The felt cannot show a draw it does not have, and every spin
-- report counts them as un-drawn. There is already a repair for this,
-- `fn_spin_repair_missing_multiplier`, on a */15 cron. It has never seen them,
-- for two separate reasons, and each one is a defect on its own.
--
-- 1. IT REFUSED TO LOOK AT A SPIN THAT NEVER STARTED.
--    The scan carried `AND t.started_at IS NOT NULL` and bounded its window on
--    `started_at`. All four of these have `started_at IS NULL`: the engine
--    completed and paid them through the recovery path without ever stamping a
--    start. So the one condition that made them broken was also the condition
--    that hid them from the repair. A row is now selected on
--    COALESCE(started_at, created_at) - a spin that never started is exactly
--    the spin most likely to have lost its draw, not the one to skip.
--
-- 2. IT RECONSTRUCTED THE MULTIPLIER FROM THE PRIZE POOL, AND WOULD HAVE BEEN
--    WRONG ON HALF OF THEM.
--    `prize_pool / buy_in_amount` is only the drawn multiplier once the draw
--    has been applied to the pool. On a spin that lost its draw the pool is
--    still the DEFAULT - the sum of the three buy-ins - so the ratio reads 3.0
--    on every three-handed spin whatever was actually drawn. Measured on these
--    four: the ratio says 3, 3, 3, 3; the reserve ledger says 3, 3, 2, 2.
--
--    CLAUDE.md 10.9, "prefer the witness that was there". The `jackpot_draw`
--    row in spin_reserve_ledger is written by fn_spin_settle_game with the
--    multiplier the engine actually drew, at the moment it drew it. That is a
--    witness. The pool ratio is an inference from a number that was never
--    updated. So the ledger is read first and the ratio is kept only as the
--    fallback for a spin with no draw row at all.
--
-- WHAT THIS DOES NOT DO: TAKE 103 CHIPS BACK.
--
-- Two of the four were paid the un-multiplied pool by the recovery settlement
-- on 2026-09-02 - 300.00 where the draw was 2x100, and 9.00 where the draw was
-- 2x3. 100.00 and 3.00 more than the draw. That overpay is ours, caused by the
-- lost stamp, and 10.9 rule 3 is explicit that overpay caused by our own defect
-- is absorbed by the house, reported, and left alone. Nothing here claws it
-- back and nothing here rewrites prize_pool to hide it: the multiplier is
-- stamped from the witness, the gap is named in a financial_alerts row, and the
-- two players keep what they were paid.
--
-- The same 2026-08-22..24 era left 27 more spins whose reserve draw and
-- tournament multiplier disagree (v_spin_draw_booking_gaps lists 11 of them).
-- Across all 31 the reserve released 1,961.00 against 2,083.00 credited to
-- winners, so the spin reserve is overstated by 122.00. No chips are moved for
-- that here either - the money reached the right players and the residue is one
-- internal pool reading 122 too rich - but it is recorded rather than absorbed
-- silently. Zero occurrences in the 23,855 draws since 2026-09-02.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_spin_repair_missing_multiplier(p_lookback_mins integer DEFAULT 1440)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  -- MIRRORS server/src/config/spinSpec.ts SPIN_TIERS. Pinned by
  -- tests/config/spinNullMultiplierRepair.test.ts.
  v_tiers    numeric[] := ARRAY[2, 3, 4, 5, 10, 25, 50, 100];
  v_t        record;
  v_ratio    numeric;
  v_witness  numeric;
  v_use      numeric;
  v_source   text;
  v_overpaid numeric;
  v_fixed    integer := 0;
  v_flag     integer := 0;
  v_over     integer := 0;
BEGIN
  FOR v_t IN
    SELECT t.id, t.name, t.club_id, t.prize_pool, t.buy_in_amount,
           t.started_at, t.created_at
      FROM public.tournaments t
     WHERE t.variant = 'spin'
       AND t.status IN ('RUNNING', 'COMPLETED')
       AND COALESCE(t.spin_multiplier, 0) <= 0
       -- A spin that never stamped a start is the spin MOST likely to have
       -- lost its draw. Gating on started_at IS NOT NULL hid exactly the rows
       -- this function exists to repair, for four days.
       AND COALESCE(t.started_at, t.created_at) IS NOT NULL
       AND COALESCE(t.started_at, t.created_at)
             > now() - make_interval(mins => GREATEST(p_lookback_mins, 1))
  LOOP
    -- THE WITNESS FIRST. fn_spin_settle_game stamps the multiplier it drew on
    -- the jackpot_draw row at the instant of the draw. The pool ratio is only
    -- equal to it once the draw has been applied to the pool, which on a spin
    -- that lost its stamp it has not been.
    SELECT l.multiplier INTO v_witness
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = v_t.id
       AND l.kind = 'jackpot_draw'
       AND COALESCE(l.multiplier, 0) > 0
     ORDER BY l.created_at ASC
     LIMIT 1;

    v_ratio := NULL;
    IF COALESCE(v_t.buy_in_amount, 0) > 0 AND COALESCE(v_t.prize_pool, 0) > 0 THEN
      v_ratio := round(v_t.prize_pool / v_t.buy_in_amount, 4);
    END IF;

    IF v_witness IS NOT NULL AND v_witness = ANY (v_tiers) THEN
      v_use := v_witness; v_source := 'spin_reserve_ledger.jackpot_draw';
    ELSIF v_ratio IS NOT NULL AND v_ratio = ANY (v_tiers) THEN
      v_use := v_ratio;   v_source := 'prize_pool / buy_in_amount';
    ELSE
      v_use := NULL;      v_source := NULL;
    END IF;

    IF v_use IS NOT NULL THEN
      UPDATE public.tournaments
         SET spin_multiplier  = v_use,
             is_premium_spin  = (v_use >= 100)
       WHERE id = v_t.id
         AND COALESCE(spin_multiplier, 0) <= 0;
      v_fixed := v_fixed + 1;

      -- The pool that was PAID, against the draw that was made. A positive gap
      -- is money already in a player's wallet: 10.9 rule 3 keeps it there and
      -- requires it to be reported rather than reversed.
      v_overpaid := round(COALESCE(v_t.prize_pool, 0) - (v_use * COALESCE(v_t.buy_in_amount, 0)), 2);
      IF v_overpaid > 0 THEN
        v_over := v_over + 1;
      END IF;

      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES (CASE WHEN v_overpaid > 0 THEN 'warning' ELSE 'info' END,
              'fn_spin_repair_missing_multiplier',
              CASE WHEN v_overpaid > 0
                   THEN 'Spin lost its draw stamp; multiplier restored from the reserve ledger, and '
                        || v_overpaid || ' paid over the draw is absorbed by the house (10.9 rule 3): '
                        || COALESCE(v_t.name, v_t.id::text)
                   ELSE 'Spin lost its draw stamp; multiplier restored from the reserve ledger: '
                        || COALESCE(v_t.name, v_t.id::text) END,
              jsonb_build_object('tournament_id', v_t.id, 'club_id', v_t.club_id,
                                 'buy_in', v_t.buy_in_amount, 'prize_pool', v_t.prize_pool,
                                 'reconstructed_multiplier', v_use,
                                 'reconstructed_from', v_source,
                                 'ledger_witness_multiplier', v_witness,
                                 'pool_ratio', v_ratio,
                                 'paid_over_drawn', v_overpaid,
                                 'clawed_back', false,
                                 'started_at', v_t.started_at,
                                 'created_at', v_t.created_at));
    ELSE
      v_flag := v_flag + 1;
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'critical', 'fn_spin_repair_missing_multiplier',
             'Spin ran without a draw and the multiplier cannot be reconstructed: '
               || COALESCE(v_t.name, v_t.id::text),
             jsonb_build_object('tournament_id', v_t.id, 'club_id', v_t.club_id,
                                'buy_in', v_t.buy_in_amount, 'prize_pool', v_t.prize_pool,
                                'implied_ratio', v_ratio,
                                'ledger_witness_multiplier', v_witness,
                                'started_at', v_t.started_at, 'created_at', v_t.created_at,
                                'detail', 'needs a human decision; no multiplier was invented')
       WHERE NOT EXISTS (
         SELECT 1 FROM public.financial_alerts
          WHERE source = 'fn_spin_repair_missing_multiplier'
            AND resolved IS NOT TRUE
            AND context->>'tournament_id' = v_t.id::text);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'repaired', v_fixed,
                            'unreconstructable', v_flag,
                            'paid_over_drawn_count', v_over,
                            'lookback_mins', p_lookback_mins);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_repair_missing_multiplier(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_repair_missing_multiplier(integer) TO service_role;

COMMENT ON FUNCTION public.fn_spin_repair_missing_multiplier(integer) IS
  'Restores spin_multiplier on a spin that completed without stamping its draw. '
  'Reads the jackpot_draw row in spin_reserve_ledger first (the witness to the '
  'draw) and falls back to prize_pool/buy_in only when there is none. Never '
  'claws back a prize already paid; reports the gap instead.';

-- ── The backfill: the four that have been waiting since 2026-09-01 ──────────
-- Bounded and asserted. The cron window is 240 minutes, so these are far
-- outside it and the corrected function alone would never reach them.
DO $backfill$
DECLARE
  v_expected CONSTANT integer := 4;
  v_seen     integer;
  v_fixed    integer := 0;
  v_over     numeric := 0;
  v_r        record;
BEGIN
  SELECT count(*) INTO v_seen
    FROM public.tournaments t
   WHERE t.variant = 'spin'
     AND t.status IN ('RUNNING', 'COMPLETED')
     AND COALESCE(t.spin_multiplier, 0) <= 0;

  IF v_seen <> v_expected THEN
    RAISE EXCEPTION
      'spin multiplier backfill: expected % un-stamped spins, found % - the board moved, re-measure before shipping this',
      v_expected, v_seen;
  END IF;

  FOR v_r IN
    SELECT t.id, t.name, t.buy_in_amount, t.prize_pool, d.multiplier AS witness
      FROM public.tournaments t
      JOIN LATERAL (
        SELECT l.multiplier
          FROM public.spin_reserve_ledger l
         WHERE l.tournament_id = t.id AND l.kind = 'jackpot_draw'
           AND COALESCE(l.multiplier, 0) > 0
         ORDER BY l.created_at ASC LIMIT 1) d ON true
     WHERE t.variant = 'spin'
       AND t.status IN ('RUNNING', 'COMPLETED')
       AND COALESCE(t.spin_multiplier, 0) <= 0
  LOOP
    UPDATE public.tournaments
       SET spin_multiplier = v_r.witness,
           is_premium_spin = (v_r.witness >= 100)
     WHERE id = v_r.id AND COALESCE(spin_multiplier, 0) <= 0;
    v_fixed := v_fixed + 1;
    v_over  := v_over + GREATEST(round(COALESCE(v_r.prize_pool,0)
                                       - (v_r.witness * COALESCE(v_r.buy_in_amount,0)), 2), 0);
  END LOOP;

  IF v_fixed <> v_expected THEN
    RAISE EXCEPTION 'spin multiplier backfill: stamped % of % - every one of them has a witness, so this is a bug in the backfill',
      v_fixed, v_expected;
  END IF;

  INSERT INTO public.financial_alerts
    (severity, source, message, context, resolved, resolved_at, resolution)
  VALUES ('warning', 'spins_multiplier_backfill_20260905',
          'Four spins completed on 2026-09-01 without stamping their draw; multiplier restored from the reserve ledger and '
            || v_over || ' paid over the draw left with the players',
          jsonb_build_object(
            'spins_stamped', v_fixed,
            'paid_over_drawn_total', v_over,
            'stamped_from', 'spin_reserve_ledger.jackpot_draw',
            'reserve_overstated_total', 122.00,
            'reserve_overstated_spins', 31,
            'reserve_overstated_window', '2026-08-22..2026-09-01',
            'occurrences_since_2026_09_02', 0),
          true, now(),
          'ACCEPTED. The four spins were paid on 2026-09-02 by the recovery settlement, which read prize_pool - '
          'and prize_pool was still the un-multiplied sum of the three buy-ins, because the draw was never stamped '
          'on the tournament row. Two winners were therefore paid 100.00 and 3.00 more than the multiplier the '
          'engine actually drew. That overpay is ours and stays with them (CLAUDE.md 10.9 rule 3); prize_pool is '
          'not rewritten, so the record still shows what each player was paid. spin_multiplier is stamped from the '
          'jackpot_draw row, which is the witness that was present at the draw. Separately, across the 31 spins '
          'from 2026-08-22 to 2026-09-01 whose reserve draw and tournament multiplier disagree, the reserve '
          'released 1961.00 against 2083.00 credited to winners, so the spin reserve reads 122.00 richer than the '
          'chips it actually holds against those events. No chips are moved for that: the money reached the right '
          'players, the residue is internal, and it is recorded here rather than absorbed silently. Zero '
          'recurrences in the 23,855 draws since 2026-09-02; the repair function is corrected in the same '
          'migration so a spin that never starts can no longer hide from it.');

  RAISE NOTICE 'spin multiplier backfill: % stamped, %.2f left with players', v_fixed, v_over;
END;
$backfill$;

COMMIT;
