-- Future tournament entry receipts use the club wallet selected by the debit.
-- No balance or historical receipt is rewritten.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
DO $receipt_source$
DECLARE installed text;
BEGIN
  SELECT md5(p.prosrc) INTO installed
    FROM pg_proc p
   WHERE p.oid='public.log_wallet_transaction(uuid,text,numeric,text,text,text,uuid,uuid,uuid)'::regprocedure;
  IF installed IS NULL OR installed NOT IN ('14d25f13e1ceca68cf4da1e231cc342b','f9d423ecda16d49d698a1b3735baf7cb') THEN
    RAISE EXCEPTION 'Tournament receipt logger changed; reconcile its current source first';
  END IF;
END;
$receipt_source$;

CREATE OR REPLACE FUNCTION public.log_wallet_transaction(p_user_id uuid, p_wallet_type text, p_amount numeric, p_type text, p_category text, p_description text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_bal NUMERIC; v_club uuid;
BEGIN
  /* ZERO-DRIFT (2026-08-31): club members' live balance is
     club_members.chip_balance; public.wallets has been frozen since
     2026-08-21, so reading it stamped a stale balance_after on every row. */
  IF p_wallet_type = 'PLAYER' THEN
    -- Entry debits already resolve the tournament's club in the money writer.
    -- Record that wallet's balance, even when another membership is older.
    IF p_type = 'debit'
       AND p_related_entity_id IS NOT NULL
       AND lower(COALESCE(p_category, '')) IN
         ('tournament_buyin', 'tournament_rebuy', 'rebuy', 'reentry', 'addon') THEN
      SELECT t.club_id INTO v_club
        FROM public.tournaments t WHERE t.id = p_related_entity_id;
    ELSE
      v_club := public.fn_player_home_club(p_user_id, NULL);
    END IF;
    IF v_club IS NOT NULL THEN
      SELECT chip_balance INTO v_bal FROM club_members
       WHERE user_id = p_user_id AND club_id = v_club;
    END IF;
  END IF;
  IF v_bal IS NULL THEN
    SELECT balance INTO v_bal FROM wallets WHERE user_id = p_user_id AND wallet_type = p_wallet_type;
  END IF;
  INSERT INTO wallet_transactions (user_id, wallet_type, amount, type, category, description, table_id, hand_id, related_entity_id, balance_after, created_at)
  VALUES (p_user_id, p_wallet_type, p_amount, p_type, p_category, p_description, p_table_id, p_hand_id, p_related_entity_id, COALESCE(v_bal, 0), NOW());
END;
$function$
;

COMMIT;
