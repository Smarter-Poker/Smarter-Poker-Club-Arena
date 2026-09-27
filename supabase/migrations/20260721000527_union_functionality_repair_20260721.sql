-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721000527 "union_functionality_repair_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cfcbd803fcb2bb905ec493fec68c27af of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- UNION FUNCTIONALITY REPAIR — 2026-07-21 (see repo migration file for full commentary)

DO $$
DECLARE v_legacy numeric;
BEGIN
  SELECT COALESCE(SUM(insurance_balance), 0) INTO v_legacy FROM public.unions;
  IF v_legacy <> 0 THEN
    RAISE EXCEPTION 'unions.insurance_balance holds % (expected 0) — migrate balances before repointing', v_legacy;
  END IF;
END $$;

DROP POLICY IF EXISTS union_wallets_admin_read ON public.union_wallets;
CREATE POLICY union_wallets_admin_read ON public.union_wallets
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.union_admins ua
      WHERE ua.union_id = union_wallets.union_id
        AND ua.user_id = (SELECT auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.unions u
      WHERE u.id = union_wallets.union_id
        AND u.owner_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS unions_public_browse ON public.unions;
CREATE POLICY unions_public_browse ON public.unions
  FOR SELECT TO authenticated USING (is_public IS NOT FALSE);

CREATE UNIQUE INDEX IF NOT EXISTS uq_union_wallet_tx_bbj_payout
  ON public.union_wallet_transactions (union_id, tx_type, period_id)
  WHERE tx_type = 'bbj_payout' AND period_id IS NOT NULL;

INSERT INTO public.bbj_pools (union_id, status, pool_amount, main_balance, backup_balance, promo_balance)
SELECT u.id, 'active', 0, 0, 0, 0
FROM public.unions u
WHERE NOT EXISTS (
  SELECT 1 FROM public.bbj_pools bp WHERE bp.union_id = u.id
);

INSERT INTO public.union_wallets (union_id)
SELECT u.id FROM public.unions u
WHERE NOT EXISTS (SELECT 1 FROM public.union_wallets w WHERE w.union_id = u.id)
ON CONFLICT (union_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.record_insurance_transaction(
  p_table_id uuid, p_club_id uuid, p_hand_number integer, p_player_id uuid,
  p_equity_percent numeric, p_premium numeric, p_insured_amount numeric,
  p_payout numeric, p_player_won boolean
) RETURNS insurance_transactions
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_union_id     uuid;
  v_bank_type    varchar(10);
  v_bank_entity  uuid;
  v_net_player   numeric;
  v_bank_delta   numeric;
  v_tx           insurance_transactions;
BEGIN
  SELECT union_id INTO v_union_id FROM clubs WHERE id = p_club_id;

  IF v_union_id IS NOT NULL THEN
    v_bank_type := 'union';
    v_bank_entity := v_union_id;
  ELSE
    v_bank_type := 'club';
    v_bank_entity := p_club_id;
  END IF;

  v_net_player := COALESCE(p_payout, 0) - COALESCE(p_premium, 0);
  v_bank_delta := COALESCE(p_premium, 0) - COALESCE(p_payout, 0);

  INSERT INTO insurance_transactions (
    table_id, club_id, union_id, hand_number,
    player_id, equity_percent, premium, insured_amount, payout,
    player_won, net_result, bank_type, bank_entity_id
  ) VALUES (
    p_table_id, p_club_id, v_union_id, p_hand_number,
    p_player_id, p_equity_percent, p_premium, p_insured_amount, p_payout,
    p_player_won, v_net_player, v_bank_type, v_bank_entity
  )
  ON CONFLICT (table_id, hand_number, player_id) DO NOTHING
  RETURNING * INTO v_tx;

  IF v_tx.id IS NULL THEN
    SELECT * INTO v_tx FROM insurance_transactions
     WHERE table_id = p_table_id AND hand_number = p_hand_number AND player_id = p_player_id
     LIMIT 1;
    RETURN v_tx;
  END IF;

  IF v_bank_delta <> 0 THEN
    IF v_bank_type = 'union' THEN
      INSERT INTO union_wallets (union_id, insurance_wallet)
      VALUES (v_bank_entity, v_bank_delta)
      ON CONFLICT (union_id) DO UPDATE
        SET insurance_wallet = COALESCE(union_wallets.insurance_wallet, 0) + v_bank_delta,
            updated_at = NOW()
    ;
    ELSE
      UPDATE club_wallets
         SET chip_balance = COALESCE(chip_balance, 0) + v_bank_delta
       WHERE club_id = v_bank_entity;
    END IF;
  END IF;

  RETURN v_tx;
END;
$function$;
