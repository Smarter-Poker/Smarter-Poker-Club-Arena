-- ZERO-DRIFT phase 2 (prod 2026-08-31 19:00:41 UTC): increment_union_wallet
-- is the last bare producer of suspense inflow to union rake wallets (the
-- engine banks spin rake by calling it directly with no notes/club_id). It
-- now self-declares category 'rake' vs table_stack - but ONLY when the
-- calling transaction has not already set richer GUC context
-- (fn_settle_tournament_rake sets rake vs prize_liability + tournament
-- entity before calling; that must survive). No signature or money-math
-- change.
CREATE OR REPLACE FUNCTION public.increment_union_wallet(p_union_id uuid, p_amount numeric, p_club_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_amount numeric; v_new_rake numeric;
BEGIN
  IF p_union_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'p_union_id required'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('success', true, 'skipped', 'zero_amount'); END IF;
  v_amount := round(p_amount, 2);

  -- ZERO-DRIFT phase 2: declare the ledger category unless the caller
  -- already set one in this transaction (caller context is richer).
  IF COALESCE(current_setting('app.ledger_category', true), '') = '' THEN
    PERFORM set_config('app.ledger_category', 'rake', true);
    PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
  END IF;

  -- Rake Treasury only — see rake_lands_only_in_rake_treasury_not_union_bank.
  INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
       VALUES (p_union_id, 0, v_amount, v_amount)
  ON CONFLICT (union_id) DO UPDATE SET
       rake_wallet          = public.union_wallets.rake_wallet + v_amount,
       total_rake_collected = COALESCE(public.union_wallets.total_rake_collected, 0) + v_amount,
       updated_at           = NOW()
  RETURNING rake_wallet INTO v_new_rake;

  IF p_notes IS NOT NULL OR p_club_id IS NOT NULL THEN
    INSERT INTO public.union_wallet_transactions
      (union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes)
    VALUES (p_union_id, p_club_id, v_amount, 'rake', 'rake_wallet', 'credit', v_new_rake,
            COALESCE(p_notes, 'Union rake credit'));
  END IF;

  RETURN jsonb_build_object('success', true, 'union_id', p_union_id, 'amount', v_amount,
                            'new_rake_wallet', v_new_rake);
END $function$;

-- Engine rake banking, never a browser API (closed in prod by
-- 20260831161047; re-stated here so this migration is self-contained).
REVOKE ALL ON FUNCTION public.increment_union_wallet(uuid, numeric, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_union_wallet(uuid, numeric, uuid, text) TO service_role;
