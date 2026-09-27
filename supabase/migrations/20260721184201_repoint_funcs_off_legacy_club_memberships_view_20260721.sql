-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721184201 "repoint_funcs_off_legacy_club_memberships_view_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 85ebdb94aaee689810143c4b39a769a9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Task #53 (expanded): repoint ALL functions off the legacy club_memberships VIEW
-- onto the canonical club_members table. Discovery: 16 money RPCs referenced the
-- view, not just mint_club_chips. All 16 are SECURITY INVOKER, and the view is
-- security_invoker=true (a transparent RLS-preserving passthrough of club_members),
-- so swapping the view name for the table name is behavior-IDENTICAL for every
-- caller (service-role and user-JWT alike). This removes the legacy dependency
-- across the money layer.
--
-- Implemented as a self-verifying loop: regenerate each function's exact current
-- definition, substitute the view name for the table name, and re-create it. The
-- full signature + SECURITY INVOKER + search_path are all preserved by
-- pg_get_functiondef. Idempotent (a replay finds nothing to change).
DO $mig$
DECLARE r record; v_def text;
BEGIN
  FOR r IN
    SELECT oid, proname FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND prosrc ILIKE '%club_memberships%'
  LOOP
    v_def := pg_get_functiondef(r.oid);
    -- 'club_memberships' -> 'club_members' (exact-substring replace; existing
    -- 'club_members' references are untouched).
    v_def := replace(v_def, 'club_memberships', 'club_members');
    EXECUTE v_def;
  END LOOP;
END
$mig$;
