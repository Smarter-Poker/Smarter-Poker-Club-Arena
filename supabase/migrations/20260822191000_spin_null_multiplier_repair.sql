-- ============================================================================
-- Migration: a Spin that ran without a draw was unbookable forever
-- Date:      2026-08-22
-- Tier:      2 (new function, one function body replaced, one view gains a
--               column; no DROP, no column type change, no data movement here)
-- ============================================================================
--
-- WHAT WAS WRONG
--
-- On 2026-08-21 three Spins ran to completion with `spin_multiplier = NULL`:
--
--   dea62e98  1 Chip Spin PLO4   started 17:44:24Z
--   a374cdd3  2 Chip Spin NLH    started 17:44:24Z
--   78181713  3 Chip Spin NLH    started 17:44:21Z
--
-- All three were created at 17:32:59-17:33:02, stood down at the paid-entry
-- gate while their batch-mates started at 17:33:32, were filled at 17:43 and
-- started 11 minutes later -- inside the engine restart window that day. They
-- carry every mark of a start that never entered the Spin block in
-- `TournamentManagerBase.start()`: `prize_pool` still holds the value
-- `fn_register_*_for_tournament` accumulated one buy-in at a time (3.00 / 6.00
-- / 9.00 -- exactly seats x buy-in, and written with the two decimals a
-- numeric column keeps, where a drawn pool is written by the engine and stores
-- as 3 / 6 / 9), `starting_chips` still the creation-time placeholder, no
-- `spin_reserve_ledger` row, no `rake_records` row. Every other Spin in that
-- hour drew normally -- 69 of 72 -- and there has not been another in the 28
-- hours since, so the cause was transient version skew, not a logic defect.
--
-- The DURABLE defect is what happened next: nothing could ever repair them.
-- `fn_spin_sweep_unbooked` filters `COALESCE(spin_multiplier, 0) > 0`, so it
-- skips exactly the rows that need it most, and `unbooked_24h` in
-- `v_spin_reserve_health` ages them out after a day. A Spin that ran without a
-- draw was therefore invisible and permanently unbooked -- the house never took
-- its rake and the reserve never saw the money.
--
-- WHAT THIS DOES
--
-- 1. `fn_spin_repair_missing_multiplier` reconstructs the multiplier from the
--    money that actually moved: `prize_pool / buy_in_amount`, accepted ONLY
--    when it lands exactly on a published tier. That is not a guess -- it is
--    the ratio the winner was actually paid. When it does not land on a tier
--    the row is left alone and a critical `financial_alerts` row is raised for
--    a human, because inventing a multiplier would write fiction into the
--    money ledger.
--
-- 2. `fn_spin_sweep_unbooked` calls it first, so the existing World Hub cron
--    (`pages/api/cron/spin-sweep.js`) gains the repair with no reader change --
--    the ordering lesson from the 2026-08-21 column-drop incident, applied the
--    other way round.
--
-- 3. `v_spin_reserve_health` gains `null_multiplier_24h`, so this condition can
--    never again be silent. Adding a column is safe for the deployed reader;
--    it selects named columns.
--
-- The three rows above are NOT booked by this migration. They are long past
-- the sweep's lookback, and retroactively moving reserve money is Dan's call,
-- not a migration's.
--
-- ROLLBACK
--
--   DROP FUNCTION IF EXISTS public.fn_spin_repair_missing_multiplier(integer);
--   -- and restore the previous bodies, both of which are recorded verbatim in
--   -- .agent/audits/2026-08-22-null-multiplier-spins-and-double-ledger.md
-- ============================================================================

-- Pre-flight: the assumptions this migration is built on.
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_spin_sweep_unbooked') THEN
    RAISE EXCEPTION 'fn_spin_sweep_unbooked is missing - refusing to rewire it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'v_spin_reserve_health') THEN
    RAISE EXCEPTION 'v_spin_reserve_health is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'tournaments'
                    AND column_name = 'spin_multiplier') THEN
    RAISE EXCEPTION 'tournaments.spin_multiplier is missing';
  END IF;
END $preflight$;

