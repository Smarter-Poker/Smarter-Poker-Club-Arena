-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902041018; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- The last two of the seven. Both already journal something - fn_atomic_buyin
-- journals the CHIP leg correctly as a mint against the issuance reserve, and
-- complete_daily_challenge writes diamond_ledger - and both leave the DIAMOND
-- leg unrecorded in diamond_transactions, which is the table the supply
-- snapshot reconciles against. Half-journalled reads as a leak.

BEGIN;

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

  SELECT diamonds INTO v_diamonds FROM profiles WHERE id = p_user_id FOR UPDATE;
  IF v_diamonds IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Profile not found');
  END IF;

  IF v_diamonds < p_diamond_cost THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient diamonds',
                              'needed', p_diamond_cost, 'available', v_diamonds);
  END IF;

  SELECT chip_balance INTO v_chips FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id FOR UPDATE;
  IF v_chips IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not a club member');
  END IF;

  -- Atomic debit diamonds
  v_new_diamonds := v_diamonds - p_diamond_cost;
  UPDATE profiles
     SET diamonds = v_new_diamonds,
         diamond_balance = v_new_diamonds
   WHERE id = p_user_id;

  -- ZERO-DRIFT: the diamond leg is a real movement of supply and belongs in
  -- diamond_transactions, or the hourly snapshot reports it as a bypass.
  INSERT INTO diamond_transactions (user_id, amount, type, balance_after, description, source)
  VALUES (p_user_id, -p_diamond_cost, 'chip_purchase', v_new_diamonds,
          'Buy-In: ' || p_chip_amount || ' Chips For ' || p_diamond_cost || ' Diamonds',
          'fn_atomic_buyin');

  -- ZERO-DRIFT phase 5: a diamond->chip conversion is chip issuance. Journal
  -- it as a mint against the issuance reserve, never as an anonymous
  -- adjustment vs table_stack.
  PERFORM set_config('app.ledger_category', 'mint', true);
  PERFORM set_config('app.ledger_counterparty', 'issuance_reserve', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);

  v_new_chips := v_chips + p_chip_amount;
  UPDATE club_members SET chip_balance = v_new_chips
    WHERE club_id = p_club_id AND user_id = p_user_id;

  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);

  INSERT INTO chip_transactions (from_user_id, to_user_id, club_id, transaction_type, amount, notes)
    VALUES (p_user_id, p_user_id, p_club_id, 'buyin', p_chip_amount,
      'Buy-In: ' || p_chip_amount || ' Chips For ' || p_diamond_cost || ' Diamonds');

  RETURN jsonb_build_object('success', true, 'chipAmount', p_chip_amount,
    'diamondCost', p_diamond_cost, 'newChipBalance', v_new_chips,
    'newDiamondBalance', v_new_diamonds);
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_daily_challenge(p_user_id uuid, p_challenge_id uuid, p_score integer DEFAULT 0, p_accuracy numeric DEFAULT 0, p_time_taken integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_existing_id uuid;
  v_perfect boolean;
  v_diamonds integer;
  v_completion_id uuid;
  v_after integer;
BEGIN
  IF p_user_id IS NULL OR p_challenge_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing user_id or challenge_id');
  END IF;

  SELECT id INTO v_existing_id FROM memory_challenge_completions
   WHERE user_id = p_user_id AND challenge_id = p_challenge_id;

  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'already_completed', true,
                              'completion_id', v_existing_id);
  END IF;

  v_perfect := (p_accuracy IS NOT NULL AND p_accuracy >= 1.0);
  v_diamonds := CASE
    WHEN v_perfect THEN 20
    WHEN p_accuracy >= 0.9 THEN 10
    WHEN p_accuracy >= 0.75 THEN 5
    ELSE 2 END;

  INSERT INTO memory_challenge_completions (
    id, user_id, challenge_id, score, accuracy, time_taken,
    perfect_completion, diamonds_earned, completed_at
  ) VALUES (
    gen_random_uuid(), p_user_id, p_challenge_id,
    COALESCE(p_score, 0), COALESCE(p_accuracy, 0), COALESCE(p_time_taken, 0),
    v_perfect, v_diamonds, NOW()
  ) RETURNING id INTO v_completion_id;

  UPDATE daily_challenges
     SET completed = true, completed_at = NOW()
   WHERE user_id = p_user_id AND completed = false AND challenge_date = CURRENT_DATE;

  UPDATE profiles
     SET diamonds = COALESCE(diamonds, 0) + v_diamonds,
         diamond_balance = COALESCE(diamond_balance, 0) + v_diamonds
   WHERE id = p_user_id
  RETURNING diamonds INTO v_after;

  -- ZERO-DRIFT: diamond_ledger is a side audit; diamond_transactions is what
  -- the supply snapshot reconciles against. This insert is NOT wrapped in a
  -- swallow-all handler - if the journal cannot be written the reward must
  -- fail, because an unjournalled credit is the bug we are here to close.
  IF v_after IS NOT NULL THEN
    INSERT INTO diamond_transactions (user_id, amount, type, balance_after, description, source)
    VALUES (p_user_id, v_diamonds, 'bonus', v_after,
            'daily challenge reward', 'complete_daily_challenge');
  END IF;

  BEGIN
    INSERT INTO diamond_ledger (user_id, delta, type, balance_after, created_at)
    VALUES (p_user_id, v_diamonds, 'daily_challenge_reward', COALESCE(v_after,0), NOW());
  EXCEPTION WHEN OTHERS THEN NULL;  -- side audit only; diamond_transactions above is authoritative
  END;

  RETURN jsonb_build_object('success', true, 'completion_id', v_completion_id,
                            'diamonds_earned', v_diamonds, 'perfect', v_perfect);
END;
$function$;

COMMIT;

