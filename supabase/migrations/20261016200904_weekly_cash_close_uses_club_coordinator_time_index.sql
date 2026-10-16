-- Reserved by scripts/new-migration.mjs:20261016200904.
-- The exact original-week rollback trial still exceeded its unchanged 3-minute
-- scope budget before round 1. Completed predecessor club discovery took56.790s,
-- original preparation repeated it15.708s, and commission validation44.363s.
-- The club/coordinator/latest lookup chose an index whose club key followed a
-- date range, repeatedly scanning the week for absent clubs. Add the matching
-- equality/equality/range index through the maintained concurrent preamble.
-- Commission validation now materializes only IDs through the existing positive
-- cash index, fetching wide rake rows only for actual unaccrued candidates.
-- The exact full readonly production predicate returned no unaccrued candidates
-- in9.178s; every original ghost, scope, attribution and cutoff check remains.
-- No source40, financial rule, budget, proof lifetime, scheduler or money change.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz)'::regprocedure))='0df1c3e9fe3e1a0e53a043baf57127d7' AND EXISTS(SELECT FROM pg_index WHERE indexrelid=to_regclass('public.accounting_cash_rake_sources_club_coordinator_earned') AND indisvalid AND indisready AND indislive))
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_cash_rake_sources_club_coordinator_earned
 ON public.accounting_cash_rake_sources (club_id,coordinator_union_id,earned_at);

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $guard$
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL THEN RAISE EXCEPTION 'weekly_cash_access_operator_refused';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL OR public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'weekly_cash_access_freeze_or_override_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'weekly_cash_access_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261016200904') THEN RAISE EXCEPTION 'weekly_cash_access_history_replay';END IF;
 IF NOT EXISTS(SELECT FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam WHERE c.oid=to_regclass('public.accounting_cash_rake_sources_club_coordinator_earned') AND i.indrelid='public.accounting_cash_rake_sources'::regclass AND c.relowner='postgres'::regrole AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique AND i.indnkeyatts=3 AND i.indnatts=3 AND i.indexprs IS NULL AND i.indpred IS NULL AND am.amname='btree' AND pg_get_indexdef(i.indexrelid,1,true)='club_id' AND pg_get_indexdef(i.indexrelid,2,true)='coordinator_union_id' AND pg_get_indexdef(i.indexrelid,3,true)='earned_at') THEN RAISE EXCEPTION 'weekly_cash_access_exact_index_required';END IF;
 IF NOT EXISTS(SELECT FROM pg_index WHERE indexrelid=to_regclass('public.rake_records_cash_positive_created') AND indisvalid AND indisready AND indislive AND indrelid='public.rake_records'::regclass AND indnkeyatts=2 AND indnatts=2 AND pg_get_indexdef(indexrelid,1,true)='created_at' AND pg_get_indexdef(indexrelid,2,true)='id' AND pg_get_expr(indpred,indrelid)='((rake_amount > (0)::numeric) AND (is_tournament IS NOT TRUE) AND (tournament_id IS NULL))') THEN RAISE EXCEPTION 'weekly_cash_access_partial_index_required';END IF;
 IF NOT EXISTS(SELECT FROM pg_constraint WHERE conrelid='public.rake_records'::regclass AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (id)') THEN RAISE EXCEPTION 'weekly_cash_access_rake_identity_required';END IF;
END $guard$;
DO $install$
DECLARE sig regprocedure:='public.fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz)'::regprocedure;def text:=pg_get_functiondef(sig);
BEGIN
 IF md5(def)<>'3143ddd4ec0f5eb3312700a1dd2b5b83' OR (SELECT proowner<>'postgres'::regrole OR NOT prosecdef OR provolatile<>'s' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' OR proconfig IS DISTINCT FROM ARRAY['search_path=public'] FROM pg_proc WHERE oid=sig) THEN RAISE EXCEPTION 'weekly_cash_access_preimage_authority_refused';END IF;
 IF (length(def)-length(replace(def,$old0$SELECT r.id, r.club_id, r.hand_id, r.table_id, r.metadata, r.created_at$old0$,'')))/length($old0$SELECT r.id, r.club_id, r.hand_id, r.table_id, r.metadata, r.created_at$old0$)<>1 THEN RAISE EXCEPTION 'weekly_cash_access_exact_replacement_refused';END IF;
 def:=replace(def,$old0$SELECT r.id, r.club_id, r.hand_id, r.table_id, r.metadata, r.created_at$old0$,$new0$SELECT r.id$new0$);
 IF (length(def)-length(replace(def,$old1$NOT COALESCE(r.is_tournament,false)$old1$,'')))/length($old1$NOT COALESCE(r.is_tournament,false)$old1$)<>1 THEN RAISE EXCEPTION 'weekly_cash_access_exact_replacement_refused';END IF;
 def:=replace(def,$old1$NOT COALESCE(r.is_tournament,false)$old1$,$new1$r.is_tournament IS NOT TRUE$new1$);
 IF (length(def)-length(replace(def,$old2$SELECT 1 FROM unaccrued r$old2$,'')))/length($old2$SELECT 1 FROM unaccrued r$old2$)<>1 THEN RAISE EXCEPTION 'weekly_cash_access_exact_replacement_refused';END IF;
 def:=replace(def,$old2$SELECT 1 FROM unaccrued r$old2$,$new2$SELECT 1 FROM unaccrued u JOIN public.rake_records r ON r.id=u.id$new2$);
 IF md5(def)<>'0df1c3e9fe3e1a0e53a043baf57127d7' THEN RAISE EXCEPTION 'weekly_cash_access_postimage_refused';END IF;
 EXECUTE def;
 IF md5(pg_get_functiondef(sig))<>'0df1c3e9fe3e1a0e53a043baf57127d7' THEN RAISE EXCEPTION 'weekly_cash_access_installed_source_refused';END IF;
END $install$;
COMMIT;
