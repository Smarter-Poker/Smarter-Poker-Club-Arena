-- ONLY A CHUNKED TICK OWNS THE IN-PROGRESS FAST PATH.
-- 20261017121500 let a tick whose first scope is an in-progress union book skip the
-- full scope scan. The engine's 8 s service_role probe also calls the coordinator
-- (unchunked). Before 20261017121500 the probe always ran out of time inside the
-- scan and recorded nothing. With the fast path it reached the in-progress book,
-- was cancelled 8 s into the visit, and marked it in_progress_visit, which gave the
-- book's place back on the next job 272 tick (observed 2026-10-17 13:15:06 UTC).
-- The fast path now applies only when v_chunked (job 272) is on, so the probe
-- reads the full scan exactly as before 20261017121500. Job 272 is unchanged.
-- No money, certificate, partial, period, budget, memo, ACL, trigger or sealed source changes.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))='56eb1c0de1083bddd8a1e218a85df511' AND smarter_private.original_inventory_proof_sources_match() IS TRUE)
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $chunked_tick_owner$
DECLARE def text;sig regprocedure;generation text;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL THEN RAISE EXCEPTION 'chunked_tick_owner_operator_refused';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL OR public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'chunked_tick_owner_freeze_or_override_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'chunked_tick_owner_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261017132500') THEN RAISE EXCEPTION 'chunked_tick_owner_history_replay';END IF;
 generation:=smarter_private.original_inventory_basis_generation();
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true OR generation IS NULL THEN RAISE EXCEPTION 'chunked_tick_owner_inventory_seal_required';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_process_weekly_accounting_scope(uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='6bd020f058339c34e51a88717cf4fbd6' AND md5(p.prosrc)='e8a3de1a65a7b3dca17c36cb42a2aab0' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v' AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'chunked_tick_owner_preimage_authority_refused';END IF;
 sig:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;def:=pg_get_functiondef(sig);
 IF (length(def)-length(replace(def,$old_0$            AND EXISTS(SELECT 1 FROM owned_tick o WHERE o.in_progress) AS owned
$old_0$,'')))/length($old_0$            AND EXISTS(SELECT 1 FROM owned_tick o WHERE o.in_progress) AS owned
$old_0$)<>1 THEN RAISE EXCEPTION 'chunked_tick_owner_exact_replacement_refused';END IF;
 def:=replace(def,$old_0$            AND EXISTS(SELECT 1 FROM owned_tick o WHERE o.in_progress) AS owned
$old_0$,$new_0$            AND EXISTS(SELECT 1 FROM owned_tick o WHERE o.in_progress)
            -- ONLY A CHUNKED TICK OWNS IT (20261017132500): the engine's 8 s
            -- service_role probe reads the full scan, as it always has.
            AND v_chunked AS owned
$new_0$);
 IF md5(def)<>'56eb1c0de1083bddd8a1e218a85df511' THEN RAISE EXCEPTION 'chunked_tick_owner_postimage_refused';END IF;
 EXECUTE def;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_process_weekly_accounting_scope(uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='56eb1c0de1083bddd8a1e218a85df511' AND md5(p.prosrc)='30454d5392d9267c35f7ce7d5596cd75' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v' AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'chunked_tick_owner_installed_authority_refused';END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation() IS DISTINCT FROM generation THEN RAISE EXCEPTION 'chunked_tick_owner_inventory_seal_changed';END IF;
END $chunked_tick_owner$;
COMMIT;
