# Actual complete public elimination with another accepted hand's shared lane.
setup {
 CREATE SCHEMA elimination_lane_native;
 CREATE FUNCTION elimination_lane_native.claim(already boolean) RETURNS void LANGUAGE plpgsql AS $$
 DECLARE c public.tournament_knockout_candidates;r jsonb; BEGIN
 SELECT * INTO STRICT c FROM public.tournament_knockout_candidates WHERE hand_number=9720004;
 BEGIN
  r:=public.fn_eliminate_tournament_player_atomic(c.tournament_id,c.eliminated_user_id,2,0,0);
  IF BASELINE_BOOL THEN RAISE EXCEPTION 'baseline did not refuse its late lane promotion'; END IF;
 EXCEPTION WHEN serialization_failure THEN
  IF NOT BASELINE_BOOL OR SQLERRM<>'F06_RETRY_CANONICAL_LANE' THEN RAISE; END IF;
  RAISE NOTICE 'LANE_BASELINE_REFUSED'; RETURN;
 END;
 IF r->>'ok' IS DISTINCT FROM 'true' OR coalesce((r->>'already')::boolean,false) IS DISTINCT FROM already
 OR (NOT already AND r->>'claimed' IS DISTINCT FROM 'true') THEN RAISE EXCEPTION 'bad complete claim: %',r; END IF;
 IF already THEN RAISE NOTICE 'LANE_DUPLICATE_PROVEN'; ELSE RAISE NOTICE 'LANE_CLAIM_PROVEN'; END IF;
 END $$;
}
session "a"
setup { SET application_name='canonical-hand-owner'; SET request.jwt.claim.role='service_role'; SET statement_timeout='10s'; SET idle_in_transaction_session_timeout='15s'; }
step "a_begin" {
 BEGIN;
}
step "a_hand" {
 SELECT public.fn_ca_share_settlement_lane_for_table('b7300000-0000-4000-8000-000000000004');
}
step "a_row_available" {
 DO $$ BEGIN
 PERFORM 1 FROM public.tournaments WHERE id='b7200000-0000-4000-8000-000000000004' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'synthetic event missing'; END IF;
 RAISE NOTICE 'LANE_ROW_AVAILABLE'; END $$;
}
step "a_commit" {
 COMMIT;
}
step "a_rollback" {
 ROLLBACK;
}
session "b"
setup { SET application_name='ordinary-elimination-owner'; SET request.jwt.claim.role='service_role'; SET statement_timeout='10s'; }
step "b_claim" {
 SELECT elimination_lane_native.claim(false);
}
step "duplicate" {
 SELECT elimination_lane_native.claim(true);
}
session "observer"
step "observed_wait" {
 DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
 WHERE b.datname=current_database() AND a.datname=current_database() AND b.application_name='ordinary-elimination-owner'
 AND a.application_name='canonical-hand-owner' AND b.wait_event_type='Lock' AND b.wait_event='advisory') THEN
 RAISE EXCEPTION 'original claim did not wait at canonical lane'; END IF; RAISE NOTICE 'LANE_WAIT_PROVEN'; END $$;
}
step "baseline_state" {
 DO $$ BEGIN
 IF (SELECT count(*) FROM public.tournament_knockout_candidates WHERE hand_number=9720004 AND state='pending')<>1
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id='b7200000-0000-4000-8000-000000000004' AND status='playing' AND chips=0)<>1
 OR EXISTS(SELECT 1 FROM smarter_private.f06_elimination_dispatch) THEN RAISE EXCEPTION 'baseline refusal leaked effect'; END IF;
 RAISE NOTICE 'LANE_BASELINE_ROLLBACK_PROVEN'; END $$;
}
step "final_state" {
 DO $$ DECLARE c public.tournament_knockout_candidates; BEGIN
 SELECT * INTO STRICT c FROM public.tournament_knockout_candidates WHERE hand_number=9720004;
 IF c.state<>'eliminated'
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=c.tournament_id AND user_id=c.eliminated_user_id AND status='eliminated' AND chips=0 AND position=2 AND prize=0)<>1
 OR (SELECT count(*) FROM public.table_seats WHERE id=c.seat_id AND left_at IS NOT NULL AND stack=0)<>1
 OR EXISTS(SELECT 1 FROM public.tournament_bounty_obligations WHERE tournament_id=c.tournament_id)
 OR EXISTS(SELECT 1 FROM public.wallet_transactions WHERE related_entity_id=c.tournament_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_elimination_dispatch)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=c.table_id AND (state<>'park_requested' OR manifest IS NOT NULL OR custody_id IS NOT NULL OR revision<>0)) THEN
 RAISE EXCEPTION 'complete elimination effects differ'; END IF;
 RAISE NOTICE 'LANE_EFFECTS_PROVEN'; END $$;
}
