-- A receipted chip is movement evidence (migration 20260926091645). Runs on
-- the installed mixed-custody foundation TWICE: once on the production
-- pre-image (every receipted state below must refuse exactly as production
-- refused it) and once after the migration (the same receipted states are
-- admitted, and every unreceipted variant still refuses). Every scene rolls
-- back to its own savepoint and the whole file rolls back.
--
-- The scene is the real parked source b7300000-...04: last sealed hand
-- 9720004 left ...07 busted at 0 (seat open, bust unrecorded), ...08 and
-- ...09 at 100. The tournament's add-on and rebuy grant its 100 starting
-- chips.
BEGIN;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
CREATE FUNCTION pg_temp.rx_phase() RETURNS text LANGUAGE sql AS $$
 SELECT CASE md5(prosrc) WHEN '97c4a1afeaa41512026d3dca6936364a' THEN 'before' WHEN 'b69098029169b71482e827e9a59ed55b' THEN 'after' END
 FROM pg_proc WHERE oid='smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure $$;
CREATE FUNCTION pg_temp.rx_check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'RECEIPT_EVIDENCE FAIL: % (%)',label,pg_temp.rx_phase(); END IF;
 RAISE NOTICE 'RECEIPT_EVIDENCE PASS: % (%)',label,pg_temp.rx_phase(); END $$;
