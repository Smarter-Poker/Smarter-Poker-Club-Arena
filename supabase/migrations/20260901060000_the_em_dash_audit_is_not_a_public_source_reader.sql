-- ===========================================================================
-- THE EM DASH AUDIT IS NOT A PUBLIC SOURCE READER (2026-08-31)
--
-- `fn_ca_banned_copy_characters()` is the database side of Dan's em dash ban:
-- it scans pg_proc for function bodies containing a banned character and
-- returns the offending line. Useful, and correct as telemetry.
--
-- It shipped executable by `anon` AND `authenticated`, SECURITY DEFINER.
--
--   postgres=X/postgres | anon=X/postgres | authenticated=X/postgres | service_role=X/postgres
--
-- So anybody holding the publishable key - no account, no session - could ask
-- production to return `left(trim(l), 200)` of matching lines from ANY function
-- body in the public schema. That is internal SQL source, read past RLS as the
-- owner, handed to a caller with no account. The characters it hunts for are
-- common enough in comments that the match set is not narrow.
--
-- The daily live audit found it the same day it shipped:
--
--   [definer-exposure] A NEW FUNCTION ANSWERS A CALLER WITH NO ACCOUNT.
--     fn_ca_banned_copy_characters()  executable by anon, and never asks who is asking
--
-- This is the audit's own option 1: operator telemetry belongs to
-- `service_role`. PUBLIC is named explicitly because anon inherits whatever
-- PUBLIC holds, so revoking anon alone reads as a fix and does nothing.
--
-- CHECKED BEFORE REVOKING, because a definer function inside a policy runs as
-- the QUERYING role and revoking it would deny every SELECT on the tables whose
-- policies call it:
--
--   policies referencing it ......... 0
--   check constraints ............... 0
--   triggers ........................ 0
--   other functions calling it ...... 0
--
-- Nothing calls it but an operator. ROLLBACK, if it is ever needed, is the
-- three grants this revokes:
--   GRANT EXECUTE ON FUNCTION public.fn_ca_banned_copy_characters() TO anon, authenticated;
-- ===========================================================================

begin;

-- PRE-FLIGHT
do $$
begin
  if to_regprocedure('public.fn_ca_banned_copy_characters()') is null then
    raise exception 'PRE-FLIGHT: public.fn_ca_banned_copy_characters() does not exist';
  end if;
end $$;

-- THE CHANGE
revoke all on function public.fn_ca_banned_copy_characters() from public, anon, authenticated;
grant execute on function public.fn_ca_banned_copy_characters() to service_role;

-- VERIFICATION: assert the new grants rather than trusting the statements above.
do $$
begin
  if has_function_privilege('anon', 'public.fn_ca_banned_copy_characters()', 'EXECUTE') then
    raise exception 'VERIFY: anon can still execute the source reader';
  end if;
  if has_function_privilege('authenticated', 'public.fn_ca_banned_copy_characters()', 'EXECUTE') then
    raise exception 'VERIFY: authenticated can still execute the source reader';
  end if;
  if not has_function_privilege('service_role', 'public.fn_ca_banned_copy_characters()', 'EXECUTE') then
    raise exception 'VERIFY: service_role lost the telemetry it needs';
  end if;
end $$;

commit;
