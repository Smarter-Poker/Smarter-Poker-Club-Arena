# Each permutation runs against a fresh real financial catalog and opening.
setup {
 CREATE SCHEMA watermark_native;
 CREATE FUNCTION watermark_native.claim(n integer, expected_already boolean) RETURNS void LANGUAGE plpgsql AS $$
 DECLARE c public.tournament_knockout_candidates;r jsonb;o uuid; BEGIN
 SELECT * INTO STRICT c FROM public.tournament_knockout_candidates WHERE hand_number=9720000+n;
 r:=public.fn_claim_tournament_bounty_elimination(c.tournament_id,c.eliminated_user_id,6-n,0,c.table_id,c.hand_id,c.hand_number,c.seat_joined_at,NULL,NULL,0,false);
 IF r->>'ok' IS DISTINCT FROM 'true' OR coalesce((r->>'already')::boolean,false) IS DISTINCT FROM expected_already THEN RAISE EXCEPTION 'WATERMARK_RACE_CLAIM_FAILED: %',r; END IF;
 o:=(r->>'obligation_id')::uuid;r:=public.fn_collect_bounty_obligation(o);
 IF r->>'ok' IS DISTINCT FROM 'true' OR r->>'marker_verified' IS DISTINCT FROM 'true'
 OR coalesce((r->>'already')::boolean,false) IS DISTINCT FROM expected_already THEN RAISE EXCEPTION 'WATERMARK_RACE_PAYOUT_FAILED: %',r; END IF;
 RAISE NOTICE 'WATERMARK_RACE_CLAIM_PROVEN'; END $$;
 SET request.jwt.claim.role='service_role';
 SELECT set_config('request.jwt.claims',json_build_object('role','service_role')::text,false);
 SELECT watermark_native.claim(3,false);
}
session "a"
setup { SET application_name='watermark-claim-a'; SET request.jwt.claim.role='service_role'; SELECT set_config('request.jwt.claims',json_build_object('role','service_role')::text,false); SET statement_timeout='10s'; SET idle_in_transaction_session_timeout='15s'; }
step "a_begin" { BEGIN; }
step "a_claim" { SELECT watermark_native.claim(2,false); }
step "a_commit" { COMMIT; }
step "a_rollback" { ROLLBACK; }
session "b"
setup { SET application_name='watermark-claim-b'; SET request.jwt.claim.role='service_role'; SELECT set_config('request.jwt.claims',json_build_object('role','service_role')::text,false); SET statement_timeout='10s'; }
step "b_claim_commit" { SELECT watermark_native.claim(2,true); }
step "b_claim_rollback" { SELECT watermark_native.claim(2,false); }
session "observer"
step "observed_wait" {
 DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
 WHERE b.datname=current_database() AND a.datname=current_database() AND b.application_name='watermark-claim-b' AND a.application_name='watermark-claim-a' AND b.wait_event_type='Lock') THEN
 RAISE EXCEPTION 'WATERMARK_RACE_WAIT_NOT_PROVEN'; END IF; RAISE NOTICE 'WATERMARK_RACE_WAIT_PROVEN'; END $$;
}
step "final_state" {
 DO $$ BEGIN
 IF (SELECT count(*)=2 AND sum(bounty_amount-added_to_collector_bounty)=5 AND sum(added_to_collector_bounty)=5 FROM public.tournament_bounties WHERE tournament_id='b7200000-0000-4000-8000-000000000002') IS DISTINCT FROM true
 OR (SELECT bounty_out=5 AND bounty_balance=15 FROM public.tournament_escrow WHERE tournament_id='b7200000-0000-4000-8000-000000000002') IS DISTINCT FROM true
 OR (SELECT current_bounty=10 AND bounty_winnings=5 FROM public.tournament_players WHERE tournament_id='b7200000-0000-4000-8000-000000000002' AND user_id='b7100000-0000-4000-8000-000000000004') IS DISTINCT FROM true
 OR (SELECT chip_balance=5 FROM public.club_members WHERE club_id='20000000-0000-0000-0000-000000000001' AND user_id='b7100000-0000-4000-8000-000000000004') IS DISTINCT FROM true
 OR (SELECT last_settled_hand_number=9720003 FROM public.tournament_pko_settlement_watermarks WHERE tournament_id='b7200000-0000-4000-8000-000000000002') IS DISTINCT FROM true
 OR (SELECT count(*)=2 AND bool_and(state='settled') FROM public.tournament_bounty_obligations WHERE tournament_id='b7200000-0000-4000-8000-000000000002') IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'WATERMARK_RACE_EFFECTS_WRONG'; END IF; RAISE NOTICE 'WATERMARK_RACE_EFFECTS_PROVEN'; END $$;
}
permutation "a_begin" "a_claim" "b_claim_commit" "observed_wait" "a_commit" "final_state"
permutation "a_begin" "a_claim" "b_claim_rollback" "observed_wait" "a_rollback" "final_state"
