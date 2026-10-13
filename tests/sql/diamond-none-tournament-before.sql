-- Actual installed trigger counterexample, isolated from financial authority.
BEGIN;
UPDATE public.tables SET tournament_id='51000000-0000-0000-0000-000000000001'
 WHERE id='30000000-0000-0000-0000-000000000002';
INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result)
 VALUES('30000000-0000-0000-0000-000000000002',1199001,'61000000-0000-0000-0000-000000000001','fixture-no-hit','{}');
DO $$ DECLARE refused boolean:=false; BEGIN
 BEGIN UPDATE public.hand_atomic_commits SET post_commit_payload=jsonb_build_object('accepted_hand_facts',
 jsonb_build_object('diamond_jackpot',jsonb_build_object('version',1,'kind','none')))
 WHERE hand_number=1199001;
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'diamond_jackpot_wrong_hand_scope' THEN RAISE; END IF; refused:=true; END;
 PERFORM fixture_assert(refused,'FAIL BEFORE: valid tournament no-hit verdict reaches cash scope refusal');
 PERFORM fixture_assert((SELECT post_commit_payload IS NULL FROM public.hand_atomic_commits WHERE hand_number=1199001),'failed trigger update rolls back');
END $$;
ROLLBACK;
