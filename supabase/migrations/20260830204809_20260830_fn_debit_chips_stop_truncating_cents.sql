-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830204809; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- fn_debit_chips silently under-charged every debit that carried cents.
--
-- club_members.chip_balance is numeric(_,2) and the function's own guards,
-- return payload and chip_transactions row all use the numeric p_amount. Only
-- the UPDATE cast it:
--
--     SET chip_balance = chip_balance - p_amount::integer
--
-- so a debit of 1670.40 removed 1670 and left 0.40 behind, while the caller
-- was told 'balance_after' = before - 1670.40. The wallet, the receipt and the
-- return value disagreed, and the difference accrued to the player every time.
--
-- Found 2026-08-30 while reversing the payouts of a tournament that never
-- finished: three of the nine prizes carried cents (1670.40, 1252.80, 730.80),
-- so routing that reversal through this function would have stranded 1.20
-- chips and made the reversal unequal to the payout. The reversal was done
-- with direct numeric arithmetic to avoid it; this is the underlying repair,
-- and it applies to EVERY debit path on the platform, not just that one.
--
-- Nothing else changes: same signature, same row lock, same insufficient-funds
-- refusal, same chip_transactions row.

CREATE OR REPLACE FUNCTION public.fn_debit_chips(
  p_club_id  uuid,
  p_user_id  uuid,
  p_amount   numeric,
  p_reason   text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_before numeric;
  v_after  numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  SELECT COALESCE(chip_balance, 0) INTO v_before
  FROM club_members
  WHERE club_id = p_club_id AND user_id = p_user_id FOR UPDATE;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not a member of this club');
  END IF;

  IF v_before < p_amount THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'insufficient chips',
      'balance', v_before, 'requested', p_amount
    );
  END IF;

  -- THE FIX: numeric, not ::integer. The column is numeric(_,2) and every
  -- other line in this function already treats p_amount as numeric.
  UPDATE club_members
  SET chip_balance = chip_balance - p_amount,
      updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_user_id;
  v_after := v_before - p_amount;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, metadata, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_user_id, NULL, p_amount,
    COALESCE(p_metadata->>'transaction_type', 'chip_debit'),
    COALESCE(p_reason, 'Chip debit'), p_metadata, v_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'balance_before', v_before,
    'balance_after', v_after
  );
END;
$fn$;
