BEGIN;
CREATE TEMP TABLE no_hit_before AS SELECT jsonb_build_object(
 'ledger',(SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.poker_diamond_jackpot_ledger x),
 'hits',(SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.poker_diamond_jackpot_hits x)) snapshot;
UPDATE public.tables SET tournament_id='51000000-0000-0000-0000-000000000001'
 WHERE id='30000000-0000-0000-0000-000000000002';
INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result)
 VALUES('30000000-0000-0000-0000-000000000002',1199001,'61000000-0000-0000-0000-000000000001','fixture-no-hit','{}');
UPDATE public.hand_atomic_commits SET post_commit_payload=jsonb_build_object('accepted_hand_facts',
 jsonb_build_object('diamond_jackpot',jsonb_build_object('version',1,'kind','none')))
 WHERE hand_number=1199001;
SELECT fixture_assert((SELECT post_commit_payload#>>'{accepted_hand_facts,diamond_jackpot,kind}'='none'
 FROM public.hand_atomic_commits WHERE hand_number=1199001),'PASS AFTER: actual trigger preserves tournament no-hit update');
UPDATE public.hand_atomic_commits SET post_commit_payload=post_commit_payload WHERE hand_number=1199001;
DO $$ DECLARE kind text; refused boolean; BEGIN
 FOREACH kind IN ARRAY ARRAY['main','mini','invalid'] LOOP
 INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result)
 VALUES('30000000-0000-0000-0000-000000000002',1199002,gen_random_uuid(),'fixture-positive-refusal','{}');
 refused:=false;
 BEGIN UPDATE public.hand_atomic_commits SET post_commit_payload=jsonb_build_object('accepted_hand_facts',
 jsonb_build_object('diamond_jackpot',jsonb_build_object('version',1,'kind',kind))) WHERE hand_number=1199002;
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>(CASE WHEN kind='invalid' THEN 'diamond_jackpot_invalid_accepted_verdict' ELSE 'diamond_jackpot_wrong_hand_scope' END) THEN RAISE; END IF; refused:=true; END;
 PERFORM fixture_assert(refused,'out-of-cash positive/invalid verdict remains refused: '||kind);
 DELETE FROM public.hand_atomic_commits WHERE hand_number=1199002;
 END LOOP;
END $$;
DO $$ DECLARE refused boolean:=false; BEGIN
 INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result)
 VALUES('30000000-0000-0000-0000-000000000002',1199002,gen_random_uuid(),'fixture-version-refusal','{}');
 BEGIN UPDATE public.hand_atomic_commits SET post_commit_payload=jsonb_build_object('accepted_hand_facts',
 jsonb_build_object('diamond_jackpot',jsonb_build_object('version',0,'kind','none'))) WHERE hand_number=1199002;
 EXCEPTION WHEN SQLSTATE '22023' THEN refused:=true; END;
 PERFORM fixture_assert(refused,'invalid no-hit version remains refused');
 DELETE FROM public.hand_atomic_commits WHERE hand_number=1199002;
END $$;
SELECT fixture_assert((SELECT snapshot=jsonb_build_object(
 'ledger',(SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.poker_diamond_jackpot_ledger x),
 'hits',(SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.poker_diamond_jackpot_hits x)) FROM no_hit_before),'no-hit and replay create no jackpot payment or hit');
SELECT fixture_assert(NOT has_function_privilege('service_role','public.fn_poker_diamond_jackpot_accept_hand()','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.fn_poker_diamond_jackpot_accept_hand()','EXECUTE')
 AND NOT has_function_privilege('anon','public.fn_poker_diamond_jackpot_accept_hand()','EXECUTE'),'trigger authority remains postgres only');
ROLLBACK;
SELECT fixture_assert(NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE hand_number IN(1199001,1199002)),'scope qualification rolls back synthetic subjects');
