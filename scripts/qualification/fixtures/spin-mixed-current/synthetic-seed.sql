\set ON_ERROR_STOP on
-- Declared synthetic starting estate ONLY, before original trigger restoration.
-- This does not assert that a prior business operation or original hand happened.
-- Existing FKs/CHECKs stay enabled. No output payout, terminal or mixed seal is seeded.
BEGIN;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='1s';
SET LOCAL search_path=public,extensions,pg_temp;
SET LOCAL timezone='UTC';
CREATE TEMP TABLE synthetic_input AS SELECT :'synthetic_model_json'::jsonb model;
DO $guard$
BEGIN
 IF current_user<>'fixture_bootstrap' OR session_user<>'fixture_bootstrap'
    OR current_database()<>'qual_spin_expiry_'||replace(current_setting('spin_mixed_qualification.execution_uuid')::uuid::text,'-','')
    OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
    OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
    OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal)
    OR EXISTS(SELECT 1 FROM auth.users) OR EXISTS(SELECT 1 FROM public.profiles)
    OR EXISTS(SELECT 1 FROM public.clubs) OR EXISTS(SELECT 1 FROM public.tournaments)
    OR EXISTS(SELECT 1 FROM public.hand_history) OR EXISTS(SELECT 1 FROM public.chip_ledger)
    OR (SELECT model->>'kind' FROM synthetic_input) IS DISTINCT FROM 'synthetic-future-consumer-v1'
    OR (SELECT model->'historical_evidence' FROM synthetic_input) IS DISTINCT FROM 'false'::jsonb THEN
   RAISE EXCEPTION 'synthetic mixed seed requires private empty pre-trigger restore boundary' USING ERRCODE='55000';
 END IF;
END $guard$;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
SELECT (r->>'user_id')::uuid,'authenticated','authenticated',
 'synthetic-mixed-'||n||'@example.invalid','{}','{}'
