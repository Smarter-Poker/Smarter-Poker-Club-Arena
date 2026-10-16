-- Reserved by scripts/new-migration.mjs:20261016214904.
-- Original Oct5 close paidR1, then its unchanged240s R2 trial timed out inside
-- fn_settle_accounting_commission_combine's per-source TOAST digest slicing.
-- Copy each window's byte stream once, project only UUID/digest rows before
-- sorting, and preserve the exact cash-first/UUID-ordered fingerprint bytes.
-- The earned-plan combiner shares that expression and receives the same fix.
-- No proof lifetime, source40, generation, financial rule, amount or budget changes.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_settle_accounting_commission_combine(text,uuid,timestamptz,timestamptz)'::regprocedure))='98470df5bb0e684508cc2fc8a105e9a6')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_union_earned_plan_combine(uuid,timestamptz,timestamptz)'::regprocedure))='79ea1825fc78b42b0928bac70b5ac4f6')
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $guard$
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL THEN RAISE EXCEPTION 'window_digest_operator_refused';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL OR public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'window_digest_freeze_or_override_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'window_digest_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261016214904') THEN RAISE EXCEPTION 'window_digest_history_replay';END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'window_digest_inventory_seal_required';END IF;
END $guard$;
DO $install_commission$
DECLARE sig regprocedure:='public.fn_settle_accounting_commission_combine(text,uuid,timestamptz,timestamptz)'::regprocedure;def text:=pg_get_functiondef(sig);
BEGIN
 IF md5(def)<>'0a4e7a1bc6b05634ebb0d87e6cc05501' OR (SELECT proowner<>'postgres'::regrole OR prosecdef OR provolatile<>'v' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' OR proconfig IS DISTINCT FROM ARRAY['search_path=public'] FROM pg_proc WHERE oid=sig) THEN RAISE EXCEPTION 'window_digest_preimage_authority_refused';END IF;
 IF (length(def)-length(replace(def,$old$ SELECT md5(COALESCE((SELECT string_agg(encode(substring(w.cash_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL unnest(w.cash_ids) WITH ORDINALITY u(id,ord)),'')
  ||COALESCE((SELECT string_agg(encode(substring(w.fee_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL unnest(w.fee_ids) WITH ORDINALITY u(id,ord)),'')) INTO fp;$old$,'')))/length($old$ SELECT md5(COALESCE((SELECT string_agg(encode(substring(w.cash_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL unnest(w.cash_ids) WITH ORDINALITY u(id,ord)),'')
  ||COALESCE((SELECT string_agg(encode(substring(w.fee_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL unnest(w.fee_ids) WITH ORDINALITY u(id,ord)),'')) INTO fp;$old$)<>1 THEN RAISE EXCEPTION 'window_digest_exact_replacement_refused';END IF;
 def:=replace(def,$old$ SELECT md5(COALESCE((SELECT string_agg(encode(substring(w.cash_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL unnest(w.cash_ids) WITH ORDINALITY u(id,ord)),'')
  ||COALESCE((SELECT string_agg(encode(substring(w.fee_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL unnest(w.fee_ids) WITH ORDINALITY u(id,ord)),'')) INTO fp;$old$,$new$ WITH fingerprint_windows AS MATERIALIZED (SELECT w.cash_ids,w.cash_md5||''::bytea AS cash_md5,w.fee_ids,w.fee_md5||''::bytea AS fee_md5 FROM pg_temp._close_r2_windows w),
 cash_rows AS MATERIALIZED (SELECT u.id,encode(substring(w.cash_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex') AS row_md5 FROM fingerprint_windows w CROSS JOIN LATERAL unnest(w.cash_ids) WITH ORDINALITY u(id,ord)),
 fee_rows AS MATERIALIZED (SELECT u.id,encode(substring(w.fee_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex') AS row_md5 FROM fingerprint_windows w CROSS JOIN LATERAL unnest(w.fee_ids) WITH ORDINALITY u(id,ord))
 SELECT md5(COALESCE((SELECT string_agg(c.row_md5,'' ORDER BY c.id) FROM cash_rows c),'')
  ||COALESCE((SELECT string_agg(f.row_md5,'' ORDER BY f.id) FROM fee_rows f),'')) INTO fp;$new$);
 IF md5(def)<>'98470df5bb0e684508cc2fc8a105e9a6' THEN RAISE EXCEPTION 'window_digest_postimage_refused';END IF;
 EXECUTE def;
 IF md5(pg_get_functiondef(sig))<>'98470df5bb0e684508cc2fc8a105e9a6' THEN RAISE EXCEPTION 'window_digest_installed_source_refused';END IF;
END $install_commission$;
DO $install_earned$
DECLARE sig regprocedure:='public.fn_accounting_union_earned_plan_combine(uuid,timestamptz,timestamptz)'::regprocedure;def text:=pg_get_functiondef(sig);
BEGIN
 IF md5(def)<>'b2e3fd77ed627e13476e440bf7aa5322' OR (SELECT proowner<>'postgres'::regrole OR prosecdef OR provolatile<>'v' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' OR proconfig IS DISTINCT FROM ARRAY['search_path=public'] FROM pg_proc WHERE oid=sig) THEN RAISE EXCEPTION 'window_digest_preimage_authority_refused';END IF;
 IF (length(def)-length(replace(def,$old$ SELECT md5(COALESCE((SELECT string_agg(encode(substring(w.cash_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_plan_windows w CROSS JOIN LATERAL unnest(w.cash_ids) WITH ORDINALITY u(id,ord)),'')
  ||COALESCE((SELECT string_agg(encode(substring(w.fee_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_plan_windows w CROSS JOIN LATERAL unnest(w.fee_ids) WITH ORDINALITY u(id,ord)),'')) INTO fp;$old$,'')))/length($old$ SELECT md5(COALESCE((SELECT string_agg(encode(substring(w.cash_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_plan_windows w CROSS JOIN LATERAL unnest(w.cash_ids) WITH ORDINALITY u(id,ord)),'')
  ||COALESCE((SELECT string_agg(encode(substring(w.fee_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_plan_windows w CROSS JOIN LATERAL unnest(w.fee_ids) WITH ORDINALITY u(id,ord)),'')) INTO fp;$old$)<>1 THEN RAISE EXCEPTION 'window_digest_exact_replacement_refused';END IF;
 def:=replace(def,$old$ SELECT md5(COALESCE((SELECT string_agg(encode(substring(w.cash_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_plan_windows w CROSS JOIN LATERAL unnest(w.cash_ids) WITH ORDINALITY u(id,ord)),'')
  ||COALESCE((SELECT string_agg(encode(substring(w.fee_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_plan_windows w CROSS JOIN LATERAL unnest(w.fee_ids) WITH ORDINALITY u(id,ord)),'')) INTO fp;$old$,$new$ WITH fingerprint_windows AS MATERIALIZED (SELECT w.cash_ids,w.cash_md5||''::bytea AS cash_md5,w.fee_ids,w.fee_md5||''::bytea AS fee_md5 FROM pg_temp._close_plan_windows w),
 cash_rows AS MATERIALIZED (SELECT u.id,encode(substring(w.cash_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex') AS row_md5 FROM fingerprint_windows w CROSS JOIN LATERAL unnest(w.cash_ids) WITH ORDINALITY u(id,ord)),
 fee_rows AS MATERIALIZED (SELECT u.id,encode(substring(w.fee_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex') AS row_md5 FROM fingerprint_windows w CROSS JOIN LATERAL unnest(w.fee_ids) WITH ORDINALITY u(id,ord))
 SELECT md5(COALESCE((SELECT string_agg(c.row_md5,'' ORDER BY c.id) FROM cash_rows c),'')
  ||COALESCE((SELECT string_agg(f.row_md5,'' ORDER BY f.id) FROM fee_rows f),'')) INTO fp;$new$);
 IF md5(def)<>'79ea1825fc78b42b0928bac70b5ac4f6' THEN RAISE EXCEPTION 'window_digest_postimage_refused';END IF;
 EXECUTE def;
 IF md5(pg_get_functiondef(sig))<>'79ea1825fc78b42b0928bac70b5ac4f6' THEN RAISE EXCEPTION 'window_digest_installed_source_refused';END IF;
END $install_earned$;
DO $post$BEGIN IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'window_digest_inventory_seal_changed';END IF;END $post$;
COMMIT;
