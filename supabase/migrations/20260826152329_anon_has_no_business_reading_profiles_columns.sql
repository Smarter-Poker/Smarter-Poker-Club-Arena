-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826152329; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- An untracked grant_anon.sql was sitting in the World Hub working tree on
-- 2026-08-26 granting `anon` column-level SELECT on 105 columns of
-- public.profiles, including diamonds, kyc_status, kyc_inquiry_id, birthday,
-- birth_year, phone_verified and email_verified. Those grants HAD been applied.
--
-- They were inert, and only by luck: public.profiles has RLS enabled and
-- exactly one SELECT policy, `profiles_select`, scoped to `authenticated` with
-- USING (true). `anon` matches no policy, so it reads zero rows no matter what
-- columns it is granted. One permissive anon policy -- added by anyone, for any
-- reason -- turns that into a full PII leak with no further step required.
--
-- This removes the grants. Nothing depends on them:
--   * the anonymous public profile page /u/[username] reads through
--     get_public_profile_by_username(), which is SECURITY DEFINER and therefore
--     runs as its owner -- verified prosecdef = true, anon EXECUTE = true;
--   * self-read of the full row goes through get_my_full_profile(), also
--     SECURITY DEFINER;
--   * every server route uses the service role.
--
-- ROLLBACK: re-run the GRANT in the World Hub's grant_anon.sql. Do not.

DO $do$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT column_name
      FROM information_schema.column_privileges
     WHERE table_schema='public' AND table_name='profiles'
       AND grantee='anon' AND privilege_type='SELECT'
  LOOP
    EXECUTE format('REVOKE SELECT (%I) ON public.profiles FROM anon', r.column_name);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'revoked SELECT on % profiles column(s) from anon', n;
END
$do$;

REVOKE SELECT ON public.profiles FROM anon;

DO $check$
DECLARE v_cols int; v_tbl int;
BEGIN
  SELECT count(*) INTO v_cols FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='profiles' AND grantee='anon' AND privilege_type='SELECT';
  IF v_cols > 0 THEN
    RAISE EXCEPTION 'anon still holds SELECT on % profiles column(s)', v_cols;
  END IF;

  SELECT count(*) INTO v_tbl FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='profiles' AND grantee='anon' AND privilege_type='SELECT';
  IF v_tbl > 0 THEN
    RAISE EXCEPTION 'anon still holds table-level SELECT on profiles';
  END IF;

  -- the two SECURITY DEFINER read paths must be untouched
  IF NOT has_function_privilege('anon','public.get_public_profile_by_username(text)','EXECUTE') THEN
    RAISE EXCEPTION 'the anonymous public profile page lost its RPC';
  END IF;

  -- and authenticated must be unaffected by this migration
  IF (SELECT count(*) FROM information_schema.column_privileges
       WHERE table_schema='public' AND table_name='profiles'
         AND grantee='authenticated' AND privilege_type='SELECT') = 0
  THEN
    RAISE EXCEPTION 'authenticated lost its profiles column grants - this migration should not have touched them';
  END IF;
END
$check$;
