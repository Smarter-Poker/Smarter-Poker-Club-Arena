-- The welcome-package reset correctly refuses a BBJ pool with prior promo
-- payouts, but its first implementation named public.bbj_promo_events. That
-- legacy table only belongs to an obsolete bootstrap migration; its writer did
-- not credit recipients, and the relation is absent from the live catalog.
-- PostgreSQL therefore accepted the PL/pgSQL body but the first production
-- reset failed with 42P01 when that deferred branch was executed.
--
-- Current BBJ promo payout authority records the pool-scoped operation identity
-- in public.wallet_credit_idempotency as bbjpromo:<pool-id>:<operation-id> and
-- records successful money movement in chip_transactions. Replace both stale
-- predicates with that current event identity. Exact installed source shapes,
-- one replacement per function, and reverse substitution are all proved before
-- commit; no compatibility table or synthetic history is created.

BEGIN;

DO $rewrite_current_bbj_promo_history$
DECLARE
  v_oid oid;
  v_before text;
  v_after text;
  v_old text;
  v_new text;
  v_count integer;
BEGIN
  v_oid := to_regprocedure('public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'WELCOME_UNWIND_FUNCTION_MISSING';
  END IF;
  v_before := pg_get_functiondef(v_oid);
  v_old := $old$OR EXISTS(SELECT 1 FROM public.bbj_promo_events WHERE pool_id=v_bbj.id)$old$;
  v_new := $new$OR EXISTS(SELECT 1 FROM public.wallet_credit_idempotency i
          WHERE i.key LIKE 'bbjpromo:'||v_bbj.id::text||':%')$new$;
  v_count := (length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'WELCOME_UNWIND_BBJ_PROMO_HISTORY_SHAPE_CHANGED: %',v_count;
  END IF;
  v_after := replace(v_before,v_old,v_new);
  EXECUTE v_after;
  IF replace(pg_get_functiondef(v_oid),v_new,v_old) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'WELCOME_UNWIND_BBJ_PROMO_HISTORY_REVERSE_SUBSTITUTION_FAILED';
  END IF;

  v_oid := to_regprocedure('public.fn_get_club_welcome_package_reset_impact(uuid)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'WELCOME_RESET_IMPACT_FUNCTION_MISSING';
  END IF;
  v_before := pg_get_functiondef(v_oid);
  v_old := $old$AND NOT EXISTS(SELECT 1 FROM public.bbj_promo_events WHERE pool_id=b.id)$old$;
  v_new := $new$AND NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency i
        WHERE i.key LIKE 'bbjpromo:'||b.id::text||':%')$new$;
  v_count := (length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'WELCOME_RESET_IMPACT_BBJ_PROMO_HISTORY_SHAPE_CHANGED: %',v_count;
  END IF;
  v_after := replace(v_before,v_old,v_new);
  EXECUTE v_after;
  IF replace(pg_get_functiondef(v_oid),v_new,v_old) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'WELCOME_RESET_IMPACT_BBJ_PROMO_HISTORY_REVERSE_SUBSTITUTION_FAILED';
  END IF;
END
$rewrite_current_bbj_promo_history$;

COMMIT;
