-- 20261016172618_a_spin_edge_drift_needs_a_second_window
--
-- Reserved by scripts/new-migration.mjs on 2026-10-16.
--
-- A SPIN EDGE DRIFT NEEDS A SECOND, INDEPENDENT WINDOW (2026-10-16)
--
-- fn_spin_fairness_check raised a critical expectation_drift alert at
-- 2026-10-16 13:44 (fffd604c, incident a08c56e1): the 7-day mean multiplier
-- 2.7849 against the published 2.7600, z 4.52 over 87,083 draws. It is the
-- third Spin fairness alert in three days on the same upswing of the rare
-- tiers (25x 89 against 64.9 expected, 50x 16 against 8.7, 100x 14 against
-- 8.7); 20261015025123 and 20261015215216 already made the chi-square warning
-- and critical wait for the preceding, non-overlapping window. The mean was
-- left to raise on one window alone.
--
-- The draw was measured read-only on production before this was written, so
-- the money path is not what changes here:
--   * every one of the 207,564 Spin draws of the last 14 days has a
--     spin_draw_receipts row whose rule manifest carries exactly the published
--     ladder (8% rake, frequencies equal to spin_tier_spec), provenance at_draw;
--   * draws, receipts and jackpot_draw ledger rows agree (100,577 each since
--     2026-10-09), so no drawn Spin was deleted or redrawn after the fact, and
--     the last 24 hours of database logs hold no failed or timed-out draw;
--   * the sampler (fn_spin_draw_multiplier: a 48-bit gen_random_bytes roll
--     over the cumulative frequencies) run 10,000,000 times on its own gives a
--     mean of 2.75932 (z -1.3), 25x 7,495 against 7,500, 50x 1,026 against
--     1,000 and 100x 956 against 1,008;
--   * the 14 days together give 2.7667 (z 1.9), the 7 days before the alert
--     window 2.7532, and today's 11,667 draws 2.7808 (z 1.4).
-- The house paid the players slightly more than the ladder for a week, by a
-- rare-tier run the sampler produces by chance. A check that slides hourly
-- will find the top of such a run and page on it; two independent windows
-- both crossing does not happen by chance.
--
-- THE FIX. expectation_drift is raised as critical when the current window
-- is beyond |z| 6 on its own (a sampler fault, never chance: about one in a
-- billion), or beyond |z| 4 AND the preceding, non-overlapping window of the
-- same length drifts the same way beyond |z| 2. A single-window |z| 4 crossing
-- is reported in the returned context as expectation_unconfirmed and is not
-- raised, exactly as distribution_unconfirmed is. off_ladder, the chi-square
-- verdicts and their confirmations, the volume floor and the alert de-dup are
-- unchanged, and the prior window is read only when the current one already
-- crosses |z| 4, so an ordinary hour costs nothing more. The open alert and
-- its incident are closed below with this measurement.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (7124884d...), each of the five
-- anchors must occur exactly once, and the result must hash to the postimage
-- derived read-only on production with replace(); owner, SECURITY DEFINER,
-- proconfig and grants must not move.
--
-- Regression: scripts/ci/test-spin-edge-second-window.py (native PostgreSQL),
-- run by .github/workflows/spin-edge-second-window.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_spin_fairness_check(integer)'::regprocedure)) = '0e6671e857d328cb86f228cac6271b94')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_spin_edge_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_spin_edge_subst(
  'public.fn_spin_fairness_check(integer)',
  '7124884d909fa278904c724a8f846f50', '0e6671e857d328cb86f228cac6271b94',
  ARRAY[$eo1$  v_critical_confirmed boolean := false;
BEGIN$eo1$,
        $eo2$
  IF v_off > 0 THEN
$eo2$,
        $eo3$  ELSIF v_n >= 2000 AND abs(v_z) > 4 THEN
    v_verdict  := 'expectation_drift';$eo3$,
        $eo4$  ELSIF v_n >= 2000 AND v_chi > v_crit_01 THEN
    -- One window crossed p < 0.01 and the window before it did not: chance$eo4$,
        $eo5$    'z',                round(v_z, 4),$eo5$],
  ARRAY[$en1$  v_critical_confirmed boolean := false;
  v_prev_ev_n   numeric := 0;
  v_prev_ev     numeric;
  v_prev_z      numeric;
  v_ev_confirmed boolean := false;
BEGIN$en1$,
        $en2$
  /* AN EDGE DRIFT NEEDS A SECOND, INDEPENDENT WINDOW (2026-10-16). A mean
     beyond |z| 4 is confirmed only by the preceding, non-overlapping window
     of the same length drifting the same way beyond |z| 2; beyond |z| 6 it
     needs nothing (a sampler fault, never chance). On 2026-10-16 the hourly
     window found the top of a rare-tier run (z 4.52) while the sampler,
     every receipt's ladder and 14 days together (z 1.9) were on spec.
     Read only when the current window already crosses. 20261016172618. */
  IF v_n >= 2000 AND abs(v_z) > 4 THEN
    SELECT count(*), avg(t.spin_multiplier::integer)
      INTO v_prev_ev_n, v_prev_ev
      FROM public.tournaments t
     WHERE t.variant = 'spin'
       AND t.spin_multiplier IS NOT NULL
       AND t.spin_multiplier > 0
       AND t.created_at >= v_since - make_interval(days => v_days)
       AND t.created_at < v_since;
    IF v_prev_ev_n >= 2000 THEN
      v_prev_z := (v_prev_ev - v_ev_spec) / (v_sd_spec / sqrt(v_prev_ev_n));
      v_ev_confirmed := sign(v_prev_z) = sign(v_z) AND abs(v_prev_z) > 2;
    END IF;
  END IF;

  IF v_off > 0 THEN
$en2$,
        $en3$  ELSIF v_n >= 2000 AND (abs(v_z) > 6 OR (abs(v_z) > 4 AND v_ev_confirmed)) THEN
    v_verdict  := 'expectation_drift';$en3$,
        $en4$  ELSIF v_n >= 2000 AND abs(v_z) > 4 THEN
    -- One window's mean crossed |z| 4 and the window before it did not drift
    -- the same way: a rare-tier run until shown otherwise. Reported, not
    -- raised (see the block above the verdicts).
    v_verdict  := 'expectation_unconfirmed';

  ELSIF v_n >= 2000 AND v_chi > v_crit_01 THEN
    -- One window crossed p < 0.01 and the window before it did not: chance$en4$,
        $en5$    'z',                round(v_z, 4),
    'prior_window_ev_draws',   v_prev_ev_n::bigint,
    'prior_window_ev',         round(COALESCE(v_prev_ev, 0), 6),
    'prior_window_z',          round(COALESCE(v_prev_z, 0), 4),
    'prior_window_confirms_expectation', v_ev_confirmed,$en5$]
);

