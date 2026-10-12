-- The seed and the cases for tests/sql/run-diamond-tournament-lane-journal.py
-- (issue #6411, migration 20261007132503). Isolated PostgreSQL 17 only.
--
-- The runner splits this file at the '-- @@ ' markers and runs each part in
-- order: SEED, then BEFORE (against the pre-images), then the migration, then
-- each AFTER part. A PASS: notice is one check.
--
-- Players: a, b, d are people; c is a horse, seated in every event and settled
-- exactly as a human (CLAUDE.md 10.5). Every amount is a fixture amount.

-- @@ SEED
INSERT INTO public.clubs (id,name,asset,is_platform) VALUES ('002c2d27-9584-4e52-835a-bb2be148fc81','Diamond Arena','diamonds',true);
INSERT INTO public.profiles (id,username,diamonds,is_horse) VALUES
  ('00000000-0000-0000-0000-00000000000a','player_a',0,false),
  ('00000000-0000-0000-0000-00000000000b','player_b',0,false),
  ('00000000-0000-0000-0000-00000000000c','horse_c',0,true),
  ('00000000-0000-0000-0000-00000000000d','player_d',0,false);
-- Each player bought 10,000 (journalled, so the register issued them).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.profiles ORDER BY id LOOP
    UPDATE public.profiles SET diamonds = 10000 WHERE id = r.id;
    INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,reference_id,description,source,issuance_class)
    VALUES (r.id,'purchase','purchase',10000,10000,'seed-purchase:'||r.id,'Fixture purchase','stripe','purchased');
  END LOOP;
END $$;
INSERT INTO public.ca_diamond_house (id,balance) VALUES (1,100000);
INSERT INTO public.ca_mint_ledger (op_id,action,asset,holder_type,holder_id,holder_label,amount,balance_before,balance_after,supply_after,reason)
VALUES ('seed-house','mint','diamonds','house','00000000-0000-0000-0000-00000000d1a0','the house',100000,0,100000,140000,
        'Fixture: the house was issued its float');

INSERT INTO public.tournaments (id,club_id,name,variant,tournament_type,max_players,buy_in_amount,buy_in_fee,bounty_amount,status,starting_chips)
VALUES ('00000000-0000-0000-0000-0000000000f1','002c2d27-9584-4e52-835a-bb2be148fc81','Fixture Freezeout','freezeout','MTT',9,180,20,0,'RUNNING',10000),
       ('00000000-0000-0000-0000-0000000000f2','002c2d27-9584-4e52-835a-bb2be148fc81','Fixture Guarantee','freezeout','MTT',9,180,20,0,'RUNNING',10000);

-- An entry bought through the wallet: an arena_deposit row, the wallet down,
-- the custody up, a reserve movement carrying that row, the entry ledger row.
CREATE FUNCTION public.fixture_enter(p_user uuid, p_tid uuid, p_prize bigint, p_fee bigint) RETURNS uuid
LANGUAGE plpgsql AS $f$
DECLARE v_reg uuid := gen_random_uuid(); v_c uuid; v_j uuid; v_w bigint;
BEGIN
  INSERT INTO public.tournament_players(id,tournament_id,user_id,status) VALUES (v_reg,p_tid,p_user,'registered');
  UPDATE public.profiles SET diamonds = diamonds - (p_prize+p_fee) WHERE id = p_user RETURNING diamonds INTO v_w;
  INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,reference_id,description,source,issuance_class)
  VALUES (p_user,'arena_deposit','arena_deposit',-(p_prize+p_fee),v_w,'entry:'||v_reg,'Fixture entry','poker_arena','arena')
  RETURNING id INTO v_j;
  INSERT INTO public.poker_diamond_custody(user_id,arena_id,purpose,target_id,entry_key,balance,state)
  VALUES (p_user,'002c2d27-9584-4e52-835a-bb2be148fc81','tournament_entry',p_tid,'entry:'||v_reg,p_prize+p_fee,'active')
  RETURNING id INTO v_c;
  INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,source_account,destination_account,wallet_journal_id,request,receipt)
  VALUES (gen_random_uuid(),v_c,p_user,'reserve',p_prize+p_fee,'player:'||p_user,'arena_custody:'||v_c,v_j,
          jsonb_build_object('action','reserve'),jsonb_build_object('success',true));
  INSERT INTO public.poker_diamond_tournament_ledger(tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,idempotency_key,wallet_journal_id,registration_id,request)
  VALUES (p_tid,'002c2d27-9584-4e52-835a-bb2be148fc81',p_user,v_c,'entry',p_prize+p_fee,p_prize,0,p_fee,'entry:'||v_reg,v_j,v_reg,'{}'::jsonb);
  RETURN v_c;
