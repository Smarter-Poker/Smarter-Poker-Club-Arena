-- 20260911042849_the_promo_funding_button_is_safe_to_press_twice.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE PROMO FUNDING BUTTON IS SAFE TO PRESS TWICE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_diamond_game_fund_promo moves chips from a host's bank into its promo
-- wallet. It was written yesterday with this line in it:
--
--   v_key text := 'diamond-games-fund:' || gen_random_uuid()::text;
--
-- A fresh key on every call is the same as no key at all. The journal's
-- ux_chip_ledger_idempotency_key index cannot refuse a replay it has never
-- seen before, so a double-tap on the console, or a request that succeeded on
-- the server and lost its reply on the way back, moves the chips twice and
-- writes two legs that both look legitimate. The UI's `disabled={funding}`
-- guard is a race with the network, not a defence: it is released the moment
-- the promise settles, and it never existed for the retry.
--
-- THE KEY NOW COMES FROM THE CALLER. The console mints one token per attempt
-- and sends the same one for every retry of that attempt, so the server can
-- tell "the operator asked again" apart from "the operator asked once and we
-- did not hear the answer". The server namespaces what it is given -
-- 'diamond-games-fund:' || p_key - so a caller can only ever write inside this
-- function's own keyspace, and validates its shape before using it.
--
-- The guard is check-then-act, and it is safe because of where it sits:
-- fn_diamond_game_cover_lock has already taken the host's wallet row FOR
-- UPDATE, so two presses for the same host serialise on that lock. The first
-- writes the leg; the second wakes up, sees it, and returns the balances with
-- replayed = true rather than moving anything. The unique index stays behind
-- it as the hard stop.
--
-- AND THE GUARD IS MADE LOAD-BEARING. The function now refuses to return
-- unless a leg actually carries the key. Replay protection that depends on a
-- journal row is worth nothing if the journal row can quietly not be written,
-- and this is the same assertion fn_diamond_game_pay_chips already makes.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  A STANDALONE CLUB OWNER GETS THEIR OWN WALLET HISTORY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The old body wrote union_wallet_transactions inside `IF v_kind = 'union'`
-- and wrote nothing at all for a standalone club, even though
-- club_wallet_transactions exists and is what a club owner's wallet history
-- reads. The chip ledger always had the leg, so the money was never untraced -
-- but the operator could not see their own money move on the surface built to
-- show them their money moving. Both host shapes now write a row.
--
-- club_wallet_transactions_type_check is a fixed vocabulary - mint, clawback,
-- rake_in, commission_out, bbj_contribution, union_in, union_out,
-- agent_settlement, correction, other - and moving a club's chips between the
-- club's own two wallets is not any of the first nine. It is booked as 'other'
-- with a reason that says what it was, exactly as the ledger category was
-- taken from the existing vocabulary rather than widening a money constraint
-- for a button.
--
-- That table also carries chk_amount_is_two_decimal_places, which is the right
-- constraint and which this function could previously have thrown against, so
-- the amount is now checked at the door and answered in words instead.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The keyless door is removed, not left ajar beside the new one.
-- ───────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.fn_diamond_game_fund_promo(uuid, numeric);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The one that takes a key.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_diamond_game_fund_promo(
  p_club_id uuid,
  p_amount  numeric,
  p_key     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  v_lock record;
  v_promo_after numeric; v_bank_after numeric;
  v_key text;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;

  -- The caller's token is the whole of the replay guard, so it is checked
  -- before anything is locked. A key this function cannot trust is not an
  -- excuse to fall back on a generated one - that is the bug being fixed.
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{8,64}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Request Could Not Be Identified. Try Again');
  END IF;
  v_key := 'diamond-games-fund:' || p_key;

  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host''s Owners And Admins Move This Money');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Enter How Many Chips To Move');
  END IF;
  -- Both wallet-history tables hold whole cents. Refusing in words beats
  -- throwing a constraint violation at an operator who typed one digit too many.
  IF p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Chips Move In Whole Cents');
  END IF;
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Try Again In A Few Minutes');
  END IF;

  -- This takes the host's wallet row FOR UPDATE, which is what makes the
  -- check-then-act below safe: a second press for the same host waits here.
  SELECT c.o_promo, c.o_bank, c.o_cover INTO v_lock FROM public.fn_diamond_game_cover_lock(v_host, v_kind) c;

  -- ── the replay guard ────────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key = v_key) THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true,
                              'promo_chips', v_lock.o_promo,
                              'bank_chips', v_lock.o_bank,
                              'cover_chips', GREATEST(v_lock.o_promo, 0) + GREATEST(v_lock.o_bank, 0));
  END IF;

  IF v_lock.o_bank < p_amount THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bank Does Not Hold That Many Chips',
                              'bank_chips', v_lock.o_bank);
  END IF;

  -- treasury_transfer is the vocabulary's word for chips moving between a host's
  -- own wallets; the journal refuses a category it does not know, and inventing
  -- one here would mean widening chip_ledger_category_check for a button.
  PERFORM public.fn_ca_declare_ledger('treasury_transfer', 'promo_wallet', v_host, NULL, v_key, ARRAY[]::text[]);
  IF v_kind = 'union' THEN
    UPDATE public.union_wallets
       SET chip_balance = chip_balance - p_amount,
           promo_wallet = COALESCE(promo_wallet, 0) + p_amount,
           updated_at = now()
     WHERE union_id = v_host AND chip_balance >= p_amount
     RETURNING promo_wallet, chip_balance INTO v_promo_after, v_bank_after;
  ELSE
    UPDATE public.clubs
       SET chip_treasury = chip_treasury - p_amount,
           promo_balance = COALESCE(promo_balance, 0) + p_amount,
           updated_at = now()
     WHERE id = v_host AND chip_treasury >= p_amount
     RETURNING promo_balance, chip_treasury INTO v_promo_after, v_bank_after;
  END IF;
  IF v_promo_after IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bank Does Not Hold That Many Chips');
  END IF;

  -- The replay guard above reads the journal, so a move that wrote no leg
  -- would be a move that can be made twice. Refuse rather than allow that.
  IF NOT EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key = v_key) THEN
    RAISE EXCEPTION 'fn_diamond_game_fund_promo: the move wrote no journal leg under %, so a replay could not be told apart from a first press', v_key;
  END IF;

  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  -- ── the operator's own wallet history, whichever shape the host is ──────
  IF v_kind = 'union' THEN
    INSERT INTO public.union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
    VALUES (v_host, NULL, 'promo_wallet', 'credit', p_amount, v_promo_after, 'treasury_transfer',
            'Moved Into The Promo Wallet For The Diamond Games', v_user);
  ELSE
    INSERT INTO public.club_wallet_transactions
      (club_id, type, amount, balance_after, actor_id, reason)
    VALUES (v_host, 'other', -p_amount, v_bank_after,  v_user,
            'Moved Into The Promo Wallet For The Diamond Games');
  END IF;

  RETURN jsonb_build_object('ok', true, 'replayed', false,
                            'promo_chips', v_promo_after, 'bank_chips', v_bank_after,
                            'cover_chips', GREATEST(v_promo_after, 0) + GREATEST(v_bank_after, 0));
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The door says who may knock. CREATE FUNCTION grants EXECUTE to PUBLIC by
--    default, and a migration that only GRANTs never takes it away.
-- ───────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.fn_diamond_game_fund_promo(uuid, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_diamond_game_fund_promo(uuid, numeric, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_fund_promo(uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_fund_promo(uuid, numeric, text) TO service_role;

COMMIT;
