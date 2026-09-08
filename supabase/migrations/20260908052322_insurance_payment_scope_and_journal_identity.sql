-- Why: insurance bank selection ignored private tables, replay accepted changed amounts,
-- and the bank delta journal defaulted to adjustment against suspense.
-- What: table scope, canonical receipt cents, bound replay, and an explicit insurance journal.
-- Measured: isolated PostgreSQL route, replay, journal rollback and concurrent-payment cases.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.record_insurance_transaction(uuid,uuid,integer,uuid,numeric,numeric,numeric,numeric,boolean,character varying)'::regprocedure)) <> '133e7d6e73164209548f356227673704' THEN
  RAISE EXCEPTION 'Insurance function changed; re-audit before applying';
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.record_insurance_transaction(p_table_id uuid, p_club_id uuid, p_hand_number integer, p_player_id uuid, p_equity_percent numeric, p_premium numeric, p_insured_amount numeric, p_payout numeric, p_player_won boolean, p_kind character varying DEFAULT 'insurance'::character varying)
 RETURNS insurance_transactions
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union_id     uuid;
  v_bank_type    varchar(10);
  v_bank_entity  uuid;
  v_net_player   numeric;
  v_bank_delta   numeric;
  v_tx           insurance_transactions;
  v_club uuid; v_private boolean; v_context jsonb; v_setting text;
BEGIN
  IF p_table_id IS NULL OR p_club_id IS NULL OR p_hand_number IS NULL OR p_player_id IS NULL
     OR p_player_won IS NULL OR p_equity_percent IS NULL
     OR p_equity_percent::text IN ('NaN','Infinity','-Infinity')
     OR p_equity_percent < 0 OR p_equity_percent > 100
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[p_premium,p_insured_amount,p_payout]) amount
                WHERE amount IS NULL OR amount::text IN ('NaN','Infinity','-Infinity') OR amount < 0)
     OR COALESCE(NULLIF(p_kind,''),'insurance') NOT IN ('insurance','ev_cashout') THEN
    RAISE EXCEPTION 'Invalid insurance payment identity or amounts' USING ERRCODE='22023';
  END IF;
  -- Canonical cents match the persisted NUMERIC(...,2) receipt. Compute the
  -- bank delta from those same cents, not from unrounded caller operands.
  p_premium := round(p_premium,2);
  p_payout := round(p_payout,2);
  p_insured_amount := round(p_insured_amount,2);
  p_equity_percent := round(p_equity_percent,2);
  p_kind := COALESCE(NULLIF(p_kind,''),'insurance');

  SELECT club_id,union_id,COALESCE(is_private,false) INTO v_club,v_union_id,v_private
    FROM public.tables WHERE id=p_table_id FOR SHARE;
  IF NOT FOUND OR v_club IS DISTINCT FROM p_club_id THEN
    RAISE EXCEPTION 'Insurance table does not belong to supplied club' USING ERRCODE='22023';
  END IF;
  IF v_private THEN
    v_union_id := NULL;
  ELSIF v_union_id IS NULL THEN
    SELECT union_id INTO v_union_id FROM public.clubs WHERE id=p_club_id;
  END IF;

  IF v_union_id IS NOT NULL THEN
    v_bank_type := 'union';
    v_bank_entity := v_union_id;
  ELSE
    v_bank_type := 'club';
    v_bank_entity := p_club_id;
  END IF;

  v_net_player := COALESCE(p_payout, 0) - COALESCE(p_premium, 0);
  v_bank_delta := COALESCE(p_premium, 0) - COALESCE(p_payout, 0);

  INSERT INTO insurance_transactions (
    table_id, club_id, union_id, hand_number,
    player_id, equity_percent, premium, insured_amount, payout,
    player_won, net_result, bank_type, bank_entity_id, kind
  ) VALUES (
    p_table_id, p_club_id, v_union_id, p_hand_number,
    p_player_id, p_equity_percent, p_premium, p_insured_amount, p_payout,
    p_player_won, v_net_player, v_bank_type, v_bank_entity,
    COALESCE(NULLIF(p_kind, ''), 'insurance')
  )
  ON CONFLICT (table_id, hand_number, player_id) DO NOTHING
  RETURNING * INTO v_tx;

  IF v_tx.id IS NULL THEN
    SELECT * INTO v_tx FROM insurance_transactions
     WHERE table_id = p_table_id AND hand_number = p_hand_number AND player_id = p_player_id
     LIMIT 1;
    IF v_tx.id IS NULL OR v_tx.club_id IS DISTINCT FROM p_club_id
       OR v_tx.equity_percent IS DISTINCT FROM p_equity_percent
       OR v_tx.premium IS DISTINCT FROM p_premium
       OR v_tx.insured_amount IS DISTINCT FROM p_insured_amount
       OR v_tx.payout IS DISTINCT FROM p_payout
       OR v_tx.player_won IS DISTINCT FROM p_player_won
       OR v_tx.kind IS DISTINCT FROM p_kind THEN
      RAISE EXCEPTION 'Insurance identity reused with a different payment payload' USING ERRCODE='22023';
    END IF;
    RETURN v_tx;
  END IF;

  SELECT jsonb_object_agg(k,COALESCE(current_setting(k,true),'')) INTO v_context
    FROM unnest(ARRAY['app.ledger_category','app.ledger_counterparty',
                     'app.ledger_counterparty_entity','app.ledger_settlement','app.ledger_hand_id']) settings(k);
  PERFORM set_config('app.ledger_category','insurance',true);
  PERFORM set_config('app.ledger_counterparty','table_stack',true);
  PERFORM set_config('app.ledger_counterparty_entity',p_table_id::text,true);
  PERFORM set_config('app.ledger_settlement',
    'insurance:' || p_table_id::text || ':' || p_hand_number::text || ':' || p_player_id::text,true);
  PERFORM set_config('app.ledger_hand_id','',true);

  IF v_bank_delta <> 0 THEN
    IF v_bank_type = 'union' THEN
      INSERT INTO union_wallets (union_id, insurance_wallet)
      VALUES (v_bank_entity, v_bank_delta)
      ON CONFLICT (union_id) DO UPDATE
        SET insurance_wallet = COALESCE(union_wallets.insurance_wallet, 0) + v_bank_delta,
            updated_at = NOW();
    ELSE
      INSERT INTO club_wallets (club_id, insurance_balance)
      VALUES (v_bank_entity, v_bank_delta)
      ON CONFLICT (club_id) DO UPDATE
        SET insurance_balance = COALESCE(club_wallets.insurance_balance, 0) + v_bank_delta,
            updated_at = NOW();
    END IF;
  END IF;

  FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP
    PERFORM set_config(v_setting,v_context->>v_setting,true);
  END LOOP;
  RETURN v_tx;
END;
$function$
;
REVOKE ALL ON FUNCTION public.record_insurance_transaction(uuid,uuid,integer,uuid,numeric,numeric,numeric,numeric,boolean,character varying) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_insurance_transaction(uuid,uuid,integer,uuid,numeric,numeric,numeric,numeric,boolean,character varying) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