CREATE OR REPLACE FUNCTION public.fn_spin_repair_missing_multiplier(
  p_lookback_mins integer DEFAULT 1440
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- MIRRORS server/src/config/spinSpec.ts SPIN_TIERS. Pinned by
  -- tests/config/spinNullMultiplierRepair.test.ts, which reads both files and
  -- fails if they disagree -- drift between copies of the tier table is
  -- exactly how three conflicting multiplier tables happened before 2026-08-20.
  v_tiers  numeric[] := ARRAY[2, 3, 4, 5, 10, 25, 50, 100];
  v_t      record;
  v_ratio  numeric;
  v_fixed  integer := 0;
  v_flag   integer := 0;
BEGIN
  FOR v_t IN
    SELECT t.id, t.name, t.club_id, t.prize_pool, t.buy_in_amount, t.started_at
      FROM public.tournaments t
     WHERE t.variant = 'spin'
       AND t.status IN ('RUNNING', 'COMPLETED')
       AND COALESCE(t.spin_multiplier, 0) <= 0
       AND t.started_at IS NOT NULL
       AND t.started_at > now() - make_interval(mins => GREATEST(p_lookback_mins, 1))
  LOOP
    v_ratio := NULL;
    IF COALESCE(v_t.buy_in_amount, 0) > 0 AND COALESCE(v_t.prize_pool, 0) > 0 THEN
      v_ratio := round(v_t.prize_pool / v_t.buy_in_amount, 4);
    END IF;

    IF v_ratio IS NOT NULL AND v_ratio = ANY (v_tiers) THEN
      UPDATE public.tournaments
         SET spin_multiplier  = v_ratio,
             is_premium_spin  = (v_ratio >= 100)
       WHERE id = v_t.id
         AND COALESCE(spin_multiplier, 0) <= 0;   -- CAS: never clobber a real draw
      v_fixed := v_fixed + 1;

      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('warning', 'fn_spin_repair_missing_multiplier',
              'Spin ran without a draw; multiplier reconstructed from the prize actually paid: '
                || COALESCE(v_t.name, v_t.id::text),
              jsonb_build_object('tournament_id', v_t.id, 'club_id', v_t.club_id,
                                 'buy_in', v_t.buy_in_amount, 'prize_pool', v_t.prize_pool,
                                 'reconstructed_multiplier', v_ratio,
                                 'started_at', v_t.started_at));
    ELSE
      v_flag := v_flag + 1;
      -- Deliberately NOT repaired. One alert per tournament, ever.
      INSERT INTO financial_alerts (severity, source, message, context)
      SELECT 'critical', 'fn_spin_repair_missing_multiplier',
             'Spin ran without a draw and the multiplier cannot be reconstructed: '
               || COALESCE(v_t.name, v_t.id::text),
             jsonb_build_object('tournament_id', v_t.id, 'club_id', v_t.club_id,
                                'buy_in', v_t.buy_in_amount, 'prize_pool', v_t.prize_pool,
                                'implied_ratio', v_ratio, 'started_at', v_t.started_at,
                                'detail', 'needs a human decision; no multiplier was invented')
       WHERE NOT EXISTS (
         SELECT 1 FROM financial_alerts
          WHERE source = 'fn_spin_repair_missing_multiplier'
            AND resolved IS NOT TRUE
            AND context->>'tournament_id' = v_t.id::text);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'repaired', v_fixed, 'unreconstructable', v_flag,
                            'lookback_mins', p_lookback_mins);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_repair_missing_multiplier(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_spin_repair_missing_multiplier(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_spin_repair_missing_multiplier(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_repair_missing_multiplier(integer) TO service_role;

-- The sweep repairs before it books. Body otherwise unchanged.
CREATE OR REPLACE FUNCTION public.fn_spin_sweep_unbooked(p_lookback_mins integer DEFAULT 180)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_t record; v_n integer := 0; v_fail integer := 0; v_res jsonb; v_repair jsonb;
BEGIN
  -- A Spin that ran without a draw used to be filtered out by the
  -- `spin_multiplier > 0` predicate below and could therefore never be booked.
  -- Reconstruct what is reconstructable first, then sweep as before.
  BEGIN
    v_repair := public.fn_spin_repair_missing_multiplier(p_lookback_mins);
  EXCEPTION WHEN OTHERS THEN
    v_repair := jsonb_build_object('ok', false, 'reason', SQLERRM);
  END;

  FOR v_t IN
    SELECT t.id, t.club_id, t.buy_in_amount, t.current_players, t.spin_multiplier
    FROM public.tournaments t
    WHERE t.variant = 'spin'
      AND t.status IN ('RUNNING','COMPLETED')
      AND COALESCE(t.buy_in_fee, 0) = 0          -- post-cutover pricing only
      AND COALESCE(t.spin_multiplier, 0) > 0
      AND t.club_id IS NOT NULL
      AND COALESCE(t.current_players, 0) > 0
      AND t.started_at > now() - make_interval(mins => p_lookback_mins)
      AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                      WHERE l.tournament_id = t.id)
  LOOP
    BEGIN
      v_res := public.fn_spin_settle_game(
        v_t.id, v_t.club_id, v_t.buy_in_amount, v_t.current_players, v_t.spin_multiplier,
        CASE WHEN v_t.buy_in_amount <= 5  THEN 0.08
             WHEN v_t.buy_in_amount <= 10 THEN 0.07
             WHEN v_t.buy_in_amount <= 50 THEN 0.06
             ELSE 0.05 END);
      IF COALESCE((v_res->>'ok')::boolean, false) THEN v_n := v_n + 1;
      ELSE v_fail := v_fail + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      -- One bad row must not stop the sweep.
      v_fail := v_fail + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'settled', v_n, 'failed', v_fail,
                            'lookback_mins', p_lookback_mins,
                            'multiplier_repair', v_repair);
END; $function$;

-- Visibility. `null_multiplier_24h` is additive; the deployed World Hub reader
-- selects named columns and is unaffected until it opts in.
CREATE OR REPLACE VIEW public.v_spin_reserve_health AS
 SELECT p.club_id,
    COALESCE(c.name, u.name) AS club_name,
    p.balance,
    p.seeded_amount,
    p.highest_stake,
    p.ceiling_amount,
    p.spin_count,
    p.total_deposited,
    p.total_drawn,
    round(p.highest_stake * 500::numeric, 2) AS top_jackpot,
    round(p.highest_stake * 500::numeric * 2.0, 2) AS need_for_500x,
    round(p.highest_stake * 100::numeric * 1.5, 2) AS need_for_100x,
    p.balance >= (p.highest_stake * 500::numeric * 2.0) AS can_draw_500x,
    p.balance >= (p.highest_stake * 100::numeric * 1.5) AS can_draw_100x,
    p.balance < (p.highest_stake * 10::numeric) AS is_thin,
    ( SELECT count(*) AS count
           FROM spin_reserve_ledger l
          WHERE fn_spin_reserve_owner(l.club_id) = p.club_id AND l.kind = 'adjustment'::text) AS shortfall_events,
    ( SELECT count(*) AS count
           FROM tournaments t
          WHERE fn_spin_reserve_owner(t.club_id) = p.club_id AND t.variant = 'spin'::text AND (t.status = ANY (ARRAY['RUNNING'::text, 'COMPLETED'::text])) AND COALESCE(t.buy_in_fee, 0::numeric) = 0::numeric AND t.started_at > (now() - '24:00:00'::interval) AND NOT (EXISTS ( SELECT 1
                   FROM spin_reserve_ledger l2
                  WHERE l2.tournament_id = t.id))) AS unbooked_24h,
    -- A Spin that reached the felt without a draw. Should always be zero.
    ( SELECT count(*) AS count
           FROM tournaments t
          WHERE fn_spin_reserve_owner(t.club_id) = p.club_id AND t.variant = 'spin'::text AND (t.status = ANY (ARRAY['RUNNING'::text, 'COMPLETED'::text])) AND COALESCE(t.spin_multiplier, 0::numeric) <= 0::numeric AND t.started_at > (now() - '24:00:00'::interval)) AS null_multiplier_24h
   FROM spin_bonus_pools p
     LEFT JOIN clubs c ON c.id = p.club_id
     LEFT JOIN unions u ON u.id = p.club_id;

-- Post-apply assertions.
DO $assert$
DECLARE v_cols text[];
BEGIN
  SELECT array_agg(column_name::text ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'v_spin_reserve_health';

  IF NOT ('null_multiplier_24h' = ANY (v_cols)) THEN
    RAISE EXCEPTION 'v_spin_reserve_health did not gain null_multiplier_24h';
  END IF;
  -- The columns the deployed World Hub cron selects must still be there.
  IF NOT ('can_draw_500x' = ANY (v_cols)) OR NOT ('unbooked_24h' = ANY (v_cols))
     OR NOT ('shortfall_events' = ANY (v_cols)) THEN
    RAISE EXCEPTION 'v_spin_reserve_health lost a column a deployed reader selects';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_spin_repair_missing_multiplier') THEN
    RAISE EXCEPTION 'fn_spin_repair_missing_multiplier was not created';
  END IF;

  IF has_function_privilege('anon',
       'public.fn_spin_repair_missing_multiplier(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_spin_repair_missing_multiplier(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_spin_repair_missing_multiplier is reachable by a player role';
  END IF;
END $assert$;
