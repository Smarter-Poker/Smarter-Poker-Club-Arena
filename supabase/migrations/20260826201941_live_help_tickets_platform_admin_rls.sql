-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826201941; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- TIER 3 (replaces two RLS policies)
--
-- WHY:
--   The Bug Reports tab in /horses renders empty for two of the three real
--   admin accounts, and its status updates silently no-op for them. Both the
--   SELECT and the UPDATE policy on live_help_tickets currently read:
--
--       auth.uid() = user_id
--       OR auth.jwt()->>'email' = ANY(ARRAY['admin@smarter.poker',
--                                           'support@smarter.poker'])
--       OR EXISTS (SELECT 1 FROM profiles
--                  WHERE id = auth.uid()
--                    AND role = ANY(ARRAY['admin','super_agent','owner']))
--
--   Two faults, both verified against production on 2026-08-26:
--
--   1. The role list omits 'superadmin' and 'god'. The accounts that actually
--      administer this platform are daniel@smarter.poker (god),
--      daniel@bekavactrading.com (god) and danimal5022@yahoo.com (admin), so
--      only the third has ever been able to see or update a ticket. Nobody
--      holds 'super_agent' or 'owner' at all -- the full role distribution is
--      user 1003, player 10, venue_owner 6, god 2, admin 1.
--
--   2. The email allowlist is not merely dead, it is a privilege leak.
--      admin@smarter.poker does not exist in profiles. support@smarter.poker
--      DOES exist and its role is 'user' -- an ordinary account granted read
--      and write over every support ticket on the platform.
--
--   Replaced with fn_is_platform_admin(), which returns true for exactly
--   ('admin','superadmin','god') and is already the convention across 44 other
--   policies in this schema. The owner's own-ticket access is preserved.
--
-- DEPENDS ON: the EXECUTE grant on fn_is_platform_admin() to `authenticated`,
--   applied immediately before this migration. Without it these policies would
--   raise 42501 for every caller.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── PRE-FLIGHT ────────────────────────────────────────────────────────
DO $$
DECLARE
  v_tbl int; v_rls boolean; v_fn int; v_sel int; v_upd int; v_grant boolean; v_legacy int;
BEGIN
  SELECT count(*) INTO v_tbl FROM pg_tables
   WHERE schemaname='public' AND tablename='live_help_tickets';
  IF v_tbl <> 1 THEN RAISE EXCEPTION 'PRE-FLIGHT: live_help_tickets not found.'; END IF;

  SELECT relrowsecurity INTO v_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname='live_help_tickets';
  IF NOT v_rls THEN RAISE EXCEPTION 'PRE-FLIGHT: RLS is not enabled on live_help_tickets.'; END IF;

  SELECT count(*) INTO v_fn FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_is_platform_admin' AND p.pronargs=0;
  IF v_fn <> 1 THEN RAISE EXCEPTION 'PRE-FLIGHT: expected exactly one zero-arg fn_is_platform_admin, found %.', v_fn; END IF;

  SELECT has_function_privilege('authenticated','public.fn_is_platform_admin()','EXECUTE') INTO v_grant;
  IF NOT v_grant THEN
    RAISE EXCEPTION 'PRE-FLIGHT: authenticated cannot EXECUTE fn_is_platform_admin. Apply the grant migration first.';
  END IF;

  SELECT count(*) INTO v_sel FROM pg_policies
   WHERE schemaname='public' AND tablename='live_help_tickets' AND policyname='live_help_tickets_select';
  SELECT count(*) INTO v_upd FROM pg_policies
   WHERE schemaname='public' AND tablename='live_help_tickets' AND policyname='live_help_tickets_update';
  IF v_sel <> 1 OR v_upd <> 1 THEN
    RAISE EXCEPTION 'PRE-FLIGHT: expected both live_help_tickets_select and _update to exist (found %/%).', v_sel, v_upd;
  END IF;

  -- If anyone has since been given super_agent or owner, dropping those from
  -- the list would take access away. Force a human decision instead.
  SELECT count(*) INTO v_legacy FROM public.profiles WHERE role IN ('super_agent','owner');
  IF v_legacy > 0 THEN
    RAISE EXCEPTION
      'PRE-FLIGHT: % profile(s) now hold super_agent/owner. This migration would revoke their ticket access. Re-review.',
      v_legacy;
  END IF;
