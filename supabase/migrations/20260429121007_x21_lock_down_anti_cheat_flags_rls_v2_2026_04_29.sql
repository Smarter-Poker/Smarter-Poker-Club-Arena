-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429121007 "x21_lock_down_anti_cheat_flags_rls_v2_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1eb9c0502f86785d10184bb6e2af4033 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 21 — anti_cheat_flags RLS lockdown (column is player_id, not user_id).

DROP POLICY IF EXISTS acf_service_all ON public.anti_cheat_flags;
DROP POLICY IF EXISTS anti_cheat_flags_service_role_all ON public.anti_cheat_flags;
DROP POLICY IF EXISTS anti_cheat_flags_self_read       ON public.anti_cheat_flags;

CREATE POLICY anti_cheat_flags_service_role_all
  ON public.anti_cheat_flags
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated users can see their OWN flags only (transparency about
-- moderation actions taken against them, but no peeking at rivals).
CREATE POLICY anti_cheat_flags_self_read
  ON public.anti_cheat_flags
  FOR SELECT
  TO authenticated
  USING (player_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.anti_cheat_flags FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.anti_cheat_flags TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.anti_cheat_flags TO service_role;
