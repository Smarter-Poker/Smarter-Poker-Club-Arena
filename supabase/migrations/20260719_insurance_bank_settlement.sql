-- FIX-A12 2026-07-19 — Insurance settlement actually moves the club/union bank.
--
-- record_insurance_transaction previously ONLY inserted an audit row; the
-- premium collected and the payout paid never touched the club/union balance,
-- so the 20% house edge was never actually banked. This makes settlement move
-- the net (premium - payout) into the insurer bank atomically and idempotently:
--   * union table  -> unions.insurance_balance (dedicated insurance reserve)
--   * club  table  -> club_wallets.chip_balance (general club bank)
-- Bank delta per settlement = premium - payout. On a win the bank keeps the
-- premium; on a paid bad beat the bank pays the insured amount. Expected net is
-- +0.2 * fairPremium (the 20% edge) because premium = insured * pLoss * 1.20.

-- One settlement row per (table, hand, player) — idempotency + ON CONFLICT key.
CREATE UNIQUE INDEX IF NOT EXISTS insurance_transactions_table_hand_player_uidx
  ON public.insurance_transactions (table_id, hand_number, player_id);

CREATE OR REPLACE FUNCTION public.record_insurance_transaction(
  p_table_id uuid,
  p_club_id uuid,
  p_hand_number integer,
  p_player_id uuid,
  p_equity_percent numeric,
  p_premium numeric,
  p_insured_amount numeric,
  p_payout numeric,
  p_player_won boolean
)
RETURNS insurance_transactions
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_union_id     uuid;
  v_bank_type    varchar(10);
  v_bank_entity  uuid;
  v_net_player   numeric;   -- player perspective: payout - premium
  v_bank_delta   numeric;   -- bank perspective:   premium - payout
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

  -- Idempotent claim of this (table, hand, player) settlement.
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
    -- Already settled (retry) — return the existing row, do NOT move money again.
    SELECT * INTO v_tx FROM insurance_transactions
     WHERE table_id = p_table_id AND hand_number = p_hand_number AND player_id = p_player_id
     LIMIT 1;
    RETURN v_tx;
  END IF;

  -- Move the net into the insurer bank atomically (row-locked additive update).
  IF v_bank_delta <> 0 THEN
    IF v_bank_type = 'union' THEN
      UPDATE unions
         SET insurance_balance = COALESCE(insurance_balance, 0) + v_bank_delta
       WHERE id = v_bank_entity;
    ELSE
      UPDATE club_wallets
         SET chip_balance = COALESCE(chip_balance, 0) + v_bank_delta
       WHERE club_id = v_bank_entity;
    END IF;
  END IF;

  RETURN v_tx;
END;
$function$;