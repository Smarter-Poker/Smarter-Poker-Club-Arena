-- A departed membership keeps its earned accounting wallet; departure is not forfeiture.
-- Original October 5-12 R2 rolled back with MEMBERSHIP_DEPARTED when the canonical
-- commission stage credited chip_balance and updated_at on a preserved departed row.
-- Permit only the existing trusted-server identity and those two fields. All other
-- columns, including future columns, must remain identical. Lifecycle, status,
-- hierarchy, browser restrictions and the existing depart/rejoin path stay intact.
-- No money, membership, grant, trigger attachment or inventory certificate is changed.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_guard_membership_lifecycle_write()'::regprocedure))='9d41bf84bc77ef026c604438c0c96b5e' AND smarter_private.original_inventory_proof_sources_match() IS TRUE)
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $departed_accounting$
DECLARE def text; generation text;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL THEN RAISE EXCEPTION 'departed_accounting_operator_refused'; END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL OR public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'departed_accounting_freeze_or_override_refused'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'departed_accounting_scheduler_owned'; END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261017053808') THEN RAISE EXCEPTION 'departed_accounting_history_replay'; END IF;
 IF md5(pg_get_functiondef('public.fn_caller_is_engine()'::regprocedure)) IS DISTINCT FROM 'd9a70f1d932538025e656bfe2b4d091d' THEN RAISE EXCEPTION 'departed_accounting_caller_authority_changed'; END IF;
 generation:=smarter_private.original_inventory_basis_generation();
 IF generation IS NULL OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'departed_accounting_inventory_seal_required'; END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_guard_membership_lifecycle_write()') AND md5(pg_get_functiondef(p.oid))='bb2eca3ab004597dbd9137f78951e943' AND md5(p.prosrc)='3af5bb1377ef28a2e1f84c600b4268d6' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'departed_accounting_guard_preimage_authority_changed'; END IF;
 IF NOT EXISTS(SELECT FROM pg_trigger t WHERE t.tgrelid='public.club_members'::regclass AND t.tgname='trg_club_members_guard_lifecycle_write' AND t.tgfoid=to_regprocedure('public.fn_guard_membership_lifecycle_write()') AND NOT t.tgisinternal AND t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))='4811a529b594383343d46b2c4d1997b9') OR NOT EXISTS(SELECT FROM public.ca_declared_money_triggers d WHERE d.table_name='club_members' AND d.trigger_name='trg_club_members_guard_lifecycle_write') THEN RAISE EXCEPTION 'departed_accounting_declared_trigger_changed'; END IF;
 def:=pg_get_functiondef('public.fn_guard_membership_lifecycle_write()'::regprocedure);
 IF (length(def)-length(replace(def,$old$  IF OLD.membership_lifecycle_status = 'departed' AND NOT v_allowed THEN$old$,'')))/length($old$  IF OLD.membership_lifecycle_status = 'departed' AND NOT v_allowed THEN$old$)<>1 THEN RAISE EXCEPTION 'departed_accounting_exact_replacement_refused'; END IF;
 def:=replace(def,$old$  IF OLD.membership_lifecycle_status = 'departed' AND NOT v_allowed THEN$old$,$new$  IF OLD.membership_lifecycle_status = 'departed' AND NOT v_allowed
     AND NOT (public.fn_caller_is_engine() IS TRUE
       AND (to_jsonb(NEW) - ARRAY['chip_balance','updated_at'])
           IS NOT DISTINCT FROM
           (to_jsonb(OLD) - ARRAY['chip_balance','updated_at'])) THEN$new$);
 IF md5(def)<>'9d41bf84bc77ef026c604438c0c96b5e' THEN RAISE EXCEPTION 'departed_accounting_postimage_refused'; END IF;
 EXECUTE def;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_guard_membership_lifecycle_write()') AND md5(pg_get_functiondef(p.oid))='9d41bf84bc77ef026c604438c0c96b5e' AND md5(p.prosrc)='ef2447ac697ae90492b538e1c8d643c5' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'departed_accounting_installed_authority_changed'; END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation() IS DISTINCT FROM generation THEN RAISE EXCEPTION 'departed_accounting_inventory_generation_changed'; END IF;
END $departed_accounting$;
COMMIT;
