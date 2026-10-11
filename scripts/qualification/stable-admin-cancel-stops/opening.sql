-- Synthetic committed opening liabilities; never a production fixture.
INSERT INTO profiles(id,role,username) VALUES
 ('10000000-0000-4000-8000-000000000001','operator','maker'),
 ('10000000-0000-4000-8000-000000000002','operator','checker'),
 ('10000000-0000-4000-8000-000000000003','player','payer');
INSERT INTO ca_operator_policy(id,enforce_named_roles,approvals_enabled,cashout_threshold) VALUES(true,true,false,0);
INSERT INTO ca_operator_roles(key,label,is_legacy) VALUES('qualification','Qualification',false);
INSERT INTO ca_operator_role_permissions(role_key,permission) SELECT 'qualification',unnest(ARRAY['console.read','clubs.read','clubs.write','money.read','money.write','cashier.write','settings.write','admin.manage']);
INSERT INTO ca_operator_grants(user_id,role_key,reason) SELECT id,'qualification','Synthetic qualification operator' FROM profiles WHERE role='operator';
INSERT INTO clubs(id,name,club_id,asset) VALUES('20000000-0000-4000-8000-000000000001','Qualification',990001,'chips');
INSERT INTO tournaments(id,name,status,club_id,buy_in_amount,buy_in_fee,prize_pool,bounty_pool,total_rake,current_players,start_time,max_players)
 VALUES('30000000-0000-4000-8000-000000000001','Chip Refund','REGISTERING','20000000-0000-4000-8000-000000000001',100,0,100,0,0,1,now()+interval '1 day',100);
INSERT INTO tournament_players(id,tournament_id,user_id,status,chips,rebuys,add_on)
 VALUES('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','registered',1000,0,false);
INSERT INTO club_members(club_id,user_id,role,status,chip_balance)
 VALUES('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','player','active',7);
INSERT INTO tournament_escrow(tournament_id,gross_in,fee_entries_in,prize_balance,bounty_balance,fee_balance,enforced)
 VALUES('30000000-0000-4000-8000-000000000001',100,0,100,0,0,true);
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,tournament_id,performed_by)
 VALUES('50000000-0000-4000-8000-000000000001','player_wallet','10000000-0000-4000-8000-000000000003','prize_liability','30000000-0000-4000-8000-000000000001',100,'tournament_buyin','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003');
INSERT INTO wallet_transactions(user_id,type,amount,category,wallet_type,related_entity_id)
 VALUES('10000000-0000-4000-8000-000000000003','debit',100,'tournament_buyin','PLAYER','30000000-0000-4000-8000-000000000001');
INSERT INTO tournament_refund_entitlements(tournament_id,user_id,entitlement_kind,charge_category,refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,source_ledger_id,registration_id,escrow_bucket,evidence_kind)
 VALUES('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','wallet_charge','tournament_buyin','20000000-0000-4000-8000-000000000001',100,100,0,0,'50000000-0000-4000-8000-000000000001',NULL,'wallet_gross','cutover_wallet_charge');
INSERT INTO ca_settle_sources(source) VALUES('atomic_cancel_tournament');
UPDATE profiles SET diamonds=7,diamond_balance=7 WHERE id='10000000-0000-4000-8000-000000000003';
INSERT INTO clubs(id,name,club_id,asset,is_platform,chip_pool,chip_treasury) VALUES('20000000-0000-4000-8000-000000000002','Diamond Qualification',990002,'diamonds',true,0,0);
INSERT INTO tournaments(id,name,status,club_id,buy_in_amount,buy_in_fee,prize_pool,bounty_pool,total_rake,current_players,start_time,max_players)
 VALUES('30000000-0000-4000-8000-000000000002','Diamond Refund','REGISTERING','20000000-0000-4000-8000-000000000002',100,0,100,0,0,1,now()+interval '1 day',100);
INSERT INTO tournament_players(id,tournament_id,user_id,status,chips,rebuys,add_on)
 VALUES('40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003','registered',1000,0,false);
INSERT INTO poker_diamond_custody(id,user_id,arena_id,purpose,target_id,entry_key,balance,state)
 VALUES('70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000002','tournament_entry','30000000-0000-4000-8000-000000000002','qualification-entry',100,'active');
INSERT INTO diamond_transactions(id,user_id,amount,type,transaction_type,reference_id,balance_after)
 VALUES('80000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003',-100,'arena_reserve','arena_reserve','qualification-reserve',7);
INSERT INTO poker_diamond_tournament_ledger(tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,registration_id,idempotency_key,wallet_journal_id)
 VALUES('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003','70000000-0000-4000-8000-000000000001','entry',100,100,'40000000-0000-4000-8000-000000000002','qualification-entry','80000000-0000-4000-8000-000000000001');

-- Synthetic second payer opening wallet for stopped-request qualification.
INSERT INTO club_members(club_id,user_id,role,status,is_active,agent_id,chip_balance) VALUES('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','player','active',true,'10000000-0000-4000-8000-000000000001',10);
