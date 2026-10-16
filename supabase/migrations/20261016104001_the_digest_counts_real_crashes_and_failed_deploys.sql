-- 20261016104001_the_digest_counts_real_crashes_and_failed_deploys.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE DIGEST COUNTS REAL CRASHES AND FAILED DEPLOYS (2026-10-16)
--
-- The Smarter.Poker daily digest (fn_sp_digest_attention over
-- fn_sp_daily_metrics_compute) files its attention items on the alert board.
-- Two of its rules fired on things that are not defects:
--
--   * DailyDigest.client_crash (operational_alert_events 255171, "2 app
--     crashes" on Oct 15). Both client_crash_log rows are boundary 'auth',
--     section login_form_submit: invalid_credentials and email_not_confirmed,
--     written by the World Hub's /api/auth/log-client-error, which records
--     every auth flow failure (a wrong password, an unconfirmed email) for
--     diagnosis. In 30 days client_crash_log holds 13 auth rows and one
--     delivery probe row (error_name 'Probe'), and no render crash at all.
--   * DailyDigest.deploy_failed (255126 "2 engine deploy attempts did not
--     ship" on Oct 14, 255169 "5" on Oct 15). All 7 unshipped
--     ca_engine_deploy_attempts rows say "stood down before cutover;
--     protected main had moved to <sha>": a release superseded by a newer
--     merge, whose newer release then shipped. That is the publisher working,
--     the same reason check-main-is-green counts only failure and never a
--     cancelled run (CLAUDE.md 10.83).
--
-- A detector that fires on a non-defect is itself the defect (CLAUDE.md
-- 10.11). The fix is in the two metric reads, so the digest's numbers and its
-- rules both mean what they say:
--
--   * 'crashes' counts client_crash_log rows outside the auth flow's own
--     reports and outside delivery probes;
--   * 'deploys' leaves out an attempt that stood down because main moved on.
--     A sealed release that did not complete, or one whose production
--     identity could not be proved, still counts as attempted and not
--     shipped, so a real deploy failure still reaches the attention list.
--
-- Read-only on production with the new predicates: Oct 14 crashes 0, deploys
-- 3 of 3; Oct 15 crashes 0, deploys 15 of 15 (before: 2 crashes; 3 of 5 and
-- 15 of 20).
--
-- Pinned-preimage substitution: the live pg_get_functiondef md5 is pinned
-- (ba689a29..., the text of 20261016100458), both anchors occur exactly once,
-- the postimage md5 was derived read-only on production with replace()
-- (52002b51...), and owner, SECURITY DEFINER, search_path and grants are
-- proven unchanged after the replace.
--
-- Regression: scripts/ci/test-digest-findings-at-the-root.py on native
-- PostgreSQL, run by .github/workflows/digest-findings-at-the-root.yml.
--
-- @live-proof: md5(pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure)) = '52002b51df42c6c7d2d3a0d6ced7fd9c'

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_digest_metrics_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_digest_metrics_subst(
  'public.fn_sp_daily_metrics_compute(date)',
  'ba689a29f14e0e922969645550f8e9e6', '52002b51df42c6c7d2d3a0d6ced7fd9c',
  ARRAY[$do1$    'crashes', (SELECT count(*) FROM public.client_crash_log WHERE created_at >= s AND created_at < e),
$do1$,
        $do2$                  FROM public.ca_engine_deploy_attempts WHERE at >= s AND at < e),
$do2$],
  ARRAY[$dn1$    -- An app crash is an error boundary catching a render failure. The auth
    -- flow's own failure reports (boundary 'auth': a wrong password, an
    -- unconfirmed email) and delivery probes share client_crash_log but are
    -- not crashes (2026-10-16: both "app crashes" on Oct 15 were login form
    -- refusals, DailyDigest.client_crash).
    'crashes', (SELECT count(*) FROM public.client_crash_log WHERE created_at >= s AND created_at < e
                  AND boundary IS DISTINCT FROM 'auth' AND error_name IS DISTINCT FROM 'Probe'),
$dn1$,
        $dn2$                  FROM public.ca_engine_deploy_attempts WHERE at >= s AND at < e
                   -- A release that stood down because protected main moved
                   -- on was superseded by a newer one, not failed (2026-10-16:
                   -- all 7 unshipped attempts on Oct 14 and 15 were these,
                   -- DailyDigest.deploy_failed).
                   AND (shipped OR COALESCE(reason, '') NOT LIKE 'stood down before cutover; protected main had moved to %')),
$dn2$]
);

COMMIT;
