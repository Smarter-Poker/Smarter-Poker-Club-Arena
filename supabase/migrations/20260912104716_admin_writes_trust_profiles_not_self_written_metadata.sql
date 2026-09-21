-- ============================================================================
-- ADMIN WRITES TRUST profiles.role, NOT SELF-WRITTEN auth.users METADATA
-- ============================================================================
--
-- WHY THIS EXISTS (2026-09-12)
--
-- Eighteen RLS policies across six tables gated INSERT/UPDATE/DELETE on a
-- claim the claimant writes themselves:
--
--     EXISTS (SELECT 1 FROM auth.users
--              WHERE users.id = (SELECT auth.uid())
--                AND (users.raw_user_meta_data ->> 'role') = 'admin')
--
-- `raw_user_meta_data` IS user_metadata. Any signed-in user sets it on
-- themselves with one client call that GoTrue performs on their behalf:
--
--     supabase.auth.updateUser({ data: { role: 'admin' } })
--
-- There is no server check on that path; user_metadata is the bag the user
-- owns. So the predicate reduced to "an admin is whoever says they are one".
-- The distinction that matters: `raw_app_meta_data` (app_metadata) is
-- service-role-only and WOULD have been a legitimate source. Not one of the
-- eighteen read it. All eighteen read the self-writable one, so all eighteen
-- named the wrong bag. The tables: training_achievement_definitions,
-- leak_hand_examples, venues, training_scenarios, commander_tournament_points,
-- commander_tournament_templates.
--
-- WHAT WE MEASURED BEFORE TOUCHING ANYTHING, AND THE SURPRISE
--
-- The escalation is REAL BUT LATENT, and the reason is worth writing down
-- because it also explains why nobody has complained. Policy expressions are
-- evaluated with the privileges of the caller, and `authenticated` HAS NO
-- SELECT ON auth.users in this project - the grants on that table are
-- postgres-only. Probed as `authenticated`, with the forged claim actually
-- written to the row, the old predicate does not return true and it does not
-- return false:
--
--     ERROR 42501: permission denied for table users
--
-- It fails CLOSED, with an error, for everyone. Which means the hole has never
-- been walkable through PostgREST - and equally that these eighteen policies
-- have never let a real administrator write these six tables either. They have
-- been dead since they were written. Only service_role and postgres, which
-- bypass RLS, can write these tables today. The exposure is one `GRANT SELECT
-- ON auth.users TO authenticated` away from live, and that grant is a single
-- innocuous-looking line in some future migration.
--
-- Nobody is relying on the old behaviour. `raw_user_meta_data ->> 'role'`
-- across all 1,199 accounts reads: player 384, sub_agent 20, agent 10,
-- venue_owner 7, super_agent 2, null 779. ZERO rows say 'admin' or 'staff'.
-- Not one account satisfies the predicate being replaced, so no access is
-- being taken away from anybody.
--
-- WHAT REPLACES IT
--
-- `public.fn_is_platform_admin()` - the estate's own answer, the one
-- src/utils/platformRoles.ts calls "the estate's authority" and forbids
-- re-deriving. It is SECURITY DEFINER, owned by postgres, search_path pinned
-- to public, and it reads `public.profiles.role IN ('admin','superadmin',
-- 'god')`. It does NOT read auth.users metadata, so it is not the same bug
-- wearing a function's name. `profiles.role` is not self-writable: the
-- `authenticated` UPDATE grant on public.profiles enumerates its columns and
-- `role` is not among them. Being SECURITY DEFINER, it also reads profiles as
-- its owner, which is what makes the new predicate evaluable at all where the
-- old one raised 42501.
--
-- Probed as `authenticated` inside a rolled-back transaction:
--
--   ordinary user, forged user_metadata.role=admin  old: ERROR 42501   new: false
--   real platform admin (profiles.role = 'god')     old: ERROR 42501   new: TRUE
--
-- So this change simultaneously closes a latent privilege path and REVIVES the
-- administrative access these policies were written to grant. That revival is
-- intended and is the only behavioural widening here: three accounts
-- (profiles.role = admin x2, god x1) gain the writes the policy names already
-- promised them.
--
-- SHAPE IS PRESERVED. Every statement below is ALTER POLICY, so names, tables,
-- commands, PERMISSIVE-ness and the `TO public` applicability are all
-- untouched; only the expression changes. The leading
-- `(SELECT auth.role()) = 'authenticated'` conjunct is kept exactly as it was,
-- both to keep the shape and because it keeps anon out of the function call.
--
-- ONE DELIBERATE NARROWING, WORTH NAMING. The six commander_tournament_*
-- policies accepted 'admin' OR 'staff' from metadata; fn_is_platform_admin
-- covers admin/superadmin/god and has no 'staff'. `public.profiles.role` has
-- no 'staff' value either - the whole column reads user 1181, player 10,
-- venue_owner 5, admin 2, god 1 - so 'staff' is a role this platform does not
-- issue and the narrowing costs zero accounts. Inventing a staff list here
-- would be exactly the re-derivation platformRoles.ts prohibits.
--
-- BLAST RADIUS. Rows: training_achievement_definitions 23,
-- leak_hand_examples 18, venues 0, training_scenarios 0,
-- commander_tournament_points 0, commander_tournament_templates 0. No client
-- path writes any of the six - a repo-wide search for `.from('<table>')`
-- across src/, server/ and supabase/functions/ returns nothing for all six;
-- the single mention of training_achievement_definitions in
-- src/pages/ProfilePage.tsx is a comment about a historical divide-by-zero.
-- Two SECURITY DEFINER functions owned by postgres write leak_hand_examples
-- (apply_personal_assistant_retention, purge_personal_assistant_data); both
-- run as postgres, which is BYPASSRLS, so RLS is not consulted on those paths
-- and this change is invisible to them.
--
-- WHAT THIS MIGRATION DOES NOT DO. It does not touch the six SELECT policies
-- on these tables (anyone_read_*, allow_read_achievement_definitions,
-- users_read_own_leak_examples) - none of them reads metadata. It does not
-- alter the table-level INSERT/UPDATE/DELETE grants that anon still holds on
-- five of the six tables; RLS remains the gate there and narrowing grants is a
-- separate, wider change. It does not grant EXECUTE on fn_is_platform_admin to
-- anon, so an anon write attempt keeps failing closed.
--
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------- venues ---
ALTER POLICY "admin_insert_venues" ON "public"."venues"
  WITH CHECK ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());