-- Runs one command. 'ok' expects a result whose ok is true; anything else is
-- the refusal the message must carry, and a refusal must change nothing.
CREATE FUNCTION pg_temp.rx_expect(label text,command text,before text,after text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE want text:=CASE pg_temp.rx_phase() WHEN 'before' THEN before WHEN 'after' THEN after END; seen text; result jsonb; BEGIN
 IF want IS NULL THEN RAISE EXCEPTION 'RECEIPT_EVIDENCE FAIL: unknown installed image'; END IF;
 BEGIN EXECUTE command INTO result; seen:=CASE WHEN result->>'ok'='true' THEN 'ok' ELSE 'NOT_OK '||coalesce(result::text,'null') END;
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS seen=MESSAGE_TEXT; END;
 IF (want='ok' AND seen<>'ok') OR (want<>'ok' AND position(want IN seen)=0) THEN
 RAISE EXCEPTION 'RECEIPT_EVIDENCE FAIL: % (%), expected %, got %',label,pg_temp.rx_phase(),want,seen; END IF;
 PERFORM pg_temp.rx_check(true,label); END $$;
CREATE FUNCTION pg_temp.rx_admit(generation text,suffix text) RETURNS text LANGUAGE sql AS $$
 SELECT format('SELECT public.fn_f06_admit_parked_movement(o.tournament_id,%L,o.source_table_id,o.lifecycle,o.break_id,%L,%L,o.revision) FROM smarter_private.f06_operations o WHERE o.source_table_id=''b7300000-0000-4000-8000-000000000004''',
 generation,'b7600000-0000-4000-8000-0000000000'||suffix,'b7700000-0000-4000-8000-0000000000'||suffix) $$;
CREATE FUNCTION pg_temp.rx_bust() RETURNS void LANGUAGE sql AS $$
 SELECT public.fn_eliminate_tournament_player_atomic('b7200000-0000-4000-8000-000000000004','b7100000-0000-4000-8000-000000000007',2,0,0); SELECT NULL::void $$;
-- A funding receipt exactly as fn_ca_record_tournament_participant_funding
-- writes it: registration and tournament images read after the grant.
CREATE FUNCTION pg_temp.rx_receipt(u text,operation text,key text) RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.tournament_participant_funding_receipts(registration_id,tournament_id,user_id,operation,purchase_key,asset,amount,registration_snapshot,tournament_snapshot)
 SELECT p.id,p.tournament_id,p.user_id,operation,key,'diamonds',1,to_jsonb(p),to_jsonb(t)
 FROM public.tournament_players p JOIN public.tournaments t ON t.id=p.tournament_id
 WHERE p.tournament_id='b7200000-0000-4000-8000-000000000004' AND p.user_id=u::uuid $$;
CREATE FUNCTION pg_temp.rx_grant(u text,n integer) RETURNS void LANGUAGE sql AS $$
 UPDATE public.table_seats SET stack=stack+n WHERE table_id='b7300000-0000-4000-8000-000000000004' AND user_id=u::uuid AND left_at IS NULL;
 UPDATE public.tournament_players SET chips=chips+n WHERE tournament_id='b7200000-0000-4000-8000-000000000004' AND user_id=u::uuid $$;
-- The stored proof re-proved by the unchanged movement assert.
CREATE FUNCTION pg_temp.rx_reproves() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
 PERFORM smarter_private.f06_assert_movement(break_id) FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004';
 RETURN true; END $$;

SELECT pg_temp.rx_check(pg_temp.rx_phase() IS NOT NULL,'the installed prior is the production pre-image or the migration post-image');
SELECT set_config('app.smarter_data_actor','tournament-manager',true);
SELECT set_config('app.smarter_tournament_id','b7200000-0000-4000-8000-000000000004',true);
SELECT set_config('app.smarter_tournament_lease_generation','b7500000-0000-4000-8000-000000000004',true);
SELECT pg_temp.rx_check(granted,'original manager claims the lease') FROM public.claim_tournament_lease_v2('b7200000-0000-4000-8000-000000000004','receipt-evidence-original','qualified','b7500000-0000-4000-8000-000000000004',30);

-- 1. ADD-ON. ...08 takes the add-on after the last hand: +100 on seat and registration.
SAVEPOINT scene;
SELECT pg_temp.rx_bust();
SET LOCAL session_replication_role=replica;
SELECT pg_temp.rx_grant('b7100000-0000-4000-8000-000000000008',100);
UPDATE public.tournament_players SET add_on=true WHERE tournament_id='b7200000-0000-4000-8000-000000000004' AND user_id='b7100000-0000-4000-8000-000000000008';
SELECT pg_temp.rx_receipt('b7100000-0000-4000-8000-000000000008','addon','tourney:b7200000-0000-4000-8000-000000000004:addon:b7100000-0000-4000-8000-000000000008');
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('a receipted add-on after the last hand',pg_temp.rx_admit('b7500000-0000-4000-8000-000000000004','01'),'F06_MOVEMENT_SEAT_CHANGED','ok');
SELECT pg_temp.rx_check(pg_temp.rx_phase()='before' OR (SELECT (r->'seat'->>'stack')::numeric=200 AND a.proof#>>'{receipts,purchases,0,operation}'='addon'
 AND (a.proof#>>'{receipts,purchases,0,chips}')::numeric=100 AND jsonb_array_length(a.proof->'roster')=2
 FROM smarter_private.f06_movement_admissions a, jsonb_array_elements(a.proof->'roster') r
 WHERE a.admission_id='b7600000-0000-4000-8000-000000000001' AND r#>>'{seat,user_id}'='b7100000-0000-4000-8000-000000000008'),'the proof holds 100 proven + 100 receipted and names the receipt');
SELECT pg_temp.rx_check(pg_temp.rx_phase()='before' OR pg_temp.rx_reproves(),'the stored proof re-proves');
ROLLBACK TO SAVEPOINT scene;
-- Unreceipted, over-granted, or a receipt whose registration image disagrees.
SAVEPOINT scene;
SELECT pg_temp.rx_bust();
SET LOCAL session_replication_role=replica;
SELECT pg_temp.rx_grant('b7100000-0000-4000-8000-000000000008',100);
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('add-on chips with no receipt',pg_temp.rx_admit('b7500000-0000-4000-8000-000000000004','02'),'F06_MOVEMENT_SEAT_CHANGED','F06_MOVEMENT_SEAT_CHANGED');
SET LOCAL session_replication_role=replica;
SELECT pg_temp.rx_receipt('b7100000-0000-4000-8000-000000000008','addon','tourney:b7200000-0000-4000-8000-000000000004:addon:b7100000-0000-4000-8000-000000000008');
SELECT pg_temp.rx_grant('b7100000-0000-4000-8000-000000000008',1);
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('a seat one chip over proven + receipted',pg_temp.rx_admit('b7500000-0000-4000-8000-000000000004','03'),'F06_MOVEMENT_SEAT_CHANGED','F06_MOVEMENT_SEAT_CHANGED');
SET LOCAL session_replication_role=replica;
SELECT pg_temp.rx_grant('b7100000-0000-4000-8000-000000000008',-1);
UPDATE public.tournament_participant_funding_receipts SET registration_snapshot=jsonb_set(registration_snapshot,'{chips}','201') WHERE user_id='b7100000-0000-4000-8000-000000000008';
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('a receipt whose registration image is not the running stack',pg_temp.rx_admit('b7500000-0000-4000-8000-000000000004','04'),'F06_MOVEMENT_SEAT_CHANGED','F06_MOVEMENT_SEAT_CHANGED');
SET LOCAL session_replication_role=replica;
UPDATE public.tournament_participant_funding_receipts SET registration_snapshot=jsonb_set(registration_snapshot,'{chips}','200'),operation='entry' WHERE user_id='b7100000-0000-4000-8000-000000000008';
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('a funding receipt that grants no movable chips (entry)',pg_temp.rx_admit('b7500000-0000-4000-8000-000000000004','05'),'F06_MOVEMENT_SEAT_CHANGED','F06_MOVEMENT_SEAT_CHANGED');
ROLLBACK TO SAVEPOINT scene;
-- An add-on older than funding receipts: its one wallet key and its posted ledger leg.
SAVEPOINT scene;
SELECT pg_temp.rx_bust();
SET LOCAL session_replication_role=replica;
SELECT pg_temp.rx_grant('b7100000-0000-4000-8000-000000000008',100);
INSERT INTO public.wallet_credit_idempotency(key,user_id,amount,created_at)
VALUES('tourney:b7200000-0000-4000-8000-000000000004:addon:b7100000-0000-4000-8000-000000000008','b7100000-0000-4000-8000-000000000008',1,clock_timestamp());
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('a legacy wallet key with no ledger leg',pg_temp.rx_admit('b7500000-0000-4000-8000-000000000004','06'),'F06_MOVEMENT_SEAT_CHANGED','F06_MOVEMENT_SEAT_CHANGED');
SET LOCAL session_replication_role=replica;
INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,tournament_id,club_id,status,created_at)
SELECT 'b7100000-0000-4000-8000-000000000008','player_wallet','b7100000-0000-4000-8000-000000000008','prize_liability','b7200000-0000-4000-8000-000000000004',1,'addon','b7200000-0000-4000-8000-000000000004','20000000-0000-0000-0000-000000000001','posted',k.created_at
FROM public.wallet_credit_idempotency k WHERE k.key='tourney:b7200000-0000-4000-8000-000000000004:addon:b7100000-0000-4000-8000-000000000008';
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('a legacy add-on: wallet key and posted ledger leg of the same time',pg_temp.rx_admit('b7500000-0000-4000-8000-000000000004','07'),'F06_MOVEMENT_SEAT_CHANGED','ok');
ROLLBACK TO SAVEPOINT scene;

-- 2. BOUGHT BACK IN. ...07 busted in the last hand, rebought (0 + 100) and
-- was re-seated on the same seat after the purchase.
SAVEPOINT scene;
SET LOCAL session_replication_role=replica;
UPDATE public.tournament_players SET chips=100,rebuys=1 WHERE tournament_id='b7200000-0000-4000-8000-000000000004' AND user_id='b7100000-0000-4000-8000-000000000007';
SELECT pg_temp.rx_receipt('b7100000-0000-4000-8000-000000000007','rebuy','tourney:b7200000-0000-4000-8000-000000000004:rebuy:b7100000-0000-4000-8000-000000000007:tok:probe');
UPDATE public.table_seats SET stack=100,joined_at=clock_timestamp(),occupancy_id=gen_random_uuid() WHERE id='b7400000-0000-4000-8000-000000000007';
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('a rebuy on the re-occupied seat after a bust in the last hand',pg_temp.rx_admit('b7500000-0000-4000-8000-000000000004','08'),'F06_MOVEMENT_SEAT_CHANGED','ok');
ROLLBACK TO SAVEPOINT scene;
SAVEPOINT scene;
SET LOCAL session_replication_role=replica;
UPDATE public.tournament_players SET chips=100 WHERE tournament_id='b7200000-0000-4000-8000-000000000004' AND user_id='b7100000-0000-4000-8000-000000000007';
UPDATE public.table_seats SET stack=100,joined_at=clock_timestamp(),occupancy_id=gen_random_uuid() WHERE id='b7400000-0000-4000-8000-000000000007';
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('a re-occupied seat with no purchase',pg_temp.rx_admit('b7500000-0000-4000-8000-000000000004','09'),'F06_MOVEMENT_SEAT_CHANGED','F06_MOVEMENT_SEAT_CHANGED');
ROLLBACK TO SAVEPOINT scene;

-- 3. ARRIVAL. ...0a is moved from ...05 into seat 4 after the last hand.
SAVEPOINT scene;
SELECT pg_temp.rx_bust();
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES('b7100000-0000-4000-8000-00000000000a');
INSERT INTO public.users(id,username) VALUES('b7100000-0000-4000-8000-00000000000a','receipt_arrival');
INSERT INTO public.profiles(id,username,display_name) VALUES('b7100000-0000-4000-8000-00000000000a','receipt_arrival','Receipt Arrival');
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance,membership_lifecycle_status)
VALUES('20000000-0000-0000-0000-000000000001','b7100000-0000-4000-8000-00000000000a','player','active',0,'active');
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,joined_at,left_at,leave_pending,is_sitting_out,is_away,club_id,active_game_scope,active_parent_key,occupancy_id)
VALUES('b7400000-0000-4000-8000-0000000000b1','b7300000-0000-4000-8000-000000000005',4,'b7100000-0000-4000-8000-00000000000a',50,'left',clock_timestamp()-interval '1 hour',clock_timestamp(),false,false,false,
'20000000-0000-0000-0000-000000000001',NULL,NULL,gen_random_uuid()),
('b7400000-0000-4000-8000-0000000000b2','b7300000-0000-4000-8000-000000000004',4,'b7100000-0000-4000-8000-00000000000a',50,'active',clock_timestamp(),NULL,false,false,false,
'20000000-0000-0000-0000-000000000001','table:b7300000-0000-4000-8000-000000000004','tournament:b7200000-0000-4000-8000-000000000004',gen_random_uuid());
INSERT INTO public.tournament_players(id,tournament_id,user_id,club_id,status,chips,table_id,seat_number,prize,current_bounty)
VALUES('b7500000-0000-4000-8000-00000000000a','b7200000-0000-4000-8000-000000000004','b7100000-0000-4000-8000-00000000000a','20000000-0000-0000-0000-000000000001','playing',50,'b7300000-0000-4000-8000-000000000004',4,0,0);
INSERT INTO public.tournament_seat_move_receipts(request_id,tournament_id,user_id,source_table_id,destination_table_id,source_seat_id,destination_seat_id,source_seat_number,destination_seat_number,source_mode,stack,moved_at)
SELECT 'b7a00000-0000-4000-8000-0000000000b1','b7200000-0000-4000-8000-000000000004','b7100000-0000-4000-8000-00000000000a','b7300000-0000-4000-8000-000000000005','b7300000-0000-4000-8000-000000000004',
'b7400000-0000-4000-8000-0000000000b1','b7400000-0000-4000-8000-0000000000b2',4,4,'live_source',50,s.joined_at FROM public.table_seats s WHERE s.id='b7400000-0000-4000-8000-0000000000b2';
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('an arrival backed by its committed move receipt at the same stack',pg_temp.rx_admit('b7500000-0000-4000-8000-000000000004','0a'),'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED','ok');
SELECT pg_temp.rx_check(pg_temp.rx_phase()='before' OR (SELECT jsonb_array_length(a.proof->'roster')=3 AND a.proof#>>'{receipts,arrivals,0,request_id}'='b7a00000-0000-4000-8000-0000000000b1'
 FROM smarter_private.f06_movement_admissions a WHERE a.admission_id='b7600000-0000-4000-8000-00000000000a'),'the proof roster holds the arrival and names its receipt');
SELECT pg_temp.rx_check(pg_temp.rx_phase()='before' OR pg_temp.rx_reproves(),'the arrival proof re-proves');
ROLLBACK TO SAVEPOINT scene;
SAVEPOINT scene;
SELECT pg_temp.rx_bust();
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES('b7100000-0000-4000-8000-00000000000a');
INSERT INTO public.users(id,username) VALUES('b7100000-0000-4000-8000-00000000000a','receipt_arrival');
INSERT INTO public.profiles(id,username,display_name) VALUES('b7100000-0000-4000-8000-00000000000a','receipt_arrival','Receipt Arrival');
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,joined_at,left_at,leave_pending,is_sitting_out,is_away,club_id,active_game_scope,active_parent_key,occupancy_id)
VALUES('b7400000-0000-4000-8000-0000000000b1','b7300000-0000-4000-8000-000000000005',4,'b7100000-0000-4000-8000-00000000000a',50,'left',clock_timestamp()-interval '1 hour',clock_timestamp(),false,false,false,
'20000000-0000-0000-0000-000000000001',NULL,NULL,gen_random_uuid()),
('b7400000-0000-4000-8000-0000000000b2','b7300000-0000-4000-8000-000000000004',4,'b7100000-0000-4000-8000-00000000000a',50,'active',clock_timestamp(),NULL,false,false,false,
'20000000-0000-0000-0000-000000000001','table:b7300000-0000-4000-8000-000000000004','tournament:b7200000-0000-4000-8000-000000000004',gen_random_uuid());
INSERT INTO public.tournament_players(id,tournament_id,user_id,club_id,status,chips,table_id,seat_number,prize,current_bounty)
VALUES('b7500000-0000-4000-8000-00000000000a','b7200000-0000-4000-8000-000000000004','b7100000-0000-4000-8000-00000000000a','20000000-0000-0000-0000-000000000001','playing',50,'b7300000-0000-4000-8000-000000000004',4,0,0);
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('an arrival with no move receipt',pg_temp.rx_admit('b7500000-0000-4000-8000-000000000004','0b'),'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED','F06_MOVEMENT_WHOLE_ROSTER_REQUIRED');
SET LOCAL session_replication_role=replica;
INSERT INTO public.tournament_seat_move_receipts(request_id,tournament_id,user_id,source_table_id,destination_table_id,source_seat_id,destination_seat_id,source_seat_number,destination_seat_number,source_mode,stack,moved_at)
SELECT 'b7a00000-0000-4000-8000-0000000000b1','b7200000-0000-4000-8000-000000000004','b7100000-0000-4000-8000-00000000000a','b7300000-0000-4000-8000-000000000005','b7300000-0000-4000-8000-000000000004',
'b7400000-0000-4000-8000-0000000000b1','b7400000-0000-4000-8000-0000000000b2',4,4,'live_source',40,s.joined_at FROM public.table_seats s WHERE s.id='b7400000-0000-4000-8000-0000000000b2';
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('an arrival whose receipt stack is not the seat stack',pg_temp.rx_admit('b7500000-0000-4000-8000-000000000004','0c'),'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED','F06_MOVEMENT_SEAT_CHANGED');
SET LOCAL session_replication_role=replica;
UPDATE public.tournament_seat_move_receipts SET stack=50,moved_at=moved_at-interval '1 second' WHERE request_id='b7a00000-0000-4000-8000-0000000000b1';
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('a receipt for a different occupancy of the seat',pg_temp.rx_admit('b7500000-0000-4000-8000-000000000004','0d'),'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED','F06_MOVEMENT_WHOLE_ROSTER_REQUIRED');
ROLLBACK TO SAVEPOINT scene;

