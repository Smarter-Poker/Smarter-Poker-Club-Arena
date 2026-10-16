CREATE OR REPLACE FUNCTION public.fn_spin_fairness_check(p_since_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
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

  v_prev_n      numeric := 0;
  v_prev_counts jsonb   := '{}'::jsonb;
  v_prev_chi    numeric := 0;
  v_prev_cells  integer := 0;
  v_prev_crit   numeric;
  v_confirmed   boolean := false;
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
    -- volume 50x and 100x each expect ~2.5 draws, and a cell with expected
    -- under 5 does not follow the chi-square distribution -- it would page
    -- somebody because one player got paid.
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

    -- A WARNING NEEDS A SECOND, INDEPENDENT WINDOW (2026-10-15). This runs
    -- hourly over a sliding window, so a p < 0.01 line is crossed by chance
    -- on a ladder that is exactly on spec (2026-10-14 22:44, chi-square
    -- 18.51 against 18.475, with the windows either side at z -1.33 and
    -- 0.07). Measure the preceding window of the same length the same way:
    -- a real drift crosses both, chance crosses both about once in ten
    -- thousand. Migration 20261015025123.
    IF v_chi > v_crit_01 THEN
      SELECT COALESCE(sum(d.c), 0), COALESCE(jsonb_object_agg(d.m::text, d.c), '{}'::jsonb)
        INTO v_prev_n, v_prev_counts
        FROM (SELECT t.spin_multiplier::integer AS m, count(*) AS c
                FROM public.tournaments t
               WHERE t.variant = 'spin'
                 AND t.spin_multiplier IS NOT NULL
                 AND t.spin_multiplier > 0
                 AND t.created_at >= v_since - make_interval(days => v_days)
                 AND t.created_at < v_since
               GROUP BY 1) d;

      IF v_prev_n >= 2000 THEN
        v_acc_e := 0;
        v_acc_a := 0;
        FOR v_cell IN
          SELECT v_prev_n * s.freq / v_spec_freq                                AS e,
                 COALESCE((v_prev_counts ->> s.multiplier::text)::numeric, 0)  AS a
            FROM public.spin_tier_spec s
           ORDER BY s.multiplier DESC
        LOOP
          v_acc_e := v_acc_e + v_cell.e;
          v_acc_a := v_acc_a + v_cell.a;
          IF v_acc_e >= 5 THEN
            v_prev_chi   := v_prev_chi + (v_acc_a - v_acc_e) ^ 2 / v_acc_e;
            v_prev_cells := v_prev_cells + 1;
            v_acc_e := 0;
            v_acc_a := 0;
          END IF;
        END LOOP;
        IF v_acc_e > 0 AND v_prev_cells > 0 THEN
          v_prev_chi := v_prev_chi + (v_acc_a - v_acc_e) ^ 2 / v_acc_e;
        END IF;
        v_prev_crit := (ARRAY[6.635, 9.210, 11.345, 13.277, 15.086,
                              16.812, 18.475, 20.090])[LEAST(GREATEST(v_prev_cells - 1, 1), 8)];
        v_confirmed := v_prev_chi > v_prev_crit;
      END IF;
    END IF;
  END IF;

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

  ELSIF v_n >= 2000 AND v_chi > v_crit_01 AND v_confirmed THEN
    v_verdict  := 'distribution_warning';
    v_severity := 'warning';
    v_message  := format(
      'Spin draw distribution is drifting from the published ladder: '
      'chi-square %s on %s df over %s draws (p < 0.01).',
      round(v_chi, 2), v_df, v_n::bigint);

  ELSIF v_n >= 2000 AND v_chi > v_crit_01 THEN
    -- One window crossed p < 0.01 and the window before it did not: chance
    -- until shown otherwise. Reported, not raised (see the block above).
    v_verdict  := 'distribution_unconfirmed';

  ELSIF v_locked > 0 THEN
    /* A LOCKED TIER IS SHOWN WHERE IT IS DRAWN (2026-10-05). This branch
       warned that the odds sheet shown at buy-in advertised the full ladder
       with no availability qualification. That sheet was removed on
       2026-09-05 (Dan: nobody ever sees the odds; the buy-in sheet has no
       render path for them and tests/unit/spinOddsOnBuyInSheet.test.ts keeps
       it so). The wheel draws each locked tier as LOCKED with its unlock
       threshold, and the lobby badge reads v_spin_tier_availability, the
       draw's own arithmetic. A lock is the reserve gate working as designed
       (eligibleSpinTiers), so it is reported in the returned context and not
       raised. Every verdict that measures the money the player was promised -
       off_ladder, distribution_critical, expectation_drift and
       distribution_warning - keeps its severity, and distribution_warning is
       now read before this branch instead of being shadowed by it.
       Migration 20261005113359. */
    v_verdict  := 'tiers_locked';

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
    'prior_window_draws',      v_prev_n::bigint,
    'prior_window_chi_square', round(v_prev_chi, 4),
    'prior_window_confirms',   v_confirmed,
    'verdict',          v_verdict,
    'detail',           'no money was moved by this check; see '
                        'v_spin_draw_distribution_7d for the per-tier counts');

  -- One open alert per verdict at a time: the window slides hourly, so
  -- re-raising an unresolved condition would bury the alert list in a day.
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
$function$
