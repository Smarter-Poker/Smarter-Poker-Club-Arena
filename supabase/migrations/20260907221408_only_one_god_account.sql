-- ═══════════════════════════════════════════════════════════════════════════
--  THERE IS EXACTLY ONE GOD ACCOUNT
-- ═══════════════════════════════════════════════════════════════════════════
-- APPLIED TO PRODUCTION 2026-09-02 via Supabase apply_migration.
--
-- Dan, 2026-09-02: "THERE SHOULD ONLY BE ONE GOD ACCOUNT, AND THATS
-- DANIEL@BEKAVACTRADING.COM ONLY."
--
-- Found two:
--   kingfish     daniel@bekavactrading.com   god   created 2025-10-20  <- KEEP
--   smarterpoker daniel@smarter.poker        god   created 2026-01-24  <- DEMOTE
--
-- `god` is one of the three roles public.fn_is_platform_admin() accepts
-- (admin, superadmin, god), so it carries full platform-staff authority
-- through every RLS policy and admin RPC on the estate.
--
-- DEMOTED TO `admin`, NOT `user`, deliberately and conservatively.
-- "Smarter.Poker Official" is a brand/system account that may be signed in
-- somewhere; dropping it to `user` could silently break an automation, while
-- `admin` satisfies the instruction as stated (one god) and is reversible in
-- either direction. A separate `admin` already exists
-- (danimal5022@yahoo.com), so this creates no new class of access. If Dan
-- wants it to hold no staff authority at all, that is one more UPDATE and it
-- is his call, not one to make silently.
--
-- THE UNIQUE INDEX IS THE POINT. Demoting one row fixes today; the partial
-- unique index makes a SECOND god impossible tomorrow - from any client, any
-- migration, any agent. It deliberately does NOT hardcode a user id: the rule
-- is "at most one", and WHICH one is data, so moving it is an UPDATE rather
-- than a schema change.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.one_god_account_only;
--   UPDATE public.profiles SET role='god' WHERE username='smarterpoker';

DO $$
DECLARE v_gods int; v_keep uuid;
BEGIN
  SELECT count(*) INTO v_gods FROM public.profiles WHERE role = 'god';
  IF v_gods <> 2 THEN
    RAISE EXCEPTION 'PRE-FLIGHT: expected exactly 2 god accounts to reconcile, found %.', v_gods;
  END IF;

  SELECT p.id INTO v_keep
  FROM public.profiles p JOIN auth.users u ON u.id = p.id
  WHERE p.role='god' AND lower(u.email) = 'daniel@bekavactrading.com';

  IF v_keep IS NULL THEN
    RAISE EXCEPTION 'PRE-FLIGHT: daniel@bekavactrading.com does not currently hold the god role - refusing to demote anyone.';
  END IF;
END $$;

UPDATE public.profiles p
   SET role = 'admin'
  FROM auth.users u
 WHERE u.id = p.id
   AND p.role = 'god'
   AND lower(u.email) <> 'daniel@bekavactrading.com';

CREATE UNIQUE INDEX IF NOT EXISTS one_god_account_only
  ON public.profiles ((role))
  WHERE role = 'god';

COMMENT ON INDEX public.one_god_account_only IS
  'Dan 2026-09-02: there is exactly one god account. A second INSERT/UPDATE to role=god is refused by the database rather than relying on every writer to remember.';

DO $$
DECLARE v_gods int; v_email text;
BEGIN
  SELECT count(*) INTO v_gods FROM public.profiles WHERE role='god';
  IF v_gods <> 1 THEN
    RAISE EXCEPTION 'POST-APPLY: expected exactly 1 god account, found %.', v_gods;
  END IF;

  SELECT lower(u.email) INTO v_email
  FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.role='god';

  IF v_email <> 'daniel@bekavactrading.com' THEN
    RAISE EXCEPTION 'POST-APPLY: the surviving god is %, not daniel@bekavactrading.com.', v_email;
  END IF;
END $$;
