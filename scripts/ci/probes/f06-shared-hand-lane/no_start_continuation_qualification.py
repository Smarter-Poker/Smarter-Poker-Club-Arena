"""Exact terminal no-start single-table continuation in the maintained F06 runner."""
from contextlib import contextmanager
import hashlib
import json
import subprocess
import time


def qualify(root, out, cmd, command, run, probe, require, results):
    require(results.get('preparedCancellation', {}).get('passed') is True,'Current preparation authority required')
    here=root/'scripts/ci/probes/f06-shared-hand-lane'
    migration=root/'supabase/migrations/20260918094425_continue_positively_never_started_last_table_parks_without_m.sql'
    run('continuation-seed-shape',(here/'no-start-fixture.sql').read_text())
    run('continuation-seed','ALTER TABLE table_seats ADD COLUMN status text DEFAULT \'active\'; SELECT fixture_seed_no_start();')
    def auth(g='no-start-current'):
      return "SET request.jwt.claims='{\"role\":\"service_role\"}'; SET app.smarter_data_actor='tournament-manager'; DO $$BEGIN PERFORM set_config('app.smarter_tournament_id',md5('no-start')::uuid::text,false); PERFORM set_config('app.smarter_tournament_lease_generation',md5('%s')::uuid::text,false); END $$;" % g
    run('continuation-positive-original-disposition',"""
      UPDATE engine_tournament_leases SET lease_generation=md5('no-start-old')::uuid WHERE tournament_id=md5('no-start')::uuid;
      INSERT INTO smarter_private.f06_operations(break_id,tournament_id,source_table_id,lifecycle,boundary_id,origin_generation,custody_id,custody_generation,revision)
      SELECT md5('no-start-park')::uuid,tournament_id,id,f06_lifecycle,md5('no-start-boundary')::uuid,
        md5('no-start-old')::uuid,md5('no-start-park-custody')::uuid,md5('no-start-old')::uuid,1
        FROM tables WHERE id=md5('no-start-table')::uuid;
    """+auth('no-start-old')+"""
      SELECT fn_f06_finish_original_no_start(md5('no-start')::uuid,md5('no-start-old')::uuid,md5('no-start-table')::uuid,
        (SELECT f06_lifecycle FROM tables WHERE id=md5('no-start-table')::uuid),md5('no-start-permit')::uuid,12429075,
        md5('no-start-custody')::uuid,md5('no-start-park')::uuid,md5('no-start-park-custody')::uuid,1);
      UPDATE engine_tournament_leases SET lease_generation=md5('no-start-current')::uuid WHERE tournament_id=md5('no-start')::uuid;
    """)
    args="md5('no-start')::uuid,md5('no-start-current')::uuid,md5('no-start-table')::uuid,(SELECT f06_lifecycle FROM tables WHERE id=md5('no-start-table')::uuid),md5('no-start-park')::uuid,md5('no-start-park-custody')::uuid,1"
    call='SELECT fn_f06_continue_no_start_last_table('+args+');'
    quiet='DO $call$ BEGIN PERFORM fn_f06_continue_no_start_last_table('+args+'); END $call$;'
    admission="SELECT fn_f06_hand_number_state(md5('no-start')::uuid,md5('no-start-current')::uuid,md5('no-start-table')::uuid)->>'can_reserve';"
    witness="""SELECT jsonb_build_object('seats',(SELECT jsonb_agg(s ORDER BY id) FROM table_seats s),
      'roster',(SELECT jsonb_agg(p ORDER BY id) FROM tournament_players p),'leases',(SELECT jsonb_agg(l ORDER BY tournament_id) FROM engine_tournament_leases l),
      'permits',(SELECT jsonb_agg(h ORDER BY permit_id) FROM smarter_private.f06_hand_permits h),
      'atomic',(SELECT jsonb_agg(a ORDER BY table_id,hand_number) FROM hand_atomic_commits a),
      'ledger',(SELECT jsonb_agg(f ORDER BY id) FROM fixture_ledger f));"""
    before=run('continuation-unchanged-boundaries-before',witness)
    run('continuation-baseline-still-excluded',auth()+admission,'false')
    probe('continuation-baseline-authority-missing',auth()+call,error='42883')
    install_body=migration.read_text().replace('\nBEGIN;\n','\n',1).removesuffix('COMMIT;\n')
    probe('continuation-install-refuses-missing-raw-binding',
      'ALTER TABLE hand_private_state DISABLE TRIGGER a00_f06_cancelled_preparation;'+install_body,
      error='F06_CONTINUATION_RAW_WRITER_BINDING_CHANGED')
    run('continuation-install',migration.read_text())
    result=json.loads(probe('continuation-valid-successor',auth()+call))
    require(result['state']=='continued_never_started' and result['credit']==0,'Incorrect continuation outcome')
    probe('continuation-allows-fresh-admission',auth()+quiet+admission,'true')
    replay=probe('continuation-duplicate',auth()+call+call).splitlines()
    require(json.loads(replay[0])==json.loads(replay[1]),'Duplicate receipt changed')
    for label,mutation,error in [
      ('unscoped',"SET app.smarter_data_actor='service';",'42501'),
      ('expired',"UPDATE engine_tournament_leases SET heartbeat_at=now()-interval '1 hour' WHERE tournament_id=md5('no-start')::uuid;",'42501'),
      ('lease-replaced',"UPDATE engine_tournament_leases SET lease_generation=gen_random_uuid() WHERE tournament_id=md5('no-start')::uuid;",'42501'),
      ('terminal-event',"UPDATE tournaments SET status='COMPLETED' WHERE id=md5('no-start')::uuid;",'F06_CONTINUATION_LAST_TABLE_REQUIRED'),
      ('second-table',"INSERT INTO tables(id,tournament_id,status) VALUES(gen_random_uuid(),md5('no-start')::uuid,'running');",'F06_CONTINUATION_LAST_TABLE_REQUIRED'),
      ('manifest',"UPDATE smarter_private.f06_operations SET manifest='[]' WHERE break_id=md5('no-start-park')::uuid;",'F06_CONTINUATION_EXACT_PREMANIFEST_PARK'),
      ('changed-custody',"UPDATE smarter_private.f06_operations SET custody_id=gen_random_uuid() WHERE break_id=md5('no-start-park')::uuid;",'F06_CONTINUATION_EXACT_PREMANIFEST_PARK'),
      ('changed-stack',"UPDATE table_seats SET stack=stack+1 WHERE id=md5('no-start-seat1')::uuid;",'F06_CONTINUATION_ROSTER_CHANGED'),
      ('changed-mirror',"UPDATE table_seats SET stack=stack+1 WHERE id=md5('no-start-seat1')::uuid; UPDATE tournament_players SET chips=chips+1 WHERE id=md5('no-start-registration1')::uuid;",'F06_CONTINUATION_POSITIVE_SEAT_CHANGED'),
      ('changed-occupancy',"UPDATE table_seats SET occupancy_id=gen_random_uuid() WHERE id=md5('no-start-seat1')::uuid;",'SEAT_OCCUPANCY_IMMUTABLE'),
      ('changed-prior-seal',"UPDATE hand_atomic_commits SET post_commit_payload_hash=repeat('0',64) WHERE table_id=md5('no-start-table')::uuid;",'F06_MIXED_PRIOR_POSTCOMMIT_SEAL'),
      ('prior-unfinished',"UPDATE hand_atomic_commits SET post_commit_completed_at=NULL WHERE table_id=md5('no-start-table')::uuid;",'F06_MIXED_PRIOR_INCOMPLETE'),
      ('freeze',"INSERT INTO engine_maintenance_break VALUES(true,now()-interval '3 minutes','last_hand',NULL,NULL);",'PLATFORM_FROZEN'),
    ]: probe('continuation-refuses-'+label,auth()+mutation+call,error=error)
    for label,a in [('custody',args.replace("md5('no-start-park-custody')","md5('wrong')")),('revision',args[:-1]+'2')]:
      probe('continuation-refuses-'+label,auth()+'SELECT fn_f06_continue_no_start_last_table('+a+');',error='F06_CONTINUATION_EXACT_PREMANIFEST_PARK')
    # The original generation may finish its own positive terminal disposition.
    original_call=call.replace("md5('no-start-current')", "md5('no-start-old')")
    probe('continuation-valid-original',auth('no-start-old')+"UPDATE engine_tournament_leases SET lease_generation=md5('no-start-old')::uuid WHERE tournament_id=md5('no-start')::uuid;"+original_call)
    zero_roster=''
    probe('continuation-prior-three-current-two-canonical-zero-vacate',auth()+zero_roster+call)
    for label,mutation in [
      ('timestamp',"UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{tournament_zero_stack_vacated_at}',to_jsonb('2026-09-18 07:03:11.241595+00'::text)) WHERE table_id=md5('no-start-table')::uuid;"),
      ('written',"UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,ARRAY['written',md5('no-start-user3')::uuid::text],'1'::jsonb) WHERE table_id=md5('no-start-table')::uuid;"),
      ('receipt',"UPDATE hand_atomic_commits SET stack_result=stack_result-'tournament_zero_stack_seat_generations' WHERE table_id=md5('no-start-table')::uuid;"),
    ]:
      probe('continuation-zero-vacate-refuses-'+label,auth()+zero_roster+mutation+call,
        error='F06_CONTINUATION_ZERO_VACATE_CHANGED')
    probe('continuation-refuses-dispatch',auth()+"INSERT INTO smarter_private.f06_hand_dispatch VALUES(md5('no-start-permit')::uuid,txid_current());"+call,error='F06_CONTINUATION_STARTED_OR_ROSTER_CHANGED')
    member="INSERT INTO smarter_private.f06_members VALUES(md5('no-start-park')::uuid,md5('no-start-user1')::uuid,md5('no-start-seat1')::uuid,1,md5('no-start-occupancy1')::uuid);"
    probe('continuation-refuses-member',auth()+member+call,error='F06_CONTINUATION_EXACT_PREMANIFEST_PARK')
    probe('continuation-refuses-attempt',auth()+member+"INSERT INTO smarter_private.f06_attempts(request_id,break_id,user_id,revision,destination_table_id,destination_seat_number,generation) VALUES(gen_random_uuid(),md5('no-start-park')::uuid,md5('no-start-user1')::uuid,1,md5('unused-destination')::uuid,1,md5('no-start-current')::uuid);"+call,error='F06_CONTINUATION_EXACT_PREMANIFEST_PARK')
    for state in ['reserved','accepted']:
      probe('continuation-refuses-later-'+state,auth()+"INSERT INTO smarter_private.f06_hand_permits SELECT gen_random_uuid(),tournament_id,table_id,lifecycle,hand_number+1,gen_random_uuid(),generation,'"+state+"',NULL FROM smarter_private.f06_hand_permits WHERE permit_id=md5('no-start-permit')::uuid;"+call,error='F06_CONTINUATION_POSITIVE_ORIGINAL_REQUIRED')
    writers={
      'snapshot':"INSERT INTO hand_state_snapshots(table_id,hand_number) VALUES(md5('no-start-table')::uuid,12429075);",
      'private':"INSERT INTO hand_private_state VALUES(md5('no-start-table')::uuid,12429075);",
      'cards':"INSERT INTO table_hole_cards(table_id,hand_number,user_id,seat_number) VALUES(md5('no-start-table')::uuid,12429075,md5('no-start-user1')::uuid,1);",
      'atomic':"INSERT INTO hand_atomic_commits(table_id,hand_number) VALUES(md5('no-start-table')::uuid,12429075);",
      'history':"INSERT INTO hand_history(table_id,hand_number) VALUES(md5('no-start-table')::uuid,12429075);",
    }
    for label,sql in writers.items():
      if label not in ('atomic','history'):
        probe('continuation-started-'+label,auth()+sql+call,error='F06_CONTINUATION_STARTED_OR_ROSTER_CHANGED')
      probe('continuation-late-'+label,auth()+quiet+sql,error='F06_CANCELLED_PREPARATION_FENCED')
    probe('continuation-immutable-receipt',auth()+quiet+'DELETE FROM smarter_private.f06_no_start_continuations;',error='F06_CONTINUATION_IMMUTABLE')
    probe('continuation-receipt-cannot-truncate',auth()+quiet+'TRUNCATE smarter_private.f06_no_start_continuations;',error='F06_CONTINUATION_IMMUTABLE')
    probe('continuation-terminal-outcome-immutable',auth()+quiet+"UPDATE smarter_private.f06_hand_permits SET state='reserved' WHERE permit_id=md5('no-start-permit')::uuid;",error='F06_HAND_IDENTITY_IMMUTABLE')
    probe('continuation-withdrawal-immutable',auth()+quiet+"UPDATE smarter_private.f06_operations SET state='park_requested',abort_receipt_id=NULL WHERE break_id=md5('no-start-park')::uuid;",error='F06_WITHDRAWAL_IMMUTABLE')
    require(run('continuation-rollback-preserves-every-boundary',witness)==before,'Continuation changed chips, histories, lease or permit')
    @contextmanager
    def held(sql,finish='ROLLBACK'):
      p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
      p.stdin.write('BEGIN;'+sql+'SELECT pg_advisory_lock(180994426);\n');p.stdin.flush()
      deadline=time.monotonic()+5
      while command(cmd,"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=180994426 AND granted);").stdout.strip()!='t':
        require(p.poll() is None and time.monotonic()<deadline,'Continuation race barrier missing');time.sleep(.01)
      try:yield
      finally:
        p.stdin.write(finish+';\n');p.stdin.close();p.wait(timeout=5);require(p.returncode==0,p.stderr.read())
    with held(auth()+quiet):
      for label,sql in writers.items():probe('continuation-inflight-fences-'+label,sql,error='F06_RETRY_CANONICAL_LANE')
      probe('continuation-concurrent-duplicate-bounded',"SET LOCAL lock_timeout='150ms';"+auth()+call,error='55P03')
    with held(writers['private']):
      probe('continuation-writer-first-refuses',"SET LOCAL lock_timeout='150ms';"+auth()+call,error='55P03')
    run('continuation-durable-owner-transition',auth()+call)
    require(run('continuation-no-financial-or-permit-effect',witness)==before,'Durable transition changed protected state')
    run('continuation-durable-replay',auth()+call)
    run('continuation-durable-fresh-admission',auth()+admission,'true')
    for label,sql in writers.items():probe('continuation-committed-fences-'+label,sql,error='F06_CANCELLED_PREPARATION_FENCED')
    run('continuation-rpc-acl',"SELECT NOT has_function_privilege('anon','fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint)','EXECUTE') AND NOT has_function_privilege('authenticated','fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint)','EXECUTE');",'t')
    results['noStartContinuationPostimages']=json.loads(run('continuation-exact-function-postimages',"""
      SELECT jsonb_agg(jsonb_build_object('signature',oid::regprocedure::text,
        'full_md5',md5(pg_get_functiondef(oid)),'body_md5',md5(prosrc),
        'owner',pg_get_userbyid(proowner),'acl',proacl::text,'security_definer',prosecdef,'config',proconfig)
        ORDER BY oid::regprocedure::text) FROM pg_proc WHERE oid IN (
        'public.fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint)'::regprocedure,
        'smarter_private.f06_no_start_prior_committed_stacks(uuid,jsonb,jsonb)'::regprocedure,
        'smarter_private.f06_no_start_continuation_immutable()'::regprocedure,
        'smarter_private.f06_immutable_identity()'::regprocedure,
        'smarter_private.f06_cancelled_preparation_writer_guard()'::regprocedure);
    """))
    results['noStartContinuationInputs']={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [migration,here/'no_start_continuation_qualification.py',here/'no-start-fixture.sql']}
    results['noStartContinuation']={'passed':True,'scope':'Positive original terminal no-start, current-owner single-table continuation; zero money/lease/permit mutation'}
