-- ─────────────────────────────────────────────────────────────────────────────
-- atomic_table_rebuy ran as SECURITY INVOKER — the only function in the
-- buy-in family that did (atomic_table_buyin, fn_seat_club_for_user and
-- fn_ensure_club_wallet are all SECURITY DEFINER).
--
-- Consequence, verified against the live schema on 2026-08-26: every rebuy
-- issued by a real player (role `authenticated`) died on RLS at its very
-- first statement — `transaction_idempotency_keys` has RLS enabled and ZERO
-- policies, so the INSERT raises 42501 before any money moves. Had it got
-- past that, `table_seats` has no UPDATE policy for authenticated (stack
-- update silently matches 0 rows) and `wallet_transactions` grants SELECT
-- only. Net effect in production: "if you lose all your chips and rebuy, it
-- silently fails, doesn't add chips to your stack" (Dan, 2026-08-26).
--
-- Fix: recreate the function SECURITY DEFINER with a hardened search_path,
-- and add the same identity guard atomic_table_buyin carries so a player can
-- only rebuy for themselves (service role, auth.uid() IS NULL, stays free
-- for the engine). Body is otherwise byte-identical to the live definition.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.atomic_table_rebuy(
  p_user_id uuid,
  p_table_id uuid,
  p_amount numeric,
  p_idempotency_key uuid DEFAULT NULL::uuid
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_new_balance numeric; v_club_id uuid; v_union_id uuid; v_ban_id uuid; v_seat_club uuid;
BEGIN
  -- SECURITY DEFINER bypasses RLS, so enforce identity explicitly:
  -- an authenticated caller may only rebuy for themselves.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot rebuy for another player';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.transaction_idempotency_keys (key, user_id, action, amount)
    VALUES (p_idempotency_key, p_user_id, 'atomic_table_rebuy', p_amount) ON CONFLICT (key) DO NOTHING;
    IF NOT FOUND THEN RETURN (SELECT chip_balance FROM club_members WHERE user_id = p_user_id AND club_id = (SELECT club_id FROM table_seats WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL LIMIT 1)); END IF;
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Rebuy amount must be positive';
  END IF;

  SELECT ts.club_id INTO v_seat_club
    FROM table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not seated at this table (cannot rebuy a vacated seat)';
  END IF;

  SELECT t.club_id, c.union_id INTO v_club_id, v_union_id
    FROM tables t LEFT JOIN clubs c ON c.id = t.club_id WHERE t.id = p_table_id LIMIT 1;
  IF v_club_id IS NOT NULL THEN
    SELECT id INTO v_ban_id FROM blacklists
     WHERE user_id = p_user_id AND (expires_at IS NULL OR expires_at > now())
       AND (club_id = v_club_id OR (v_union_id IS NOT NULL AND union_id = v_union_id))
     LIMIT 1;
    IF v_ban_id IS NOT NULL THEN RAISE EXCEPTION 'Banned from this club'; END IF;
  END IF;

  IF v_seat_club IS NULL THEN
    v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, NULL);
  END IF;
  IF v_seat_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this rebuy';
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;
  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for rebuy (club %)', v_seat_club;
  END IF;

  UPDATE table_seats SET stack = stack + p_amount
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'rebuy',
            'Cash game rebuy (club wallet)', p_table_id, v_new_balance);

  RETURN v_new_balance;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.atomic_table_rebuy(uuid, uuid, numeric, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.atomic_table_rebuy(uuid, uuid, numeric, uuid) TO authenticated, service_role;

-- Post-apply assertion: the function must now be SECURITY DEFINER.
DO $$
DECLARE v_secdef boolean;
BEGIN
  SELECT p.prosecdef INTO v_secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_table_rebuy'
     AND pg_get_function_identity_arguments(p.oid) = 'p_user_id uuid, p_table_id uuid, p_amount numeric, p_idempotency_key uuid';
  IF v_secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'atomic_table_rebuy is still SECURITY INVOKER — migration did not take';
  END IF;
END $$;

-- ROLLBACK (Tier 3, function redefinition): re-apply the previous definition
-- (identical body, no auth guard, SECURITY INVOKER):
--   CREATE OR REPLACE FUNCTION public.atomic_table_rebuy(...) RETURNS numeric
--   LANGUAGE plpgsql SET search_path TO 'public' AS $$ <previous body> $$;
-- The previous body is preserved in git history of this file (it is the block
-- above minus the auth.uid() guard) and in the audit for 2026-08-26.
