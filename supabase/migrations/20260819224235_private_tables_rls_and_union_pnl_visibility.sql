-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819224235 "private_tables_rls_and_union_pnl_visibility"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ec85b988becd43f0506e278581ea236a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- AUDIT ROUND 3 (2026-08-19)
--
-- 1. PRIVATE TABLES WERE WORLD-READABLE. The `tables` SELECT policy was
--    literally USING (true) — despite being named "Club members can view
--    tables", it checked nothing. Every client-side omission therefore became
--    a real exposure: SearchPage lists tables by name with no filters at all,
--    and TableService.getActiveTables is a platform-wide lobby helper. Now
--    that union clubs create is_private games, those were readable by anyone.
--    RLS is the one place this closes for every present and future query.
--
--    Union-owned tables stay readable (that IS the shared union lobby, and
--    club_id may be NULL on them). Only private games become club-scoped.
--
-- 2. THE WEEKLY UNION SETTLEMENT HAD NO READABLE SURFACE. union_pnl_settlements
--    was service_role-only, so a union admin could not see what was settled,
--    what was collected or paid, or why a period was parked needs_review.
--    A money process nobody can inspect is a money process nobody trusts.
-- ============================================================================

DROP POLICY IF EXISTS "Club members can view tables" ON tables;
DROP POLICY IF EXISTS tables_select_scoped ON tables;
CREATE POLICY tables_select_scoped ON tables
  FOR SELECT
  USING (
    COALESCE(is_private, false) = false
    OR club_id IS NULL
    OR is_club_member(club_id, (SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM clubs c
                WHERE c.id = tables.club_id AND c.owner_id = (SELECT auth.uid()))
    OR fn_union_oversees_club(club_id, (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS union_pnl_settlements_admin_read ON union_pnl_settlements;
CREATE POLICY union_pnl_settlements_admin_read ON union_pnl_settlements
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM unions u
             WHERE u.id = union_pnl_settlements.union_id
               AND u.owner_id = (SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM union_admins a
                WHERE a.union_id = union_pnl_settlements.union_id
                  AND a.user_id = (SELECT auth.uid()))
  );

DO $$
DECLARE v_expr text;
BEGIN
  SELECT pg_get_expr(polqual, polrelid) INTO v_expr
    FROM pg_policy WHERE polrelid = 'public.tables'::regclass AND polcmd = 'r' LIMIT 1;
  IF v_expr IS NULL OR v_expr = 'true' THEN
    RAISE EXCEPTION 'ASSERTION FAILED: tables SELECT policy still unrestricted (%)', v_expr;
  END IF;
  IF v_expr NOT LIKE '%is_private%' THEN
    RAISE EXCEPTION 'ASSERTION FAILED: tables SELECT policy ignores is_private';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                  WHERE polrelid = 'public.union_pnl_settlements'::regclass
                    AND polname = 'union_pnl_settlements_admin_read') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: union P&L read policy missing';
  END IF;
END $$;