END $$;

-- ─── CHANGE ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS live_help_tickets_select ON public.live_help_tickets;
CREATE POLICY live_help_tickets_select ON public.live_help_tickets
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.fn_is_platform_admin());

DROP POLICY IF EXISTS live_help_tickets_update ON public.live_help_tickets;
CREATE POLICY live_help_tickets_update ON public.live_help_tickets
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.fn_is_platform_admin())
  WITH CHECK (auth.uid() = user_id OR public.fn_is_platform_admin());

-- ─── POST-APPLY ASSERTIONS ─────────────────────────────────────────────
DO $$
DECLARE v_sel text; v_upd text; v_chk text; v_rls boolean;
BEGIN
  SELECT qual INTO v_sel FROM pg_policies
   WHERE schemaname='public' AND tablename='live_help_tickets' AND policyname='live_help_tickets_select';
  SELECT qual, with_check INTO v_upd, v_chk FROM pg_policies
   WHERE schemaname='public' AND tablename='live_help_tickets' AND policyname='live_help_tickets_update';

  IF v_sel NOT LIKE '%fn_is_platform_admin%' OR v_upd NOT LIKE '%fn_is_platform_admin%' THEN
    RAISE EXCEPTION 'POST-APPLY: a policy does not call fn_is_platform_admin.';
  END IF;
  IF v_chk NOT LIKE '%fn_is_platform_admin%' THEN
    RAISE EXCEPTION 'POST-APPLY: the UPDATE policy has no WITH CHECK on fn_is_platform_admin.';
  END IF;
  IF v_sel LIKE '%smarter.poker%' OR v_upd LIKE '%smarter.poker%' THEN
    RAISE EXCEPTION 'POST-APPLY: the hardcoded email allowlist survived.';
  END IF;
  IF v_sel LIKE '%super_agent%' OR v_upd LIKE '%super_agent%' THEN
    RAISE EXCEPTION 'POST-APPLY: the stale role array survived.';
  END IF;

  SELECT relrowsecurity INTO v_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname='live_help_tickets';
  IF NOT v_rls THEN RAISE EXCEPTION 'POST-APPLY: RLS is no longer enabled.'; END IF;

  RAISE NOTICE 'POST-APPLY OK: both live_help_tickets policies now gate on fn_is_platform_admin.';
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK -- restores the original policies, including the dead/leaky email
-- allowlist. Only run this if fn_is_platform_admin itself is in trouble.
--
--   BEGIN;
--   DROP POLICY IF EXISTS live_help_tickets_select ON public.live_help_tickets;
--   CREATE POLICY live_help_tickets_select ON public.live_help_tickets
--     FOR SELECT TO authenticated
--     USING (auth.uid() = user_id
--            OR (auth.jwt() ->> 'email') = ANY (ARRAY['admin@smarter.poker','support@smarter.poker'])
--            OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()
--                        AND role = ANY (ARRAY['admin','super_agent','owner'])));
--   DROP POLICY IF EXISTS live_help_tickets_update ON public.live_help_tickets;
--   CREATE POLICY live_help_tickets_update ON public.live_help_tickets
--     FOR UPDATE TO authenticated
--     USING (auth.uid() = user_id
--            OR (auth.jwt() ->> 'email') = ANY (ARRAY['admin@smarter.poker','support@smarter.poker'])
--            OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()
--                        AND role = ANY (ARRAY['admin','super_agent','owner'])));
--   COMMIT;
-- ═══════════════════════════════════════════════════════════════════════
