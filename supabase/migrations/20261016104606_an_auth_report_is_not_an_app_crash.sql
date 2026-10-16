-- 20261016104606_an_auth_report_is_not_an_app_crash.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- AN AUTH REPORT IS NOT AN APP CRASH (2026-10-16)
--
-- DailyDigest.client_crash (operational_alert_events 255171, "2 app crashes"
-- on Oct 15). The Smarter.Poker daily digest counts every client_crash_log
-- row of the day as an app crash (fn_sp_daily_metrics_compute 'crashes') and
-- files any nonzero count on the alert board (fn_sp_digest_attention rule
-- client_crash). Both rows are boundary 'auth', section login_form_submit,
-- error_name invalid_credentials and email_not_confirmed: a wrong password
-- and an unconfirmed email, written by the World Hub's
-- /api/auth/log-client-error, which records every auth flow failure for
-- diagnosis. In 30 days client_crash_log holds 13 auth rows, one delivery
-- probe row (error_name 'Probe') and no render crash at all, so every
-- client_crash item the digest has filed was a non-defect.
--
-- A detector that fires on a non-defect is itself the defect (CLAUDE.md
-- 10.11). The fix is in the metric read: 'crashes' counts client_crash_log
-- rows outside the auth flow's own reports and outside delivery probes, so a
-- real error-boundary crash still reaches the attention list. Read-only on
-- production with the new predicate: Oct 14 and Oct 15 both 0 (before: 0 and
-- 2).
--
-- ORDER. #7080 (20261016103449) edits the same function's 'deploys' and
-- diamond lines and pins today's live text (ba689a29...). This migration pins
-- #7080's postimage (0a7241d8...), so it installs AFTER 20261016103449 and
-- refuses whole before it. Its own anchor occurs exactly once in that text;
-- the postimage (80560936...) was derived by applying 20261016103449 and then
-- this replace() to the live text on native PostgreSQL. Owner, SECURITY
-- DEFINER, search_path and grants are proven unchanged after the replace.
--
-- Regression: scripts/ci/test-an-auth-report-is-not-an-app-crash.py on native
-- PostgreSQL, run by .github/workflows/an-auth-report-is-not-an-app-crash.yml.
--
-- @live-proof: md5(pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure)) = '8056093672bc76bbe02244a6615af79c'

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
  '0a7241d8426993393e54accdeec01676', '8056093672bc76bbe02244a6615af79c',
  ARRAY[$do1$    'crashes', (SELECT count(*) FROM public.client_crash_log WHERE created_at >= s AND created_at < e),
$do1$],
  ARRAY[$dn1$    -- An app crash is an error boundary catching a render failure. The auth
    -- flow's own failure reports (boundary 'auth': a wrong password, an
    -- unconfirmed email) and delivery probes share client_crash_log but are
    -- not crashes (2026-10-16: both "app crashes" on Oct 15 were login form
    -- refusals, DailyDigest.client_crash).
    'crashes', (SELECT count(*) FROM public.client_crash_log WHERE created_at >= s AND created_at < e
                  AND boundary IS DISTINCT FROM 'auth' AND error_name IS DISTINCT FROM 'Probe'),
$dn1$]
);

COMMIT;
