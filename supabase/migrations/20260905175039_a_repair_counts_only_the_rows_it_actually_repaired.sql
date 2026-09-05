-- 20260905175039_a_repair_counts_only_the_rows_it_actually_repaired.sql
--
-- Applied to production as version 20260905175136 (apply_migration stamps its
-- own timestamp; the New-Migrations-Were-Applied check verifies the OBJECTS
-- exist, not the version, and the bodies below are pg_get_functiondef output
-- read back from production so the repo and the database cannot disagree).
--
-- Two defects found by the final sweep over today's OWN work, both the same
-- shape as the bug the day was spent on.
--
-- 1. A GUARDED UPDATE COUNTED AS A REPAIR WITHOUT CHECKING IT UPDATED ANYTHING.
--    fn_spin_repair_missing_multiplier did:
--
--      UPDATE public.tournaments SET spin_multiplier = v_use, ...
--       WHERE id = v_t.id AND COALESCE(spin_multiplier, 0) <= 0;
--      v_fixed := v_fixed + 1;
--
--    No GET DIAGNOSTICS. If another writer stamped the row between the SELECT
--    and the UPDATE, v_fixed still incremented AND a financial_alerts row was
--    still written claiming a repair that did not happen.
--
--    Reachable, not theoretical: TWO pg_cron jobs drive this function -
--    spin_repair_missing_multiplier (quarter-hourly, direct) and
--    spin_sweep_unbooked (five-minutely, which calls it first) - and they take
--    DIFFERENT advisory locks, so they overlap by design.
--
--    This is precisely the class fixed in TournamentManagerBase this morning
--    ("a guarded update that matches nothing is not an error"), reintroduced in
--    SQL hours later by the same hand. The shape is easy to write and invisible
--    to read. It reports as `lost_the_race` now instead of as a repair.
--
-- 2. `skipped_no_entrants` WAS A CONSTANT PLACEHOLDER. Declared, never
--    incremented, returned in the payload - it read 0 forever because the
--    entrant test lives in the WHERE clause. REMOVED rather than wired: the
--    number it described is no longer computed, and a field that always reads
--    zero is worse than an absent one, because an operator can mistake it for a
--    measurement.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_spin_repair_missing_multiplier(p_lookback_mins integer DEFAULT 1440)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
  v_hit      integer;
  v_fixed    integer := 0;
  v_flag     integer := 0;
  v_over     integer := 0;
  v_aged     integer := 0;
  v_raced    integer := 0;
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
       -- lost its draw. Gating on a bare started_at hid exactly the rows this
       -- function exists to repair, for four days.
       AND COALESCE(t.started_at, t.created_at) IS NOT NULL
       AND (
         COALESCE(t.started_at, t.created_at)
           > now() - make_interval(mins => GREATEST(p_lookback_mins, 1))
         -- AT ANY AGE when the reserve ledger already booked a draw: such a row
         -- is broken by definition and the window must not bound it.
         -- Self-draining, so it cannot become an unbounded scan.
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
    -- the jackpot_draw row at the instant of the draw. The pool ratio equals it
    -- only once the draw has been applied to the pool, which on a spin that
    -- lost its stamp it has not been.
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
      -- A GUARDED UPDATE THAT MATCHES NOTHING IS NOT A REPAIR. Two crons drive
      -- this function under different advisory locks, so the row can be stamped
      -- between the SELECT and here. Counting that as a fix - and filing an
      -- alert for it - is a lie about work that another pass did.
      GET DIAGNOSTICS v_hit = ROW_COUNT;
      IF v_hit = 0 THEN
        v_raced := v_raced + 1;
        CONTINUE;
      END IF;
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
                            'lost_the_race', v_raced,
                            'lookback_mins', p_lookback_mins);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_repair_missing_multiplier(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_repair_missing_multiplier(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_spin_sweep_unbooked(p_lookback_mins integer DEFAULT 180, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t record; v_n integer := 0; v_fail integer := 0;
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
      -- Did anybody actually enter? current_players drains to zero, so test the
      -- rows, not the counter. A spin nobody entered has nothing to book.
      AND EXISTS (SELECT 1 FROM public.tournament_players tp
                   WHERE tp.tournament_id = t.id)
      -- COALESCE, not a bare started_at: NULL > now() - interval is NULL, which
      -- is not true, so a spin whose start write was lost was invisible here.
      AND COALESCE(t.started_at, t.created_at) > now() - make_interval(mins => p_lookback_mins)
      AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                      WHERE l.tournament_id = t.id)
    ORDER BY COALESCE(t.started_at, t.created_at)
    LIMIT v_limit
  LOOP
    BEGIN
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

  -- `skipped_no_entrants` is GONE, not zero. It was declared, never
  -- incremented, and returned - a field that always read 0 because the entrant
  -- test lives in the WHERE clause now. An absent field is honest; a constant
  -- one is a placeholder an operator can mistake for a measurement.
  RETURN jsonb_build_object('ok', true, 'settled', v_n, 'failed', v_fail,
                            'failures', v_failures,
                            'lookback_mins', p_lookback_mins,
                            'batch_limit', v_limit,
                            'remaining', v_remaining,
                            'multiplier_repair', v_repair);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_sweep_unbooked(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_sweep_unbooked(integer, integer) TO service_role;

COMMIT;