END $f$;

-- A Spin: three entrants (a, b and the horse c), one whole buy-in of 100 each,
-- a one-tier table so the draw is deterministic.
CREATE FUNCTION public.fixture_spin(p_tid uuid, p_multiplier integer) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_manifest jsonb; v_u uuid;
BEGIN
  INSERT INTO public.tournaments (id,club_id,name,variant,tournament_type,max_players,format_contract,buy_in_amount,buy_in_fee,bounty_amount,status,starting_chips)
  VALUES (p_tid,'002c2d27-9584-4e52-835a-bb2be148fc81','Fixture Spin x'||p_multiplier,'spin','SPIN',3,'spin-v1',100,0,0,'REGISTERING',500);
  v_manifest := jsonb_build_object('tiers', jsonb_build_array(jsonb_build_object(
    'freq', 1, 'multiplier', p_multiplier, 'blind_structure', '[]'::jsonb, 'payout_structure', '[]'::jsonb)));
  INSERT INTO public.poker_diamond_spin_contracts(tournament_id,buy_in,starting_chips,rule_manifest,rule_sha256,worst_excess,required_cover)
  VALUES (p_tid,100,500,v_manifest,encode(extensions.digest(v_manifest::text,'sha256'),'hex'),1000,1000);
  FOREACH v_u IN ARRAY ARRAY['00000000-0000-0000-0000-00000000000a'::uuid,'00000000-0000-0000-0000-00000000000b'::uuid,
                             '00000000-0000-0000-0000-00000000000c'::uuid] LOOP
    PERFORM public.fixture_enter(v_u, p_tid, 100, 0);
  END LOOP;
END $f$;
INSERT INTO public.poker_diamond_spin_reserve_source(id,source_account,max_underwrite_per_spin,authorized_by,ruling)
VALUES (1,'ca_diamond_house',100000,'fixture','fixture ruling');

SELECT public.fixture_enter(u, '00000000-0000-0000-0000-0000000000f1', 180, 20)
  FROM unnest(ARRAY['00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b',
                    '00000000-0000-0000-0000-00000000000c','00000000-0000-0000-0000-00000000000d']::uuid[]) u;
SELECT public.fixture_enter(u, '00000000-0000-0000-0000-0000000000f2', 180, 20)
  FROM unnest(ARRAY['00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000c']::uuid[]) u;
INSERT INTO public.ca_diamond_house_earmarks(entry,earmark_key,purpose,amount,tournament_id,reason)
VALUES ('open','guarantee:00000000-0000-0000-0000-0000000000f2','guarantee',1000,'00000000-0000-0000-0000-0000000000f2',
        'Fixture: the guarantee set aside at creation');

DO $$
BEGIN
  IF public.fixture_journal_gaps() <> 0 THEN RAISE EXCEPTION 'the seed journal does not explain the seed wallets'; END IF;
  IF public.fixture_identity() <> 0 THEN RAISE EXCEPTION 'the seed identity is not whole (%)', public.fixture_identity(); END IF;
  RAISE NOTICE 'PASS: the seed: four wallets their journal explains, eight entries in custody, identity 0';
END $$;

-- @@ BEFORE
-- The installed drain journals the fee as a spend that moves no wallet. Rolled
-- back, so the cases after the migration start from the seed.
BEGIN;
DO $$
DECLARE v_w bigint; v_rows bigint; v_gaps bigint;
BEGIN
  SELECT diamonds INTO v_w FROM public.profiles WHERE id = '00000000-0000-0000-0000-00000000000c';
  PERFORM public.fn_poker_diamond_tournament_settle_fee('00000000-0000-0000-0000-0000000000f1', 'fixture');
  SELECT count(*) INTO v_rows FROM public.diamond_transactions WHERE transaction_type = 'tournament_fee';
  v_gaps := public.fixture_journal_gaps();
  IF v_rows <> 4 OR v_gaps <> 4 THEN
    RAISE EXCEPTION 'BEFORE did not reproduce the defect: % fee rows, % unexplained wallets', v_rows, v_gaps;
  END IF;
  IF (SELECT diamonds FROM public.profiles WHERE id = '00000000-0000-0000-0000-00000000000c') <> v_w THEN
    RAISE EXCEPTION 'BEFORE moved a wallet';
  END IF;
  RAISE NOTICE 'PASS: BEFORE, the installed drain journals 4 fee rows that move no wallet; 4 wallets unexplained (the 13:03 UTC defect)';
