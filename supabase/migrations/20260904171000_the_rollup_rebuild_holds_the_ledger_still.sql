-- THE ROLLUP REBUILD HOLDS THE LEDGER STILL WHILE IT COUNTS.
--
-- Found re-reading 20260904170000 in the phase 4 verification pass.
-- fn_rebuild_agent_commission_rollup DELETEd the rollup and re-INSERTed it
-- from the ledger in one transaction, but took no lock on agent_commissions.
-- A commission landing while the rebuild ran would fire the insert trigger,
-- upsert its pair into the (now empty) rollup, and the rebuild's own INSERT
-- of the same pair would then fail on the primary key at commit - or, the
-- other way round, the trigger's row would be counted twice. The migration's
-- backfill was safe only because CREATE TRIGGER had already taken SHARE ROW
-- EXCLUSIVE on the ledger; the rebuild must take the same lock itself. Inserts
-- queue for the few seconds the count takes; they do not fail.
--
-- Same body otherwise. Grants restated because CREATE OR REPLACE keeps them
-- and the definer gate reads the file.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_rebuild_agent_commission_rollup()
RETURNS TABLE(pairs bigint, owed numeric, rows_behind bigint)
LANGUAGE plpgsql
SECURITY DEFINER
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

  DELETE FROM public.agent_commission_unsettled_rollup;
  INSERT INTO public.agent_commission_unsettled_rollup
         (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
  SELECT ac.club_id, ac.user_id, sum(ac.amount), count(*), min(ac.created_at), now()
    FROM agent_commissions ac
   WHERE ac.settled_at IS NULL AND ac.club_id IS NOT NULL AND ac.user_id IS NOT NULL
   GROUP BY ac.club_id, ac.user_id;

  RETURN QUERY
  SELECT count(*)::bigint, coalesce(sum(r.owed), 0), coalesce(sum(r.rows_behind), 0)::bigint
    FROM public.agent_commission_unsettled_rollup r;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_rebuild_agent_commission_rollup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rebuild_agent_commission_rollup() TO service_role;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'fn_rebuild_agent_commission_rollup'
     AND p.prosrc LIKE '%LOCK TABLE public.agent_commissions IN SHARE ROW EXCLUSIVE MODE%'
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF n <> 1 THEN RAISE EXCEPTION 'rebuild function not as declared'; END IF;
END $$;

COMMIT;
