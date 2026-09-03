-- BACKFILLED 2026-09-03 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831195719; the file committed at the time was a placeholder
-- marker (kept below) that said to export the body. Content is byte-exact to
-- what ran. Do NOT re-apply; it is already live.

-- ca_phase5_atomic_buyin_mints_honestly (prod 20260831195719). Canonical body lives in prod schema_migrations -
-- replace this marker byte-exact via scripts/dev/export-applied-migrations.sh.
-- Phase 5 ruling: buyin.js endpoint retired (WH PR); fn_atomic_buyin journals diamond→chip conversion as mint vs issuance_reserve.

-- ZERO-DRIFT phase 5 — THE buyin.js RULING, IMPLEMENTED.
-- Findings: /api/club-arena/buyin.js calls orb1_buyin_transaction, which has
-- been a deprecated HARD-FAIL stub since 2026-04-29 — the endpoint is dead
-- (the companion WH patch turns it into an honest 410 pointing at the
-- sanctioned flows). The LIVE diamond→chip converter is fn_atomic_buyin, and
-- it created chips with NO ledger declaration — the club_members auto-journal
-- recorded each conversion as an anonymous 'adjustment' vs table_stack.
-- A diamond→chip conversion is chip ISSUANCE backed by a diamond burn: it now
-- journals as category 'mint' against issuance_reserve, with the diamond cost
-- in the evidence trail. Input guards added (positive whole chips, positive
-- diamond cost) — money math otherwise unchanged.
CREATE OR REPLACE FUNCTION public.fn_atomic_buyin(p_user_id uuid, p_club_id uuid, p_chip_amount integer, p_diamond_cost integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_diamonds INTEGER;
  v_chips NUMERIC;
  v_new_diamonds INTEGER;
  v_new_chips NUMERIC;
BEGIN
  -- ZERO-DRIFT phase 5: reject nonsense before touching balances.
  IF COALESCE(p_chip_amount, 0) <= 0 OR COALESCE(p_diamond_cost, 0) <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid amounts');
  END IF;

  -- Lock and read current diamond balance
  SELECT diamonds INTO v_diamonds
    FROM profiles
    WHERE id = p_user_id
    FOR UPDATE;

  IF v_diamonds IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Profile not found');
  END IF;

  IF v_diamonds < p_diamond_cost THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Insufficient diamonds',
      'needed', p_diamond_cost,
      'available', v_diamonds
    );
  END IF;

  -- Lock and read current chip balance
  SELECT chip_balance INTO v_chips
    FROM club_members
    WHERE club_id = p_club_id AND user_id = p_user_id
    FOR UPDATE;

  IF v_chips IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not a club member');
  END IF;

  -- Atomic debit diamonds
  v_new_diamonds := v_diamonds - p_diamond_cost;
  UPDATE profiles SET diamonds = v_new_diamonds WHERE id = p_user_id;

  -- ZERO-DRIFT phase 5: a diamond→chip conversion is chip issuance. Journal
  -- it as a mint against the issuance reserve, never as an anonymous
  -- adjustment vs table_stack.
  PERFORM set_config('app.ledger_category', 'mint', true);
  PERFORM set_config('app.ledger_counterparty', 'issuance_reserve', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);

  -- Atomic credit chips
  v_new_chips := v_chips + p_chip_amount;
  UPDATE club_members SET chip_balance = v_new_chips
    WHERE club_id = p_club_id AND user_id = p_user_id;

  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);

  -- Record transaction
  INSERT INTO chip_transactions (from_user_id, to_user_id, club_id, transaction_type, amount, notes)
    VALUES (p_user_id, p_user_id, p_club_id, 'buyin', p_chip_amount,
      'Buy-in: ' || p_chip_amount || ' chips for ' || p_diamond_cost || ' 💎');

  RETURN jsonb_build_object(
    'success', true,
    'chipAmount', p_chip_amount,
    'diamondCost', p_diamond_cost,
    'newChipBalance', v_new_chips,
    'newDiamondBalance', v_new_diamonds
  );
END;
$function$;

INSERT INTO public.ca_money_rpc_registry (proname, notes)
VALUES ('fn_atomic_buyin', 'phase 5: diamond→chip issuance, journals as mint vs issuance_reserve')
ON CONFLICT DO NOTHING;
