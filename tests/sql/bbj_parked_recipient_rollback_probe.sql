-- Run as postgres in one call. Expected P0001 AUDIT_TEST_PASS deliberately rolls back all temporary fixtures.
-- No production financial fixtures; external helpers and table triggers are not exercised.
DO $probe$
DECLARE src text; pool uuid:=gen_random_uuid(); payout uuid; felt uuid:=gen_random_uuid();
  player uuid:=gen_random_uuid(); club uuid:=gen_random_uuid(); k text; ok boolean;
  b numeric; m numeric; t numeric; w numeric; n integer;
BEGIN
  CREATE TEMP TABLE bbj_pools(id uuid PRIMARY KEY,main_balance numeric,backup_balance numeric,total_paid_out numeric,updated_at timestamptz) ON COMMIT DROP;
  CREATE TEMP TABLE bbj_payouts(id uuid PRIMARY KEY,pool_id uuid,table_id uuid,kind text) ON COMMIT DROP;
  CREATE TEMP TABLE bbj_unclaimed_shares(id uuid DEFAULT gen_random_uuid(),payout_id uuid,pool_id uuid,table_id uuid,user_id uuid,amount numeric,reason text,paid_at timestamptz,paid_note text,UNIQUE(payout_id,user_id)) ON COMMIT DROP;
  CREATE TEMP TABLE bbj_payout_recipients(payout_id uuid,user_id uuid,amount numeric,UNIQUE(payout_id,user_id)) ON COMMIT DROP;
  CREATE TEMP TABLE table_seats(table_id uuid,user_id uuid,club_id uuid,stack numeric,left_at timestamptz,joined_at timestamptz DEFAULT now()) ON COMMIT DROP;
  CREATE TEMP TABLE tables(id uuid,club_id uuid) ON COMMIT DROP;
  CREATE TEMP TABLE club_members(user_id uuid,club_id uuid,status text,chip_balance numeric,updated_at timestamptz) ON COMMIT DROP;
  CREATE TEMP TABLE wallet_credit_idempotency(key text PRIMARY KEY,user_id uuid,amount numeric) ON COMMIT DROP;
  CREATE TEMP TABLE chip_transactions(club_id uuid,from_user_id uuid,to_user_id uuid,amount numeric,transaction_type text,notes text,balance_after numeric,table_id uuid) ON COMMIT DROP;
  EXECUTE $f$CREATE FUNCTION pg_temp.fn_player_home_club(uuid,uuid) RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.fn_ensure_club_wallet(uuid,uuid) RETURNS void LANGUAGE sql AS 'SELECT'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.fn_ca_declare_ledger(text,text,uuid,uuid,text,uuid) RETURNS void LANGUAGE sql AS 'SELECT'$f$;
  SELECT pg_get_functiondef('public.bbj_credit_one_recipient(uuid,uuid,uuid,numeric,boolean)'::regprocedure) INTO src;
  src:=replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp''');
  EXECUTE src;
  INSERT INTO pg_temp.tables VALUES(felt,club);
  FOREACH k IN ARRAY ARRAY['main','mini'] LOOP
    payout:=gen_random_uuid();
    INSERT INTO pg_temp.bbj_pools VALUES(pool,CASE WHEN k='main' THEN 900 ELSE 500 END,900,100,now());
    INSERT INTO pg_temp.bbj_payouts VALUES(payout,pool,felt,k);
    ok:=pg_temp.bbj_credit_one_recipient(payout,felt,player,100,false);
    IF ok THEN RAISE EXCEPTION 'FAIL unresolved share reported paid'; END IF;
    SELECT main_balance,backup_balance,total_paid_out INTO m,b,t FROM pg_temp.bbj_pools WHERE id=pool;
    IF m<>(CASE WHEN k='main' THEN 1000 ELSE 500 END) OR b<>(CASE WHEN k='mini' THEN 1000 ELSE 900 END) OR t<>0 THEN
      RAISE EXCEPTION 'FAIL first park bank: kind %, main %, backup %, paid %',k,m,b,t;
    END IF;
    FOR n IN 1..4 LOOP
      ok:=pg_temp.bbj_credit_one_recipient(payout,felt,player,100,false);
      IF ok OR EXISTS(SELECT 1 FROM pg_temp.bbj_pools WHERE id=pool AND (main_balance<>m OR backup_balance<>b OR total_paid_out<>t)) THEN
        RAISE EXCEPTION 'FAIL repeated park changes bank: kind %, retry %',k,n;
      END IF;
    END LOOP;
    BEGIN
      PERFORM pg_temp.bbj_credit_one_recipient(payout,felt,player,99,false);
      RAISE EXCEPTION 'FAIL changed entitlement accepted';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM<>'parked jackpot amount cannot change on replay' THEN RAISE; END IF;
    END;
    INSERT INTO pg_temp.club_members VALUES(player,club,'active',0,now());
    IF k='mini' THEN INSERT INTO pg_temp.table_seats VALUES(felt,player,club,0,NULL,now()); END IF;
    -- Inject depleted funding. The actual function may touch the destination
    -- first, but an unsuccessful reclaim must roll that entire call back.
    UPDATE pg_temp.bbj_pools SET main_balance=CASE WHEN k='main' THEN 99 ELSE m END,
      backup_balance=CASE WHEN k='mini' THEN 99 ELSE b END WHERE id=pool;
    BEGIN
      PERFORM pg_temp.bbj_credit_one_recipient(payout,felt,player,100,k='mini');
      RAISE EXCEPTION 'FAIL unfunded redemption accepted';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM<>'parked jackpot share lacks its original funding' THEN RAISE; END IF;
    END;
    IF EXISTS(SELECT 1 FROM pg_temp.club_members WHERE chip_balance<>0)
       OR EXISTS(SELECT 1 FROM pg_temp.table_seats WHERE stack<>0)
       OR EXISTS(SELECT 1 FROM pg_temp.bbj_payout_recipients WHERE payout_id=payout)
       OR EXISTS(SELECT 1 FROM pg_temp.bbj_unclaimed_shares WHERE payout_id=payout AND paid_at IS NOT NULL) THEN
      RAISE EXCEPTION 'FAIL failed redemption left a partial financial effect';
    END IF;
    UPDATE pg_temp.bbj_pools SET main_balance=m,backup_balance=b WHERE id=pool;
    ok:=pg_temp.bbj_credit_one_recipient(payout,felt,player,100,k='mini');
    IF NOT ok THEN RAISE EXCEPTION 'FAIL funded redemption rejected'; END IF;
    SELECT main_balance,backup_balance,total_paid_out INTO m,b,t FROM pg_temp.bbj_pools WHERE id=pool;
    SELECT chip_balance INTO w FROM pg_temp.club_members WHERE user_id=player;
    IF m<>(CASE WHEN k='main' THEN 900 ELSE 500 END) OR b<>900 OR t<>100 OR
       w<>(CASE WHEN k='main' THEN 100 ELSE 0 END) OR
       NOT EXISTS(SELECT 1 FROM pg_temp.bbj_unclaimed_shares WHERE payout_id=payout AND paid_at IS NOT NULL) THEN
      RAISE EXCEPTION 'FAIL redeemed funding or destination: % % % % %',k,m,b,t,w;
    END IF;
    IF k='mini' AND NOT EXISTS(SELECT 1 FROM pg_temp.table_seats WHERE stack=100) THEN RAISE EXCEPTION 'FAIL seat credit'; END IF;
    ok:=pg_temp.bbj_credit_one_recipient(payout,felt,player,100,k='mini');
    IF ok OR EXISTS(SELECT 1 FROM pg_temp.bbj_pools WHERE id=pool AND (main_balance<>m OR backup_balance<>b OR total_paid_out<>t)) THEN RAISE EXCEPTION 'FAIL duplicate redemption'; END IF;
    TRUNCATE pg_temp.bbj_pools,pg_temp.bbj_payouts,pg_temp.bbj_unclaimed_shares,pg_temp.bbj_payout_recipients,pg_temp.table_seats,pg_temp.club_members,pg_temp.wallet_credit_idempotency,pg_temp.chip_transactions;
  END LOOP;
  -- Direct, already allocated recipients must remain single-credit operations.
  FOREACH k IN ARRAY ARRAY['main','mini'] LOOP
    payout:=gen_random_uuid();
    INSERT INTO pg_temp.bbj_pools VALUES(pool,900,900,100,now());
    INSERT INTO pg_temp.bbj_payouts VALUES(payout,pool,felt,k);
    INSERT INTO pg_temp.club_members VALUES(player,club,'active',0,now());
    IF k='mini' THEN
      INSERT INTO pg_temp.table_seats VALUES(felt,player,club,0,NULL,now()),(felt,player,club,0,NULL,now());
      BEGIN
        PERFORM pg_temp.bbj_credit_one_recipient(payout,felt,player,100,true);
        RAISE EXCEPTION 'FAIL duplicate seats accepted';
      EXCEPTION WHEN raise_exception THEN
        IF SQLERRM<>'multiple active seats for jackpot recipient' THEN RAISE; END IF;
      END;
      IF EXISTS(SELECT 1 FROM pg_temp.table_seats WHERE stack<>0) OR EXISTS(SELECT 1 FROM pg_temp.bbj_payout_recipients) THEN RAISE EXCEPTION 'FAIL duplicate seat partial effect'; END IF;
      DELETE FROM pg_temp.table_seats;
      INSERT INTO pg_temp.table_seats VALUES(felt,player,club,0,NULL,now());
    END IF;
    ok:=pg_temp.bbj_credit_one_recipient(payout,felt,player,100,k='mini');
    IF NOT ok THEN RAISE EXCEPTION 'FAIL direct credit'; END IF;
    ok:=pg_temp.bbj_credit_one_recipient(payout,felt,player,100,k='mini');
    IF ok OR EXISTS(SELECT 1 FROM pg_temp.bbj_unclaimed_shares) OR EXISTS(SELECT 1 FROM pg_temp.bbj_pools WHERE main_balance<>900 OR backup_balance<>900 OR total_paid_out<>100) THEN RAISE EXCEPTION 'FAIL direct replay altered funding'; END IF;
    IF k='main' AND (SELECT chip_balance FROM pg_temp.club_members)<>100 THEN RAISE EXCEPTION 'FAIL direct wallet amount'; END IF;
    IF k='mini' AND (SELECT stack FROM pg_temp.table_seats)<>100 THEN RAISE EXCEPTION 'FAIL direct seat amount'; END IF;
    TRUNCATE pg_temp.bbj_pools,pg_temp.bbj_payouts,pg_temp.bbj_unclaimed_shares,pg_temp.bbj_payout_recipients,pg_temp.table_seats,pg_temp.club_members,pg_temp.wallet_credit_idempotency,pg_temp.chip_transactions;
  END LOOP;
  RAISE EXCEPTION 'AUDIT_TEST_PASS: Main and Mini original-bank parking, four repeated parks each, immutable owed amount, unfunded-redemption rollback, funded wallet/seat redemption, paid receipt, duplicate redemption, direct wallet/seat retries and duplicate-seat rollback. All pg_temp fixtures rolled back; ledger declaration/home-club/wallet-ensure helpers stubbed.';
END;
$probe$;