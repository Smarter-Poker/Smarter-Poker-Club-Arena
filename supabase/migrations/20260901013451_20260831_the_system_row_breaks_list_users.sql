-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901013451; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Companion to 20260831_auth_null_tokens_break_the_admin_api. That one repaired
-- 295 rows and fixed every single-user admin read, but listUsers still failed:
-- it scans EVERY row, and one row was still unscannable.
--
-- auth.users id 00000000-0000-0000-0000-000000000001 (system@smarter.poker) was
-- inserted directly rather than through GoTrue, so it carries NULL instance_id
-- and NULL created_at. GoTrue scans instance_id into a non-pointer uuid.UUID,
-- so that single row made listUsers fail for the whole project.
--
-- Not a real user: no sign-in, no identity, it exists as a system actor for
-- service-side writes. Setting instance_id to the all-zero default is what
-- GoTrue itself writes for every row in a single-instance project, and
-- created_at is backfilled from its profile so the row stops being undated.
-- Idempotent; no other column is touched.

DO $$
DECLARE v_left integer;
BEGIN
  UPDATE auth.users
     SET instance_id = '00000000-0000-0000-0000-000000000000'::uuid
   WHERE instance_id IS NULL;

  UPDATE auth.users u
     SET created_at = COALESCE(
           (SELECT p.created_at FROM public.profiles p WHERE p.id = u.id),
           now()
         )
   WHERE u.created_at IS NULL;

  UPDATE auth.users SET updated_at = created_at WHERE updated_at IS NULL;

  SELECT count(*) INTO v_left FROM auth.users
   WHERE instance_id IS NULL OR created_at IS NULL;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'POST-APPLY: % auth.users rows still unscannable', v_left;
  END IF;
END $$;

