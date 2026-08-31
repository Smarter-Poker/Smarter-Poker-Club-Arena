-- ═══════════════════════════════════════════════════════════════════════════
--  SPIN FAIRNESS GUARD — the wheel audits itself, hourly
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS
--
-- The Spin draw distribution has been audited exactly twice, both times BY
-- HAND (.agent/audits/2026-08-28-spin-deep-dive-and-platform-sweep.md and the
-- round-11 changelog). Both passed. Neither left anything behind that would
-- notice the third time.
--
-- A skewed wheel is the worst-shaped bug in this system, because it is
-- invisible to a player AND to the ledger. The money still conserves. The
-- reserve still balances. Every game still pays exactly buy_in x multiplier.
-- Only the FREQUENCIES are wrong, and nobody sees a frequency.
--
-- This codebase has already shipped that bug once. Before 2026-08-22 three
-- multiplier tables disagreed (EV 3.00 / 2.75 / 2.24) and the one that ran was
-- not the one that was documented; the all-time draw data still carries a
-- ten-sigma 2x/3x skew from that era. src/config/spinSpec.ts and its test now
-- make the two TypeScript copies impossible to fork. Nothing watched the copy
-- PostgreSQL actually deals from.
--
-- WHAT IT CHECKS (all four are things nothing else looks at)
--
--   1. OFF-LADDER DRAWS. A multiplier not on the published ladder at all.
--      Zero tolerance, any volume: it means a table forked again.
--   2. DISTRIBUTION. Pearson chi-square of observed tier counts against the
--      published frequencies, with the rare tail pooled.
--   3. EXPECTATION. The mean multiplier against 2.763773, as a z-test. A
--      distribution can pass a chi-square and still drift the house edge if
--      the error concentrates in the tail — which is exactly where the money
--      is — so the edge is tested on its own terms rather than inferred.
--   4. TIER LOCKING. The reserve gate can exclude 100x from a draw. The odds
--      sheet the player is shown carries no "when available" qualification,
--      which is honest only while nothing is ever locked.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5). There is no is_horse filter anywhere in
-- this file and there must never be one. Horses are ~all of the Spin volume;
-- excluding them would leave the guard measuring a few hundred draws a week
-- and blind to the fleet the wheel actually deals to. There is deliberately no
-- p_include_horses parameter to default to true, because there is nothing to
-- opt into. tests/config/spinSpecMatchesDatabase.test.ts fails if is_horse
-- ever appears here.
--
-- WHERE IT RUNS: pg_cron, hourly at :28 (see the companion schedule
-- migration), beside the ten sibling money-integrity audits. Open Claw is the
-- right home for an HTTP application trigger; this is pure SQL with no HTTP
-- surface, and giving it one would mean a net-new pages/api/cron/ file, which
-- World Hub CLAUDE.md 11.3 bans outright.
--
-- VERIFIED IN PRODUCTION 2026-08-31, and verified to FIRE as well as to pass —
-- a gate that passes by doing nothing is the failure this repo has already
-- documented. Probed inside a rolled-back transaction (CLAUDE.md 11.5):
--   - removing 10x from the ladder      -> verdict off_ladder, 236 draws, 1 alert
--   - swapping the 2x and 3x frequencies-> verdict distribution_critical,
--                                          chi-square 739.17 on 5 df (crit 20.5),
--                                          z = -7.34, 1 alert
-- Live reading at apply time: 21,263 draws, chi-square 10.31 on 5 df against a
-- 0.01 critical value of 15.086, E[mult] 2.763251 against a published 2.763773
-- (z = -0.047). The wheel players are sold is the wheel they get.

CREATE TABLE IF NOT EXISTS public.spin_tier_spec (
  multiplier          integer PRIMARY KEY,
  freq                bigint  NOT NULL CHECK (freq > 0),
  reserve_threshold_x numeric NOT NULL DEFAULT 0,
  CONSTRAINT spin_tier_spec_multiplier_positive CHECK (multiplier > 0)
);