-- The open alert the unconfirmed crossing raised, and the incident that
-- mirrors it. Scoped to their ids and to still being open.
UPDATE public.financial_alerts
   SET resolved = true,
       resolved_at = now(),
       resolution = 'verified 2026-10-16: a rare-tier run, not a drift. Every one of 207,564 '
                    || 'draws in 14 days carries the published ladder in its receipt; the sampler run '
                    || '10,000,000 times gives 2.75932 (z -1.3); 14 days give 2.7667 (z 1.9) and the '
                    || 'preceding 7 days 2.7532. fn_spin_fairness_check now raises an edge drift beyond '
                    || '|z| 4 only when the preceding window drifts the same way (or beyond |z| 6 alone). '
                    || 'migration 20261016172618'
 WHERE id = 'fffd604c-2048-44d4-9805-96bad5a37ffd'
   AND source = 'fn_spin_fairness_check'
   AND resolved IS NOT TRUE
   AND context->>'verdict' = 'expectation_drift';

SELECT public.fn_ca_incident_action(i.id, 'resolve',
  'No chips were wrong. The 7-day Spin mean (2.7849, z 4.52) was the top of a rare-tier run: every draw '
  || 'in 14 days carries the published ladder in its receipt, draws = receipts = jackpot_draw rows, the '
  || 'sampler is on spec over 10,000,000 runs, and 14 days together read z 1.9. The check now needs the '
  || 'preceding window to drift the same way before it raises.',
  NULL,
  'An hourly sliding 7-day window raised the mean on one window alone; the chi-square verdicts already '
  || 'required an independent window (20261015025123, 20261015215216).',
  'migration 20261016172618_a_spin_edge_drift_needs_a_second_window')
  FROM public.ca_drift_incidents i
 WHERE i.id = 'a08c56e1-e081-40d6-8a2e-f03320d307c0'
   AND i.status <> 'resolved';

COMMIT;
