-- 20261015101106_the_money_check_board_reads_the_cron_runs_that_drive_each_ch.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE MONEY CHECK BOARD READS THE CRON RUNS THAT DRIVE EACH CHECK (2026-10-15)
--
-- fn_money_check_health raised seven critical financial_alerts at
-- 2026-10-15 10:07:10 UTC ("<check> has never run. It is expected every N
-- minutes, and until it does its silence means nothing."), as it did on
-- 2026-09-02. Read from production:
--
--   * money_check_heartbeat holds 7 rows, every one with run_count 0 and
--     last_run_at NULL. Its only writer is fn_record_money_check_run, which
--     "is called by the driver" (20260902012048) - and nothing calls it: no
--     engine code, no cron command, no function (pg_proc prosrc and the
--     repository searched).
--   * The checks themselves do run. pg_cron drives six of them and every run
--     in the last 24 hours succeeded: ca-payout-guarantee-check-hourly (24/24),
--     ca-pay-backed-payout-shortfalls-hourly (24/24),
--     ca-uncollected-entry-check-hourly (23/23),
--     tourney_money_conservation_hourly (24/24) plus its deep daily,
--     ca-cash-pot-conservation-hourly (4/4, schedule "34 */6") and
--     ca-results-without-a-hand-6h (3/3).
--   * The seventh, fn_backpay_unfinalised_bounty_pools, is a repair job whose
--     schedule was retired on 2026-09-22 (docs/BAND-AIDS-REGISTER.md item 3,
--     "stays defined and nothing calls it"); the board still expected it
--     hourly.
--
-- So the board answered "never run" for checks that run every hour: a
-- detector that fires on a non-defect, and one that would have hidden a real
-- stop the same way, because every check already read as never run.
--
-- THE FIX, AT THE LINE THAT READ IT: the board's row source now takes each
-- check's last run as the later of its heartbeat and the last SUCCEEDED run of
-- an active cron job whose command calls it (strpos(command, check_name ||
-- '(')), over the last 8 days of cron.job_run_details, and adds those runs to
-- run_count. A check whose job fails, is deactivated or is unscheduled is
-- still stale and still raises. The registry gets two corrections from the
-- same reads: fn_cash_pot_conservation_check is expected every 360 minutes
-- (its job runs "34 */6"), and the retired repair job leaves the registry.
-- Nothing else in the function moves; owner, SECURITY DEFINER, search_path
-- and grants are asserted unchanged.
--
-- Preimage md5 5fccb514423f4867faaf3b09408f470b (read live 2026-10-15); the
-- postimage 7bcc8d063db2746334c5c7a617015fe9 is that exact text with the one
-- anchor (occurring once) replaced.
--
-- Regression: scripts/ci/test-money-check-health-reads-cron.py (native
-- PostgreSQL), run by .github/workflows/money-check-health-reads-cron.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_money_check_health(numeric)'::regprocedure)) = '7bcc8d063db2746334c5c7a617015fe9' AND NOT EXISTS (SELECT 1 FROM public.money_check_heartbeat WHERE check_name = 'fn_backpay_unfinalised_bounty_pools') AND (SELECT expected_interval_minutes FROM public.money_check_heartbeat WHERE check_name = 'fn_cash_pot_conservation_check') = 360)

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_money_board_subst(p_sig text, p_before text, p_after text,
                                             p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned preimage (md5 %)', p_sig, md5(v_def);
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

SELECT pg_temp.ca_money_board_subst(
  'public.fn_money_check_health(numeric)',
  '5fccb514423f4867faaf3b09408f470b', '7bcc8d063db2746334c5c7a617015fe9',
  ARRAY[$mo1$    SELECT h.check_name, h.expected_interval_minutes AS every_min, h.last_run_at,
           h.run_count, h.note,
           CASE WHEN h.last_run_at IS NULL THEN NULL
                ELSE round(EXTRACT(epoch FROM (now() - h.last_run_at)) / 60.0, 1)
           END AS age_min
      FROM public.money_check_heartbeat h
     ORDER BY h.check_name$mo1$],
  ARRAY[$mn1$    -- The checks run on pg_cron, which never calls fn_record_money_check_run,
    -- so the heartbeat alone read every check as never run (2026-10-15). A
    -- check's last run is the later of its heartbeat and the last SUCCEEDED
    -- run of an active cron job whose command calls it; a failing job is
    -- still stale.
    WITH runs AS (
      SELECT d.jobid, max(d.end_time) AS last_ok, count(*) AS n
        FROM cron.job_run_details d
       WHERE d.status = 'succeeded' AND d.start_time > now() - interval '8 days'
       GROUP BY d.jobid
    ), driven AS (
      SELECT hc.check_name, max(rn.last_ok) AS last_ok, sum(rn.n)::bigint AS n
        FROM public.money_check_heartbeat hc
        JOIN cron.job j ON j.active AND strpos(j.command, hc.check_name || '(') > 0
        JOIN runs rn ON rn.jobid = j.jobid
       GROUP BY hc.check_name
    ), seen AS (
      SELECT h.check_name, h.expected_interval_minutes, h.note,
             GREATEST(h.last_run_at, dr.last_ok) AS last_run_at,
             h.run_count + COALESCE(dr.n, 0) AS run_count
        FROM public.money_check_heartbeat h
        LEFT JOIN driven dr ON dr.check_name = h.check_name
    )
    SELECT s.check_name, s.expected_interval_minutes AS every_min, s.last_run_at,
           s.run_count, s.note,
           CASE WHEN s.last_run_at IS NULL THEN NULL
                ELSE round(EXTRACT(epoch FROM (now() - s.last_run_at)) / 60.0, 1)
           END AS age_min
      FROM seen s
     ORDER BY s.check_name$mn1$]
);

DO $registry$
BEGIN
  IF (SELECT expected_interval_minutes FROM public.money_check_heartbeat
       WHERE check_name = 'fn_cash_pot_conservation_check') IS DISTINCT FROM 60 THEN
    RAISE EXCEPTION 'fn_cash_pot_conservation_check is not registered at 60 minutes: the registry moved';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.money_check_heartbeat
                  WHERE check_name = 'fn_backpay_unfinalised_bounty_pools' AND run_count = 0) THEN
    RAISE EXCEPTION 'fn_backpay_unfinalised_bounty_pools is not the never-run registry row this retires';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE active AND strpos(command, 'fn_backpay_unfinalised_bounty_pools(') > 0) THEN
    RAISE EXCEPTION 'fn_backpay_unfinalised_bounty_pools is scheduled again: do not retire its registry row';
  END IF;
END
$registry$;

UPDATE public.money_check_heartbeat
   SET expected_interval_minutes = 360
 WHERE check_name = 'fn_cash_pot_conservation_check';

DELETE FROM public.money_check_heartbeat
 WHERE check_name = 'fn_backpay_unfinalised_bounty_pools';

COMMIT;