COMMENT ON TABLE public.spin_tier_spec IS
  'The published Spin multiplier ladder, mirrored from src/config/spinSpec.ts. '
  'Frequencies are per SPIN_FREQ_DENOMINATOR (10,000,099). Read-only reference '
  'data: fn_spin_fairness_check measures the live draw against it.';

-- Seeded, not appended: this statement is the whole ladder, so re-running the
-- migration cannot leave a retired tier (the 500x, say) behind as a live row.
DELETE FROM public.spin_tier_spec
 WHERE multiplier NOT IN (2, 3, 4, 5, 10, 25, 50, 100);

INSERT INTO public.spin_tier_spec (multiplier, freq, reserve_threshold_x) VALUES
  (2,   4772073, 0),
  (3,   3968518, 0),
  (4,    900000, 0),
  (5,    250000, 0),
  (10,   100000, 0),
  (25,     7500, 0),
  (50,     1000, 0),
  (100,    1008, 1.5)
ON CONFLICT (multiplier) DO UPDATE
  SET freq = EXCLUDED.freq,
      reserve_threshold_x = EXCLUDED.reserve_threshold_x;

-- The arithmetic that IS the product. If a future edit moves frequency mass
-- around without holding these, the migration refuses rather than quietly
-- repricing the game — which is precisely what the 500x retirement had to be
-- careful about (it moved 508 units into 100x and compensated 2x and 3x so
-- that both totals stayed invariant).
DO $$
DECLARE
  v_freq  bigint;
  v_units bigint;
  v_ev    numeric;
  v_edge  numeric;
BEGIN
  SELECT sum(freq), sum(multiplier::bigint * freq)
    INTO v_freq, v_units
    FROM public.spin_tier_spec;

  IF v_freq <> 10000099 THEN
    RAISE EXCEPTION 'spin_tier_spec total frequency is %, expected 10000099', v_freq;
  END IF;

  IF v_units <> 27638000 THEN
    RAISE EXCEPTION 'spin_tier_spec weighted units are %, expected 27638000 -- '
                    'moving mass between tiers must hold this total or the '
                    'house edge changes as a side effect', v_units;
  END IF;

  v_ev   := v_units::numeric / v_freq::numeric;
  v_edge := (3::numeric - v_ev) / 3::numeric;

  -- E[multiplier] = seats x (1 - rake_rate); at 3 seats this is an equality
  -- satisfied at 8% and at no other rate. See spinSpec.ts.
  IF abs(v_edge - 0.08) > 0.005 THEN
    RAISE EXCEPTION 'spin_tier_spec implies a house edge of %, not the '
                    'advertised 8%% (E[mult]=%)', round(v_edge, 6), round(v_ev, 6);
  END IF;
END $$;

ALTER TABLE public.spin_tier_spec ENABLE ROW LEVEL SECURITY;

-- The ladder is already published to players (the odds sheet on the buy-in
-- sheet). Readable by anyone; writable by nobody but the service role, so a
-- browser cannot reprice the game.
DROP POLICY IF EXISTS spin_tier_spec_read ON public.spin_tier_spec;
CREATE POLICY spin_tier_spec_read ON public.spin_tier_spec FOR SELECT USING (true);

REVOKE INSERT, UPDATE, DELETE ON public.spin_tier_spec FROM anon, authenticated;
GRANT SELECT ON public.spin_tier_spec TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.spin_tier_spec TO service_role;

