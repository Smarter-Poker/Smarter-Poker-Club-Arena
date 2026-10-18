-- A weekly statement keeps its actual per-club quality certificate (2026-10-18).
-- The installed 20261017223358 cascade writes club_statement_quality:<club UUID>.
-- A guarded rolled-back original-week call on 2026-10-18 returned READY for
-- 183871 events, then failed 23514 because the table still allowed only nine
-- fixed P&L kinds. No payment was committed by that diagnostic.
-- Admit only that exact canonical lowercase UUID key alongside ALL nine old
-- kinds. The generic writer, reader, their ordinary 12-hour certificate life,
-- the separate 72-hour report-receipt life, every row and financial function
-- are unchanged. No replay, history rewrite, certificate refresh or payment.
-- Reserved by the maintained allocator as 20261018142435.
-- @live-proof: (SELECT convalidated AND md5(pg_get_constraintdef(oid))='be81406a7d1b6bb24d6330cd60b866a6' FROM pg_constraint WHERE conrelid='public.accounting_close_certificates'::regclass AND conname='accounting_close_certificates_kind_check')
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $admit_statement_kind$
DECLARE refusal text;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR auth.uid() IS NOT NULL
  OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL
  OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL
  OR NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL
 THEN RAISE EXCEPTION 'weekly_statement_kind_operator_refused';END IF;
 refusal:=public.fn_ca_break_window_refuses_migrations(now());
 IF refusal IS NOT NULL OR public.fn_platform_frozen() IS DISTINCT FROM false
  OR public.fn_active_maintenance_release_boundary() IS NOT NULL
 THEN RAISE EXCEPTION 'weekly_statement_kind_window_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0))
 THEN RAISE EXCEPTION 'weekly_statement_kind_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261018142435')
 THEN RAISE EXCEPTION 'weekly_statement_kind_history_replay';END IF;
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations
  WHERE version='20261017223358' AND cardinality(statements)=1
   AND octet_length(statements[1])=28291 AND md5(statements[1])='88e709123e442ba60696eabbc9522666')
 THEN RAISE EXCEPTION 'weekly_statement_kind_installed_producer_required';END IF;
 IF NOT EXISTS(SELECT FROM pg_constraint WHERE conrelid='public.accounting_close_certificates'::regclass
  AND conname='accounting_close_certificates_kind_check' AND contype='c' AND convalidated AND conislocal
  AND md5(pg_get_constraintdef(oid))='923b63b9f2735497f2fe408c519c1267')
 THEN RAISE EXCEPTION 'weekly_statement_kind_exact_preimage_required';END IF;
 IF md5(pg_get_functiondef('public.fn_accounting_close_certify(text,uuid,timestamptz,timestamptz,jsonb)'::regprocedure))<>'58501728a93f9f4534dbf26d26aba63f'
  OR md5(pg_get_functiondef('public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)'::regprocedure))<>'7b4a5f4572a45db069b6058899614021'
  OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'weekly_statement_kind_current_authority_required';END IF;
 ALTER TABLE public.accounting_close_certificates
  DROP CONSTRAINT accounting_close_certificates_kind_check,
  ADD CONSTRAINT accounting_close_certificates_kind_check CHECK (
   kind = ANY (ARRAY['earned_plan'::text, 'pnl_boundary'::text, 'pnl_flows'::text, 'pnl_touched'::text, 'pnl_clubs'::text, 'pnl_boundary_problem'::text, 'pnl_flows_problem'::text, 'pnl_touched_problem'::text, 'pnl_clubs_problem'::text]) OR kind ~ '^club_statement_quality:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
 IF NOT EXISTS(SELECT FROM pg_constraint WHERE conrelid='public.accounting_close_certificates'::regclass
  AND conname='accounting_close_certificates_kind_check' AND contype='c' AND convalidated AND conislocal
  AND md5(pg_get_constraintdef(oid))='be81406a7d1b6bb24d6330cd60b866a6')
  OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'weekly_statement_kind_postimage_required';END IF;
END $admit_statement_kind$;
COMMIT;