END $$;
ROLLBACK;

-- @@ AFTER FEE
BEGIN;
DO $$
DECLARE v_before jsonb; v_after jsonb; v_r jsonb; v_reg record; v_n bigint;
BEGIN
  SELECT jsonb_object_agg(id, diamonds) INTO v_before FROM public.profiles;
  v_r := public.fn_poker_diamond_tournament_settle_fee('00000000-0000-0000-0000-0000000000f1', 'fixture');
  IF (v_r->>'amount')::bigint IS DISTINCT FROM 80 THEN RAISE EXCEPTION 'the fee settled %, not 80', v_r; END IF;
  SELECT jsonb_object_agg(id, diamonds) INTO v_after FROM public.profiles;
  IF v_before <> v_after THEN RAISE EXCEPTION 'a wallet moved on the fee'; END IF;
  IF public.fixture_house_leg_journals() <> 0 THEN RAISE EXCEPTION 'the fee wrote a wallet journal row'; END IF;
  IF public.fixture_journal_gaps() <> 0 THEN RAISE EXCEPTION 'a journal stopped explaining its wallet'; END IF;
  RAISE NOTICE 'PASS: the fee (80) settles with no wallet journal row and no wallet moving';

  SELECT count(*) INTO v_n FROM public.ca_mint_ledger m
   WHERE m.op_id LIKE 'poker-tournament-fee:00000000-0000-0000-0000-0000000000f1:%' AND m.action='burn'
     AND m.holder_type='player' AND m.amount = 20 AND m.balance_before = m.balance_after AND m.diamond_tx_id IS NULL;
  IF v_n <> 4 THEN RAISE EXCEPTION 'expected 4 player burns of 20 with the wallet unchanged, found %', v_n; END IF;
  FOR v_reg IN SELECT m.holder_id, m.balance_after FROM public.ca_mint_ledger m
                WHERE m.op_id LIKE 'poker-tournament-fee:00000000-0000-0000-0000-0000000000f1:%' LOOP
    IF v_reg.balance_after <> (SELECT diamonds FROM public.profiles WHERE id = v_reg.holder_id) THEN
      RAISE EXCEPTION 'a fee burn names a wallet balance that is not the wallet';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger
                  WHERE op_id = 'poker-tournament-fee:00000000-0000-0000-0000-0000000000f1:'||
                        (SELECT id FROM public.poker_diamond_custody
                          WHERE user_id='00000000-0000-0000-0000-00000000000c'
                            AND target_id='00000000-0000-0000-0000-0000000000f1')::text) THEN
    RAISE EXCEPTION 'the horse was not retired like the others';
  END IF;
  RAISE NOTICE 'PASS: one register burn of 20 per entry, the horse included, wallet unchanged on both sides';

  SELECT count(*) INTO v_n FROM public.poker_diamond_movements
   WHERE destination_account='house' AND wallet_journal_id IS NULL AND (receipt->>'register_op_id') IS NOT NULL;
  IF v_n <> 4 THEN RAISE EXCEPTION 'expected 4 house legs with no journal id, found %', v_n; END IF;
  IF (SELECT balance FROM public.ca_diamond_house WHERE id=1) <> 100080 THEN RAISE EXCEPTION 'the house did not bank 80'; END IF;
  IF public.fixture_identity() <> 0 THEN RAISE EXCEPTION 'identity %', public.fixture_identity(); END IF;
  RAISE NOTICE 'PASS: four house legs carry no journal id; the house banks 80; identity 0';

  v_r := public.fn_poker_diamond_tournament_settle_fee('00000000-0000-0000-0000-0000000000f1', 'fixture');
  IF (v_r->>'already_settled')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'a second settlement was not refused: %', v_r; END IF;
  IF (SELECT count(*) FROM public.ca_mint_ledger WHERE op_id LIKE 'poker-tournament-fee:00000000-0000-0000-0000-0000000000f1%') <> 5 THEN
    RAISE EXCEPTION 'a second settlement wrote register rows';
  END IF;
  RAISE NOTICE 'PASS: a second fee settlement is already_settled and writes nothing';

  v_r := public.fn_diamond_arena_reconciliation('00000000-0000-0000-0000-00000000000c');
  IF (v_r->>'balanced')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'the horse does not reconcile: %', v_r; END IF;
  RAISE NOTICE 'PASS: the reconciliation balances for the horse after its fee';
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;

