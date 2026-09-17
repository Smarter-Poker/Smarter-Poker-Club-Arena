-- Isolated PostgreSQL contract probe: empty Diamond Spins fixture, canonical claim, wheel and Mint bodies.
-- Test identities are local only. This file always rolls back. Production proof uses the separate
-- controlled host probe recorded in the Diamond Spins verification report.
\set ON_ERROR_STOP on
BEGIN;
-- Nonreserved local identities exercise the real player eligibility guards.
-- The all-zero prefix denotes certification equipment in production.
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000001';
DO $$
DECLARE p uuid:='d1000000-0000-4000-8000-000000000001'; host_owner uuid:='d1000000-0000-4000-8000-000000000002'; club uuid:='d1000000-0000-4000-8000-000000000003';
 d date:=(now() AT TIME ZONE 'America/Chicago')::date; st integer; u uuid; status jsonb; cl jsonb; c jsonb; r jsonb; t uuid; req uuid; paid numeric; owner_before numeric; player_before numeric; pool_before numeric; welcome_before jsonb; n integer; denied boolean;
BEGIN
 FOREACH st IN ARRAY ARRAY[9,10,11,19,20,29,30,31,40] LOOP
   u:=gen_random_uuid();
   INSERT INTO auth.users(id) VALUES(u);
   INSERT INTO profiles(id,diamonds) VALUES(u,0);
   INSERT INTO ca_daily_bonus_days(user_id,bonus_date,streak,cycle_day,tiles,first_claimed_at)
    VALUES(u,d-1,st-1,((st-2)%7)+1,'[]',now());
   PERFORM set_config('test.user',u::text,true);
   status:=fn_ca_daily_bonus_status();
   IF status->>'eligible' IS DISTINCT FROM 'true' OR (status->>'streak')::integer IS DISTINCT FROM st THEN RAISE EXCEPTION 'Wrong or missing milestone eligibility %: %',st,status; END IF;
   IF jsonb_typeof(status->'tiles') IS DISTINCT FROM 'array' OR jsonb_typeof(status->'tomorrow') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Missing milestone snapshot %: %',st,status; END IF;
   SELECT count(*) INTO n FROM jsonb_array_elements(status->'tiles') x WHERE x->>'kind'='free_spin';
   IF n IS DISTINCT FROM (CASE WHEN st%10=0 THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'Wrong milestone %: %',st,status; END IF;
   SELECT count(*) INTO n FROM jsonb_array_elements(status->'tomorrow') x WHERE x->>'kind'='free_spin';
   IF n IS DISTINCT FROM (CASE WHEN (st+1)%10=0 THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'Wrong preview %',st; END IF;
   IF st=30 AND (status->>'streak_day')::integer IS DISTINCT FROM 30 THEN RAISE EXCEPTION 'Day 30 chest removed'; END IF;
   IF st=30 AND jsonb_array_length(status->'tiles') IS DISTINCT FROM (SELECT count(*)+1 FROM ca_daily_bonus_calendar WHERE active AND streak_day=30) THEN RAISE EXCEPTION 'Day 30 chest changed'; END IF;
 END LOOP;
 PERFORM set_config('test.user',p::text,true);
 -- Opening a milestone is not a claim and does not create a usable ticket.
 INSERT INTO ca_daily_bonus_days(user_id,bonus_date,streak,cycle_day,tiles,first_claimed_at) VALUES(p,d-1,9,2,'[]',now());
 status:=fn_ca_daily_bonus_status();
 IF EXISTS(SELECT 1 FROM diamond_bonus_spin_tickets WHERE user_id=p) THEN RAISE EXCEPTION 'Read granted a ticket'; END IF;
 c:=fn_wheel_commit();
 r:=fn_wheel_daily_bonus_spin(club,(c->>'commit_id')::uuid,'unclaimed',gen_random_uuid());
 IF r->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Unclaimed spin paid'; END IF;
 req:=gen_random_uuid();cl:=fn_ca_daily_bonus_claim(7,req,NULL,d);
 IF cl->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Claim refused: %',cl; END IF;
 t:=(cl->'granted'->>'ticket_id')::uuid;
 IF t IS NULL THEN RAISE EXCEPTION 'Claim did not return a ticket'; END IF;
 r:=fn_ca_daily_bonus_claim(7,req,NULL,d);
 IF r->>'idempotent' IS DISTINCT FROM 'true' OR r->'granted' IS DISTINCT FROM cl->'granted' THEN RAISE EXCEPTION 'Claim replay changed'; END IF;
 r:=fn_ca_daily_bonus_claim(7,gen_random_uuid(),NULL,d);
 IF r->>'reason' IS DISTINCT FROM 'already_claimed' OR (SELECT count(*) FROM diamond_bonus_spin_tickets WHERE user_id=p) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Claim duplicated'; END IF;
 IF EXISTS(SELECT 1 FROM ca_mint_ledger) THEN RAISE EXCEPTION 'Claim minted spendable diamonds'; END IF;
 welcome_before:=fn_wheel_welcome_state(club);
 SELECT diamonds INTO STRICT owner_before FROM profiles WHERE id=host_owner;
 SELECT diamonds INTO STRICT player_before FROM profiles WHERE id=p;
 SELECT intake_diamonds INTO STRICT pool_before FROM wheel_pools WHERE host_id=club;
 IF owner_before IS NULL OR player_before IS NULL OR pool_before IS NULL THEN RAISE EXCEPTION 'Missing starting funding balances'; END IF;
 IF welcome_before->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Welcome state unavailable before daily spin'; END IF;
 c:=fn_wheel_commit();
 -- Another player's ticket cannot be spent; they cannot name the real player at claim.
 PERFORM set_config('test.user',u::text,true);
 r:=fn_wheel_daily_bonus_spin(club,(c->>'commit_id')::uuid,'ticket',t);
 IF r->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Foreign ticket paid'; END IF;
 denied:=false;
 BEGIN PERFORM fn_ca_daily_bonus_claim(7,gen_random_uuid(),p,d); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Claim for another player allowed'; END IF;
 PERFORM set_config('test.user',p::text,true);
 -- Mint funding cannot be committed without the matching wheel receipt.
 denied:=false;
 BEGIN
   UPDATE diamond_bonus_spin_tickets SET club_id=club,host_id=club,host_kind='club',owner_id=host_owner,
     commit_id=(c->>'commit_id')::uuid,client_seed='ticket',funded_at=now(),mint_op_id='ignored'
   WHERE id=t;
   SET CONSTRAINTS diamond_bonus_spin_settled IMMEDIATE;
 EXCEPTION WHEN OTHERS THEN
   IF SQLERRM IS DISTINCT FROM 'Mint Funding And Bonus Spin Redemption Must Commit Together' THEN RAISE; END IF;
   denied:=true;
 END;
 IF NOT denied OR EXISTS(SELECT 1 FROM ca_mint_ledger) THEN RAISE EXCEPTION 'Unsettled Mint committed'; END IF;
 -- A canonical Mint refusal must roll back its op claim and preserve the ticket.
 UPDATE ca_mint_policy SET per_operation_cap_diamonds=99 WHERE id=1;
 r:=fn_wheel_daily_bonus_spin(club,(c->>'commit_id')::uuid,'ticket',t);
 IF r->>'ok' IS DISTINCT FROM 'false' OR EXISTS(SELECT 1 FROM ca_mint_ledger) OR EXISTS(SELECT 1 FROM ca_op_claims WHERE op_id='daily-bonus-spin:'||t) OR EXISTS(SELECT 1 FROM diamond_bonus_spin_tickets WHERE id=t AND funded_at IS NOT NULL) THEN RAISE EXCEPTION 'Mint refusal moved money: %',r; END IF;
 UPDATE ca_mint_policy SET per_operation_cap_diamonds=1000000 WHERE id=1;
 r:=fn_wheel_daily_bonus_spin(club,(c->>'commit_id')::uuid,'ticket',t);
 IF r->>'ok' IS DISTINCT FROM 'true' OR r->>'spin_id' IS NULL OR r->>'daily_bonus' IS DISTINCT FROM 'true' OR r->>'welcome' IS DISTINCT FROM 'false' OR (r->>'player_cost_diamonds')::integer IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'Spin failed: %',r; END IF;
 IF (r->>'bonus_ticket_id')::uuid IS DISTINCT FROM t OR (r->>'club_id')::uuid IS DISTINCT FROM club
    OR (r->>'entry_value_diamonds')::integer IS DISTINCT FROM 100 OR r->>'entry_funded_by' IS DISTINCT FROM 'mint'
    OR jsonb_typeof(r->'outcome') IS DISTINCT FROM 'object'
    OR (r->'outcome'->>'kind' IN ('nothing','chips','diamonds')) IS NOT TRUE
    OR r->'outcome'->>'amount' IS NULL THEN RAISE EXCEPTION 'Missing or changed funded spin receipt: %',r; END IF;
 paid:=CASE WHEN r->'outcome'->>'kind'='diamonds' THEN (r->'outcome'->>'amount')::numeric ELSE 0 END;
 IF (SELECT diamonds FROM profiles WHERE id=host_owner) IS DISTINCT FROM owner_before+100-paid THEN RAISE EXCEPTION 'Owner intake wrong'; END IF;
 IF (SELECT diamonds FROM profiles WHERE id=p) IS DISTINCT FROM player_before+paid THEN RAISE EXCEPTION 'Player paid the entry'; END IF;
 IF (SELECT intake_diamonds FROM wheel_pools WHERE host_id=club) IS DISTINCT FROM pool_before+100 THEN RAISE EXCEPTION 'Pool lost Mint entry'; END IF;
 IF (SELECT count(*) FROM ca_mint_ledger WHERE op_id='daily-bonus-spin:'||t AND amount=100 AND asset='diamonds' AND holder_id=host_owner) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Mint entry wrong'; END IF;
 IF (SELECT fn_diamond_games_spent_today(club,p)) IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'Mint entry counted as player spend'; END IF;
 IF fn_wheel_welcome_state(club) IS DISTINCT FROM welcome_before THEN RAISE EXCEPTION 'Daily spin consumed or changed welcome'; END IF;
 cl:=fn_wheel_daily_bonus_spin(club,(c->>'commit_id')::uuid,'ticket',t);
 IF cl->>'replayed' IS DISTINCT FROM 'true' OR cl->>'spin_id' IS DISTINCT FROM r->>'spin_id' THEN RAISE EXCEPTION 'Spin replay wrong'; END IF;
 IF (SELECT count(*) FROM ca_mint_ledger) IS DISTINCT FROM 1 OR (SELECT count(*) FROM wheel_spins) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Replay doubled payout'; END IF;
 cl:=fn_wheel_daily_bonus_spin(club,(c->>'commit_id')::uuid,'changed',t);
 IF cl->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Changed request replayed'; END IF;
 cl:=fn_wheel_daily_bonus_spin(club,(fn_wheel_commit()->>'commit_id')::uuid,'new',t);
 IF cl->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Ticket spent twice'; END IF;
 cl:=fn_wheel_welcome_spin(club,(fn_wheel_commit()->>'commit_id')::uuid,'welcome');
 IF cl->>'ok' IS DISTINCT FROM 'true' OR cl->>'welcome' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Separate welcome did not pay: %',cl; END IF;
 IF (SELECT count(*) FROM ca_mint_ledger) IS DISTINCT FROM 1 OR (SELECT count(*) FROM wheel_spins WHERE is_welcome) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Welcome minted or consumed ticket'; END IF;
 cl:=fn_wheel_welcome_spin(club,(fn_wheel_commit()->>'commit_id')::uuid,'welcome-again');
 IF cl->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Welcome spent twice'; END IF;
 IF has_table_privilege('authenticated','diamond_bonus_spin_tickets','SELECT') OR has_table_privilege('authenticated','diamond_bonus_spin_tickets','INSERT') OR has_function_privilege('authenticated','fn_wheel_spin_core(uuid,uuid,text,boolean,uuid)','EXECUTE') OR has_function_privilege('anon','fn_wheel_daily_bonus_spin(uuid,uuid,text,uuid)','EXECUTE') THEN RAISE EXCEPTION 'Private doors exposed'; END IF;
 RAISE NOTICE 'PASS milestones 9/10/11/19/20/29/30/31/40, chest preserved, preview, claim required, duplicate claim, foreign user, canonical Mint refusal, entry=100, player cost=0, host funding, exact replay, welcome independent and once only, private permissions';
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