-- `variant = 'spin'` is the predicate. `spin_type IS NOT NULL` is NOT: it is
-- also set on heads-up sit-and-gos and on ordinary MTTs (13,709 of them since
-- 2026-08-22, all carrying spin_multiplier = 0), so a population built on it
-- is one third non-Spins and every percentage computed from it is wrong. The
-- existing money views (v_spin_unpaid_settlements, v_spin_draw_booking_gaps)
-- already join on variant; this guard matches them deliberately.
CREATE OR REPLACE VIEW public.v_spin_draw_distribution_7d AS
WITH drawn AS (
  SELECT t.spin_multiplier::integer AS multiplier
    FROM public.tournaments t
   WHERE t.variant = 'spin'
     AND t.spin_multiplier IS NOT NULL
     AND t.spin_multiplier > 0
     AND t.created_at >= now() - interval '7 days'
), n AS (
  SELECT count(*)::numeric AS draws FROM drawn
), denom AS (
  SELECT sum(freq)::numeric AS f FROM public.spin_tier_spec
)
SELECT s.multiplier,
       COALESCE(a.actual, 0)                                            AS actual,
       round((SELECT draws FROM n) * s.freq / (SELECT f FROM denom), 2) AS expected,
       round(100 * COALESCE(a.actual, 0)
             / NULLIF((SELECT draws FROM n), 0), 4)                     AS actual_pct,
       round(100 * s.freq / (SELECT f FROM denom), 4)                   AS spec_pct,
       (SELECT draws FROM n)::bigint                                    AS window_draws
  FROM public.spin_tier_spec s
  LEFT JOIN (SELECT multiplier, count(*)::numeric AS actual
               FROM drawn GROUP BY multiplier) a
         ON a.multiplier = s.multiplier
 ORDER BY s.multiplier;

COMMENT ON VIEW public.v_spin_draw_distribution_7d IS
  'Live Spin draw counts against the published ladder over the trailing 7 days. '
  'Includes horses (CLAUDE.md 10.5) -- they are most of the volume.';

GRANT SELECT ON public.v_spin_draw_distribution_7d TO service_role;

