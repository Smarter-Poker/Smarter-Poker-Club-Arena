-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424015856 "20260421185000_hg_pin_search_path_on_3_trigger_secdef_fns"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ed977f1b79a40489d7982b2bc3c0ab7d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Defense-in-depth: 3 SECURITY DEFINER trigger fns had no explicit
-- SET search_path. Bodies currently use public.-qualified refs (no
-- immediate exploit), but pinning search_path is the standard
-- hardening — prevents future refactors from silently introducing
-- unqualified refs that would be hijackable via pg_temp.social_pages.

ALTER FUNCTION public.autocreate_home_group_social_page()
  SET search_path = public, pg_temp;
ALTER FUNCTION public.link_home_game_to_social_page()
  SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_home_group_to_social_page()
  SET search_path = public, pg_temp;
