-- 20260905165154_a_lost_spin_stamp_cannot_age_out_of_its_own_repair.sql
--
-- THE ROOT CAUSE, not the symptom. Migration 20260905161235 earlier today
-- taught fn_spin_repair_missing_multiplier to see a spin that never stamped a
-- start, and repaired the four that were waiting. That fixed the last link of
-- a chain of four. This closes the other three, and the chain is worth writing
-- down because every link on its own looks like a reasonable decision.
--
-- WHAT ACTUALLY HAPPENED TO THOSE FOUR SPINS
--
-- 1. They sold their third seat at 2026-09-01 20:45:40..20:45:56 and drew
--    seconds later: spin_reserve_ledger carries a jackpot_draw row for each,
--    at 20:45:58..20:46:34, booking 2x, 2x, 3x, 3x against the club reserve.
--    So the draw HAPPENED and the money moved.
--
-- 2. Then every write the engine made to `tournaments` was lost. Not partly -
--    entirely. All four still read the pre-draw placeholder:
--    payout_structure [{"place":1,"percentage":100}], spin_reveal_lag_ms NULL,
--    spin_reveal_at NULL, spin_multiplier NULL, started_at NULL. Seventeen
--    SIBLING spins created in the same twenty minutes also lost started_at, so
--    whatever broke was not spin-specific and not one row: it was that engine,
--    in that window. Nothing in the data now can say which failure it was, and
--    it has not recurred - 21 spins with a NULL start across 2026-08-31 and
--    2026-09-01, and zero in the 24,000 spins since 2026-09-02.
--
-- 3. THE ENGINE'S OWN RECOVERY LIVES IN MEMORY AND DIED NINE MINUTES LATER.
--    TournamentManagerBase.scheduleSpinRowRepair re-tries the identical patch
--    twelve times, five seconds apart - about one minute - on unref'd timers.
--    The engine restarts at :55 of every hour (CLAUDE.md 13). These drew at
--    20:46. Even had the database recovered, the only process holding the
--    drawn multiplier was gone before it could write it. Its own comment says
--    that at exhaustion the row "genuinely needs fn_spin_repair_missing_
--    multiplier or a human".
--
-- 4. AND THAT LAST RESORT COULD NOT SEE THEM. The repair gated on
--    `started_at IS NOT NULL`. A spin whose writes were lost has no start, so
--    the documented backstop was unreachable for precisely the rows that
--    reached it. Fixed in 20260905161235.
--
-- WHAT THIS MIGRATION CLOSES
--
-- A. fn_spin_sweep_unbooked carries the IDENTICAL blindness one function over:
--    `AND t.started_at > now() - make_interval(...)`. NULL > anything is NULL,
--    which is not true, so a spin with no start is invisible to the sweep as
--    well - in the loop AND in the `remaining` gauge that is supposed to say
--    a backlog exists. Both now read COALESCE(started_at, created_at). A spin
--    that never started is the one most likely to be unbooked, not the one to
--    skip.
--
-- B. A LOST STAMP CAN NO LONGER AGE OUT OF ITS OWN REPAIR. The repair is a
--    */15 cron with a 240-minute lookback. These four were stranded for three
--    hours and forty-six minutes and finished fourteen minutes inside that
--    window; an engine that came back an hour later would have put them
--    outside it forever, and the only remaining path would have been a human
--    noticing. A spin that HAS a booked jackpot_draw and NO multiplier is
--    broken by definition, at any age, so it is now always in scope. The set
--    is self-draining - the same pass that finds it repairs it - so this
--    cannot become an unbounded scan: it is zero right now.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It does not move the stamp inside fn_spin_settle_game, which was the first
-- design and would make the draw and the stamp one transaction. `tournaments`
-- carries twenty-five triggers, several of which raise on an UPDATE
-- (fn_guard_registered_tournament_contract raises 55000 on a contract change
-- once a player has registered; fn_spin_ladder_is_the_drawn_one fires on every
-- UPDATE). A stamp that fails there would fail the SETTLEMENT, which is the
-- money leg - strictly worse than the bug being fixed. The durable backstop
-- runs every five and fifteen minutes forever and does not care whether an
-- engine lived or died.
--
-- It does not backfill started_at on the 21 completed spins that lack it.
-- They are finished and correctly stamped; the only witness to when they began
-- is the draw time, and writing an inferred start onto a settled record to
-- tidy a column is the thing 10.9 forbids.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ── A. the sweep stops being blind to a spin that never started ─────────────
CREATE OR REPLACE FUNCTION public.fn_spin_sweep_unbooked(
  p_lookback_mins integer DEFAULT 180,
  p_limit integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_t record; v_n integer := 0; v_fail integer := 0; v_skipped integer := 0;
  v_res jsonb; v_repair jsonb; v_failures jsonb := '[]'::jsonb;
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 500));
  v_remaining integer := 0;