ALTER POLICY "admin_update_venues" ON "public"."venues"
  USING ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin())
  WITH CHECK ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());
ALTER POLICY "admin_delete_venues" ON "public"."venues"
  USING ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());

-- ------------------------------------------------------ training_scenarios ---
ALTER POLICY "admin_insert_scenarios" ON "public"."training_scenarios"
  WITH CHECK ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());
ALTER POLICY "admin_update_scenarios" ON "public"."training_scenarios"
  USING ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin())
  WITH CHECK ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());
ALTER POLICY "admin_delete_scenarios" ON "public"."training_scenarios"
  USING ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());

-- ------------------------------------ training_achievement_definitions ---
ALTER POLICY "admin_insert_achievements" ON "public"."training_achievement_definitions"
  WITH CHECK ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());
ALTER POLICY "admin_update_achievements" ON "public"."training_achievement_definitions"
  USING ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin())
  WITH CHECK ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());
ALTER POLICY "admin_delete_achievements" ON "public"."training_achievement_definitions"
  USING ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());

-- ------------------------------------------------------ leak_hand_examples ---
ALTER POLICY "admin_insert_examples" ON "public"."leak_hand_examples"
  WITH CHECK ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());
ALTER POLICY "admin_update_examples" ON "public"."leak_hand_examples"
  USING ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin())
  WITH CHECK ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());
ALTER POLICY "admin_delete_examples" ON "public"."leak_hand_examples"
  USING ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());

-- --------------------------------------------- commander_tournament_points ---
ALTER POLICY "staff_insert_points" ON "public"."commander_tournament_points"
  WITH CHECK ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());
ALTER POLICY "staff_update_points" ON "public"."commander_tournament_points"
  USING ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin())
  WITH CHECK ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());
ALTER POLICY "staff_delete_points" ON "public"."commander_tournament_points"
  USING ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());

-- ------------------------------------------ commander_tournament_templates ---
ALTER POLICY "staff_insert_templates" ON "public"."commander_tournament_templates"
  WITH CHECK ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());
ALTER POLICY "staff_update_templates" ON "public"."commander_tournament_templates"
  USING ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin())
  WITH CHECK ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());
ALTER POLICY "staff_delete_templates" ON "public"."commander_tournament_templates"
  USING ((( SELECT auth.role()) = 'authenticated'::text) AND public.fn_is_platform_admin());

-- The assertion is deliberately two-sided. Counting only the policies that now
-- mention fn_is_platform_admin would pass just as happily if a rewrite had
-- silently dropped one; counting the surviving metadata references is what
-- catches that. A narrow assertion that passes reads as a guarantee.
DO $do$
DECLARE
  v_tables text[] := ARRAY['training_achievement_definitions','leak_hand_examples',
    'venues','training_scenarios','commander_tournament_points',
    'commander_tournament_templates'];
  v_stale integer;
  v_fixed integer;
BEGIN
  SELECT count(*) INTO v_stale FROM pg_policies
   WHERE schemaname = 'public' AND tablename = ANY(v_tables)
     AND (coalesce(qual,'') || coalesce(with_check,'')) ~ 'raw_user_meta_data';
  IF v_stale <> 0 THEN
    RAISE EXCEPTION
      '% policy/policies on the six tables still read raw_user_meta_data', v_stale;
  END IF;

  SELECT count(*) INTO v_fixed FROM pg_policies
   WHERE schemaname = 'public' AND tablename = ANY(v_tables)
     AND (coalesce(qual,'') || coalesce(with_check,'')) ~ 'fn_is_platform_admin';
  IF v_fixed <> 18 THEN
    RAISE EXCEPTION
      'expected 18 write policies gated by fn_is_platform_admin, found %', v_fixed;
  END IF;

  RAISE NOTICE
    'admin writes: 18 policies across 6 tables now trust profiles.role via fn_is_platform_admin(); 0 still read self-written user_metadata.';
END
$do$;

COMMIT;
