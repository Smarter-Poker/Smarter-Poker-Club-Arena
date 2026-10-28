-- Original private deposit key discovery timed out30s before any verdict.
-- Its exact club/coordinator/week index read union_id and rake_record_id from
-- the heap. Cover only these five scalar columns; no financial rule, query,
-- function, source65/GEN, grant, cache or budget changes. Current original
-- nullable selector and explicit NULL selector both qualify unchanged.
-- @live-proof: (SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid=to_regclass('public.accounting_cash_private_deposit_keys_cover'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_cash_private_deposit_keys_cover
 ON public.accounting_cash_rake_sources(club_id,coordinator_union_id,earned_at)
 INCLUDE(rake_record_id,union_id);
BEGIN;
SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s';
DO $cover$DECLARE g text;seal text;BEGIN
 IF current_user<>'postgres'OR session_user<>'postgres'OR NULLIF(current_setting('request.jwt.claims',true),'')IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'')IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.sub',true),'')IS NOT NULL OR NULLIF(current_setting('ca.break_window_migration_override',true),'')IS NOT NULL THEN RAISE EXCEPTION 'private_keys_cover_operator_refused';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'private_keys_cover_source65_required';END IF;
 g:=smarter_private.original_inventory_basis_generation();seal:=pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure);IF g IS NULL THEN RAISE EXCEPTION 'private_keys_cover_generation_required';END IF;
 IF public.fn_ca_break_window_refuses_migrations(now())IS NOT NULL OR public.fn_platform_frozen()IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary()IS NOT NULL THEN RAISE EXCEPTION 'private_keys_cover_window_refused';END IF;
 IF NOT EXISTS(SELECT FROM pg_class c WHERE c.oid='public.accounting_cash_rake_sources'::regclass AND c.relkind='r' AND c.relpersistence='p' AND c.relowner='postgres'::regrole)THEN RAISE EXCEPTION 'private_keys_cover_source_refused';END IF;
 IF(SELECT count(*)FROM pg_attribute a WHERE a.attrelid='public.accounting_cash_rake_sources'::regclass AND NOT a.attisdropped AND((a.attname IN('club_id','coordinator_union_id','rake_record_id','union_id')AND a.atttypid='uuid'::regtype)OR(a.attname='earned_at'AND a.atttypid='timestamptz'::regtype)))<>5 THEN RAISE EXCEPTION 'private_keys_cover_columns_refused';END IF;
 IF NOT EXISTS(SELECT FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indexrelid=to_regclass('public.accounting_cash_private_deposit_keys_cover')AND i.indrelid='public.accounting_cash_rake_sources'::regclass AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique AND NOT i.indisprimary AND i.indnkeyatts=3 AND i.indnatts=5 AND i.indexprs IS NULL AND i.indpred IS NULL AND c.relowner='postgres'::regrole AND pg_get_indexdef(i.indexrelid)='CREATE INDEX accounting_cash_private_deposit_keys_cover ON public.accounting_cash_rake_sources USING btree (club_id, coordinator_union_id, earned_at) INCLUDE (rake_record_id, union_id)')THEN RAISE EXCEPTION 'private_keys_cover_exact_catalog_required';END IF;
IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation()IS DISTINCT FROM g OR pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure)IS DISTINCT FROM seal THEN RAISE EXCEPTION 'private_keys_cover_original_source_changed';END IF;
END$cover$;
COMMIT;
