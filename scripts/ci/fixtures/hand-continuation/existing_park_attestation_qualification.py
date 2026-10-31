"""Compose existing stopped custody with read-only attestation for an OLD original."""
import json
ATTEST='supabase/migrations/20261029093051_attest_frozen_original_hand_continuation_custody.sql'
DATA='scripts/ci/fixtures/hand-continuation'

def qualify(e,root,hand,db):
 case=e.database(db)
 def snap(label):return(e.snapshot(case,label+'-data'),e.catalog_snapshot(case,label+'-catalog'),hand.private_snapshot(e,case,label+'-private'))
 manager="SELECT set_config('request.jwt.claim.role','service_role',true);SELECT set_config('app.smarter_data_actor','tournament-manager',true);SELECT set_config('app.smarter_tournament_id','86000000-0000-0000-0000-000000000001',true);SELECT set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000002',true);"
 process="SELECT set_config('request.jwt.claim.role','service_role',true);SELECT set_config('app.smarter_data_actor','service',true);"
 try:
  deps=json.loads((root/DATA/'structured-park-dependencies.json').read_text())
  for t in deps['tables']:
   e.sql(case,t['definition']+'ALTER TABLE '+t['signature']+' OWNER TO postgres;REVOKE ALL ON TABLE '+t['signature']+' FROM PUBLIC,anon,authenticated,service_role;'+('GRANT ALL ON TABLE '+t['signature']+' TO service_role;' if 'service_role=' in t['acl'] else ''),label='existing-park-real-shape')
  for f in deps['functions']:e.sql(case,hand.captured_function(f),label='existing-park-real-lock-trigger-owner')
  row=json.loads((root/DATA/'structured-park-preimage.json').read_text())[0]
  e.sql(case,hand.captured_function(row),label='existing-park-exact-installed-owner')
  for t in deps['triggers']:e.sql(case,t['definition']+';',label='existing-park-real-enabled-trigger')
  e.sql(case,file=root/ATTEST,label='existing-park-shared-attestation-owner')
  native=(root/'scripts/ci/probes/hand-continuation-native.sql').read_text();prefix=native[:native.index('DO $boundaries$')]
  prefix=prefix.replace("'engine','{}'::jsonb","'engine',jsonb_build_object('capturedAt',floor(extract(epoch FROM transaction_timestamp())*1000))")
  successor="UPDATE public.engine_tournament_leases SET lease_generation='86500000-0000-0000-0000-000000000002',heartbeat_at=clock_timestamp() WHERE tournament_id='86000000-0000-0000-0000-000000000001';"+manager+"SELECT public.fn_f06_claim_hand_continuation('86000000-0000-0000-0000-000000000001','86500000-0000-0000-0000-000000000002','86100000-0000-0000-0000-000000000001');"
  freeze="INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,enforce_freeze,ownership_token) VALUES(true,'counting_down',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '4 minutes',true,'86800000-0000-0000-0000-000000000001');"
  e.sql(case,'BEGIN;'+(e.output/'opening.sql').read_text()+prefix+'SELECT pg_temp.retain_continuation(0);'+successor+freeze+'COMMIT;',label='existing-park-actual-claim-old-original-before-freeze')
  _,digest,_=e.sql(case,'SELECT payload_sha256 FROM smarter_private.hand_continuations;',label='existing-park-fixture-digest');digest=digest.strip()
  attest="public.fn_f06_attest_frozen_hand_continuation('86000000-0000-0000-0000-000000000001','86500000-0000-0000-0000-000000000002','86100000-0000-0000-0000-000000000001',8600001,0,'"+digest+"')"
  banks="(SELECT jsonb_object_agg(user_id::text,jsonb_build_object('occupancyId',occupancy_id,'remainingSeconds',17,'usesRemaining',1,'initialSeconds',30,'baseSeconds',20,'dbConsumedSeconds',3)) FROM public.table_seats WHERE table_id='86100000-0000-0000-0000-000000000001' AND left_at IS NULL)"
  states="(SELECT jsonb_object_agg(user_id::text,jsonb_build_object('state','ABSENT','sinceMs',100,'graceDeadlineMs',200,'sitOutSinceMs',null)) FROM public.table_seats WHERE table_id='86100000-0000-0000-0000-000000000001' AND left_at IS NULL)"
  park="public.fn_park_stopped_time_bank_custody('86100000-0000-0000-0000-000000000001','86000000-0000-0000-0000-000000000001','86500000-0000-0000-0000-000000000002',8600001,clock_timestamp()::text,"+states+','+banks+",'atomic-hand-boundary-probe:stopped_custody',NULL,NULL)"
  # Evaluate fixture arguments as the owner, exactly as the compiled engine
  # supplies its captured stopped banks/FSM. Calls themselves use service_role.
  capture="CREATE TEMP TABLE original_custody_expected AS SELECT c.payload,c.payload_sha256,c.sequence,c.original_generation,c.writer_generation,"+banks+" banks,"+states+" states FROM smarter_private.hand_continuations c;GRANT SELECT ON original_custody_expected TO service_role;"
  service_park=park.replace(banks,'(SELECT banks FROM original_custody_expected)').replace(states,'(SELECT states FROM original_custody_expected)')
  check="""DO $$DECLARE p public.engine_presence_parked;x record;BEGIN
SELECT * INTO x FROM original_custody_expected;SELECT * INTO p FROM public.engine_presence_parked;
IF x.original_generation<>'86500000-0000-0000-0000-000000000001' OR x.writer_generation<>'86500000-0000-0000-0000-000000000002' OR p.engine_instance<>'atomic-hand-boundary-probe:stopped_custody' OR p.disconnect_states IS DISTINCT FROM x.states OR p.time_bank_snapshot->'players' IS DISTINCT FROM x.banks OR p.time_bank_snapshot->>'handNumber'<>'8600001' OR (p.time_bank_snapshot->>'parkedAt')::timestamptz IS DISTINCT FROM p.parked_at OR EXISTS(SELECT 1 FROM jsonb_each(x.banks) b WHERE NOT EXISTS(SELECT 1 FROM public.table_seats s WHERE s.user_id::text=b.key AND s.occupancy_id::text=b.value->>'occupancyId' AND s.left_at IS NULL)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(x.payload::jsonb->'seats') chair WHERE NOT EXISTS(SELECT 1 FROM public.table_seats s WHERE s.id::text=chair->>'seat_id' AND s.user_id::text=chair->>'user_id' AND s.joined_at=(chair->>'seat_joined_at')::timestamptz AND s.left_at IS NULL)) OR (SELECT payload FROM smarter_private.hand_continuations) IS DISTINCT FROM x.payload OR EXISTS(SELECT 1 FROM public.hand_atomic_commits) OR EXISTS(SELECT 1 FROM public.hand_history WHERE hand_number=8600001) OR (SELECT sum(stack) FROM public.table_seats WHERE table_id=p.table_id)<>20 THEN RAISE EXCEPTION 'EXISTING_PARK_CUSTODY_ORIGINAL_CHANGED';END IF;
END$$;"""
  before=snap('composition-before')
  sql='BEGIN;'+capture+manager+'SET LOCAL ROLE service_role;SELECT '+attest+';RESET ROLE;'+process+'SET LOCAL ROLE service_role;SELECT '+service_park+';RESET ROLE;'+check+manager+'SET LOCAL ROLE service_role;SELECT '+attest+';RESET ROLE;ROLLBACK;'
  _,out,_=e.sql(case,sql,label='existing-park-old-original-attest-park-attest-full-rollback')
  replies=[json.loads(line) for line in out.splitlines() if line.startswith('{')]
  if len(replies)!=3 or replies[0]!=replies[2] or replies[0].get('original_generation')!='86500000-0000-0000-0000-000000000001' or replies[1].get('ok') is not True or replies[1].get('unstarted_permit_released') is not None or before!=snap('composition-after'):raise RuntimeError('existing old-original composition failed:'+out)
  # A bank captured at the preceding hand does NOT silently bypass the old
  # foreign-generation original. Keep this refusal to expose a caller mismatch.
  before=snap('previous-boundary-before');_,out,_=e.sql(case,'BEGIN;'+capture+process+'SET LOCAL ROLE service_role;SELECT '+service_park.replace(',8600001,clock_timestamp()',',8600000,clock_timestamp()')+';RESET ROLE;ROLLBACK;',label='existing-park-preceding-boundary-refuses-old-original')
  answers=[json.loads(line) for line in out.splitlines() if line.startswith('{')]
  if len(answers)!=1 or answers[0].get('ok') is not False or answers[0].get('refused')!='hand_after_custody' or before!=snap('previous-boundary-after'):raise RuntimeError('preceding boundary was not refused:'+out)
  e.report['existing_park_attestation_composition']={'passed':True,'actual_old_generation_claimed_by_new_writer':True,'manager_attestation_before_after_equal':True,'actual_service_root_park':True,'actual_stopped_custody_instance_suffix':True,'same_hand_chairs_joined_occupancy_bank_fsm':True,'private_original_unchanged':True,'financial_zero':True,'preceding_hand_boundary_foreign_original_refused':True,'full_catalog_data_private_rollback':True,'new_wrapper_or_tag':False,'limit':'SQL owner composition only; actual compiled handCount/custody selection and presence restoration are verified separately by runtime owner.'}
 finally:e.discard(case)
