-- A funding replay belongs to the same request.
-- Version reserved by scripts/new-migration.mjs.
-- Live rolled-back probe: funding 1 chip, then asking for 2 or asking at a
-- different host under the same key returned successful replays for both.
-- The journal held only the original 1-chip movement. Match that immutable
-- evidence before claiming completion; retain the namespace for old retries.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

CREATE OR REPLACE FUNCTION public.fn_diamond_game_fund_promo(p_club_id uuid, p_amount numeric, p_key text)
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
  v_previous public.chip_ledger%ROWTYPE;
  v_source uuid;
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
  -- Union bank legs identify the wallet ROW; club legs identify the club.
  IF v_kind = 'union' THEN
    SELECT id INTO v_source FROM public.union_wallets WHERE union_id = v_host;
  ELSE
    v_source := v_host;
  END IF;
  SELECT l.* INTO v_previous FROM public.chip_ledger l WHERE l.idempotency_key = v_key;
  IF FOUND THEN
    -- A token identifies one actor, host and amount, not any later request
    -- carrying the same text. Preserve the historical namespace so old keys
    -- still replay instead of funding a second time after this upgrade.
    IF v_previous.performed_by IS DISTINCT FROM v_user
       OR v_previous.from_entity_id IS DISTINCT FROM v_source
       OR v_previous.to_entity_id IS DISTINCT FROM v_host
       OR v_previous.from_type IS DISTINCT FROM (CASE WHEN v_kind = 'union' THEN 'union_bank' ELSE 'club_treasury' END)
       OR v_previous.to_type IS DISTINCT FROM 'promo_wallet'
       OR v_previous.category IS DISTINCT FROM 'treasury_transfer'
       OR v_previous.amount IS DISTINCT FROM p_amount THEN
      RETURN jsonb_build_object('ok', false, 'error',
        'That Request Key Was Already Used For Different Funding');
    END IF;
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

REVOKE ALL ON FUNCTION public.fn_diamond_game_fund_promo(uuid, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_diamond_game_fund_promo(uuid, numeric, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_fund_promo(uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_fund_promo(uuid, numeric, text) TO service_role;

COMMIT;
