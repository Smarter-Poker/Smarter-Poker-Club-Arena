-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901013328; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- GoTrue scans auth.users token columns into non-nullable Go strings. A NULL in
-- any of them makes every admin read of that row fail with "Database error
-- loading user", and makes listUsers fail outright the moment it touches one.
--
-- Measured before this change: 295 of 1,039 rows affected - 129 REAL HUMAN
-- accounts and 166 horses. For those 129 people, password recovery, email
-- change and admin user management were all broken.
--
-- Proved by bisection rather than assumed: a user with non-null tokens loads
-- through auth.admin.getUserById; a user with NULL tokens returns "Database
-- error loading user". Same key, same client, same call.
--
-- '' and NULL mean the identical thing to GoTrue - no token pending - so this
-- is a representation repair, not a semantic change. No password, identity,
-- confirmation state or session is touched. Idempotent: re-running is a no-op.

DO $$
DECLARE
  v_before integer;
  v_after  integer;
BEGIN
  SELECT count(*) INTO v_before FROM auth.users
   WHERE confirmation_token IS NULL
      OR email_change IS NULL
      OR email_change_token_new IS NULL
      OR email_change_token_current IS NULL
      OR recovery_token IS NULL
      OR phone_change IS NULL
      OR phone_change_token IS NULL
      OR reauthentication_token IS NULL;

  UPDATE auth.users SET confirmation_token          = '' WHERE confirmation_token          IS NULL;
  UPDATE auth.users SET email_change                = '' WHERE email_change                IS NULL;
  UPDATE auth.users SET email_change_token_new      = '' WHERE email_change_token_new      IS NULL;
  UPDATE auth.users SET email_change_token_current  = '' WHERE email_change_token_current  IS NULL;
  UPDATE auth.users SET recovery_token              = '' WHERE recovery_token              IS NULL;
  UPDATE auth.users SET phone_change                = '' WHERE phone_change                IS NULL;
  UPDATE auth.users SET phone_change_token          = '' WHERE phone_change_token          IS NULL;
  UPDATE auth.users SET reauthentication_token      = '' WHERE reauthentication_token      IS NULL;

  SELECT count(*) INTO v_after FROM auth.users
   WHERE confirmation_token IS NULL
      OR email_change IS NULL
      OR email_change_token_new IS NULL
      OR email_change_token_current IS NULL
      OR recovery_token IS NULL
      OR phone_change IS NULL
      OR phone_change_token IS NULL
      OR reauthentication_token IS NULL;

  IF v_after <> 0 THEN
    RAISE EXCEPTION 'POST-APPLY: % auth.users rows still carry a NULL token column', v_after;
  END IF;

  RAISE NOTICE 'auth token repair: % rows had a NULL token column, 0 remain', v_before;
END $$;

