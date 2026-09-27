-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260512143933 "20260512143500_drop_unused_post_targets_overload"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e0506dbd224fe9e397279787d11635fd of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Dan-fix/home-group-identity (2026-05-12)
--
-- The function fn_list_my_post_targets() exists in two overloads:
--   1) fn_list_my_post_targets()                            — uses auth.uid()
--   2) fn_list_my_post_targets(p_caller_user_id uuid)       — caller passes uuid
--
-- The only caller in the codebase is src/components/social/SharedPostCreator.jsx
-- which calls the no-args form:
--     supabase.rpc('fn_list_my_post_targets')
--
-- When PostgREST sees an overloaded function with the same name, it must pick
-- one based on the request body. With an empty body `{}`, it should pick the
-- no-args overload — but supabase-js can sometimes inject default keys, and
-- PostgREST 11+ has had bug reports where overload resolution silently fails
-- (returning 300 Multiple Choices or 404 Could not find function), which the
-- supabase-js promise then surfaces as an `error` in the response. The .catch
-- in SharedPostCreator silently swallows it, leaving homeGroupTargets empty.
--
-- Dan reported the home-group never appearing in his social composer picker,
-- even though the server-side RPC returns his home_group correctly. Dropping
-- the unused 1-arg overload eliminates the possibility of overload ambiguity.
--
-- Same pattern likely affects fn_list_my_home_memberships if it has the same
-- two overloads — handled in a sibling migration if it surfaces.
--
-- Verification post-migration:
--   1. Only one fn_list_my_post_targets in pg_proc
--   2. SharedPostCreator's no-args call still returns Dan's home_group row
--   3. Dan re-tests /hub/social-media picker → expects "Home Groups" section

DROP FUNCTION IF EXISTS public.fn_list_my_post_targets(uuid);

-- Confirm only the no-args form remains
DO $$
DECLARE
  cnt int;
BEGIN
  SELECT count(*) INTO cnt
  FROM pg_proc p
  WHERE p.proname = 'fn_list_my_post_targets'
    AND p.pronamespace = 'public'::regnamespace;
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'expected 1 fn_list_my_post_targets after drop, found %', cnt;
  END IF;
END$$;

