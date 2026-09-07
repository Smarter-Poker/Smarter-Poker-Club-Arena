-- Expected final P0001 AUDIT_TEST_PASS is an intentional rollback, not a committed fixture.
DO $probe$
DECLARE src text; tbl text; pool uuid:=gen_random_uuid(); felt uuid:=gen_random_uuid();
 loser uuid:=gen_random_uuid(); winner uuid:=gen_random_uuid(); stranger uuid:=gen_random_uuid();
 club uuid:=gen_random_uuid(); uni uuid:=gen_random_uuid(); oldaward uuid; r record; j jsonb; n numeric; b numeric;
BEGIN
 FOREACH tbl IN ARRAY ARRAY['bbj_pools','bbj_mini_tiers','bbj_payouts','bbj_winners','bbj_payout_recipients',
  'hand_history','profiles','ca_payout_freeze','bbj_unclaimed_shares','ca_bbj_bucket_moves',
  'union_wallets','union_wallet_transactions','wallet_credit_idempotency','chip_transactions'] LOOP
  EXECUTE format('CREATE TEMP TABLE %I (LIKE public.%I INCLUDING DEFAULTS) ON COMMIT DROP',tbl,tbl);
 END LOOP;
 CREATE TEMP TABLE table_seats(table_id uuid,user_id uuid,club_id uuid,stack numeric,left_at timestamptz,joined_at timestamptz DEFAULT now()) ON COMMIT DROP;
 CREATE TEMP TABLE tables(id uuid,club_id uuid) ON COMMIT DROP;
 CREATE TEMP TABLE club_members(user_id uuid,club_id uuid,status text,chip_balance numeric,updated_at timestamptz) ON COMMIT DROP;
 CREATE TEMP TABLE clubs(id uuid,chip_treasury numeric,promo_balance numeric) ON COMMIT DROP;
 CREATE UNIQUE INDEX ON pg_temp.bbj_payouts(pool_id,table_id,hand_number);
 CREATE UNIQUE INDEX ON pg_temp.bbj_winners(pool_id,table_id,hand_number);
 CREATE UNIQUE INDEX ON pg_temp.bbj_payout_recipients(payout_id,user_id);
 CREATE UNIQUE INDEX ON pg_temp.bbj_unclaimed_shares(payout_id,user_id);
 CREATE UNIQUE INDEX ON pg_temp.wallet_credit_idempotency(key);
 CREATE UNIQUE INDEX ON pg_temp.ca_bbj_bucket_moves(op_id);
 CREATE UNIQUE INDEX ON pg_temp.union_wallets(union_id);
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_player_home_club(uuid,uuid) RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_ensure_club_wallet(uuid,uuid) RETURNS void LANGUAGE sql AS 'SELECT'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[]) RETURNS void LANGUAGE sql AS 'SELECT'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_arena_name(text,text,text,text,text,text) RETURNS text LANGUAGE sql AS 'SELECT ''Fixture'''$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_spin_absorb_club_pool_into_union(uuid,uuid) RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_spin_move_owner_wallet(uuid,text,text,numeric) RETURNS numeric LANGUAGE sql AS 'UPDATE pg_temp.clubs SET chip_treasury=chip_treasury+$4 WHERE id=$1 RETURNING chip_treasury'$f$;
 SELECT pg_get_functiondef('public.fn_bbj_parked_reserve(uuid,text)'::regprocedure) INTO src; src:=replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''); EXECUTE src;