-- 4. A BEGUN BREAK THAT NEVER TOOK A PROOF. The original manager begins the
-- break and moves ...08; the engine restarts and the successor must admit.
SAVEPOINT scene;
SELECT pg_temp.rx_bust();
DO $$ DECLARE o smarter_private.f06_operations; manifest jsonb; BEGIN
 SELECT * INTO STRICT o FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004';
 SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'source_seat_id',s.id,'source_seat_number',s.seat_number,'occupancy_id',s.occupancy_id,
 'request_id',CASE WHEN s.user_id::text LIKE '%000008' THEN 'b7a00000-0000-4000-8000-0000000000c1' ELSE 'b7a00000-0000-4000-8000-0000000000c2' END,
 'destination_table_id',CASE WHEN s.user_id::text LIKE '%000008' THEN 'b7300000-0000-4000-8000-000000000005' ELSE 'b7300000-0000-4000-8000-000000000006' END,
 'destination_seat_number',1) ORDER BY s.user_id) INTO manifest FROM public.table_seats s WHERE s.table_id=o.source_table_id AND s.left_at IS NULL;
 PERFORM public.fn_f06_begin_break(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id,manifest);
 PERFORM public.fn_move_tournament_player(o.tournament_id,'b7100000-0000-4000-8000-000000000008',o.source_table_id,'b7300000-0000-4000-8000-000000000005',1,'b7a00000-0000-4000-8000-0000000000c1','live_source');
 PERFORM public.release_tournament_leases_v2('receipt-evidence-original',jsonb_build_array(jsonb_build_object('tournament_id','b7200000-0000-4000-8000-000000000004','lease_generation','b7500000-0000-4000-8000-000000000004')));