-- @@ AFTER OVERLAY
BEGIN;
DO $$
DECLARE v_before jsonb; v_after jsonb; v_amt bigint; v_n bigint;
BEGIN
  SELECT jsonb_object_agg(id, diamonds) INTO v_before FROM public.profiles;
  -- Two entries collected 360 for the prize pool; a 600 guarantee needs 240.
  v_amt := public.fn_poker_diamond_tournament_settle_overlay('00000000-0000-0000-0000-0000000000f2', 'lock', 600);
  IF v_amt <> 240 THEN RAISE EXCEPTION 'the overlay paid %, not 240', v_amt; END IF;
  SELECT jsonb_object_agg(id, diamonds) INTO v_after FROM public.profiles;
  IF v_before <> v_after THEN RAISE EXCEPTION 'a wallet moved on the overlay'; END IF;
  IF public.fixture_house_leg_journals() <> 0 THEN RAISE EXCEPTION 'the overlay wrote a wallet journal row'; END IF;
  IF public.fixture_journal_gaps() <> 0 THEN RAISE EXCEPTION 'a journal stopped explaining its wallet'; END IF;
  SELECT count(*) INTO v_n FROM public.ca_mint_ledger
   WHERE op_id LIKE 'poker-guarantee-overlay:00000000-0000-0000-0000-0000000000f2:lock:%' AND action='mint'
     AND holder_type='player' AND amount = 120 AND balance_before = balance_after;
  IF v_n <> 2 THEN RAISE EXCEPTION 'expected 2 player mints of 120, found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.poker_diamond_tournament_ledger
   WHERE tournament_id='00000000-0000-0000-0000-0000000000f2' AND kind='overlay' AND wallet_journal_id IS NULL;
  IF v_n <> 2 THEN RAISE EXCEPTION 'expected 2 overlay ledger rows with no journal id, found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.poker_diamond_movements
   WHERE source_account LIKE 'house:%' AND request->>'action'='guarantee_overlay' AND wallet_journal_id IS NULL;
  IF v_n <> 2 THEN RAISE EXCEPTION 'expected 2 overlay movements with no journal id, found %', v_n; END IF;
  IF public.fixture_identity() <> 0 THEN RAISE EXCEPTION 'identity %', public.fixture_identity(); END IF;
  RAISE NOTICE 'PASS: the overlay (240) lands in custody, registered 120 to each entry (the horse too), no journal row, identity 0';

  -- At finalize the guarantee is 300: the 240 is no longer needed and returns.
  v_amt := public.fn_poker_diamond_tournament_settle_overlay('00000000-0000-0000-0000-0000000000f2', 'finalize', 300);
  IF v_amt <> -240 THEN RAISE EXCEPTION 'the return was %, not -240', v_amt; END IF;
  SELECT jsonb_object_agg(id, diamonds) INTO v_after FROM public.profiles;
  IF v_before <> v_after THEN RAISE EXCEPTION 'a wallet moved on the return'; END IF;
  IF public.fixture_house_leg_journals() <> 0 THEN RAISE EXCEPTION 'the return wrote a wallet journal row'; END IF;
  IF public.fixture_journal_gaps() <> 0 THEN RAISE EXCEPTION 'a journal stopped explaining its wallet'; END IF;
  IF (SELECT COALESCE(sum(amount),0) FROM public.ca_mint_ledger
       WHERE op_id LIKE 'poker-guarantee-overlay-return:00000000-0000-0000-0000-0000000000f2:finalize:%'
         AND action='burn' AND holder_type='player' AND balance_before = balance_after) <> 240 THEN
    RAISE EXCEPTION 'the return was not retired from the players in the register';
  END IF;
  SELECT count(*) INTO v_n FROM public.poker_diamond_tournament_ledger
   WHERE tournament_id='00000000-0000-0000-0000-0000000000f2' AND kind='overlay_return' AND wallet_journal_id IS NULL;
  IF v_n < 1 THEN RAISE EXCEPTION 'no overlay_return ledger row with no journal id'; END IF;
  IF public.fixture_identity() <> 0 THEN RAISE EXCEPTION 'identity %', public.fixture_identity(); END IF;
  RAISE NOTICE 'PASS: the return (240) leaves custody for the house, retired from the players in the register, no journal row, identity 0';
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;

