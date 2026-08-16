-- 20260816_revoke_anon_execute_on_definer_functions.sql
--
-- APPLIED LIVE 2026-08-16 15:33 UTC. Safe to re-run.
--
-- Supabase grants EXECUTE on public-schema functions to `anon` and
-- `authenticated` by default. Combined with SECURITY DEFINER — which runs the
-- body as the owner and therefore bypasses RLS — that makes any such function
-- callable by anybody holding the publishable key, straight from a browser via
-- POST /rest/v1/rpc/<name>.
--
-- sp_prune_hand_history was the serious one: it is SECURITY DEFINER, it DELETEs
-- from hand_history, and it takes a batch size. An anonymous caller could have
-- invoked it with a large p_batch and destroyed hand history at will. It was
-- introduced earlier the same day as part of the retention work; this closes it
-- roughly two hours later. Caught by the repo's own
-- `anon_mutating_definer_functions_check_auth_uid` invariant in Pre-Deploy
-- Safety Checks — the check was doing exactly its job.
--
-- The other three are lower risk but cost nothing to close:
--   * sp_pending_family_apply_delta — plain mutating function (GTO pending-family
--     incremental maintenance)
--   * sp_pending_family_tg, trg_tournament_completed_stats — trigger functions.
--     PostgreSQL does not check EXECUTE privilege when firing a trigger, so
--     revoking here does NOT affect trigger behaviour; it only removes the
--     ability to call them directly over RPC.
--
-- Only pg_cron (running as postgres) and server-side service_role callers need
-- EXECUTE on any of these.

revoke execute on function public.sp_prune_hand_history(int)
  from public, anon, authenticated;

revoke execute on function public.sp_pending_family_apply_delta(jsonb)
  from public, anon, authenticated;

revoke execute on function public.sp_pending_family_tg()
  from public, anon, authenticated;

revoke execute on function public.trg_tournament_completed_stats()
  from public, anon, authenticated;

-- Verification:
--   select p.proname,
--          has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.prosecdef
--      and has_function_privilege('anon', p.oid, 'EXECUTE')
--      and pg_get_functiondef(p.oid) ~* '(^|[^a-z_])(insert|update|delete|truncate)[^a-z_]'
--      and pg_get_functiondef(p.oid) !~* 'auth\.uid\(\)';
--   -- expected: zero rows