BEGIN
  BEGIN
    v_repair := public.fn_spin_repair_missing_multiplier(p_lookback_mins);
  EXCEPTION WHEN OTHERS THEN
    v_repair := jsonb_build_object('ok', false, 'reason', SQLERRM);
  END;

  FOR v_t IN
    SELECT t.id, t.club_id, t.buy_in_amount, t.spin_multiplier
    FROM public.tournaments t
    WHERE t.variant = 'spin'
      AND t.status IN ('RUNNING','COMPLETED')
      AND COALESCE(t.buy_in_fee, 0) = 0
      AND COALESCE(t.spin_multiplier, 0) > 0
      AND t.club_id IS NOT NULL
      -- Did anybody actually enter? current_players drains to zero, so test
      -- the rows, not the counter. A spin nobody entered has nothing to book.
      AND EXISTS (SELECT 1 FROM public.tournament_players tp
                   WHERE tp.tournament_id = t.id)
      -- COALESCE, not a bare started_at: `NULL > now() - interval` is NULL,
      -- which is not true, so a spin whose start write was lost was invisible
      -- to the sweep - the same blindness that hid four spins from
      -- fn_spin_repair_missing_multiplier for four days.
      AND COALESCE(t.started_at, t.created_at) > now() - make_interval(mins => p_lookback_mins)
      AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                      WHERE l.tournament_id = t.id)
    -- Oldest first. A backlog then drains in a deterministic order instead of
    -- the newest games starving the ones that have been waiting longest.
    ORDER BY COALESCE(t.started_at, t.created_at)
    LIMIT v_limit
  LOOP
    BEGIN
      -- SPIN_SEATS = 3, by definition and to match the engine settle path
      -- exactly (TournamentManagerBase forces 3 regardless of row counts).
      v_res := public.fn_spin_settle_game(
        v_t.id, v_t.club_id, v_t.buy_in_amount, 3, v_t.spin_multiplier,
        public.fn_spin_rake_rate(v_t.buy_in_amount));
      IF COALESCE((v_res->>'ok')::boolean, false) THEN
        v_n := v_n + 1;
      ELSE
        v_fail := v_fail + 1;
        v_failures := v_failures || jsonb_build_object(
          'tournament_id', v_t.id, 'reason', COALESCE(v_res->>'reason', 'refused'));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fail := v_fail + 1;
      v_failures := v_failures || jsonb_build_object(
        'tournament_id', v_t.id, 'sqlstate', SQLSTATE, 'error', SQLERRM);
    END;
  END LOOP;

  -- What this pass could not reach. A caller that sees remaining > 0 knows to
  -- come back sooner than the next quarter hour, and the gauge knows the
  -- difference between a quiet platform and a backlog nobody is draining.
  SELECT count(*) INTO v_remaining
  FROM public.tournaments t
  WHERE t.variant = 'spin'
    AND t.status IN ('RUNNING','COMPLETED')
    AND COALESCE(t.buy_in_fee, 0) = 0
    AND COALESCE(t.spin_multiplier, 0) > 0
    AND t.club_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = t.id)
    AND COALESCE(t.started_at, t.created_at) > now() - make_interval(mins => p_lookback_mins)
    AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                    WHERE l.tournament_id = t.id);

  RETURN jsonb_build_object('ok', true, 'settled', v_n, 'failed', v_fail,
                            'failures', v_failures,
                            'skipped_no_entrants', v_skipped,
                            'lookback_mins', p_lookback_mins,
                            'batch_limit', v_limit,
                            'remaining', v_remaining,
                            'multiplier_repair', v_repair);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_sweep_unbooked(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_sweep_unbooked(integer, integer) TO service_role;

-- ── B. a booked draw with no stamp is in scope at any age ───────────────────
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
  v_aged     integer := 0;
BEGIN
  FOR v_t IN
    SELECT t.id, t.name, t.club_id, t.prize_pool, t.buy_in_amount,
           t.started_at, t.created_at,
           d.multiplier AS witness,
           (COALESCE(t.started_at, t.created_at)
              <= now() - make_interval(mins => GREATEST(p_lookback_mins, 1))) AS outside_window
      FROM public.tournaments t
      LEFT JOIN LATERAL (
        SELECT l.multiplier
          FROM public.spin_reserve_ledger l
         WHERE l.tournament_id = t.id
           AND l.kind = 'jackpot_draw'
           AND COALESCE(l.multiplier, 0) > 0
         ORDER BY l.created_at ASC
         LIMIT 1) d ON true
     WHERE t.variant = 'spin'
       AND t.status IN ('RUNNING', 'COMPLETED')
       AND COALESCE(t.spin_multiplier, 0) <= 0
       -- A spin that never stamped a start is the spin MOST likely to have
       -- lost its draw. Gating on started_at IS NOT NULL hid exactly the rows
       -- this function exists to repair, for four days.
       AND COALESCE(t.started_at, t.created_at) IS NOT NULL
       AND (
         COALESCE(t.started_at, t.created_at)
           > now() - make_interval(mins => GREATEST(p_lookback_mins, 1))
         -- AT ANY AGE, when the reserve ledger already booked a draw for it.
         -- The window exists to bound a scan of every spin ever played; it
         -- must not bound the repair of a row that is provably broken. Those
         -- four sat three hours forty-six minutes and finished fourteen
         -- minutes inside a 240-minute window - an engine that came back an
         -- hour later would have aged them out permanently. The set is
         -- self-draining: the pass that finds one repairs it.
         OR d.multiplier IS NOT NULL
       )
  LOOP
    v_witness := v_t.witness;
    IF v_t.outside_window THEN
      v_aged := v_aged + 1;
    END IF;

    v_ratio := NULL;
    IF COALESCE(v_t.buy_in_amount, 0) > 0 AND COALESCE(v_t.prize_pool, 0) > 0 THEN
      v_ratio := round(v_t.prize_pool / v_t.buy_in_amount, 4);
    END IF;

    -- THE WITNESS FIRST. fn_spin_settle_game stamps the multiplier it drew on
    -- the jackpot_draw row at the instant of the draw. The pool ratio is only
    -- equal to it once the draw has been applied to the pool, which on a spin
    -- that lost its stamp it has not been - the pool is still the sum of the
    -- three buy-ins, so the ratio reads 3.0 whatever was drawn.
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
                                 'outside_lookback_window', v_t.outside_window,
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
                            'repaired_outside_window', v_aged,
                            'lookback_mins', p_lookback_mins);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_repair_missing_multiplier(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_repair_missing_multiplier(integer) TO service_role;

COMMENT ON FUNCTION public.fn_spin_repair_missing_multiplier(integer) IS
  'Restores spin_multiplier on a spin that completed without stamping its draw. '
  'Reads the jackpot_draw row in spin_reserve_ledger first (the witness to the '
  'draw) and falls back to prize_pool/buy_in only when there is none. A spin '
  'with a booked draw and no stamp is in scope at ANY age - the lookback only '
  'bounds the ratio fallback. Never claws back a prize already paid.';

COMMENT ON FUNCTION public.fn_spin_sweep_unbooked(integer, integer) IS
  'Books the reserve leg for a spin the engine settled without writing. Scoped '
  'on COALESCE(started_at, created_at): a spin whose start write was lost is '
  'the one most likely to be unbooked, and a bare started_at comparison made it '
  'invisible.';

COMMIT;
