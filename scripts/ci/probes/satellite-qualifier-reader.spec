# Actual completed-state and authenticated own-result readers. The fixture
# contains one already-settled v3 cohort; neither reader may change its money.
session "manager"
setup {
 SET application_name='satellite-qualifier-manager-reader';
 SET statement_timeout='25s';
 SELECT set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,false);
 SET ROLE service_role;
}
step "manager_begin" { BEGIN; }
step "manager_read" {
 DO $proof$ DECLARE r jsonb; BEGIN
  r:=public.fn_get_satellite_qualifier_state(md5('l04:race:source')::uuid);
  IF r->>'state' IS DISTINCT FROM 'completed' OR r->'receipt'->>'fully_settled' IS DISTINCT FROM 'true'
     OR r->'receipt'->>'receipt_version' IS DISTINCT FROM '3' THEN
   RAISE EXCEPTION 'SATELLITE_MANAGER_RECEIPT_INVALID';
  END IF;
  RAISE NOTICE 'SATELLITE_MANAGER_RECEIPT_PROVEN';
 END $proof$;
}
step "reader_wait_proven" {
 RESET ROLE;
 DO $proof$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.application_name='satellite-qualifier-browser-reader'
    AND a.wait_event_type='Lock' AND a.wait_event='advisory'
    AND pg_backend_pid()=ANY(pg_blocking_pids(a.pid))) THEN
   RAISE EXCEPTION 'SATELLITE_READER_LANE_WAIT_NOT_PROVEN';
  END IF;
  RAISE NOTICE 'SATELLITE_READER_LANE_WAIT_PROVEN';
 END $proof$;
 SET ROLE service_role;
}
step "manager_commit" { COMMIT; }
step "manager_rollback" { ROLLBACK; }

session "browser"
setup {
 SET application_name='satellite-qualifier-browser-reader';
 SET statement_timeout='25s';
 SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated',
   'sub',md5('l04:race:user:1')::uuid,'session_id',md5('l04:race:session:1')::uuid)::text,false);
 SET ROLE authenticated;
}
step "own_result" {
 DO $proof$ DECLARE r jsonb; BEGIN
  r:=public.fn_get_my_satellite_qualifier_result(md5('l04:race:source')::uuid);
  IF r->>'ok' IS DISTINCT FROM 'true' OR r->>'receipt_version' IS DISTINCT FROM '3'
    OR r->>'tournament_id' IS DISTINCT FROM md5('l04:race:source')::uuid::text
    OR r->>'target_id' IS DISTINCT FROM md5('l04:race:target')::uuid::text
    OR r->>'user_id' IS DISTINCT FROM md5('l04:race:user:1')::uuid::text
    OR r->>'qualified' IS DISTINCT FROM 'true' OR r->'position' IS DISTINCT FROM 'null'::jsonb
    OR (r->>'amount')::numeric IS DISTINCT FROM 50 OR r->>'delivery_kind' IS DISTINCT FROM 'seat'
    OR r->>'registration_id' IS NULL OR r?'qualifier_ids' OR r?'awards' THEN
   RAISE EXCEPTION 'SATELLITE_OWN_RESULT_INVALID';
  END IF;
  RAISE NOTICE 'SATELLITE_OWN_RESULT_PROVEN';
 END $proof$;
}
step "reader_effects" {
 RESET ROLE;
 DO $proof$ DECLARE source_id uuid:=md5('l04:race:source')::uuid; BEGIN
  IF (SELECT count(*) FROM public.tournament_satellite_settlements WHERE tournament_id=source_id)<>1
    OR (SELECT count(*) FROM public.tournament_satellite_awards WHERE tournament_id=source_id)<>2
    OR (SELECT sum(amount) FROM public.tournament_satellite_awards WHERE tournament_id=source_id)<>100
    OR (SELECT sum(amount) FROM public.tournament_satellite_remainders WHERE tournament_id=source_id)<>5
    OR (SELECT count(*) FROM public.tournament_players WHERE source_satellite_id=source_id)<>2
    OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id=source_id AND prize_balance=0 AND prize_out=105 AND closed_at IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id=md5('l04:race:target')::uuid AND prize_balance=90 AND fee_balance=10) THEN
   RAISE EXCEPTION 'SATELLITE_READER_EFFECTS_CHANGED';
  END IF;
  RAISE NOTICE 'SATELLITE_READER_EFFECTS_PROVEN';
 END $proof$;
}

permutation "manager_begin" "manager_read" "own_result" "reader_wait_proven" "manager_commit" "reader_effects"
permutation "manager_begin" "manager_read" "own_result" "reader_wait_proven" "manager_rollback" "reader_effects"