END $$;
SELECT pg_temp.rx_check((SELECT state='begun' AND revision=0 FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004')
 AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions),'the break is begun, one member moved, and no proof was ever taken');
SELECT set_config('app.smarter_tournament_lease_generation','b7500000-0000-4000-8000-0000000000c1',true);
SELECT pg_temp.rx_check(granted,'successor claims the lease') FROM public.claim_tournament_lease_v2('b7200000-0000-4000-8000-000000000004','receipt-evidence-successor','qualified','b7500000-0000-4000-8000-0000000000c1',30);
SAVEPOINT tamper;
SET LOCAL session_replication_role=replica;
UPDATE public.table_seats SET stack=stack+1 WHERE id='b7400000-0000-4000-8000-000000000009';
UPDATE public.tournament_players SET chips=chips+1 WHERE tournament_id='b7200000-0000-4000-8000-000000000004' AND user_id='b7100000-0000-4000-8000-000000000009';
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('a remaining member holding an unreceipted chip',pg_temp.rx_admit('b7500000-0000-4000-8000-0000000000c1','c1'),'F06_MOVEMENT_ORIGINAL_PROOF_MISSING','F06_MOVEMENT_SEAT_CHANGED');
ROLLBACK TO SAVEPOINT tamper;
SET LOCAL session_replication_role=replica;
UPDATE public.tournament_seat_move_receipts SET stack=99 WHERE request_id='b7a00000-0000-4000-8000-0000000000c1';
UPDATE smarter_private.f06_attempts SET receipt=jsonb_set(receipt,'{stack}','99') WHERE request_id='b7a00000-0000-4000-8000-0000000000c1';
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('a moved member whose receipt is not its proven stack',pg_temp.rx_admit('b7500000-0000-4000-8000-0000000000c1','c2'),'F06_MOVEMENT_ORIGINAL_PROOF_MISSING','F06_MOVEMENT_ORIGINAL_PROOF_MISSING');
ROLLBACK TO SAVEPOINT tamper;
SELECT pg_temp.rx_expect('a begun break proven from its winner receipt and live seat',pg_temp.rx_admit('b7500000-0000-4000-8000-0000000000c1','c3'),'F06_MOVEMENT_ORIGINAL_PROOF_MISSING','ok');
DO $$ DECLARE o smarter_private.f06_operations; before_total numeric; after_total numeric; BEGIN
 IF pg_temp.rx_phase()='before' THEN RETURN; END IF;
 SELECT * INTO STRICT o FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004';
 PERFORM pg_temp.rx_check((SELECT a.proof#>>'{receipts,moved,0,request_id}'='b7a00000-0000-4000-8000-0000000000c1' AND jsonb_array_length(a.proof->'roster')=2
   FROM smarter_private.f06_movement_admissions a WHERE a.admission_id='b7600000-0000-4000-8000-0000000000c3'),'the proof names the winner receipt and the whole roster');
 SELECT sum(stack) INTO before_total FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id=o.tournament_id AND s.left_at IS NULL;
 PERFORM public.fn_move_tournament_player(o.tournament_id,'b7100000-0000-4000-8000-000000000009',o.source_table_id,'b7300000-0000-4000-8000-000000000006',1,'b7a00000-0000-4000-8000-0000000000c2','live_source');
 SELECT sum(stack) INTO after_total FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id=o.tournament_id AND s.left_at IS NULL;
 PERFORM pg_temp.rx_check(NOT EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=o.source_table_id AND left_at IS NULL),'the successor moves the last member under the receipt proof');
 PERFORM pg_temp.rx_check(after_total=before_total AND after_total=200,'every chip is carried: 200 seated before and after');
 PERFORM pg_temp.rx_check((SELECT bool_and(s.stack=100 AND p.chips=100) FROM public.table_seats s JOIN public.tournament_players p ON p.tournament_id=o.tournament_id AND p.user_id=s.user_id
   WHERE s.left_at IS NULL AND s.user_id IN ('b7100000-0000-4000-8000-000000000008','b7100000-0000-4000-8000-000000000009')),'each member sits at a destination with its proven stack');