CREATE OR REPLACE FUNCTION public.fn_spin_fairness_check(p_since_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- A week is the shortest window that gives the 25x tier an expected count
  -- worth testing (~16 at current volume). Shorter windows do not fail safe,
  -- they fail NOISY.
  v_days      integer := GREATEST(COALESCE(p_since_days, 7), 1);
  v_since     timestamptz := now() - make_interval(days => v_days);

  v_n         numeric := 0;
  v_counts    jsonb   := '{}'::jsonb;
  v_off       bigint  := 0;
  v_off_list  jsonb   := '[]'::jsonb;
  v_locked    bigint  := 0;

  v_chi       numeric := 0;
  v_df        integer := 0;
  v_pooled    integer := 0;
  v_crit_01   numeric;
  v_crit_001  numeric;
  v_spec_freq numeric;

  v_ev_spec   numeric;
  v_sd_spec   numeric;
  v_ev_actual numeric;
  v_z         numeric := 0;

  v_verdict   text := 'pass';
  v_severity  text;
  v_message   text;
  v_context   jsonb;
  v_alerts    integer := 0;

  v_cell      record;
  v_acc_e     numeric := 0;
  v_acc_a     numeric := 0;
  v_cells     integer := 0;
BEGIN
  -- Population: variant and nothing else. No is_horse filter (CLAUDE.md 10.5)
  -- -- horses are most of the volume, and excluding them would leave this
  -- measuring a few hundred draws a week.
  SELECT COALESCE(count(*), 0), COALESCE(avg(m), 0)
    INTO v_n, v_ev_actual
    FROM (SELECT t.spin_multiplier::integer AS m
            FROM public.tournaments t
           WHERE t.variant = 'spin'
             AND t.spin_multiplier IS NOT NULL
             AND t.spin_multiplier > 0
             AND t.created_at >= v_since) d;

  SELECT COALESCE(jsonb_object_agg(m::text, c), '{}'::jsonb)
    INTO v_counts
    FROM (SELECT t.spin_multiplier::integer AS m, count(*) AS c
            FROM public.tournaments t
           WHERE t.variant = 'spin'
             AND t.spin_multiplier IS NOT NULL
             AND t.spin_multiplier > 0
             AND t.created_at >= v_since
           GROUP BY 1) d;

  -- Check 1: off-ladder multipliers. Zero tolerance, any volume.
  SELECT COALESCE(sum((kv.value)::text::bigint), 0),
         COALESCE(jsonb_agg(kv.key::integer ORDER BY kv.key::integer), '[]'::jsonb)
    INTO v_off, v_off_list
    FROM jsonb_each(v_counts) kv
   WHERE NOT EXISTS (SELECT 1 FROM public.spin_tier_spec s
                      WHERE s.multiplier = kv.key::integer);

  -- Check 4: did any draw run with a tier locked out?
  SELECT count(*)
    INTO v_locked
    FROM public.tournaments t
   WHERE t.variant = 'spin'
     AND t.created_at >= v_since
     AND t.spin_locked_tiers IS NOT NULL
     AND jsonb_typeof(t.spin_locked_tiers) = 'array'
     AND jsonb_array_length(t.spin_locked_tiers) > 0;

  IF v_n >= 2000 THEN
    SELECT sum(s.freq),
           sum(s.multiplier::numeric * s.freq) / sum(s.freq),
           sqrt(sum((s.multiplier::numeric ^ 2) * s.freq) / sum(s.freq)
                - (sum(s.multiplier::numeric * s.freq) / sum(s.freq)) ^ 2)
      INTO v_spec_freq, v_ev_spec, v_sd_spec
      FROM public.spin_tier_spec s;

    -- Check 3: the house edge, on its own terms. A distribution can pass a
    -- chi-square and still drift the edge if the error concentrates in the
    -- tail, which is where the money is.
    v_z := (v_ev_actual - v_ev_spec) / (v_sd_spec / sqrt(v_n));

    -- Check 2: Pearson chi-square, rare tail pooled. At a week of current
    -- volume 50x and 100x each expect ~2.1 draws, and a cell with expected
    -- under 5 does not follow the chi-square distribution -- it would page
    -- somebody at 3am because one player got paid.
    FOR v_cell IN
      SELECT s.multiplier,
             v_n * s.freq / v_spec_freq                              AS e,
             COALESCE((v_counts ->> s.multiplier::text)::numeric, 0)  AS a
        FROM public.spin_tier_spec s
       ORDER BY s.multiplier DESC
    LOOP
      v_acc_e := v_acc_e + v_cell.e;
      v_acc_a := v_acc_a + v_cell.a;

      IF v_acc_e >= 5 THEN
        v_chi   := v_chi + (v_acc_a - v_acc_e) ^ 2 / v_acc_e;
        v_cells := v_cells + 1;
        IF v_acc_e > v_cell.e THEN
          v_pooled := v_pooled + 1;
        END IF;
        v_acc_e := 0;
        v_acc_a := 0;
      END IF;
    END LOOP;

    -- A remainder means the densest tiers could not reach an expected 5, which
    -- cannot happen above the volume gate. Fold it into the last cell rather
    -- than discarding observations.
    IF v_acc_e > 0 AND v_cells > 0 THEN
      v_chi := v_chi + (v_acc_a - v_acc_e) ^ 2 / v_acc_e;
    END IF;

    v_df := GREATEST(v_cells - 1, 1);

    -- Upper-tail critical values. Postgres has no chi-square CDF and this
    -- needs no more than a lookup: 8 tiers, so df cannot exceed 7.
    v_crit_01  := (ARRAY[6.635, 9.210, 11.345, 13.277, 15.086,
                         16.812, 18.475, 20.090])[LEAST(v_df, 8)];
    v_crit_001 := (ARRAY[10.828, 13.816, 16.266, 18.467, 20.515,
                         22.458, 24.322, 26.125])[LEAST(v_df, 8)];
  END IF;

  -- Verdict, worst harm first.
  IF v_off > 0 THEN
    v_verdict  := 'off_ladder';
    v_severity := 'critical';
    v_message  := format(
      'Spin dealt %s draw(s) at multipliers that are not on the published '
      'ladder (%s). The engine and spin_tier_spec disagree about what game '
      'this is.', v_off, v_off_list::text);

  ELSIF v_n >= 2000 AND v_chi > v_crit_001 THEN
    v_verdict  := 'distribution_critical';
    v_severity := 'critical';
    v_message  := format(
      'Spin draw distribution does not match the published ladder: '
      'chi-square %s on %s df over %s draws (p < 0.001).',
      round(v_chi, 2), v_df, v_n::bigint);

  ELSIF v_n >= 2000 AND abs(v_z) > 4 THEN
    v_verdict  := 'expectation_drift';
    v_severity := 'critical';
    v_message  := format(
      'Spin expected multiplier has drifted to %s against a published %s '
      '(z = %s over %s draws) -- the house edge is not what the player was told.',
      round(v_ev_actual, 4), round(v_ev_spec, 4), round(v_z, 2), v_n::bigint);

  ELSIF v_locked > 0 THEN
    v_verdict  := 'tiers_locked';
    v_severity := 'warning';
    v_message  := format(
      '%s Spin(s) drew from a reduced ladder in the last %s day(s). The odds '
      'sheet shown at buy-in advertises the full ladder with no availability '
      'qualification.', v_locked, v_days);

  ELSIF v_n >= 2000 AND v_chi > v_crit_01 THEN
    v_verdict  := 'distribution_warning';
    v_severity := 'warning';
    v_message  := format(
      'Spin draw distribution is drifting from the published ladder: '
      'chi-square %s on %s df over %s draws (p < 0.01).',
      round(v_chi, 2), v_df, v_n::bigint);

  ELSIF v_n < 2000 THEN
    v_verdict := 'insufficient_volume';
  END IF;

  v_context := jsonb_build_object(
    'window_days',      v_days,
    'draws',            v_n::bigint,
    'off_ladder',       v_off,
    'off_ladder_mults', v_off_list,
    'locked_draws',     v_locked,
    'chi_square',       round(v_chi, 4),
    'degrees_freedom',  v_df,
    'pooled_cells',     v_pooled,
    'crit_p01',         v_crit_01,
    'crit_p001',        v_crit_001,
    'ev_actual',        round(COALESCE(v_ev_actual, 0), 6),
    'ev_spec',          round(COALESCE(v_ev_spec, 0), 6),
    'z',                round(v_z, 4),
    'verdict',          v_verdict,
    'detail',           'no money was moved by this check; see '
                        'v_spin_draw_distribution_7d for the per-tier counts');

  -- One open alert per verdict at a time: the window slides hourly, so
  -- re-raising an unresolved condition would bury the alert list in a day --
  -- which is what happened to the payout sweep before it learned the same
  -- handshake.
  IF v_severity IS NOT NULL THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT v_severity, 'fn_spin_fairness_check', v_message, v_context
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_spin_fairness_check'
          AND fa.resolved IS NOT TRUE
          AND fa.context->>'verdict' = v_verdict);
    IF FOUND THEN v_alerts := 1; END IF;
  END IF;

  RETURN v_context || jsonb_build_object('ok', true, 'alerts_raised', v_alerts);
END;
$function$;

COMMENT ON FUNCTION public.fn_spin_fairness_check(integer) IS
  'Audits the live Spin draw against the published ladder: off-ladder '
  'multipliers, chi-square of the tier distribution, z-test of the expected '
  'multiplier, and whether any draw ran with a tier locked out. Raises into '
  'financial_alerts, moves no money. Counts horses (CLAUDE.md 10.5).';

-- A maintenance RPC, not a browser one -- same treatment as fn_spin_unpaid_check.
REVOKE ALL ON FUNCTION public.fn_spin_fairness_check(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_fairness_check(integer) TO service_role;

DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.fn_spin_fairness_check(integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_spin_fairness_check(integer)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'fn_spin_fairness_check grants did not take';
  END IF;
END $$;
