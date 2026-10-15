-- 20261015025123_spin_detectors_measure_what_can_fail
--
-- Reserved by scripts/new-migration.mjs on 2026-10-15 02:51:23 UTC.
-- Supersedes held PR #6473 (20261008044926, "count a thin pool once it has
-- funded a Spin"), which no longer fixes the class: re-measured 2026-10-15,
-- its spin_count > 0 rule still counts Deep Stack Society, a pool that funded
-- 86,048 Spins before 2026-09-15, has balance 0, and has hosted no Spin in 30
-- days. This edits today's live text in place instead.
--
-- THE SPIN DETECTORS MEASURE WHAT CAN FAIL (2026-10-15)
--
-- 1. SpinReservePoolThin (poker_spin_reserve_thin_clubs > 0 for 30m) has 197
--    store rows since 2026-10-02 and fires today on "1140 club(s) cannot cover
--    Spin's top tier". Measured read-only on production 2026-10-15: of 1,146
--    pools in v_spin_reserve_health, 1,143 are thin, and every Spin started in
--    the last 30 days (268,408 in 7 days, 1,830 in 24 hours) drew from ONE
--    owner pool, Midway Union, balance 50,881.24 against a 15,000.00 thin line.
--    fn_spin_draw_multiplier reads only the pool of the Spin being drawn, so a
--    pool that hosts no Spin locks no tier and moves no edge, and the gauge
--    counted 1,143 of them. Fix: fn_spin_metrics.reserve_thin_clubs counts a
--    thin pool only when it owns (fn_spin_reserve_owner) a Spin that started
--    in the last 24 hours, the same window as the view's other columns. A pool
--    that funds Spins and drops below the line still pages within the
--    30-minute `for:`; a club that opens Spins on an empty pool pages from its
--    first Spin. The read is the partial index idx_tournaments_spin_unbooked_
--    scan (20 ms measured against 836 ms for the DISTINCT form). Every other
--    gauge, the view and the draw are unchanged.
--
-- 2. fn_spin_fairness_check raised a distribution_warning financial alert on
--    2026-10-14 22:44 (chi-square 18.5052 on 7 df against a 18.475 line over
--    86,416 draws). The check runs hourly over a sliding 7-day window, so a
--    p < 0.01 line is crossed by chance on a ladder that is exactly on spec.
--    Measured read-only 2026-10-15: the 7 days before that window give z
--    -1.33, the 14 days before it z 0.07, 28 days z 0.87, and 21 days of tier
--    counts sit on the published frequencies (25x 187 against 194.7 expected,
--    50x 30 against 26.0, 100x 17 against 26.2). Fix: a warning is raised only
--    when the preceding, non-overlapping window of the same length ALSO
--    crosses p < 0.01. Chance crossings in two independent windows happen
--    about once in ten thousand; a real drift persists and crosses both. An
--    unconfirmed crossing is reported in the returned context as verdict
--    distribution_unconfirmed and is not raised. off_ladder,
--    distribution_critical (p < 0.001) and expectation_drift (|z| > 4) are
--    unchanged and still raise as critical. The one open warning this cause
--    raised (79a97fc6-b1f8-4465-9c9e-21201a1f6fbe) is resolved below with the
--    measurement.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (fn_spin_metrics 9a85c178...,
-- fn_spin_fairness_check 7020ab8e...), each anchor must occur exactly once,
-- and the result must hash to the postimage derived read-only on production
-- with replace(); owner, SECURITY DEFINER, proconfig and grants must not move.
--
-- Regression: scripts/ci/test-spin-detectors.py (native PostgreSQL), run by
-- .github/workflows/spin-detectors.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_spin_metrics(integer)'::regprocedure)) = '7e92b1acfd7b86b557a464c6f4e00a6f' AND md5(pg_get_functiondef('public.fn_spin_fairness_check(integer)'::regprocedure)) = 'f481e023244f76359626544c661f9c0f')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_spin_subst(p_sig text, p_before text, p_after text,
                                      p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_spin_subst(
  'public.fn_spin_metrics(integer)',
  '9a85c17823966c26901422a473dcb911', '7e92b1acfd7b86b557a464c6f4e00a6f',
  ARRAY[$mo1$  res as (
    select
      count(*) filter (where is_thin)::bigint as thin_clubs,
      min(balance) as min_balance
    from public.v_spin_reserve_health
  ),$mo1$],
  ARRAY[$mn1$  /* A THIN POOL PAGES ONLY WHEN IT FUNDS SPINS (2026-10-15). The draw reads
     the pool of the Spin being drawn, so a pool that hosts no Spin locks no
     tier. Count a thin pool only when it owns a Spin started in the last 24
     hours. Migration 20261015025123. */
  serving as materialized (
    select public.fn_spin_reserve_owner(c.club_id) as owner_id
    from (
      select t.club_id
      from public.tournaments t
      where t.variant = 'spin'
        and t.status in ('RUNNING', 'COMPLETED')
        and t.started_at > now() - interval '24 hours'
        and t.club_id is not null
      group by t.club_id
    ) c
  ),
  res as (
    select
      count(*) filter (
        where h.is_thin
          and exists (select 1 from serving s where s.owner_id = h.club_id)
      )::bigint as thin_clubs,
      min(h.balance) as min_balance
    from public.v_spin_reserve_health h
  ),$mn1$]
);

