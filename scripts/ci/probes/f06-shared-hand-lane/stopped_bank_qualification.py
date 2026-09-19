"""Actual stop-bank receipt survives committed reply loss and native successor release."""
import hashlib
import json
import runpy
from contextlib import contextmanager
import subprocess
import time

def qualify(root,out,cmd,command,run,probe,require,results):
 dump=command([__import__('pathlib').Path(cmd[0]).with_name('pg_dump'),'-h',cmd[cmd.index('-h')+1],'-p',cmd[cmd.index('-p')+1],'-U','postgres','-d',cmd[-1]])
 require(dump.returncode==0,dump.stderr)
 (out/'stopped-bank-native-predecessor.sql').write_text(dump.stdout)
 build=runpy.run_path(str(root/'scripts/ci/build-f06-stopped-bank-custody.py'))
 migration=root/build['MIGRATION'];require(migration.read_text()==build['render'](),'Stopped bank composition differs')
 run('stopped-bank-fixture',(root/'scripts/ci/probes/f06-shared-hand-lane/stopped-bank-fixture.sql').read_text())
 service="SET request.jwt.claims='{\"role\":\"service_role\"}';SET app.smarter_data_actor='service';"
 original=run('stopped-bank-original-data',"SELECT jsonb_build_object('seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s),'roster',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM tournament_players p));")
 probe('stopped-bank-red-before',service+'SELECT fixture_stopped_prepare();',error='F06_MIXED_BANK_ORIGINAL_EVIDENCE_MISSING')
 run('stopped-bank-install',migration.read_text())
 run('stopped-bank-original-input',"SELECT jsonb_build_object('input',(SELECT local_proof FROM fixture_stopped_bank_input),'seats',(SELECT jsonb_agg(to_jsonb(s)) FROM table_seats s WHERE table_id=md5('sb-table')::uuid),'history',(SELECT jsonb_agg(to_jsonb(h)) FROM hand_history h WHERE table_id=md5('sb-table')::uuid),'permits',(SELECT jsonb_agg(to_jsonb(p)) FROM smarter_private.f06_hand_permits p WHERE table_id=md5('sb-table')::uuid));")
 for label,sql,reason in [
 ('unknown-accounting',"UPDATE fixture_stopped_bank_input SET local_proof=jsonb_set(local_proof,'{engines,0,bank_custody,stopped_capture,accounting}','\"unknown\"');",'CAPTURE_UNPROVEN'),
 ('wrong-process',"UPDATE fixture_stopped_bank_input SET local_proof=jsonb_set(local_proof,'{stopped_bank_owner,instance_id}','\"another\"');",'OWNER_CHANGED'),
 ('legacy-source',"UPDATE engine_tournament_leases SET engine_version='8825af51' WHERE tournament_id=md5('sb-event')::uuid;UPDATE fixture_stopped_bank_input SET local_proof=jsonb_set(local_proof,'{stopped_bank_owner,version}','\"8825af51\"');",'ORIGINAL_CHANGED'),
 ('wrong-engine',"UPDATE fixture_stopped_bank_input SET local_proof=jsonb_set(local_proof,'{engines,0,bank_custody,stopped_capture,engine_id}',to_jsonb(gen_random_uuid()));",'CAPTURE_UNPROVEN'),
 ('wrong-generation',"UPDATE fixture_stopped_bank_input SET local_proof=jsonb_set(local_proof,'{engines,0,bank_custody,stopped_capture,generation}',to_jsonb(gen_random_uuid()));",'ORIGINAL_CHANGED'),
 ('wrong-hand',"UPDATE fixture_stopped_bank_input SET local_proof=jsonb_set(local_proof,'{engines,0,bank_custody,hand_number}','11');",'ORIGINAL_CHANGED'),
 ('wrong-occupancy',"UPDATE fixture_stopped_bank_input SET local_proof=jsonb_set(local_proof,'{engines,0,bank_custody,roster,0,1}',to_jsonb(gen_random_uuid()));",'ORIGINAL_CHANGED'),
 ('changed-snapshot',"UPDATE fixture_stopped_bank_input SET local_proof=jsonb_set(local_proof,ARRAY['engines','0','bank_custody','stopped_capture','snapshot','time_bank_snapshot','players',md5('sb-user')::uuid::text,'remainingSeconds'],'8');",'CAPTURE_UNPROVEN'),
 ('omitted-capture',"UPDATE fixture_stopped_bank_input SET local_proof=local_proof#-'{engines,0,bank_custody,stopped_capture}';",'ORIGINAL_EVIDENCE_MISSING'),
 ('unauthorized', 'SET ROLE authenticated;', '42501'),
 ]:probe('stopped-bank-refuses-'+label,service+sql+'SELECT fixture_stopped_prepare();',error=reason)
 # Native initialized banks before the first hand have their actual lifecycle,
 # not a fabricated historical permit. This exception never serves legacy8825.
 zero=(root/'scripts/ci/probes/f06-shared-hand-lane/stopped-bank-fixture.sql').read_text()
 zero='\n'.join(line for line in zero.splitlines() if not line.startswith('INSERT INTO hand_history') and not line.startswith('INSERT INTO smarter_private.f06_hand_permits'))
 zero=zero.replace('sb-','sb-zero-').replace('fixture_stopped_bank_input','fixture_zero_bank_input').replace('fixture_stopped_prepare','fixture_zero_prepare').replace("'hand_number',12","'hand_number',0").replace("'handNumber',12","'handNumber',0")
 probe('stopped-bank-before-first-hand',zero+service+'SELECT fixture_zero_prepare();')

 @contextmanager
 def held(sql):
  p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
  try:
   p.stdin.write('BEGIN;'+sql+'SELECT pg_advisory_lock(19032212);\n');p.stdin.flush()
   deadline=time.monotonic()+5
   while command(cmd,"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=19032212 AND granted);").stdout.strip()!='t':
    require(p.poll() is None and time.monotonic()<deadline,'Stopped bank native barrier missing');time.sleep(.01)
   yield
  finally:
   if p.poll() is None:p.stdin.write('ROLLBACK;\n');p.stdin.close();p.wait(timeout=6)
   require(p.returncode==0,p.stderr.read())
 lease_lock="SELECT 1 FROM engine_tournament_leases WHERE tournament_id=md5('sb-event')::uuid FOR UPDATE;"
 with held(lease_lock):
  probe('stopped-bank-owner-update-first',"SET LOCAL lock_timeout='100ms';"+service+'SELECT fixture_stopped_prepare();',error='55P03')
 with held(service+'SELECT fixture_stopped_prepare();'):
  probe('stopped-bank-capture-first',"SET LOCAL lock_timeout='100ms';UPDATE engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id=md5('sb-event')::uuid;",error='55P03')
 run('stopped-bank-observe',service+"UPDATE fixture_stopped_bank_input SET expected=fixture_stopped_prepare()->'canonical';")
 run('stopped-bank-observation-wrote-no-receipt',"SELECT count(*) FROM smarter_private.f06_manager_custody_transfers WHERE tournament_id=md5('sb-event')::uuid;",'0')
 probe('stopped-bank-canonical-race',service+"UPDATE table_seats SET stack=1499 WHERE id=md5('sb-seat')::uuid;SELECT fixture_stopped_prepare((SELECT expected FROM fixture_stopped_bank_input));",error='CANONICAL_CHANGED')
 run('stopped-bank-commit-lost-reply',service+"SELECT fixture_stopped_prepare((SELECT expected FROM fixture_stopped_bank_input));")
 probe('stopped-bank-committed-altered-local',service+"UPDATE fixture_stopped_bank_input SET local_proof=jsonb_set(local_proof,'{manager_id}',to_jsonb(gen_random_uuid()));SELECT fixture_stopped_prepare((SELECT expected FROM fixture_stopped_bank_input));",error='TRANSFER_CHANGED')
 run('stopped-bank-exact-reply-readback',service+"UPDATE fixture_stopped_bank_input SET receipt=fixture_stopped_prepare(expected)->'receipt';")
 run('stopped-bank-receipt-durable-before-native-row',"SELECT (SELECT count(*)=1 FROM smarter_private.f06_manager_custody_transfers WHERE tournament_id=md5('sb-event')::uuid) AND NOT EXISTS(SELECT 1 FROM engine_presence_parked WHERE table_id=md5('sb-table')::uuid);",'t')
 # Only the original owner releases; actual v2 authority admits the preselected UUID.
 lease=(root/'supabase/migrations/20260908042900_tournament_leases_have_fencing_generations.sql').read_text()
 import re
 release=re.search(r'CREATE OR REPLACE FUNCTION public.release_tournament_leases_v2\(.*?\$function\$;',lease,re.S)
 require(release is not None,'Native original release authority missing')
 run('stopped-bank-native-release-authority',release[0])
 run('stopped-bank-owner-release',service+"SELECT release_tournament_leases_v2('sb-process',jsonb_build_array(jsonb_build_object('tournament_id',md5('sb-event')::uuid,'lease_generation',md5('sb-old')::uuid))); ")
 run('stopped-bank-real-successor-claim',"SELECT granted FROM claim_tournament_lease_v2(md5('sb-event')::uuid,'sb-successor','aaaaa222',md5('sb-new')::uuid);",'t')
 event=__import__('uuid').UUID(hashlib.md5(b'sb-event').hexdigest());generation=__import__('uuid').UUID(hashlib.md5(b'sb-new').hexdigest())
 manager=service+f"SET app.smarter_data_actor='tournament-manager';SET app.smarter_tournament_id='{event}';SET app.smarter_tournament_lease_generation='{generation}';"
 args="md5('sb-event')::uuid,md5('sb-new')::uuid,md5('sb-transfer')::uuid,(SELECT receipt FROM fixture_stopped_bank_input)"
 run('stopped-bank-successor-admits',manager+'SELECT fn_f06_admit_mixed_manager_custody('+args+');')
 run('stopped-bank-completion-lost-reply',manager+'SELECT fn_f06_complete_mixed_manager_custody('+args+');')
 native=run('stopped-bank-native-restored-value',"SELECT time_bank_snapshot->'players' FROM engine_presence_parked WHERE table_id=md5('sb-table')::uuid;")
 banks=json.loads(native);bank=next(iter(banks.values()));require(bank['remainingSeconds']==7 and bank['usesRemaining']==1 and bank['unlimitedActivations'] is True and bank['dbConsumedSeconds']==33,'Actual stopped bank changed')
 run('stopped-bank-completion-exact-replay',manager+'SELECT fn_f06_complete_mixed_manager_custody('+args+');')
 run('stopped-bank-duplicate-no-change',"SELECT time_bank_snapshot->'players' FROM engine_presence_parked WHERE table_id=md5('sb-table')::uuid;",native)
 run('stopped-bank-original-data-unchanged',"SELECT jsonb_build_object('seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s),'roster',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM tournament_players p));",original)
 run('stopped-bank-completed-not-rediscovered',service+"SELECT fn_f06_find_mixed_manager_custody(md5('sb-event')::uuid)->'receipt';",'null')
 run('stopped-bank-successor-release',service+"SELECT release_tournament_leases_v2('sb-successor',jsonb_build_array(jsonb_build_object('tournament_id',md5('sb-event')::uuid,'lease_generation',md5('sb-new')::uuid))); ")
 run('stopped-bank-later-ordinary-claim',"SELECT granted FROM claim_tournament_lease_v2(md5('sb-event')::uuid,'sb-later','aaaaa333',md5('sb-later')::uuid);",'t')
 catalog=json.loads(run('stopped-bank-service-readonly-catalog','BEGIN READ ONLY;SET ROLE service_role;'+service+'SELECT fn_f06_mixed_custody_contract();COMMIT;'))
 require(len(catalog['functions'])==24 and all(x['body_md5'] for x in catalog['functions']),'Stopped bank catalogue incomplete')
 (out/'qualified-stopped-bank-contract.json').write_text(json.dumps(catalog,indent=2)+'\n')
 fixture=json.loads((root/'tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json').read_text())
 require(catalog==fixture,'Publisher fixture does not equal actual stopped-bank catalogue')
 import ast
 publisher=ast.parse((root/'server/scripts/engine-release-database-proof.py').read_text())
 pinned=next(ast.literal_eval(n.value) for n in publisher.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='MIXED_CUSTODY_CONTRACT' for t in n.targets))
 require(catalog==pinned,'Publisher control generation has stale bank-custody definitions')
 results['stoppedBanks']={'passed':True,'remainingSeconds':7,'usesRemaining':1,'unlimitedActivations':True,'committedLostReply':['prepare','completion'],'originalDataUnchanged':True,'nativeOwnerRelease':True,'laterOrdinaryRestart':True,'legacyReconstruction':False,'ownerLockOrders':2,'publisherCatalogEquality':True,'sourceSha256':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [migration,root/'scripts/ci/build-f06-stopped-bank-custody.py',root/'scripts/ci/probes/f06-shared-hand-lane/stopped-bank-fixture.sql',__import__('pathlib').Path(__file__),root/'scripts/ci/test-f06-shared-hand-lane.py',root/'scripts/ci/classify-ci-changes.mjs',root/'tests/unit/fixtureNativeCi.test.ts',root/'server/scripts/engine-release-database-proof.py',root/'tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json']}}
