BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '170s';

/* PHASE 7 OF 8 (UNION ACCOUNTING) - TWO DEFECTS THE GATES CAUGHT ON THE WAY
   IN, IN CODE THAT WAS ALREADY LIVE.
   ---------------------------------------------------------------------------
   20260908025653, 031445, 032512 and 033445 were applied to production through
   the Supabase MCP and never opened as a pull request, so they never met
   .husky/pre-push. Committing them (this branch) ran those gates for the first
   time, and two of them fired on SQL that had been serving for an hour. Both
   findings are real. This migration is the forward fix for BOTH IN PRODUCTION,
   which ran the original statements and is not changed by editing a file.

   ONE EDIT WAS MADE TO A RECOVERED FILE, and it is recorded here rather than
   left for somebody to find with git blame: 20260908025653 line 371 gains the
   two words `WHERE true`. The unqualified-write gate reads one file at a time
   and its only escape hatch is an in-file declaration that the write is
   unreachable - which would have been a lie, since service_role reaches it
   through PostgREST. The change is semantically identical (both forms delete
   every row) and it stops the file being a landmine for the next rebuild. The
   byte-exact record of what production executed remains in
   supabase_migrations.schema_migrations.statements.

   ---------------------------------------------------------------------------
   1. THE ROLLUP REBUILD COULD NOT RUN THROUGH THE API.

   fn_rebuild_agent_commission_rollup contains

       DELETE FROM public.agent_commission_unsettled_rollup;

   with no WHERE. That is legal SQL and it works every time it is run as
   `postgres`, which is how the migration ran it - so it applied cleanly and
   looked correct. PostgREST connects as `authenticator`, which carries
   session_preload_libraries = safeupdate, and safeupdate raises "DELETE
   requires a WHERE clause". SET ROLE service_role does not unload it.

   REACHABLE, verified 2026-09-08: the function is SECURITY INVOKER and
   has_function_privilege('service_role', ..., 'EXECUTE') is true, so it IS an
   RPC the engine and the operator dashboard can call - and every such call
   would have raised, every time. The same shape silently stopped the GTO
   aggregation driver for an hour on 2026-09-06.

   The intent here really is every row: the function takes SHARE ROW EXCLUSIVE
   on the ledger and rebuilds the whole rollup from
   agent_commissions_unsettled. So this is remedy 1 from the gate's own list -
   `WHERE true` - which is semantically identical and which safeupdate accepts.
   Nothing else about the function changes.

   THE LIVE PATH WAS REASONED ABOUT, NOT EXECUTED (section 11.5, rule 5).
   safeupdate is preloaded onto `authenticator`, not onto the `postgres` role
   the MCP connects as, so the refusal cannot be reproduced from here, and
   calling the real rebuild on production to watch it fail would take a lock on
   a 2.6 GB ledger to prove a mechanism the gate already documents.

   ---------------------------------------------------------------------------
   2. THE OWED READER NEVER NAMED THE ROLES IT MEANT TO SERVE.

   fn_agent_unsettled_commission is SECURITY DEFINER, owned by postgres, and it
   never calls auth.uid(): it trusts the p_club_id / p_user_id it is handed.
   Neither 20260908025653 nor 20260908032512 issued a GRANT or a REVOKE for it,
   and a function created with no grant statement is EXECUTE-to-PUBLIC by
   default, which anon inherits.

   PRODUCTION IS NOT EXPOSED, verified 2026-09-08:
   has_function_privilege('anon', ..., 'EXECUTE') is false, because the
   function predates phase 7 and CREATE OR REPLACE PRESERVES the privileges of
   the function it replaces. The hole is in the FILES, and it is the kind that
   only appears when somebody rebuilds from them - a restore, a branch
   database, a fresh environment - where the CREATE is a create rather than a
   replace and the default takes effect. That environment would hand every
   (club, agent) commission figure to an unauthenticated caller.

   So this states the grants the platform actually relies on instead of
   inheriting them. It is not an RLS policy helper - pg_policy holds no policy
   whose expression references it (checked 2026-09-08), so revoking cannot
   deny anyone a row.
*/

-- 1. The rebuild, unchanged except for the two words safeupdate needs.
CREATE OR REPLACE FUNCTION public.fn_rebuild_agent_commission_rollup()
RETURNS TABLE(pairs bigint, owed numeric, rows_behind bigint)
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (session_user IN ('postgres', 'supabase_admin')
          OR coalesce(auth.role(), '') = 'service_role'
          OR coalesce(fn_is_platform_admin(), false)) THEN
    RAISE EXCEPTION 'rebuild is an operator action' USING ERRCODE = '42501';
  END IF;

  -- Nothing may write the ledger between the count and the commit.
  LOCK TABLE public.agent_commissions IN SHARE ROW EXCLUSIVE MODE;

  -- WHERE true: this is a full rebuild and it means every row, but PostgREST
  -- runs under safeupdate, which refuses an unqualified DELETE outright.
  DELETE FROM public.agent_commission_unsettled_rollup WHERE true;
  INSERT INTO public.agent_commission_unsettled_rollup
         (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
  SELECT ac.club_id, ac.user_id, sum(ac.amount), count(*), min(ac.created_at), now()
    FROM public.agent_commissions_unsettled ac
   WHERE ac.club_id IS NOT NULL AND ac.user_id IS NOT NULL
   GROUP BY ac.club_id, ac.user_id;

  RETURN QUERY
  SELECT count(*)::bigint, coalesce(sum(r.owed), 0), coalesce(sum(r.rows_behind), 0)::bigint
    FROM public.agent_commission_unsettled_rollup r;
END;
$function$;

-- 2. Say who may read the owed figure. PUBLIC is named as well as anon:
--    anon inherits whatever PUBLIC holds, so revoking anon alone is a no-op
--    that reads as a fix.
REVOKE ALL ON FUNCTION public.fn_agent_unsettled_commission(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_unsettled_commission(uuid, uuid)
  TO authenticated, service_role;

/* Assert both postconditions, so this aborts rather than reporting success if
   the board moved underneath it. */
DO $assert$
DECLARE
  still_unqualified int;
  anon_exec         boolean;
  authed_exec       boolean;
  svc_exec          boolean;
BEGIN
  SELECT count(*) INTO still_unqualified
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'fn_rebuild_agent_commission_rollup'
    AND p.prosrc ~* 'delete\s+from\s+public\.agent_commission_unsettled_rollup\s*;';
  IF still_unqualified <> 0 THEN
    RAISE EXCEPTION 'the rollup rebuild still holds an unqualified DELETE';
  END IF;

  SELECT has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         has_function_privilege('service_role', p.oid, 'EXECUTE')
    INTO anon_exec, authed_exec, svc_exec
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_agent_unsettled_commission';

  IF anon_exec THEN
    RAISE EXCEPTION 'anon can still execute fn_agent_unsettled_commission';
  END IF;
  IF NOT authed_exec OR NOT svc_exec THEN
    RAISE EXCEPTION 'fn_agent_unsettled_commission must stay callable by authenticated and service_role (got %, %)',
      authed_exec, svc_exec;
  END IF;
END
$assert$;

COMMIT;