-- @@ AFTER SPIN
SELECT public.fixture_spin('00000000-0000-0000-0000-0000000000f3', 5);
SELECT public.fixture_spin('00000000-0000-0000-0000-0000000000f4', 2);
BEGIN;
DO $$
DECLARE v_before jsonb; v_after jsonb; v_r jsonb; v_n bigint;
BEGIN
  SELECT jsonb_object_agg(id, diamonds) INTO v_before FROM public.profiles;
  -- 5x on three 100 entries: a 500 pool, 200 underwritten by the house.
  v_r := public.fn_poker_diamond_spin_draw('00000000-0000-0000-0000-0000000000f3', gen_random_uuid(), gen_random_uuid());
  IF (v_r->>'ok')::boolean IS NOT TRUE OR (v_r->>'underwrite')::bigint IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'the 5x draw did not underwrite 200: %', v_r;
  END IF;
  SELECT jsonb_object_agg(id, diamonds) INTO v_after FROM public.profiles;
  IF v_before <> v_after THEN RAISE EXCEPTION 'a wallet moved on the underwrite'; END IF;
  IF public.fixture_house_leg_journals() <> 0 THEN RAISE EXCEPTION 'the underwrite wrote a wallet journal row'; END IF;
  IF public.fixture_journal_gaps() <> 0 THEN RAISE EXCEPTION 'a journal stopped explaining its wallet'; END IF;
  SELECT count(*) INTO v_n FROM public.ca_mint_ledger
   WHERE op_id LIKE 'poker-spin-underwrite:00000000-0000-0000-0000-0000000000f3:%' AND action='mint'
     AND holder_type='player' AND balance_before = balance_after;
  IF v_n <> 3 THEN RAISE EXCEPTION 'expected 3 player mints, found %', v_n; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(v_r->'custody_legs') l
       WHERE l->>'journal_id' IS NULL AND l->>'register_op_id' IS NOT NULL) <> 3 THEN
    RAISE EXCEPTION 'the receipt legs still name journal rows: %', v_r->'custody_legs';
  END IF;
  SELECT count(*) INTO v_n FROM public.poker_diamond_tournament_ledger
   WHERE tournament_id='00000000-0000-0000-0000-0000000000f3' AND kind='spin_underwrite' AND wallet_journal_id IS NULL;
  IF v_n <> 3 THEN RAISE EXCEPTION 'expected 3 underwrite ledger rows with no journal id, found %', v_n; END IF;
  IF public.fixture_identity() <> 0 THEN RAISE EXCEPTION 'identity %', public.fixture_identity(); END IF;
  RAISE NOTICE 'PASS: a 5x Spin underwrite (200) lands in custody, registered 67/67/66 to the three entries (the horse too), no journal row, identity 0';

  -- 2x on three 100 entries: a 200 pool, 100 surplus back to the house.
  v_r := public.fn_poker_diamond_spin_draw('00000000-0000-0000-0000-0000000000f4', gen_random_uuid(), gen_random_uuid());
  IF (v_r->>'ok')::boolean IS NOT TRUE OR (v_r->>'surplus')::bigint IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'the 2x draw did not return a 100 surplus: %', v_r;
  END IF;
  SELECT jsonb_object_agg(id, diamonds) INTO v_after FROM public.profiles;
  IF v_before <> v_after THEN RAISE EXCEPTION 'a wallet moved on the surplus'; END IF;
  IF public.fixture_house_leg_journals() <> 0 THEN RAISE EXCEPTION 'the surplus wrote a wallet journal row'; END IF;
  IF public.fixture_journal_gaps() <> 0 THEN RAISE EXCEPTION 'a journal stopped explaining its wallet'; END IF;
  IF (SELECT COALESCE(sum(amount),0) FROM public.ca_mint_ledger
       WHERE op_id LIKE 'poker-spin-surplus:00000000-0000-0000-0000-0000000000f4:%' AND action='burn'
         AND holder_type='player' AND balance_before = balance_after) <> 100 THEN
    RAISE EXCEPTION 'the surplus was not retired from the players in the register';
  END IF;
  SELECT count(*) INTO v_n FROM public.poker_diamond_tournament_ledger
   WHERE tournament_id='00000000-0000-0000-0000-0000000000f4' AND kind='spin_surplus' AND wallet_journal_id IS NULL;
  IF v_n < 1 THEN RAISE EXCEPTION 'no spin_surplus ledger row with no journal id'; END IF;
  IF public.fixture_identity() <> 0 THEN RAISE EXCEPTION 'identity %', public.fixture_identity(); END IF;
  RAISE NOTICE 'PASS: a 2x Spin surplus (100) leaves custody for the house, retired in the register, no journal row, identity 0';
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;

