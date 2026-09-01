-- HARDENING ROUND 2, PHASE 5B: the cert-fleet option for epoch-3, prepared
-- for Dan's one-word ruling and inert until he gives it. The 85-account bot
-- fleet holds ~15.79M chips; this zeroes every cert account's club balances
-- with fully journaled burns so the new epoch's bot economy starts at
-- exactly zero. Dry-run by default; execution demands the same literal
-- confirmation as the main reset AND a passing preflight. Runs standalone so
-- the audited main reset is not modified.
CREATE OR REPLACE FUNCTION public.fn_ca_epoch3_cert_fleet_reset(
  p_confirm text DEFAULT NULL,
  p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_accounts int; v_rows int; v_chips numeric; v_promo numeric;
  v_pre jsonb; v_zeroed int;
BEGIN
  SELECT count(DISTINCT cm.user_id), count(*),
         COALESCE(sum(cm.chip_balance), 0), COALESCE(sum(cm.promo_balance), 0)
    INTO v_accounts, v_rows, v_chips, v_promo
    FROM club_members cm
   WHERE public.fn_ca_is_cert_account(cm.user_id)
     AND (cm.chip_balance > 0 OR cm.promo_balance > 0);

  IF p_dry_run THEN
    RETURN jsonb_build_object('dry_run', true,
      'cert_accounts_holding_value', v_accounts,
      'membership_rows', v_rows,
      'chips_to_retire', round(v_chips, 2),
      'promo_to_retire', round(v_promo, 2),
      'note', 'execution requires the epoch-3 confirmation literal and a passing preflight');
  END IF;

  IF p_confirm IS DISTINCT FROM 'MIDWAY-EPOCH-3-RESET' THEN
    RAISE EXCEPTION 'cert-fleet reset refused: confirmation literal missing';
  END IF;
  v_pre := public.fn_ca_epoch3_preflight();
  IF NOT COALESCE((v_pre->>'pass')::boolean, false) THEN
    RAISE EXCEPTION 'cert-fleet reset refused: preflight failing - %', v_pre::text;
  END IF;

  PERFORM public.fn_ca_declare_ledger('burn', 'chip_retirement');
  UPDATE club_members cm
     SET chip_balance = 0, promo_balance = 0, updated_at = now()
   WHERE public.fn_ca_is_cert_account(cm.user_id)
     AND (cm.chip_balance > 0 OR cm.promo_balance > 0);
  GET DIAGNOSTICS v_zeroed = ROW_COUNT;

  RETURN jsonb_build_object('dry_run', false,
    'rows_zeroed', v_zeroed,
    'chips_retired', round(v_chips, 2),
    'promo_retired', round(v_promo, 2));
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_epoch3_cert_fleet_reset(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_epoch3_cert_fleet_reset(text, boolean) TO service_role;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
SELECT 'fn_ca_epoch3_cert_fleet_reset', 'approved',
       'Hardening round 2 phase 5 (2026-09-01): Dan-gated option to zero the cert/bot fleet at epoch-3 with journaled burns. Dry-run default; execution needs the literal + passing preflight.'
WHERE NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry WHERE proname='fn_ca_epoch3_cert_fleet_reset');
