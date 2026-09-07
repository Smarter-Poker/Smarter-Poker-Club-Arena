-- 20260907040315_the_threshold_grants_are_only_what_the_migration_named.sql
--
-- Named for the version the Supabase MCP recorded when it applied this.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE THRESHOLD GRANTS ARE ONLY WHAT THE MIGRATION NAMED
--  BBJ phase 3.4 follow-up, found in the phase-3 deep dive
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260906234056's header says "THE GRANTS ARE NAMED, not inherited" and then
-- named four for `authenticated`: SELECT, INSERT, UPDATE, DELETE. Read back on
-- production, `authenticated` also held REFERENCES and TRIGGER.
--
-- WHY. The REVOKE in that migration named `PUBLIC, anon` and not
-- `authenticated`, because `authenticated` was about to be granted the four it
-- needs. But Supabase's default privileges had already granted it ALL, so the
-- GRANT added nothing and the two extras simply survived. The header was
-- therefore describing an intent the SQL did not carry out - which is the same
-- shape of gap the phase-2 deep dive found on `bbj_unclaimed_shares`, one
-- table earlier. Twice in two phases is a pattern, not an accident: on this
-- database a new public table starts with ALL granted to both browser roles,
-- so a migration that wants a narrow ACL must REVOKE from every role it then
-- grants to, not only from the ones it is shutting out.
--
-- IS IT EXPLOITABLE? No, and saying so plainly matters more than the fix.
-- REFERENCES lets a role create a foreign key pointing at the table and
-- TRIGGER lets it attach a trigger; both additionally require CREATE on the
-- schema, which `authenticated` does not have. So this is untidiness with a
-- security shape, not a hole.
--
-- IT IS STILL WORTH CLOSING, for the reason the phase-2 note gives: the moment
-- a privilege exists for no stated reason, the next person to read the ACL has
-- to work out whether it was deliberate. A grant list that matches its own
-- migration header answers that question by itself.
--
-- ROLLBACK (there is no reason to want this):
--   GRANT REFERENCES, TRIGGER ON public.bbj_notify_thresholds TO authenticated;
BEGIN;

REVOKE REFERENCES, TRIGGER ON public.bbj_notify_thresholds FROM authenticated;
REVOKE REFERENCES, TRIGGER ON public.bbj_threshold_crossings FROM authenticated;

DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(table_name || '.' || grantee || ':' || privilege_type, ', ')
    INTO v_bad
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('bbj_notify_thresholds', 'bbj_threshold_crossings')
     AND grantee IN ('anon', 'authenticated')
     AND privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a browser role still holds an unnamed privilege: %', v_bad;
  END IF;

  -- And the four the panel genuinely needs are still there, or the operator
  -- control shipped in the same phase stops working.
  IF NOT (has_table_privilege('authenticated', 'public.bbj_notify_thresholds', 'SELECT')
      AND has_table_privilege('authenticated', 'public.bbj_notify_thresholds', 'INSERT')
      AND has_table_privilege('authenticated', 'public.bbj_notify_thresholds', 'UPDATE')
      AND has_table_privilege('authenticated', 'public.bbj_notify_thresholds', 'DELETE')) THEN
    RAISE EXCEPTION 'authenticated lost a privilege the club settings panel needs';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.bbj_threshold_crossings', 'INSERT') THEN
    RAISE EXCEPTION 'service_role lost INSERT - the sender could not record a crossing';
  END IF;
END $$;

COMMIT;
