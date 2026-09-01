-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831114942; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- fn_prune_index_usage_snapshots is SECURITY DEFINER and it DELETEs. Postgres
-- grants EXECUTE to PUBLIC by default and Supabase publishes every public
-- function as an RPC, so as created it was an unauthenticated DELETE over the
-- very evidence table the migration exists to protect: anyone could erase the
-- history and reset the unused-index verdict to "no evidence" indefinitely.
--
-- It cannot consult auth.uid() instead, because pg_cron runs it with no JWT at
-- all. The honest answer is that no browser role holds it.
--
-- Caught by scripts/ci/check-definer-authorization.mjs in the pre-push hook -
-- the same rule extended one phase earlier the same day, now catching its
-- author.

REVOKE ALL ON FUNCTION public.fn_prune_index_usage_snapshots(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_prune_index_usage_snapshots(integer) TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon',
       'public.fn_prune_index_usage_snapshots(integer)'::regprocedure, 'EXECUTE')
  OR has_function_privilege('authenticated',
       'public.fn_prune_index_usage_snapshots(integer)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role still holds EXECUTE on the snapshot prune';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.fn_prune_index_usage_snapshots(integer)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost EXECUTE - the nightly prune would stop';
  END IF;
END $$;
