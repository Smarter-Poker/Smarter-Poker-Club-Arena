-- A TRIGGER FUNCTION IS NOT A BROWSER ROUTINE.
--
-- `main` is red, and two of the three causes are mine. The workflows:
--
--   Telemetry Exposure       20:22  "A browser can execute an unscoped
--                                    SECURITY DEFINER routine"
--   Schema Manifest Refresh  21:40  "Ask production which DEFINER writers a
--                                    browser can reach"
--
-- Both ask PRODUCTION - not the repo - which SECURITY DEFINER routines that
-- WRITE are executable by a browser role and never consult auth.uid(),
-- auth.role() or auth.jwt(). Asked directly, production names three, and all
-- three are TRIGGER functions holding EXECUTE for `authenticated`:
--
--   fn_ca_alert_resolution_reaches_the_incident   mine, 20260906113923
--   fn_ca_incident_resolution_reaches_the_alerts  mine, 20260906113923
--   fn_sync_profile_total_hands                   pre-existing
--
-- WHY IT HAPPENED, and it is worth saying because it will happen again to the
-- next person: `CREATE OR REPLACE FUNCTION` on this database hands EXECUTE to
-- `authenticated` by default, and the [autorevoke] event trigger that strips
-- PUBLIC/anon does not strip `authenticated`. The repo-side gate,
-- check-definer-authorization.mjs, deliberately SKIPS anything
-- `RETURNS trigger` - its header explains why, and the reasoning is sound:
-- Postgres refuses to call a trigger function outside a trigger context, so
-- the grant cannot actually be exercised. The production-side auditors do not
-- make that exemption. So a grant that is genuinely inert still turns main
-- red, and a red nobody can act on is the thing CLAUDE.md 10.83 is about.
--
-- THE GRANT IS INERT AND IT STILL SHOULD NOT EXIST. Firing a trigger does not
-- check EXECUTE on the trigger function - Postgres runs it as part of the
-- statement, under the table owner - so revoking costs the triggers nothing.
-- The three triggers that use these functions stay attached and keep working;
-- what goes away is a permission that was only ever noise. Fixing two of the
-- three would leave the check red and teach everyone to ignore it, so the
-- pre-existing one is closed here too.
--
-- GRANT/REVOKE does not fire pgrst_ddl_watch (CLAUDE.md 2, rule 5), so this
-- costs no schema reload.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.fn_ca_alert_resolution_reaches_the_incident()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_ca_incident_resolution_reaches_the_alerts()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_sync_profile_total_hands()
  FROM PUBLIC, anon, authenticated;

DO $verify$
DECLARE r record; v_seen int := 0; v_open int;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prorettype::regtype AS rt,
           (SELECT count(*) FROM pg_trigger t
             WHERE t.tgfoid = p.oid AND NOT t.tgisinternal) AS attached
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('fn_ca_alert_resolution_reaches_the_incident',
                         'fn_ca_incident_resolution_reaches_the_alerts',
                         'fn_sync_profile_total_hands')
  LOOP
    v_seen := v_seen + 1;
    IF r.rt <> 'trigger'::regtype THEN
      RAISE EXCEPTION 'VERIFY FAILED: % is not a trigger function - do not revoke it blind', r.proname;
    END IF;
    IF r.attached < 1 THEN
      RAISE EXCEPTION 'VERIFY FAILED: % is attached to no trigger; revoking would strand it', r.proname;
    END IF;
    IF has_function_privilege('authenticated', r.oid, 'EXECUTE')
       OR has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED: a browser role still holds EXECUTE on %', r.proname;
    END IF;
  END LOOP;

  /* The count is the point - a loop over an empty set reports success.
     Learned the hard way in 20260906153725, corrected in 20260906154804. */
  IF v_seen <> 3 THEN
    RAISE EXCEPTION 'VERIFY FAILED: expected 3 trigger functions, checked %', v_seen;
  END IF;

  /* And the condition the production auditors actually test is now empty,
     allowlist entries excluded. */
  SELECT count(*) INTO v_open
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     AND p.prosrc ~* '(insert\s+into|update\s+[a-z_"]|delete\s+from)'
     AND p.prosrc !~* 'auth\.(uid|role|jwt)\(\)'
     AND p.proname NOT IN ('get_current_settlement_period','recalculate_leaderboard_ranks');
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % unscoped DEFINER writer(s) are still browser-reachable', v_open;
  END IF;

  RAISE NOTICE 'TRIGGER_FUNCTIONS_ARE_NOT_ROUTINES 3 revoked, all still attached, no unscoped DEFINER writer is browser-reachable';
END $verify$;

COMMIT;
