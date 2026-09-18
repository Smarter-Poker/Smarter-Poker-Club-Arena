-- Synthetic historical opening only. The full real triggers govern every call.
UPDATE public.tournaments SET is_bounty=false,is_pko=false,is_mystery_bounty=false,
 starting_chips=2500,rebuy_chips=2500,rebuy_cost=1,bounty_amount=0,bounty_pool=0,
 buy_in_amount=0,buy_in_fee=0,current_level=100,late_reg_levels=0,late_reg_mins=0,
 current_players=2,prize_pool_finalized=true,entry_contract_locked=true,format_contract='mtt-v1'
 WHERE id='b7200000-0000-4000-8000-000000000001';
INSERT INTO auth.users(id)
 SELECT ('b7100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(9,106) n;
INSERT INTO public.users(id,username)
 SELECT ('b7100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'custody_fixture_'||n FROM generate_series(9,106) n;
INSERT INTO public.tournament_players(tournament_id,user_id,status,chips,rebuys,add_on,position,prize)
 SELECT 'b7200000-0000-4000-8000-000000000001',('b7100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'eliminated',0,CASE WHEN n<=33 THEN 1 ELSE 0 END,false,n-6,0 FROM generate_series(9,106) n;
UPDATE public.tournament_players SET rebuys=1,add_on=false,current_bounty=0,
 chips=CASE WHEN user_id='b7100000-0000-4000-8000-000000000001' THEN 2500 ELSE 320000 END,
 table_id=CASE WHEN user_id='b7100000-0000-4000-8000-000000000001' THEN NULL ELSE table_id END,
 seat_number=CASE WHEN user_id='b7100000-0000-4000-8000-000000000001' THEN NULL ELSE seat_number END
 WHERE tournament_id='b7200000-0000-4000-8000-000000000001' AND status='playing';
UPDATE public.table_seats SET left_at=now()-interval '20 seconds',status='left',active_game_scope=NULL,active_parent_key=NULL
 WHERE id='b7400000-0000-4000-8000-000000000001';
UPDATE public.table_seats SET stack=320000 WHERE id='b7400000-0000-4000-8000-000000000002';
UPDATE public.tables SET current_players=1 WHERE id='b7300000-0000-4000-8000-000000000001';
UPDATE public.tournament_knockout_candidates SET created_at=now()-interval '41 seconds'
 WHERE id='b7800000-0000-4000-8000-000000000001';
UPDATE public.hand_atomic_commits SET post_commit_completed_at=now()-interval '25 seconds',post_commit_result='{"ok":true}'
 WHERE hand_number=9720001;
INSERT INTO public.chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,status,
 tournament_id,club_id,created_at,chain_seq,row_hash,performed_by)
 VALUES('b7800000-0000-4000-8000-000000000001','player_wallet','b7100000-0000-4000-8000-000000000001',
 'prize_liability','b7200000-0000-4000-8000-000000000001',1,'rebuy','posted','b7200000-0000-4000-8000-000000000001',
 '20000000-0000-0000-0000-000000000001',now()-interval '10 seconds',3012760,repeat('a',64),'2d1cd6c3-5700-4af9-a271-d4863fdab20d');
INSERT INTO public.tournament_refund_entitlements(id,tournament_id,user_id,entitlement_kind,charge_category,
 refund_wallet_club_id,gross,refund_prize,refund_fee,refund_bounty,source_ledger_id,escrow_bucket,evidence_kind,created_at)
 VALUES('b7900000-0000-4000-8000-000000000001','b7200000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001',
 'wallet_charge','rebuy','20000000-0000-0000-0000-000000000001',1,.9,.1,0,'b7800000-0000-4000-8000-000000000001',
 'wallet_gross','cutover_wallet_charge',now()-interval '10 seconds');
INSERT INTO public.wallet_transactions(id,user_id,related_entity_id,type,category,wallet_type,amount,description,created_at)
 VALUES('b7a00000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001',
 'b7200000-0000-4000-8000-000000000001','debit','rebuy','PLAYER',1,'Tournament rebuy: Original paid custody',now()-interval '10 seconds');
INSERT INTO public.wallet_credit_idempotency(key,user_id,amount,created_at)
 VALUES('tourney:b7200000-0000-4000-8000-000000000001:rebuy:b7100000-0000-4000-8000-000000000001:#0',
 'b7100000-0000-4000-8000-000000000001',0,now()-interval '10 seconds');
INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,engine_version,lease_generation,protocol_version,acquired_at,heartbeat_at)
 VALUES('b7200000-0000-4000-8000-000000000001','native-original-custody','native',
 'b7b00000-0000-4000-8000-000000000001',2,now()-interval '1 minute',now());
SET LOCAL session_replication_role=origin;
COMMIT;
