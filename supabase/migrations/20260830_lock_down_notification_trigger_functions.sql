-- HARDENING. Found reviewing my own work from earlier today rather than by a
-- failure, which is the only reason it was found at all.
--
-- I added five SECURITY DEFINER functions across three migrations and put
-- REVOKEs on only two. The other three inherited PostgreSQL's default
-- `GRANT EXECUTE TO PUBLIC`:
--
--   fn_raise_notification      authenticated NO   anon NO    <- correct, the one that matters
--   fn_notify_display_name     authenticated YES  anon NO
--   fn_notify_dispute          authenticated YES  anon NO
--   fn_notify_credit_request   authenticated YES  anon NO
--   fn_notify_blinding_off     authenticated YES  anon YES   <- and PUBLIC
--
-- NOT EXPLOITABLE TODAY, and each claim was checked rather than assumed:
--
--   * The four notify_* are TRIGGER functions: no arguments, and they read
--     NEW / OLD / TG_OP, so PostgreSQL refuses a direct call outside a trigger
--     context. Probed as `anon`: it errors.
--   * fn_notify_display_name IS directly callable by `authenticated` and, being
--     SECURITY DEFINER, bypasses RLS on profiles. It discloses nothing new: the
--     `profiles_select` policy is already FOR SELECT TO authenticated
--     USING (true), so any signed-in user can read every profile regardless.
--   * fn_raise_notification is the one that inserts arbitrary notifications and
--     was locked correctly from the start. Probed as `authenticated`: the call
--     fails and zero rows are created.
--
-- So this is defence in depth, not an incident. It is worth doing because the
-- gap is exactly the shape that becomes real later: the day somebody refactors
-- one of these into a callable helper with arguments, it is already granted to
-- anon and nothing would have said so. A SECURITY DEFINER function in this
-- schema should be reachable by service_role and the trigger machinery only.
REVOKE ALL ON FUNCTION public.fn_notify_display_name(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_notify_dispute() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_notify_credit_request() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_notify_blinding_off() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_raise_notification(uuid, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE r record; v_bad text := '';
BEGIN
  FOR r IN
    SELECT p.oid, p.proname FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('fn_raise_notification','fn_notify_display_name',
                        'fn_notify_dispute','fn_notify_credit_request','fn_notify_blinding_off')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      v_bad := v_bad || ' ' || r.proname;
    END IF;
  END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION 'still executable by a client role:%', v_bad; END IF;

  -- The triggers must still work after the revoke. They run as the definer, so
  -- they do; assert the wiring is intact rather than trust that.
  IF (SELECT count(*) FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname IN ('trg_notify_dispute','trg_notify_credit_request','trg_notify_blinding_off')) <> 3 THEN
    RAISE EXCEPTION 'a notification trigger went missing during the revoke';
  END IF;
END $$;