-- @@ MUTATIONS
-- The relaxed constraints are still strict wherever a wallet leg exists. An
-- error is the success case.
DO $$
DECLARE v_c uuid;
BEGIN
  SELECT id INTO v_c FROM public.poker_diamond_custody
   WHERE user_id='00000000-0000-0000-0000-00000000000a' AND target_id='00000000-0000-0000-0000-0000000000f1';
  BEGIN
    INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,source_account,destination_account,wallet_journal_id,request,receipt)
    VALUES (gen_random_uuid(),v_c,'00000000-0000-0000-0000-00000000000a','release',5,'arena_custody:'||v_c,
            'player:00000000-0000-0000-0000-00000000000a',NULL,jsonb_build_object('action','tournament_drain'),'{}'::jsonb);
    RAISE EXCEPTION 'MUTATION ADMITTED: a release into a wallet with no journal row';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,source_account,destination_account,wallet_journal_id,request,receipt)
    VALUES (gen_random_uuid(),v_c,'00000000-0000-0000-0000-00000000000a','reserve',5,
            'player:00000000-0000-0000-0000-00000000000a','arena_custody:'||v_c,NULL,jsonb_build_object('action','spin_underwrite'),'{}'::jsonb);
    RAISE EXCEPTION 'MUTATION ADMITTED: a reserve from a wallet with no journal row';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,source_account,destination_account,wallet_journal_id,request,receipt)
    VALUES (gen_random_uuid(),v_c,'00000000-0000-0000-0000-00000000000a','release',5,'arena_custody:'||v_c,'house',NULL,
            jsonb_build_object('action','cash_out'),'{}'::jsonb);
    RAISE EXCEPTION 'MUTATION ADMITTED: a house release that is not a tournament drain, with no journal row';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.poker_diamond_tournament_ledger(tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,idempotency_key,wallet_journal_id,request)
    VALUES ('00000000-0000-0000-0000-0000000000f1','002c2d27-9584-4e52-835a-bb2be148fc81','00000000-0000-0000-0000-00000000000a',
            v_c,'rebuy',5,5,0,0,'mutation-rebuy',NULL,'{}'::jsonb);
    RAISE EXCEPTION 'MUTATION ADMITTED: an inflow with no journal row';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.poker_diamond_tournament_ledger(tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,idempotency_key,wallet_journal_id,request)
    VALUES ('00000000-0000-0000-0000-0000000000f1','002c2d27-9584-4e52-835a-bb2be148fc81',NULL,v_c,'overlay',5,5,0,0,
            'mutation-overlay',NULL,'{}'::jsonb);
    RAISE EXCEPTION 'MUTATION ADMITTED: an overlay leg naming no player';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS: mutations refused: a wallet leg with no journal row (both directions), a non-drain house release, an inflow with no journal row, an overlay naming no player';
END $$;

DO $$
BEGIN
  IF public.fixture_journal_gaps() <> 0 OR public.fixture_identity() <> 0 THEN
    RAISE EXCEPTION 'the world is not whole at the end: % gaps, identity %', public.fixture_journal_gaps(), public.fixture_identity();
  END IF;
  RAISE NOTICE 'PASS: at the end every journal explains its wallet and the identity is 0';
END $$;
