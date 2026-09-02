-- PIN THE SEARCH PATH ON THE ENGINE PREDICATE.
--
-- fn_caller_is_engine is the predicate that answers "is this caller the Hetzner
-- engine?", and on this platform that answer gates the trusted money path. It
-- was the only function in the database flagged `function_search_path_mutable`
-- by the Supabase security advisor.
--
-- HONEST SEVERITY. The advisor's stock warning is about SECURITY DEFINER
-- functions, where a mutable search_path lets a caller shadow the objects the
-- body resolves and borrow the definer's privileges. This function is NOT
-- SECURITY DEFINER — it is the default INVOKER — so the classic escalation does
-- not apply and the finding is less severe than the category name suggests.
--
-- It is still worth pinning, for one specific reason: the body resolves
-- `auth.role()`. Whenever this is evaluated in a context whose search_path the
-- caller influences — an RLS policy, or a function that did not pin its own —
-- a schema placed ahead of `auth` containing a `role()` that returns
-- 'service_role' makes the predicate answer yes. Everything downstream that
-- trusts "the engine did this" then accepts an ordinary session.
--
-- The fix costs nothing and closes the question. The body is unchanged.

ALTER FUNCTION public.fn_caller_is_engine() SET search_path = pg_catalog, public, auth;

DO $post$
DECLARE v_cfg text[]; v_result boolean;
BEGIN
  SELECT proconfig INTO v_cfg FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_caller_is_engine';
  IF v_cfg IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_cfg) c WHERE c LIKE 'search_path=%') THEN
    RAISE EXCEPTION 'search_path was not pinned on fn_caller_is_engine';
  END IF;

  -- And it must still answer correctly. This migration runs with no PostgREST
  -- request context, which is the trusted case, so it has to return true — if
  -- pinning had broken auth.role() resolution this would now be false and every
  -- engine-gated money path would start refusing the engine.
  SELECT public.fn_caller_is_engine() INTO v_result;
  IF v_result IS NOT TRUE THEN
    RAISE EXCEPTION 'fn_caller_is_engine now returns % for a trusted context; pinning broke it', v_result;
  END IF;
END
$post$;
