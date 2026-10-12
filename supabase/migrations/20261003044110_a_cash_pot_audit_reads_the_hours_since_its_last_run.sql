-- ===========================================================================
--  A CASH POT AUDIT READS THE HOURS SINCE ITS LAST RUN
-- ===========================================================================
--
-- Launch-gate sweep, 2026-10-03. Read from cron.job_run_details and timed
-- read-only against production between 04:25 and 04:40 UTC.
--
-- ca-cash-pot-conservation-hourly (job 259, '34 */6 * * *') called
-- fn_cash_pot_conservation_check() with its default 24-hour window, every 6
-- hours, so each cash hand was read four times. Cash volume has grown to
-- ~15,000-18,000 cash hands with a pot per hour (33,195 in the last 2 h at
-- 04:35 UTC; the 2026-10-01 run read 207,668 in 24 h). The scan is
-- hand_history by idx_hand_history_created with a heap fetch per row and a
-- jsonb_array_elements sum over `winners`; it is IO-bound (one uncached hour
-- read 8,106 pages from disk and took 12.5 s). In the five runs to 04:30 UTC:
--
--   2026-10-02 00:34  failed  600 s  statement timeout, line 63 (the scan)
--   2026-10-02 06:34  failed  600 s  statement timeout, line 63
--   2026-10-02 12:34  ok      569 s
--   2026-10-02 18:34  ok      350 s
--   2026-10-03 00:34  failed  600 s  statement timeout, line 63
--
-- Each failure is delivered by trigger ca_cash_failed_run_intake to
-- public.operational_alert_events (source cash-pot-conservation-cron-failure,
-- severity critical, addressed to the production-alerts fleet task) and to
-- ca_cash_failed_run_outcomes. That inbox has no trigger, no publication and
-- no database reader that files into ca_drift_incidents; the only cron-failure
-- path into ca_drift_incidents is fn_ca_cron_failure_watch (5 failures and no
-- success in 2 hours), which a job that runs every 6 hours cannot reach. So a
-- failure here never moves fn_ca_midway_burnin_gate - but while it fails, no
-- cash hand's pot is checked at all.
--
-- WHAT CHANGES. The job calls fn_cash_pot_conservation_check(8). Runs are 6
-- hours apart, so every cash hand is still inside the window of the first run
-- after it is written, with 2 hours of overlap (hand_history.created_at is the
-- insert time: ended_at <= created_at, created_at - started_at <= 2.5 min,
-- measured over the last 90 minutes). Measured read-only on production at
-- 04:35 UTC, the same scan over 8 hours in 2-hour bands: 0-2 h 33,195 rows
-- 5.3 s, 2-4 h 34,438 rows 32.7 s, 4-6 h 29,405 rows 17.6 s, 6-8 h 27,851 rows
-- 7.1 s - 62.7 s for 124,889 rows against the 600 s budget, where the 24-hour
-- read needed 350-600+ s. The function body, its 48-hour ceiling, its alerts
-- and its evidence are unchanged; it already reports since_hours.
--
-- THE FAILURE INTAKE MOVES WITH IT. fn_ca_cash_failed_run_intake refuses
-- ("job contract drift") any run whose command is not its pinned v_command,
-- so a changed command with an unchanged pin would turn every future failure
-- into an undelivered intake_failed outcome. The pin is edited in the same
-- transaction by exact substitution (pinned preimage, the one anchor exactly
-- once, derived postimage computed read-only on production, owner/SECURITY
-- DEFINER/settings/grants unmoved). The schedule is unchanged. The CI
-- qualification fixtures (supabase/components/cash-failed-run-intake*.sql,
-- scripts/ci/test-cash-failure-pgcron.py, the reader and qualification SQL)
-- carry the same command, and their manifests are restamped in this PR.
-- ===========================================================================
-- @live-proof: (SELECT md5(command) = '574ffca254298b8638eb4f4ff048894e' AND schedule = '34 */6 * * *' AND active FROM cron.job WHERE jobid = 259) AND md5(pg_get_functiondef('public.fn_ca_cash_failed_run_intake()'::regprocedure)) = '23c2e46cf1e251d5e665056a2c1f09a6'

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
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

-- ---------------------------------------------------------------------------
-- 1. Preimage: the job is the command and schedule read on 2026-10-03
-- ---------------------------------------------------------------------------
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobid = 259 AND jobname = 'ca-cash-pot-conservation-hourly'
                    AND md5(command) = '72b3dc33b68f7354a0282c676315bc84'
                    AND schedule = '34 */6 * * *' AND active
                    AND database = 'postgres' AND username = 'postgres') THEN
    RAISE EXCEPTION 'preimage: cron job 259 is not the command and schedule read on 2026-10-03';
  END IF;
END $pre$;

-- ---------------------------------------------------------------------------
-- 2. The job reads 8 hours every 6 hours
-- ---------------------------------------------------------------------------
SELECT cron.alter_job(259, command := replace(command,
         'public.fn_cash_pot_conservation_check())',
         'public.fn_cash_pot_conservation_check(8))'))
  FROM cron.job WHERE jobid = 259;

-- ---------------------------------------------------------------------------
-- 3. The failure intake pins the same command
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_cash_failed_run_intake()',
  '3ef722e8990b508b8741ee2e558f19c1', '23c2e46cf1e251d5e665056a2c1f09a6',
  ARRAY['public.fn_cash_pot_conservation_check()) ELSE -1 END;'],
  ARRAY['public.fn_cash_pot_conservation_check(8)) ELSE -1 END;']);

-- ---------------------------------------------------------------------------
-- 4. Postimage: the job and the intake's contract agree
-- ---------------------------------------------------------------------------
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobid = 259 AND jobname = 'ca-cash-pot-conservation-hourly'
                    AND md5(command) = '574ffca254298b8638eb4f4ff048894e'
                    AND command = 'SET statement_timeout = ''600s''; SELECT CASE WHEN pg_try_advisory_lock(hashtext(''ca-cash-pot-conservation'')) THEN (SELECT count(*)::int FROM public.fn_cash_pot_conservation_check(8)) ELSE -1 END;'
                    AND schedule = '34 */6 * * *' AND active) THEN
    RAISE EXCEPTION 'postimage: cron job 259 is not the 8-hour command';
  END IF;
  IF strpos(pg_get_functiondef('public.fn_ca_cash_failed_run_intake()'::regprocedure),
            (SELECT replace(command, '''', '''''') FROM cron.job WHERE jobid = 259)) = 0 THEN
    RAISE EXCEPTION 'postimage: the failure intake does not pin the live command';
  END IF;
END $post$;

-- pg_temp.ca_audit_subst is a temporary object and ends with this session.

COMMIT;
