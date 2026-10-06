-- ===========================================================================
--  VIDEO SEARCH ANSWERS THROUGH THE LIBRARY POLICY, NOT PAST IT
-- ===========================================================================
--
-- Closes issue #6082. The daily live definer-exposure audit
-- (scripts/ci/audit-live-definer-exposure.mjs) found one new
-- anon-executable SECURITY DEFINER reader:
--   public.search_video_learning(text, vector, integer)
-- It runs as its owner, past RLS, for a caller with no account, and never
-- asks who is asking.
--
-- WHY INVOKER IS THE ROOT FIX AND CHANGES NOTHING ANYBODY SEES. The function
-- reads exactly one relation, public.video_learning_search_documents, and
-- already filters it by public.fn_is_video_library_asset_eligible(video_id).
-- That table has RLS on and one SELECT policy,
-- video_learning_search_public_read, for {anon, authenticated}, whose
-- qualifier is the same fn_is_video_library_asset_eligible(video_id). Both
-- browser roles hold SELECT on the table, EXECUTE on the eligibility helper
-- (a reviewed anon reader in definer-exposure-baseline.json) and USAGE on
-- the extensions schema the vector operator lives in. So under SECURITY
-- INVOKER the policy admits precisely the rows the function's own WHERE
-- already returns: same rows, same callers, and the table policy now stands
-- behind the search instead of being bypassed by it. Read from production
-- 2026-10-05.
--
-- Not a revoke (option 1 or 2 of the audit): the public video library is
-- searched before login. Not a baseline entry (option 3): a reader that can
-- run as the caller has no reason to run as the owner.
--
-- Grants, search_path and the body are asserted unmoved; only prosecdef
-- changes. One ALTER, one transaction, applied outside the :50-:03 window.
-- ===========================================================================
-- @live-proof: (SELECT NOT prosecdef FROM pg_proc WHERE oid = 'public.search_video_learning(text,vector,integer)'::regprocedure)

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.search_video_learning(text,vector,integer)'::regprocedure))
       <> '256e2e2c3e116af147e0c279e9087365' THEN
    RAISE EXCEPTION 'search_video_learning is not the pinned text';
  END IF;
END $pre$;

ALTER FUNCTION public.search_video_learning(text, vector, integer) SECURITY INVOKER;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.search_video_learning(text,vector,integer)'::regprocedure))
       <> '1b974425375e37ced98bb01fe17b644a' THEN
    RAISE EXCEPTION 'search_video_learning does not read back as the postimage';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.search_video_learning(text,vector,integer)'::regprocedure
                    AND NOT p.prosecdef
                    AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres,anon=X/postgres,authenticated=X/postgres}'
                    AND p.proconfig = ARRAY['search_path=public, extensions']) THEN
    RAISE EXCEPTION 'search_video_learning grants or settings moved';
  END IF;
  -- The reader it now relies on: the table policy, for both browser roles.
  IF NOT EXISTS (SELECT 1 FROM pg_policy pol
                  WHERE pol.polrelid = 'public.video_learning_search_documents'::regclass
                    AND pol.polname = 'video_learning_search_public_read'
                    AND pol.polcmd = 'r')
     OR NOT has_table_privilege('anon', 'public.video_learning_search_documents', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.video_learning_search_documents', 'SELECT')
     OR NOT has_function_privilege('anon', 'public.fn_is_video_library_asset_eligible(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the library read policy is not standing behind search_video_learning';
  END IF;
END $post$;

COMMIT;
