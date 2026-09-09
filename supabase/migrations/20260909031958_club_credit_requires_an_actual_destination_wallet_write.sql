-- Permanent shared Club Arena credit guard. No balance repair or new retry job.
-- The non-club wallet branch and all caller signatures remain unchanged.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$
DECLARE v_hash text;
BEGIN
 SELECT md5(pg_get_functiondef('public.atomic_credit_wallet_and_log(uuid,numeric,text,text,uuid,uuid,uuid,text)'::regprocedure)) INTO v_hash;
 IF v_hash NOT IN ('ca0a0d6fe1f01c1f2bed49e7db1fd7e8','ffc49583c6142ea0929f247edc65e219') THEN
  RAISE EXCEPTION 'Unreviewed shared wallet credit baseline: %',v_hash;
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.atomic_credit_wallet_and_log(p_user_id uuid, p_amount numeric, p_category text DEFAULT 'credit'::text, p_description text DEFAULT ''::text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_inserted integer;
  v_new_balance numeric;
  v_has_club boolean;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO wallet_credit_idempotency (key, user_id, amount)
    VALUES (p_idempotency_key, p_user_id, p_amount)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN RETURN true; END IF;
  END IF;

  -- ZERO-DRIFT phase 5: tournament stacks are play chips and never cash
  -- out to a wallet. Blocked here exactly as in atomic_table_cashout.
  IF p_table_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.tables t WHERE t.id = p_table_id AND t.tournament_id IS NOT NULL) THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'atomic_credit_wallet_and_log:tournament_mint_blocked', 'unauthorized_adjustment', 'info',
      'tourney-cashout-blocked:' || to_char(now(), 'YYYY-MM-DD'),
      p_amount, 0, p_amount, 'ledger', 'tables', p_table_id, NULL,
      NULL, p_table_id, NULL, NULL, NULL, NULL, NULL,
      'a tournament-table stack was about to credit a real wallet via atomic_credit_wallet_and_log - blocked. Tournament chips are play chips. This now blocks EVERY category, not just cashout; the category the caller used is in the metadata.',
      NULL, jsonb_build_object('user_id', p_user_id, 'amount', p_amount, 'category', p_category));
    RETURN true;
  END IF;

  /* ZERO-DRIFT (2026-08-31): tell the club_members ledger writer what this
     credit IS. 'cashout' maps to the table_cashout flow off the felt. */
  PERFORM set_config('app.ledger_category',
    CASE WHEN p_category IN ('cashout') THEN 'table_cashout'
         WHEN p_category IN ('buyin','rake','commission','transfer','rakeback',
                             'settlement','tournament_buyin','tournament_prize',
                             'bounty','refund','addon','rebuy','promo')
              THEN p_category
         ELSE 'player_funding' END, true);
  IF p_table_id IS NOT NULL THEN
    PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_table_id::text, true);
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT ts.club_id INTO v_club_id
      FROM table_seats ts
     WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id
     ORDER BY ts.joined_at DESC LIMIT 1;
  END IF;
  IF v_club_id IS NULL THEN
    -- A caller that KNOWS which club a credit belongs to says so in
    -- app.ledger_club_id. Rakeback earned at a club is paid into THAT
    -- club's wallet, not into whichever club the player joined first.
    -- Unset - which is every existing caller - is the old behaviour
    -- exactly, because fn_player_home_club ignores a NULL hint.
    v_club_id := public.fn_player_home_club(p_user_id,
      NULLIF(current_setting('app.ledger_club_id', true), '')::uuid);
  END IF;

  IF v_club_id IS NOT NULL THEN
    PERFORM public.fn_ensure_club_wallet(p_user_id, v_club_id);
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance,0) + p_amount, updated_at = now()
     WHERE user_id = p_user_id AND club_id = v_club_id
     RETURNING chip_balance INTO v_new_balance;
    IF NOT FOUND THEN
      -- A credit is not complete unless its destination balance was written.
      -- Abort before journal rows or a caller's cashout/seat exit can commit.
      RAISE EXCEPTION 'CLUB_CREDIT_DESTINATION_MISSING: player %, club %', p_user_id, v_club_id
        USING ERRCODE = '23503';
    END IF;
  ELSE
    SELECT EXISTS (SELECT 1 FROM club_members m WHERE m.user_id = p_user_id) INTO v_has_club;
    IF v_has_club THEN
      RAISE EXCEPTION 'No club wallet resolves for Club Arena credit to player %', p_user_id;
    END IF;
    UPDATE wallets SET balance = COALESCE(balance,0) + p_amount, updated_at = now()
     WHERE user_id = p_user_id AND wallet_type = 'PLAYER'
     RETURNING balance INTO v_new_balance;
    IF NOT FOUND THEN
      INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
      VALUES (p_user_id, 'PLAYER', p_amount, 0)
      ON CONFLICT (user_id, wallet_type) DO UPDATE
        SET balance = wallets.balance + p_amount, updated_at = now()
      RETURNING balance INTO v_new_balance;
    END IF;
  END IF;

  IF p_category = 'cashout' THEN
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category,
                                     description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'credit', p_amount, 'cashout',
            COALESCE(NULLIF(p_description, ''), 'Cash-out to club wallet'),
            p_table_id, v_new_balance);
  END IF;

  IF v_club_id IS NOT NULL THEN
    INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type,
                                   notes, table_id, metadata)
    VALUES (v_club_id, p_user_id, p_amount, p_category,
            COALESCE(NULLIF(p_description, ''), 'Wallet credit'), p_table_id,
            CASE WHEN p_category = 'cashout'
                 THEN jsonb_build_object('mirrored_to_wallet', true)
                 ELSE '{}'::jsonb END);
  END IF;

  RETURN true;
END; $function$;
COMMIT;