END $$;
ROLLBACK TO SAVEPOINT scene;

-- 5. AN UNRECORDED BUST ON A PARK WHOSE CUSTODY WAS CLAIMED.
SAVEPOINT scene;
SELECT pg_temp.rx_check((public.fn_f06_claim_custody(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id,'b7700000-0000-4000-8000-0000000000d1',0))->>'revision'='1','the park custody is claimed (revision 1), no proof taken')
 FROM smarter_private.f06_operations o WHERE o.source_table_id='b7300000-0000-4000-8000-000000000004';
SELECT pg_temp.rx_expect('the bust is recorded through the normal elimination door',
 $q$SELECT public.fn_eliminate_tournament_player_atomic('b7200000-0000-4000-8000-000000000004','b7100000-0000-4000-8000-000000000007',2,0,0)$q$,'F06_SOURCE_EXCLUDED','ok');
SELECT pg_temp.rx_check(pg_temp.rx_phase()='before' OR (SELECT p.status='eliminated' AND p.position=2 AND p.chips=0 AND p.eliminated_at=(SELECT committed_at FROM public.hand_atomic_commits WHERE hand_number=9720004)
 FROM public.tournament_players p WHERE p.tournament_id='b7200000-0000-4000-8000-000000000004' AND p.user_id='b7100000-0000-4000-8000-000000000007'),'eliminated at 0 chips, place 2, at the bust hand''s commit time');