SELECT pg_get_functiondef('public.bbj_credit_one_recipient(uuid,uuid,uuid,numeric,boolean)'::regprocedure) INTO src; src:=replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''); EXECUTE src;
SELECT pg_get_functiondef('public.fn_bbj_move_between_banks(uuid,text,text,numeric,text,text)'::regprocedure) INTO src; src:=replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''); EXECUTE src;
SELECT pg_get_functiondef('public.fn_bbj_reseed_main_from_backup(uuid)'::regprocedure) INTO src; src:=replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''); EXECUTE src;
SELECT pg_get_functiondef('public.bbj_atomic_payout_v2(uuid,uuid,bigint,numeric,uuid,uuid,uuid[],uuid[],jsonb)'::regprocedure) INTO src; src:=replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''); EXECUTE src;
SELECT pg_get_functiondef('public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb)'::regprocedure) INTO src; src:=replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''); EXECUTE src;
SELECT pg_get_functiondef('public.fn_union_bbj_backup_transfer(uuid,numeric,text,uuid,uuid,text)'::regprocedure) INTO src; src:=replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''); EXECUTE src;
SELECT pg_get_functiondef('public.fn_close_club_wallets_on_union_join(uuid,uuid)'::regprocedure) INTO src; src:=replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''); EXECUTE src;
 INSERT INTO pg_temp.tables VALUES(felt,club);
 INSERT INTO pg_temp.clubs VALUES(club,0,0);
 INSERT INTO pg_temp.bbj_pools(id,club_id,main_balance,backup_balance,mini_reserve_floor) VALUES(pool,club,1000,1000,0);
 -- First Main award parks every share. A 10% hit must reserve exactly 100.
 SELECT * INTO r FROM pg_temp.bbj_atomic_payout_v2(pool,felt,1,10,loser,winner,ARRAY[loser,winner,loser,NULL],ARRAY[]::uuid[]);
 IF NOT r.applied OR r.total_payout<>100 OR pg_temp.fn_bbj_parked_reserve(pool,'main')<>100 THEN RAISE EXCEPTION 'FAIL main park'; END IF;
 oldaward:=r.payout_id;
 -- A different hand can spend 10% of the 900 still available, not the owed 100.
 SELECT * INTO r FROM pg_temp.bbj_atomic_payout_v2(pool,felt,2,10,loser,winner,ARRAY[loser,winner],ARRAY[]::uuid[]);
 IF r.total_payout<>90 OR pg_temp.fn_bbj_parked_reserve(pool,'main')<>190 THEN RAISE EXCEPTION 'FAIL main spent an existing obligation: %',row_to_json(r); END IF;
 j:=pg_temp.fn_bbj_move_between_banks(pool,'main','promo',811,'fixture forbidden reserve move','blocked');
 IF (j->>'ok')::boolean THEN RAISE EXCEPTION 'FAIL bank move spent reserve'; END IF;
 j:=pg_temp.fn_bbj_move_between_banks(pool,'main','promo',810,'fixture full available transfer','allowed');
 IF (j->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL available bank move'; END IF;
 j:=pg_temp.fn_bbj_move_between_banks(pool,'main','promo',810,'fixture full available transfer','allowed');
 IF (j->>'replayed')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL bank move replay after depletion'; END IF;
 INSERT INTO pg_temp.club_members VALUES(loser,club,'active',0,now()),(winner,club,'active',0,now()),(stranger,club,'active',0,now());
 -- A replay with forged player arguments must pay only the two stored debts.
 SELECT * INTO r FROM pg_temp.bbj_atomic_payout_v2(pool,felt,1,10,stranger,winner,ARRAY[stranger,winner],ARRAY[]::uuid[]);
 IF NOT r.already_paid OR NOT r.recovered OR (SELECT chip_balance FROM pg_temp.club_members WHERE user_id=stranger)<>0
  OR (SELECT sum(chip_balance) FROM pg_temp.club_members)<>100 OR pg_temp.fn_bbj_parked_reserve(pool,'main')<>90 THEN RAISE EXCEPTION 'FAIL durable Main replay'; END IF;
 -- Mini cannot use Backup already owed to another Mini recipient.
 INSERT INTO pg_temp.bbj_mini_tiers(tier_id,amount) VALUES('fixture',250);
 DELETE FROM pg_temp.club_members;
 SELECT * INTO r FROM pg_temp.fn_bbj_mini_payout(pool,felt,3,'fixture',loser,winner,ARRAY[loser,winner],ARRAY[]::uuid[]);
 IF NOT r.applied OR pg_temp.fn_bbj_parked_reserve(pool,'backup')<>250 THEN RAISE EXCEPTION 'FAIL mini park'; END IF;
 UPDATE pg_temp.bbj_pools SET mini_reserve_floor=501 WHERE id=pool;
 SELECT * INTO r FROM pg_temp.fn_bbj_mini_payout(pool,felt,4,'fixture',loser,winner,ARRAY[loser,winner],ARRAY[]::uuid[]);
 IF r.refused IS DISTINCT FROM 'reserve_at_floor' THEN RAISE EXCEPTION 'FAIL mini spent pending reserve'; END IF;
 -- Union transfers must also exclude owed Backup, for either destination.
 UPDATE pg_temp.bbj_pools SET union_id=uni WHERE id=pool;
 j:=pg_temp.fn_union_bbj_backup_transfer(uni,751,'promo',gen_random_uuid());
 IF (j->>'success')::boolean THEN RAISE EXCEPTION 'FAIL union promo transfer spent debt'; END IF;
 j:=pg_temp.fn_union_bbj_backup_transfer(uni,751,'main',gen_random_uuid());
 IF (j->>'success')::boolean THEN RAISE EXCEPTION 'FAIL union main transfer spent debt'; END IF;
 j:=pg_temp.fn_union_bbj_backup_transfer(uni,1,'promo',gen_random_uuid());
 IF (j->>'success')::boolean IS DISTINCT FROM true OR (SELECT promo_wallet FROM pg_temp.union_wallets WHERE union_id=uni)<>1 THEN RAISE EXCEPTION 'FAIL free Backup promo transfer'; END IF;
 -- Restore only isolated fixture balances before the next independent scenario.
 UPDATE pg_temp.bbj_pools SET union_id=NULL,backup_balance=1000 WHERE id=pool;
 -- Reseeding transfers only free Backup; existing Main debt remains funded.
 UPDATE pg_temp.bbj_pools SET main_balance=90 WHERE id=pool;
 n:=pg_temp.fn_bbj_reseed_main_from_backup(pool);
 IF n<>840 OR (SELECT backup_balance FROM pg_temp.bbj_pools WHERE id=pool)<>250 THEN RAISE EXCEPTION 'FAIL reseed spent pending reserve'; END IF;
 INSERT INTO pg_temp.table_seats VALUES(felt,loser,club,0,NULL,now()),(felt,winner,club,0,NULL,now());
 UPDATE pg_temp.bbj_mini_tiers SET enabled=false;
 SELECT * INTO r FROM pg_temp.fn_bbj_mini_payout(pool,felt,3,'fixture',stranger,winner,ARRAY[stranger,winner],ARRAY[]::uuid[]);
 IF NOT r.already_paid OR (SELECT sum(stack) FROM pg_temp.table_seats)<>250 OR pg_temp.fn_bbj_parked_reserve(pool,'backup')<>0 THEN RAISE EXCEPTION 'FAIL Mini durable replay after disable'; END IF;
 SELECT * INTO r FROM pg_temp.fn_bbj_mini_payout(pool,felt,3,'fixture',stranger,winner,ARRAY[stranger,winner],ARRAY[]::uuid[]);
 IF (SELECT sum(stack) FROM pg_temp.table_seats)<>250 THEN RAISE EXCEPTION 'FAIL Mini replay duplicated'; END IF;
 -- Closing a club moves only free funds; the old pool retains its 90 debt.
 j:=pg_temp.fn_close_club_wallets_on_union_join(club,uni);
 IF (j->>'bbj_swept')::numeric<>1560 OR (SELECT main_balance FROM pg_temp.bbj_pools WHERE id=pool)<>90
  OR (SELECT chip_treasury FROM pg_temp.clubs WHERE id=club)<>1560 THEN RAISE EXCEPTION 'FAIL union join reserve retention: %',j; END IF;
 RAISE EXCEPTION 'AUDIT_TEST_PASS: integrated Main/Mini actual recipient parking and recovery, forged replay identities, available-only payouts/transfers/reseed, replay after depletion, Mini floor and tier disable, retained obligations on union join. pg_temp only, full rollback. External wallet/home/ledger/spin helpers and triggers not exercised.';
END;
$probe$;