-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260501014344 "lock_search_path_on_secdef_triggers"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8bdd45e9dc3289f20e036bab201de491 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Lock search_path on the two SECURITY DEFINER trigger functions surfaced by the
-- Supabase security advisor. Without this, a malicious user with CREATE on a
-- shadowing schema could intercept the INSERT-time lookups (profiles,
-- social_stories) and either steal data or pollute author_name with attacker-
-- controlled text.
ALTER FUNCTION public.enforce_live_comment_author_name()
    SET search_path = public, extensions;

ALTER FUNCTION public.fn_auto_create_story_from_post()
    SET search_path = public, extensions;