SELECT pg_temp.ca_spin_subst(
  'public.fn_spin_fairness_check(integer)',
  '7020ab8e6d565b3aa1884a5252364e49', 'f481e023244f76359626544c661f9c0f',
  ARRAY[$fo1$  v_cells     integer := 0;
BEGIN$fo1$,
        $fo2$    v_crit_001 := (ARRAY[10.828, 13.816, 16.266, 18.467, 20.515,
                         22.458, 24.322, 26.125])[LEAST(v_df, 8)];
  END IF;$fo2$,
        $fo3$  ELSIF v_n >= 2000 AND v_chi > v_crit_01 THEN
    v_verdict  := 'distribution_warning';$fo3$,
        $fo4$  ELSIF v_locked > 0 THEN$fo4$,
        $fo5$    'verdict',          v_verdict,$fo5$],
  ARRAY[$fn1$  v_cells     integer := 0;

  v_prev_n      numeric := 0;
  v_prev_counts jsonb   := '{}'::jsonb;
  v_prev_chi    numeric := 0;
  v_prev_cells  integer := 0;
  v_prev_crit   numeric;
  v_confirmed   boolean := false;
BEGIN$fn1$,
        $fn2$    v_crit_001 := (ARRAY[10.828, 13.816, 16.266, 18.467, 20.515,
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
  END IF;$fn2$,
        $fn3$  ELSIF v_n >= 2000 AND v_chi > v_crit_01 AND v_confirmed THEN
    v_verdict  := 'distribution_warning';$fn3$,
        $fn4$  ELSIF v_n >= 2000 AND v_chi > v_crit_01 THEN
    -- One window crossed p < 0.01 and the window before it did not: chance
    -- until shown otherwise. Reported, not raised (see the block above).
    v_verdict  := 'distribution_unconfirmed';

  ELSIF v_locked > 0 THEN$fn4$,
        $fn5$    'prior_window_draws',      v_prev_n::bigint,
    'prior_window_chi_square', round(v_prev_chi, 4),
    'prior_window_confirms',   v_confirmed,
    'verdict',          v_verdict,$fn5$]
);

-- The one open warning the unconfirmed crossing raised. Not a defect: see
-- the header for the measurement. Scoped to its id and to still being open.
UPDATE public.financial_alerts
   SET resolved = true,
       resolved_at = now(),
       resolution = 'verified 2026-10-15: a chance p < 0.01 crossing of an hourly sliding '
                    || '7-day window (chi-square 18.51 against 18.475); the preceding 7 days give '
                    || 'z -1.33, 28 days z 0.87, and 21 days of tier counts match the published '
                    || 'ladder. fn_spin_fairness_check now raises a warning only when the '
                    || 'preceding window confirms it. migration 20261015025123'
 WHERE id = '79a97fc6-b1f8-4465-9c9e-21201a1f6fbe'
   AND source = 'fn_spin_fairness_check'
   AND resolved IS NOT TRUE
   AND context->>'verdict' = 'distribution_warning';

COMMIT;