SELECT pg_temp.rx_expect('the claimed park then takes its proof',pg_temp.rx_admit('b7500000-0000-4000-8000-000000000004','d1'),'F06_MOVEMENT_ELIMINATION_UNPROVEN','ok');
ROLLBACK TO SAVEPOINT scene;
SAVEPOINT scene;
SELECT pg_temp.rx_check((public.fn_f06_claim_custody(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id,'b7700000-0000-4000-8000-0000000000d2',0))->>'revision'='1','a second park custody is claimed')
 FROM smarter_private.f06_operations o WHERE o.source_table_id='b7300000-0000-4000-8000-000000000004';
SET LOCAL session_replication_role=replica;
INSERT INTO smarter_private.f06_movement_admissions(admission_id,tournament_id,lease_generation,table_id,lifecycle,break_id,custody_id,revision,requested_revision,proof,proof_hash)
SELECT 'b7600000-0000-4000-8000-0000000000d2',o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.source_table_id,o.lifecycle,o.break_id,'b7700000-0000-4000-8000-0000000000d2',1,0,'{}',repeat('0',64)
FROM smarter_private.f06_operations o WHERE o.source_table_id='b7300000-0000-4000-8000-000000000004';
SET LOCAL session_replication_role=origin;
SELECT pg_temp.rx_expect('a bust on a park that already holds a movement proof',
 $q$SELECT public.fn_eliminate_tournament_player_atomic('b7200000-0000-4000-8000-000000000004','b7100000-0000-4000-8000-000000000007',2,0,0)$q$,'F06_SOURCE_EXCLUDED','F06_SOURCE_EXCLUDED');
ROLLBACK TO SAVEPOINT scene;

DO $$ BEGIN RAISE NOTICE 'RECEIPT_EVIDENCE_COMPLETE %',pg_temp.rx_phase(); END $$;
ROLLBACK;