FROM synthetic_input,jsonb_array_elements(model#>'{input_model,roster}') WITH ORDINALITY q(r,n);
INSERT INTO public.profiles(id,username,email,role,is_horse,diamonds,diamond_balance)
SELECT id,split_part(email,'@',1),email,'user',false,0,0 FROM auth.users;
INSERT INTO public.clubs(id,name,owner_id,chip_treasury,chip_pool,total_rake)
VALUES('70000000-0000-4000-8000-000000000001','Synthetic mixed model',
 '00000000-0000-4000-8000-000000000001',0,0,0);
INSERT INTO public.club_members(club_id,user_id,chip_balance,role,status)
SELECT '70000000-0000-4000-8000-000000000001',id,90,'player','active' FROM auth.users;
INSERT INTO public.tournaments(id,club_id,name,status,variant,tournament_type,buy_in_amount,buy_in_fee,
 start_time,started_at,starting_chips,max_players,table_size,is_rebuy,is_reentry,add_on_available,
 is_bounty,is_pko,is_mystery_bounty,bubble_protection,prize_pool,prize_pool_finalized,
 payout_structure,spin_multiplier,total_rake,guaranteed_prize,created_at)
VALUES('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001',
 'Synthetic mixed consumer', 'RUNNING','spin','SNG',10,0,'2026-09-01T00:00:00Z','2026-09-01T00:00:00Z',
 100,3,3,false,false,false,false,false,false,false,20,true,'[{"place":1,"percentage":100}]',2,0,0,'2026-09-01T00:00:00Z');
INSERT INTO public.tables(id,club_id,tournament_id,name,game_type,game_variant,status,lifecycle,current_players,max_players,seat_game_scope,seat_admission_key)
VALUES('20000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001',
 '10000000-0000-4000-8000-000000000001','Synthetic mixed table','tournament','nlh','running','live',1,3,
 'table:20000000-0000-4000-8000-000000000001','tournament:10000000-0000-4000-8000-000000000001');
INSERT INTO public.tournament_players(id,tournament_id,user_id,table_id,club_id,chips,status,position,
 elimination_sequence,rebuys,add_on,prize,registered_at,eliminated_at)
SELECT (r->>'id')::uuid,(r->>'tournament_id')::uuid,(r->>'user_id')::uuid,(r->>'table_id')::uuid,
 '70000000-0000-4000-8000-000000000001',(r->>'chips')::integer,r->>'status',(r->>'position')::integer,
 (r->>'elimination_sequence')::bigint,0,false,0,'2026-09-01T00:00:00Z',
 CASE WHEN n<3 THEN '2026-09-01T00:00:00Z'::timestamptz+n*interval '1 second' ELSE NULL END
FROM synthetic_input,jsonb_array_elements(model#>'{input_model,roster}') WITH ORDINALITY q(r,n);
INSERT INTO public.table_seats(id,table_id,user_id,club_id,seat_number,stack,status,joined_at,left_at,
 occupancy_id,active_game_scope,active_parent_key)
SELECT ('80000000-0000-4000-8000-00000000000'||n)::uuid,(r->>'table_id')::uuid,(r->>'user_id')::uuid,
 '70000000-0000-4000-8000-000000000001',n,(r->>'chips')::numeric,'active','2026-09-01T00:00:00Z',
 CASE WHEN n<3 THEN '2026-09-01T00:00:00Z'::timestamptz+n*interval '1 second' ELSE NULL END,
 ('81000000-0000-4000-8000-00000000000'||n)::uuid,
 CASE WHEN n=3 THEN 'table:20000000-0000-4000-8000-000000000001' ELSE NULL END,
 CASE WHEN n=3 THEN 'tournament:10000000-0000-4000-8000-000000000001' ELSE NULL END
FROM synthetic_input,jsonb_array_elements(model#>'{input_model,roster}') WITH ORDINALITY q(r,n);
INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,
 category,club_id,tournament_id,created_at,status)
SELECT ('90000000-0000-4000-8000-00000000000'||n)::uuid,(r->>'user_id')::uuid,'player_wallet',
 (r->>'user_id')::uuid,'prize_liability','10000000-0000-4000-8000-000000000001',10,'tournament_buyin',
 '70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','2026-09-01T00:00:00Z','posted'
FROM synthetic_input,jsonb_array_elements(model#>'{input_model,roster}') WITH ORDINALITY q(r,n);
INSERT INTO public.wallet_transactions(id,user_id,wallet_type,amount,type,category,related_entity_id,created_at,balance_after)
SELECT ('91000000-0000-4000-8000-00000000000'||n)::uuid,(r->>'user_id')::uuid,'PLAYER',10,'debit',
 'tournament_buyin','10000000-0000-4000-8000-000000000001','2026-09-01T00:00:00Z',90
FROM synthetic_input,jsonb_array_elements(model#>'{input_model,roster}') WITH ORDINALITY q(r,n);
INSERT INTO public.tournament_refund_entitlements(id,tournament_id,user_id,entitlement_kind,charge_category,
 refund_wallet_club_id,gross,refund_prize,refund_fee,refund_bounty,source_ledger_id,escrow_bucket,evidence_kind,created_at)
SELECT ('92000000-0000-4000-8000-00000000000'||n)::uuid,'10000000-0000-4000-8000-000000000001',
 (r->>'user_id')::uuid,'wallet_charge','tournament_buyin','70000000-0000-4000-8000-000000000001',
 10,10,0,0,('90000000-0000-4000-8000-00000000000'||n)::uuid,'wallet_gross','cutover_wallet_charge','2026-09-01T00:00:00Z'
FROM synthetic_input,jsonb_array_elements(model#>'{input_model,roster}') WITH ORDINALITY q(r,n);
INSERT INTO public.spin_bonus_pools(id,club_id,balance,total_deposited,total_drawn,spin_count,bonus_count,
 seeded_amount,ceiling_amount,highest_stake,is_active,owner_kind)
VALUES('a0000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001',10,30,20,1,0,0,500,10,true,'club');
INSERT INTO public.spin_reserve_ledger(id,club_id,tournament_id,kind,amount,balance_after,multiplier,buy_in,seats,house_rake,created_at)
VALUES('a1000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','contribution',30,30,NULL,10,3,0,'2026-09-01T00:00:00Z'),
 ('a1000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','jackpot_draw',-20,10,2,10,3,0,'2026-09-01T00:00:00Z');
INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,
 club_id,tournament_id,created_at,status,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
VALUES('90000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','prize_liability','10000000-0000-4000-8000-000000000001','spin_reserve','a0000000-0000-4000-8000-000000000001',30,'spin_entry','70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','2026-09-01T00:00:00Z','posted',30,0,0,30),
 ('90000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001','spin_reserve','a0000000-0000-4000-8000-000000000001','prize_liability','10000000-0000-4000-8000-000000000001',20,'spin_prize','70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','2026-09-01T00:00:00Z','posted',30,10,0,20);
INSERT INTO public.tournament_escrow(tournament_id,enforced,gross_in,reserve_out,reserve_in,prize_balance,
 opened_at,opened_from,updated_at)
VALUES('10000000-0000-4000-8000-000000000001',true,30,30,20,20,'2026-09-01T00:00:00Z','synthetic-consumer-model','2026-09-01T00:00:00Z');
INSERT INTO public.tournament_launch_receipts(tournament_id,launch_id,started_at,claimed_at,completed_at,lease_generation,supply_version)
VALUES('10000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z','b1000000-0000-4000-8000-000000000001',0);
-- Explicit synthetic blind schedule: the schema default Standard is a label, not JSON.
UPDATE public.tournaments SET blind_structure='[{"level":1,"small_blind":1,"big_blind":2,"ante":0,"duration_minutes":3}]'
 WHERE id='10000000-0000-4000-8000-000000000001';
INSERT INTO public.spin_draw_receipts(tournament_id,launch_id,lease_generation,rule_manifest,rule_sha256,entrants,receipt,created_at)
SELECT '10000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',
 rules,encode(extensions.digest(rules::text,'sha256'),'hex'),entrants,
 jsonb_build_object('ok',true,'rule_provenance','legacy_projection','tournament_id','10000000-0000-4000-8000-000000000001',
 'launch_id','b0000000-0000-4000-8000-000000000001','prize_pool',20,'starting_chips',100,'multiplier',2,
 'buy_in',10,'payout_structure','[{"place":1,"percentage":100}]'::jsonb,
 'blind_structure',(SELECT blind_structure::jsonb FROM public.tournaments WHERE id='10000000-0000-4000-8000-000000000001'),
 'rule_manifest',rules,'entrants',entrants),'2026-09-01T00:00:00Z'
FROM (SELECT '{"model":"synthetic-future-consumer-v1","multiplier":2}'::jsonb rules,
 jsonb_agg(jsonb_build_object('user_id',user_id,'registration_id',id) ORDER BY user_id) entrants FROM public.tournament_players) q;
INSERT INTO public.hand_history(id,table_id,tournament_id,hand_number,players,created_at,game_variant,rake_amount,bbj_amount,has_human,summary)
SELECT (r->>'id')::uuid,(r->>'table_id')::uuid,(r->>'tournament_id')::uuid,(r->>'hand_number')::integer,r->'players',
 '2026-09-01T00:00:00Z'::timestamptz+n*interval '1 second','nlh',0,0,true,'Declared synthetic consumer input'
FROM synthetic_input,jsonb_array_elements(model#>'{input_model,histories}') WITH ORDINALITY q(r,n);
INSERT INTO public.settlement_idempotency_keys(table_id,hand_id,status,result,error,attempt_count,first_attempt_at,last_attempt_at,completed_at)
SELECT (r->>'table_id')::uuid,(r->>'hand_id')::uuid,r->>'status',r->'result',NULL,1,
 (r->>'completed_at')::timestamptz,(r->>'completed_at')::timestamptz,(r->>'completed_at')::timestamptz
FROM synthetic_input,jsonb_array_elements(model#>'{input_model,receipts}') r;
INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result,committed_at,
 post_commit_payload,post_commit_request_hash,post_commit_payload_hash,post_commit_completed_at,post_commit_result)
SELECT (r->>'table_id')::uuid,(r->>'hand_number')::bigint,(r->>'hand_id')::uuid,
 encode(extensions.digest((r#>'{stack_result,request}')::text,'sha256'),'hex'),r->'stack_result',(r->>'committed_at')::timestamptz,
 r->'post_commit_payload',encode(extensions.digest((r->'post_commit_payload')::text,'sha256'),'hex'),
 encode(extensions.digest((r->'post_commit_payload')::text,'sha256'),'hex'),(r->>'post_commit_completed_at')::timestamptz,r->'post_commit_result'
FROM synthetic_input,jsonb_array_elements(model#>'{input_model,commits}') r;
INSERT INTO public.tournament_knockout_candidates(id,tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,
 hand_id,hand_number,stack_before,stack_after,state,created_at,resolved_at)
SELECT (r->>'id')::uuid,(r->>'tournament_id')::uuid,(r->>'eliminated_user_id')::uuid,(r->>'table_id')::uuid,
 (r->>'seat_id')::uuid,(r->>'seat_joined_at')::timestamptz,(r->>'hand_id')::uuid,(r->>'hand_number')::bigint,
 (r->>'stack_before')::numeric,0,'eliminated','2026-09-01T00:00:02Z','2026-09-01T00:00:04Z'
FROM synthetic_input,jsonb_array_elements(model#>'{input_model,knockouts}') r;
SET CONSTRAINTS ALL IMMEDIATE;
DO $independent_input_estate$
BEGIN
 IF (SELECT sum(chip_balance) FROM public.club_members)<>270
    OR (SELECT sum(balance) FROM public.spin_bonus_pools)<>10
    OR (SELECT sum(prize_balance+bounty_balance+fee_balance) FROM public.tournament_escrow)<>20
    OR (SELECT sum(chips) FROM public.tournament_players)<>300
    OR (SELECT count(*) FROM public.tournament_players)<>3
    OR (SELECT count(*) FROM public.chip_ledger)<>5
    OR EXISTS(SELECT 1 FROM public.tournament_payouts)
    OR EXISTS(SELECT 1 FROM public.tournament_obligations)
    OR EXISTS(SELECT 1 FROM public.tournament_terminal_settlements) THEN
   RAISE EXCEPTION 'declared synthetic starting estate differs';
 END IF;
END $independent_input_estate$;
DROP TABLE synthetic_input;
COMMIT;
