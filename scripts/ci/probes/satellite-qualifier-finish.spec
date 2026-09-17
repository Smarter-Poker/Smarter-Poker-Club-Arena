# Real financial authority, two backends. The driver prepares one captured
# fixture database per permutation; no production connection is accepted.
session "payer"
setup {
  SET application_name='satellite-qualifier-payer';
  SET statement_timeout='25s';
  SELECT set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,false);
  SET ROLE service_role;
}
step "payer_begin" { BEGIN; }
step "payer_finish" {
 SELECT (public.fn_settle_satellite_qualifiers(md5('l04:race:source')::uuid,
  ARRAY(SELECT x FROM unnest(ARRAY[md5('l04:race:user:1')::uuid,md5('l04:race:user:2')::uuid]) x ORDER BY x))->>'receipt_version')='3' AS first_financial_receipt;
}
step "wait_proven" {
 RESET ROLE;
 DO $proof$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.application_name='satellite-qualifier-resolver'
    AND a.wait_event_type='Lock' AND a.wait_event='advisory'
    AND pg_backend_pid()=ANY(pg_blocking_pids(a.pid))) THEN
   RAISE EXCEPTION 'SATELLITE_FINISH_LANE_WAIT_NOT_PROVEN';
  END IF;
  RAISE NOTICE 'SATELLITE_FINISH_LANE_WAIT_PROVEN';
 END $proof$;
 SET ROLE service_role;
}
step "payer_commit" { COMMIT; }
step "payer_rollback" { ROLLBACK; }

session "resolver"
setup {
 SET application_name='satellite-qualifier-resolver';
 SET statement_timeout='25s';
 SELECT set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,false);
 SET ROLE service_role;
}
step "resolve_outcome" {
 DO $result$ DECLARE r jsonb; BEGIN
  r:=public.fn_resolve_satellite_qualifier_outcome(md5('l04:race:source')::uuid,
   ARRAY(SELECT x FROM unnest(ARRAY[md5('l04:race:user:1')::uuid,md5('l04:race:user:2')::uuid]) x ORDER BY x));
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'invalid outcome'; END IF;
  IF r->>'satellite_committed'='true' AND r->>'definitively_not_committed'='false' AND r->>'status'='COMPLETED' THEN
   RAISE NOTICE 'SATELLITE_RACE_OUTCOME_COMMITTED';
  ELSIF r->>'satellite_committed'='false' AND r->>'definitively_not_committed'='true' AND r->>'status'='RUNNING' THEN
   RAISE NOTICE 'SATELLITE_RACE_OUTCOME_ROLLED_BACK';
  ELSE RAISE EXCEPTION 'invalid serialized outcome: %',r; END IF;
 END $result$;
}
step "same_identity_finish" {
 SELECT (public.fn_settle_satellite_qualifiers(md5('l04:race:source')::uuid,
  ARRAY(SELECT x FROM unnest(ARRAY[md5('l04:race:user:1')::uuid,md5('l04:race:user:2')::uuid]) x ORDER BY x))->>'receipt_version')='3' AS exact_same_identity_receipt;
}
step "verify_effects" {
 RESET ROLE;
 DO $proof$ DECLARE source_id uuid:=md5('l04:race:source')::uuid; BEGIN
  IF (SELECT count(*) FROM public.tournament_satellite_settlements WHERE tournament_id=source_id)<>1
    OR (SELECT count(*) FROM public.tournament_satellite_awards WHERE tournament_id=source_id)<>2
    OR (SELECT sum(amount) FROM public.tournament_satellite_awards WHERE tournament_id=source_id)<>100
    OR (SELECT sum(amount) FROM public.tournament_satellite_remainders WHERE tournament_id=source_id)<>5
    OR (SELECT count(*) FROM public.tournament_players WHERE source_satellite_id=source_id)<>2
    OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id=source_id AND prize_balance=0 AND prize_out=105 AND closed_at IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id=md5('l04:race:target')::uuid AND prize_balance=90 AND fee_balance=10) THEN
   RAISE EXCEPTION 'SATELLITE_RACE_EXACT_EFFECTS_NOT_PROVEN';
  END IF;
  RAISE NOTICE 'SATELLITE_RACE_EXACT_EFFECTS_PROVEN';
 END $proof$;
}

permutation "payer_begin" "payer_finish" "resolve_outcome" "wait_proven" "payer_commit" "same_identity_finish" "verify_effects"
permutation "payer_begin" "payer_finish" "resolve_outcome" "wait_proven" "payer_rollback" "same_identity_finish" "verify_effects"
