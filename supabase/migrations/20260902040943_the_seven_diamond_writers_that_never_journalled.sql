-- Seven RPCs move profiles.diamonds and write no diamond_transactions row, so
-- fn_ca_diamond_snapshot counts every one of them as unexplained supply. Each
-- now journals the movement it makes, signed the way the snapshot sums it
-- (positive credit, negative debit).
--
-- purchase_vip_with_diamonds_atomic looked like an eighth and is not: its own
-- UPDATE touches only the vip_* columns, and the diamond leg is delegated to
-- add_diamonds_to_balance, which journals. Left alone deliberately.
--
-- Types reuse the existing diamond_transactions vocabulary rather than
-- inventing new ones. 'chip_purchase' in particular already means exactly what
-- fn_atomic_buyin does. (There is no CHECK constraint on `type` here, so
-- nothing would have stopped me inventing one - which is precisely why I am
-- writing this down. Twice tonight a new value was rejected by a constraint
-- that already had the right word in it.)
--
-- The four functions that touched `diamonds` without `diamond_balance` now
-- keep both. Platform-wide the two columns agree exactly (1,029,977 each), so
-- they are two names for one balance, and a writer updating one is a latent
-- divergence waiting for its first caller.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_add_diamonds(p_user_id uuid, p_amount integer)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_after integer;
BEGIN
  IF p_amount <= 0 THEN RETURN; END IF;
  UPDATE profiles
     SET diamonds = COALESCE(diamonds,0) + p_amount,
         diamond_balance = COALESCE(diamond_balance,0) + p_amount,
         updated_at = now()
   WHERE id = p_user_id
  RETURNING diamonds INTO v_after;
  IF v_after IS NULL THEN RETURN; END IF;
  INSERT INTO diamond_transactions (user_id, amount, type, balance_after, description, source)
  VALUES (p_user_id, p_amount, 'credit', v_after, 'fn_add_diamonds', 'fn_add_diamonds');
END; $function$;

CREATE OR REPLACE FUNCTION public.increment_diamonds(p_user_id uuid, p_amount integer)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_after integer;
BEGIN
  IF p_amount <= 0 THEN RETURN; END IF;
  UPDATE profiles
     SET diamonds = COALESCE(diamonds,0) + p_amount,
         diamond_balance = COALESCE(diamond_balance,0) + p_amount,
         updated_at = now()
   WHERE id = p_user_id
  RETURNING diamonds INTO v_after;
  IF v_after IS NULL THEN RETURN; END IF;
  INSERT INTO diamond_transactions (user_id, amount, type, balance_after, description, source)
  VALUES (p_user_id, p_amount, 'credit', v_after, 'increment_diamonds', 'increment_diamonds');
END; $function$;

CREATE OR REPLACE FUNCTION public.fn_credit_diamonds(p_user_id uuid, p_amount integer)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_after integer;
BEGIN
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be positive'; END IF;
  UPDATE profiles
     SET diamonds = COALESCE(diamonds,0) + p_amount,
         diamond_balance = COALESCE(diamond_balance,0) + p_amount
   WHERE id = p_user_id
  RETURNING diamonds INTO v_after;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found for user %', p_user_id; END IF;
  INSERT INTO diamond_transactions (user_id, amount, type, balance_after, description, source)
  VALUES (p_user_id, p_amount, 'credit', v_after, 'fn_credit_diamonds', 'fn_credit_diamonds');
END; $function$;

CREATE OR REPLACE FUNCTION public.transfer_diamonds_credit(recipient_id uuid, credit_amount integer)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE new_balance INTEGER;
BEGIN
  UPDATE profiles
     SET diamonds = COALESCE(diamonds,0) + credit_amount,
         diamond_balance = COALESCE(diamond_balance,0) + credit_amount,
         updated_at = NOW()
   WHERE id = recipient_id
  RETURNING diamonds INTO new_balance;

  IF new_balance IS NOT NULL THEN
    INSERT INTO diamond_transactions (user_id, amount, type, balance_after, description, source)
    VALUES (recipient_id, credit_amount, 'diamond_gift_received', new_balance,
            'transfer in', 'transfer_diamonds_credit');
  END IF;
  RETURN new_balance;
END; $function$;

CREATE OR REPLACE FUNCTION public.transfer_diamonds_deduct(sender_id uuid, deduct_amount integer)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE new_balance INTEGER;
BEGIN
  -- Atomic: UPDATE only if balance >= amount, return new balance
  UPDATE profiles
     SET diamonds = diamonds - deduct_amount,
         diamond_balance = COALESCE(diamond_balance,0) - deduct_amount,
         updated_at = NOW()
   WHERE id = sender_id
     AND diamonds >= deduct_amount
  RETURNING diamonds INTO new_balance;

  -- NULL means insufficient funds and no row moved; journal nothing.
  IF new_balance IS NOT NULL THEN
    INSERT INTO diamond_transactions (user_id, amount, type, balance_after, description, source)
    VALUES (sender_id, -deduct_amount, 'diamond_gift_sent', new_balance,
            'transfer out', 'transfer_diamonds_deduct');
  END IF;
  RETURN new_balance;
END; $function$;

COMMIT;
