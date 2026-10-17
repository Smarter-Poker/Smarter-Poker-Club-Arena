-- Reserved20261016233224 through scripts/new-migration.mjs.
-- Oct5 union R2 was blocked by31 already-paid standalone commissions389.60
-- for a club that joined this union onOct12 14:54, after the week ended07:00.
-- Limit only finite valid-period membership fallback to joins before period end.
-- Preserve attributed historical earnings, own/NULL clubs, unsupported inputs,
-- standalone routing, keys/locks, legacy duplicate-payment refusal and ALL money.
-- Read exact-view earning witnesses once per club; cash acceptance makes the
-- same club's fee existence test unnecessary in the final UNION club set.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz)'::regprocedure))='e773d469ebeb010df4ac46757fca724e')
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $install_routing$
DECLARE sig regprocedure:='public.fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz)'::regprocedure;def text:=pg_get_functiondef(sig);generation text;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL THEN RAISE EXCEPTION 'routing_period_operator_refused';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL OR public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'routing_period_freeze_or_override_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'routing_period_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261016233224') THEN RAISE EXCEPTION 'routing_period_history_replay';END IF;
 generation:=smarter_private.original_inventory_basis_generation();
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true OR generation IS NULL THEN RAISE EXCEPTION 'routing_period_inventory_seal_required';END IF;
 IF md5(pg_get_viewdef('public.accounting_payable_earning_sources'::regclass,true)) IS DISTINCT FROM '8eafef6d8f5e0d615b83baf14d1c0da4' THEN RAISE EXCEPTION 'routing_period_exact_payable_view_required';END IF;
 IF md5(def)<>'e681a25749f290403589a2ff28d1d405' OR (SELECT proowner<>'postgres'::regrole OR NOT prosecdef OR provolatile<>'v' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' OR proconfig IS DISTINCT FROM ARRAY['search_path=public'] FROM pg_proc WHERE oid=sig) THEN RAISE EXCEPTION 'routing_period_preimage_authority_refused';END IF;
 IF (length(def)-length(replace(def,$old$ IF p_scope_kind='union' THEN
  club_ids:=ARRAY(SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=p_scope_id UNION
   SELECT rs.club_id FROM public.accounting_payable_earning_sources rs WHERE rs.coordinator_union_id=p_scope_id
    AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end ORDER BY club_id);
$old$,'')))/length($old$ IF p_scope_kind='union' THEN
  club_ids:=ARRAY(SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=p_scope_id UNION
   SELECT rs.club_id FROM public.accounting_payable_earning_sources rs WHERE rs.coordinator_union_id=p_scope_id
    AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end ORDER BY club_id);
$old$)<>1 THEN RAISE EXCEPTION 'routing_period_exact_replacement_refused';END IF;
 def:=replace(def,$old$ IF p_scope_kind='union' THEN
  club_ids:=ARRAY(SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=p_scope_id UNION
   SELECT rs.club_id FROM public.accounting_payable_earning_sources rs WHERE rs.coordinator_union_id=p_scope_id
    AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end ORDER BY club_id);
$old$,$new$ IF p_scope_kind='union' THEN
  club_ids:=ARRAY(WITH RECURSIVE
cash_clubs(club_id) AS (
 (SELECT s.club_id FROM public.accounting_cash_rake_sources s WHERE s.club_id IS NOT NULL ORDER BY s.club_id LIMIT 1)
 UNION ALL
 SELECT n.club_id FROM cash_clubs c CROSS JOIN LATERAL
 (SELECT s.club_id FROM public.accounting_cash_rake_sources s WHERE s.club_id>c.club_id ORDER BY s.club_id LIMIT 1)n
),
fee_clubs(club_id) AS (
 (SELECT s.club_id FROM public.accounting_tournament_fee_sources s WHERE s.club_id IS NOT NULL ORDER BY s.club_id LIMIT 1)
 UNION ALL
 SELECT n.club_id FROM fee_clubs c CROSS JOIN LATERAL
 (SELECT s.club_id FROM public.accounting_tournament_fee_sources s WHERE s.club_id>c.club_id ORDER BY s.club_id LIMIT 1)n
),
accepted_cash AS MATERIALIZED (
 SELECT k.club_id FROM cash_clubs k CROSS JOIN LATERAL
 (SELECT true FROM public.accounting_payable_earning_sources rs WHERE rs.source_type='cash_rake_accrual'
 AND rs.club_id=k.club_id AND rs.coordinator_union_id=p_scope_id
 AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end LIMIT 1 OFFSET 0)w
 UNION ALL SELECT NULL::uuid WHERE EXISTS(SELECT FROM public.accounting_payable_earning_sources rs
 WHERE rs.source_type='cash_rake_accrual' AND rs.club_id IS NULL AND rs.coordinator_union_id=p_scope_id
 AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end)
),
fee_candidates AS MATERIALIZED (SELECT k.club_id FROM fee_clubs k WHERE NOT EXISTS
 (SELECT FROM accepted_cash c WHERE c.club_id IS NOT DISTINCT FROM k.club_id)),
accepted_fee AS (
 SELECT k.club_id FROM fee_candidates k CROSS JOIN LATERAL (
 SELECT true FROM public.accounting_tournament_fee_sources fee CROSS JOIN LATERAL (
 SELECT true FROM public.accounting_payable_earning_sources rs WHERE rs.source_type='tournament_fee_accrual'
 AND rs.source_id=fee.id AND rs.club_id=k.club_id AND rs.coordinator_union_id=p_scope_id
 AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end LIMIT 1 OFFSET 0)witness
 WHERE fee.club_id=k.club_id AND fee.coordinator_union_id=p_scope_id
 LIMIT 1 OFFSET 0)w
 UNION ALL SELECT NULL::uuid WHERE NOT EXISTS(SELECT FROM accepted_cash c WHERE c.club_id IS NULL)
 AND EXISTS(SELECT FROM public.accounting_payable_earning_sources rs
 WHERE rs.source_type='tournament_fee_accrual' AND rs.club_id IS NULL AND rs.coordinator_union_id=p_scope_id
 AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end)
)
SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=p_scope_id
 AND((isfinite(p_period_start) AND isfinite(p_period_end) AND p_period_end>p_period_start) IS NOT TRUE OR uc.joined_at IS NULL OR uc.joined_at<p_period_end)
 UNION SELECT ac.club_id FROM accepted_cash ac UNION SELECT af.club_id FROM accepted_fee af ORDER BY club_id);
$new$);
 IF md5(def)<>'e773d469ebeb010df4ac46757fca724e' THEN RAISE EXCEPTION 'routing_period_postimage_refused';END IF;
 EXECUTE def;
 IF md5(pg_get_functiondef(sig))<>'e773d469ebeb010df4ac46757fca724e' OR (SELECT proowner<>'postgres'::regrole OR NOT prosecdef OR provolatile<>'v' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' OR proconfig IS DISTINCT FROM ARRAY['search_path=public'] FROM pg_proc WHERE oid=sig) THEN RAISE EXCEPTION 'routing_period_installed_authority_refused';END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation() IS DISTINCT FROM generation THEN RAISE EXCEPTION 'routing_period_inventory_seal_changed';END IF;
END $install_routing$;
COMMIT;
