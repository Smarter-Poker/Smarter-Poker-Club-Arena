#!/usr/bin/env python3
"""Finite isolated native PostgreSQL qualification; never uses DATABASE_URL."""
import importlib.util,json,os,shutil,socket,subprocess,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('fleet_packet',Path(__file__).with_name('horse-fleet-packet.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class NativeFleetPacket(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  bindir=Path(os.environ.get('PG_BIN') or subprocess.check_output(['pg_config','--bindir'],text=True).strip())
  temp_root=None
  if __import__('sys').platform=='darwin':
   temp_root=Path(__file__).resolve().parents[2]/'work'
   if not str(temp_root).startswith('/Volumes/SmarterWork/agent-work/'):raise RuntimeError('SSD checkout required')
   temp_root.mkdir(exist_ok=True)
  cls.folder=tempfile.TemporaryDirectory(prefix='horse-fleet-pg-',dir=temp_root);cls.root=Path(cls.folder.name);cls.data=cls.root/'data'
  sock=socket.socket();sock.bind(('127.0.0.1',0));cls.port=sock.getsockname()[1];sock.close()
  cls.env=dict(os.environ);cls.env.pop('DATABASE_URL',None);cls.env.update(PGHOST='127.0.0.1',PGPORT=str(cls.port),PGDATABASE='postgres',PGUSER=__import__('getpass').getuser())
  subprocess.run([str(bindir/'initdb'),'-D',str(cls.data),'-A','trust','--no-locale'],check=True,capture_output=True)
  cls.ctl=str(bindir/'pg_ctl')
  cls.addClassCleanup(cls.cleanup_cluster)
  subprocess.run([cls.ctl,'-D',str(cls.data),'-l',str(cls.root/'postgres.log'),'-o',f"-h 127.0.0.1 -k '' -p {cls.port}",'-w','start'],check=True,capture_output=True)
  cls.sql("""CREATE SCHEMA smarter_private;
CREATE TABLE public.ca_horse_active_roster(horse_id uuid PRIMARY KEY);
CREATE TABLE public.ca_horse_fleet_register(horse_id uuid PRIMARY KEY, retired_at timestamptz);
CREATE TABLE public.hand_history(id uuid PRIMARY KEY,table_id uuid,hand_number bigint,created_at timestamptz);
CREATE INDEX idx_hand_history_created ON public.hand_history(created_at DESC);
CREATE TABLE public.hand_atomic_commits(hand_id uuid UNIQUE,table_id uuid,hand_number bigint,post_commit_completed_at timestamptz,post_commit_payload jsonb DEFAULT '{}'::jsonb,PRIMARY KEY(table_id,hand_number));
CREATE TABLE public.lightning_hand(hand_id uuid PRIMARY KEY,hand_history_id uuid,host_table_id uuid,hand_number bigint,settled_at timestamptz);
CREATE INDEX idx_lightning_hand_hand_history_id ON public.lightning_hand(hand_history_id);
CREATE TABLE smarter_private.hand_submissions(table_id uuid,hand_number bigint,lease_generation uuid,PRIMARY KEY(table_id,hand_number));
INSERT INTO public.ca_horse_active_roster SELECT ('10000000-0000-4000-8000-'||lpad(to_hex(i),12,'0'))::uuid FROM generate_series(1,1000)i;
INSERT INTO public.ca_horse_fleet_register SELECT horse_id,NULL FROM public.ca_horse_active_roster;
INSERT INTO public.hand_history VALUES('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',1000001,'2026-10-25T19:01:00Z');
INSERT INTO public.hand_atomic_commits(hand_id,table_id,hand_number,post_commit_completed_at) SELECT id,table_id,hand_number,'2026-10-25T19:01:01Z' FROM public.hand_history;
INSERT INTO smarter_private.hand_submissions SELECT table_id,hand_number,'40000000-0000-4000-8000-000000000001' FROM public.hand_history;""")
 @classmethod
 def cleanup_cluster(cls):
  if (cls.data/'postmaster.pid').exists():subprocess.run([cls.ctl,'-D',str(cls.data),'-m','immediate','-w','stop'],check=True,capture_output=True,timeout=15)
  cls.folder.cleanup()
 @classmethod
 def sql(cls,sql):
  return subprocess.run(['psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True,check=True,timeout=15,env=cls.env).stdout
 def rows(self):return json.loads(self.sql(module.query('2026-10-25T19:00:00.000Z','2026-10-25T19:15:00.000Z')))
 def convert(self,r):return module.packet_from_rows(r,'a'*40,'2026-10-25T19:00:00.000Z','2026-10-25T19:15:00.000Z')
 def test_main_private_roundtrip_uses_actual_readonly_database(self):
  packet_path=self.root/'private-packet.json';attestation_path=self.root/'private-attestation.json'
  env=dict(self.env);env.update(DATABASE_URL=f"postgresql://{self.env['PGUSER']}@127.0.0.1:{self.port}/postgres",FLEET_SOURCE_SHA='a'*40,FLEET_FROM_UTC='2026-10-25T19:00:00.000Z',FLEET_TO_UTC='2026-10-25T19:15:00.000Z')
  command=[__import__('sys').executable,'-B',str(Path(__file__).with_name('horse-fleet-packet.py')),str(packet_path),str(attestation_path)]
  result=subprocess.run(command,env=env,text=True,capture_output=True,timeout=15)
  self.assertEqual(result.returncode,0,result.stdout);self.assertTrue(json.loads(result.stdout)['canonicalRosterVerified'])
  self.assertNotIn('10000000-0000-4000-8000-',result.stdout);self.assertEqual(packet_path.stat().st_mode&0o777,0o600);self.assertEqual(attestation_path.stat().st_mode&0o777,0o600)
  self.assertEqual(subprocess.run(command,env=env,text=True,capture_output=True,timeout=15).returncode,3)
 def test_native_snapshot_and_original_lease(self):
  packet,receipt=self.convert(self.rows());self.assertEqual(len(packet['horseIds']),1000);self.assertEqual(len(packet['handKeys']),1);self.assertEqual(receipt['authority'],'canonical_database_snapshot');self.assertFalse(receipt['allPhasesVerified'])
 def test_missing_original_and_wrong_index_refuse(self):
  r=self.rows();r['hands'][0]['lease_generation']=None
  with self.assertRaises(ValueError):self.convert(r)
  self.sql('ALTER INDEX public.idx_hand_history_created RENAME TO wrong_index;')
  try:
   with self.assertRaises(ValueError):self.convert(self.rows())
  finally:self.sql('ALTER INDEX public.wrong_index RENAME TO idx_hand_history_created;')
 def test_roster_overflow_and_hand_cap_refuse(self):
  self.sql("INSERT INTO public.ca_horse_fleet_register VALUES('10000000-0000-4000-8000-000000001001',NULL);")
  try:
   with self.assertRaises(ValueError):self.convert(self.rows())
  finally:self.sql("DELETE FROM public.ca_horse_fleet_register WHERE horse_id='10000000-0000-4000-8000-000000001001';")
  self.sql("INSERT INTO public.hand_history SELECT md5(i::text)::uuid,'30000000-0000-4000-8000-000000000001',1000001+i,'2026-10-25T19:01:00Z' FROM generate_series(1,10001)i;")
  try:
   r=self.rows();self.assertEqual(len(r['hands']),10001)
   with self.assertRaises(ValueError):self.convert(r)
  finally:self.sql("DELETE FROM public.hand_history WHERE hand_number>1000001;")
 def test_separate_cohort_and_capture_witnesses_must_agree(self):
  packet,a=self.convert(self.rows());result={'packetDigest':a['packetDigest'],'sourceSha':a['sourceSha'],'qualifiedExecution':True,'execution':{'observation':{'observedHorses':999,'completeHorseCoverage':False}}}
  self.assertFalse(module.summarize(a,result)['completeCanonicalHorseCoverage'])
  result['execution']['observation']={'observedHorses':1000,'completeHorseCoverage':True}
  self.assertTrue(module.summarize(a,result)['completeCanonicalHorseCoverage'])
  result['packetDigest']='b'*64
  self.assertFalse(module.summarize(a,result)['canonicalRosterVerified'])
 def test_full_registry_is_independent_of_cash_selection_and_excludes_retired(self):
  self.sql("DELETE FROM public.ca_horse_active_roster WHERE horse_id > '10000000-0000-4000-8000-0000000001f4'; INSERT INTO public.ca_horse_fleet_register SELECT ('90000000-0000-4000-8000-'||lpad(to_hex(i),12,'0'))::uuid,'2026-10-25T00:00:00Z' FROM generate_series(1,62)i;")
  try:
   self.assertEqual(self.sql('SELECT count(*) FROM public.ca_horse_active_roster;').strip(),'500')
   packet,receipt=self.convert(self.rows())
   self.assertEqual(len(packet['horseIds']),1000)
   self.assertTrue(all(id.startswith('10000000-') for id in packet['horseIds']))
   self.assertEqual(receipt['rosterTable'],'public.ca_horse_fleet_register')
   self.assertEqual(receipt['rosterPredicate'],'retired_at IS NULL')
   self.assertFalse(receipt['cashEligibilityInferred'])
   self.assertFalse(receipt['allPhasesVerified'])
  finally:
   self.sql("DELETE FROM public.ca_horse_fleet_register WHERE retired_at IS NOT NULL; INSERT INTO public.ca_horse_active_roster SELECT horse_id FROM public.ca_horse_fleet_register ON CONFLICT DO NOTHING;")
 def test_mixed_lightning_uses_private_original_receipt_not_classic_submission(self):
  self.sql("""INSERT INTO public.hand_history VALUES('20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002',1000002,'2026-10-25T19:01:02Z');
INSERT INTO public.lightning_hand VALUES('50000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002',1000002,'2026-10-25T19:01:03Z');
INSERT INTO public.hand_atomic_commits VALUES('20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002',1000002,'2026-10-25T19:01:03Z','{"accepted_hand_facts":{"horse_journal_identity":{"version":1,"lease_generation":"40000000-0000-4000-8000-000000000002"}}}');
INSERT INTO smarter_private.hand_submissions VALUES('30000000-0000-4000-8000-000000000002',1000002,'90000000-0000-4000-8000-000000000002');""")
  try:
   # Actual isolated execution, not a source-string performance claim: select
   # just the Lightning row and compare archive scan loops against prior SQL.
   q=module.query('2026-10-25T19:00:00.000Z','2026-10-25T19:15:00.000Z')
   body=q[q.index('WITH cohort'):q.index('\\else')].replace("WHERE created_at>=", "WHERE id='20000000-0000-4000-8000-000000000002' AND created_at>=")
   prior=body.replace(" -- A Lightning receipt owns its original lease; do not probe the classic\n -- archive for those hands. OFFSET 0 retains the correlated one-time filter.\n LEFT JOIN LATERAL (\n   SELECT lease_generation FROM smarter_private.hand_submissions\n   WHERE l.hand_id IS NULL AND table_id=h.table_id AND hand_number=h.hand_number\n   OFFSET 0\n ) s ON true", " LEFT JOIN smarter_private.hand_submissions s ON s.table_id=h.table_id AND s.hand_number=h.hand_number")
   self.assertNotEqual(prior,body)
   def archive_loops(sql):
    plan=json.loads(self.sql('BEGIN READ ONLY; SET LOCAL enable_seqscan=off; EXPLAIN (ANALYZE,FORMAT JSON) '+sql+' ROLLBACK;'))[0]['Plan']
    def nodes(p):
     yield p
     for child in p.get('Plans',[]):yield from nodes(child)
    scans=[n for n in nodes(plan) if n.get('Relation Name')=='hand_submissions']
    self.assertTrue(scans)
    return sum(n['Actual Loops'] for n in scans)
   self.assertGreater(archive_loops(prior),0)
   self.assertEqual(archive_loops(body),0)
   rows=self.rows();lightning=next(h for h in rows['hands'] if h['source_owner']=='lightning');self.assertEqual(lightning['lease_generation'],'40000000-0000-4000-8000-000000000002')
   packet,receipt=self.convert(rows);self.assertEqual(len(packet['handKeys']),2);self.assertEqual(receipt['sourceOwnerCounts'],{'classic':1,'lightning':1})
   self.sql("UPDATE public.hand_atomic_commits SET post_commit_payload='{}' WHERE hand_number=1000002;")
   with self.assertRaises(module.PacketGap) as gap:self.convert(self.rows())
   self.assertEqual(str(gap.exception),'lightning_original_lease_unavailable');self.assertEqual(gap.exception.counts['lightningMissingOriginalCoordinates'],1)
  finally:self.sql('DELETE FROM smarter_private.hand_submissions WHERE hand_number=1000002;DELETE FROM public.hand_atomic_commits WHERE hand_number=1000002;DELETE FROM public.lightning_hand;DELETE FROM public.hand_history WHERE hand_number=1000002;')
 def test_actual_native_cancel_and_schema_classification_never_echo_stderr(self):
  for sql,expected in [("SET statement_timeout='1ms'; SELECT pg_sleep(0.05);",'database_statement_cancelled'),('SELECT nonexistent_private_column FROM public.hand_history;','database_schema_unavailable')]:
   result=subprocess.run(['psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],input=sql,text=True,capture_output=True,timeout=5,env=self.env)
   self.assertNotEqual(result.returncode,0);self.assertEqual(module.database_failure(result.stderr),expected)
 def test_native_classic_lookup_is_gated_before_index_scan(self):
  q=module.query('2026-10-25T19:00:00.000Z','2026-10-25T19:15:00.000Z')
  body=q[q.index('WITH cohort'):q.index('\\else')]
  plan=json.loads(self.sql('EXPLAIN (FORMAT JSON) '+body))[0]['Plan']
  def nodes(p):
   yield p
   for child in p.get('Plans',[]):yield from nodes(child)
  filters=[p.get('One-Time Filter','') for p in nodes(plan)]
  self.assertTrue(any('hand_id IS NULL' in x for x in filters),filters)
 def test_pending_original_remains_refused(self):
  self.sql('UPDATE public.hand_atomic_commits SET post_commit_completed_at=NULL WHERE hand_number=1000001;')
  try:
   with self.assertRaises(module.PacketGap) as gap:self.convert(self.rows())
   self.assertEqual(str(gap.exception),'original_acceptance_pending')
  finally:self.sql("UPDATE public.hand_atomic_commits SET post_commit_completed_at='2026-10-25T19:01:01Z' WHERE hand_number=1000001;")
 def test_reader_transaction_rejects_writes(self):
  with self.assertRaises(subprocess.CalledProcessError):self.sql('BEGIN READ ONLY;INSERT INTO public.ca_horse_active_roster VALUES(gen_random_uuid());ROLLBACK;')
class PacketContracts(unittest.TestCase):
 def rows(self):return {'snapshot':'1:2:','readAt':'2026-10-25T19:15:00Z','timeIndexValid':True,'horseIds':[f'10000000-0000-4000-8000-{i:012x}' for i in range(1000)],'hands':[{'id':'20000000-0000-4000-8000-000000000001','table_id':'30000000-0000-4000-8000-000000000001','hand_number':'1000001','lease_generation':'40000000-0000-4000-8000-000000000001','accepted':True,'source_owner':'classic'}]}
 def convert(self,rows):return module.packet_from_rows(rows,'a'*40,'2000-01-01T00:00:00.000Z','2000-01-01T00:15:00.000Z')
 def test_exact_packet_shape_and_bounds(self):
  packet,receipt=self.convert(self.rows());self.assertEqual(len(packet['horseIds']),1000);self.assertEqual(len(packet['handKeys']),1);self.assertFalse(receipt['allPhasesVerified'])
  for mutate in [lambda r:r['horseIds'].pop(),lambda r:r['hands'].extend(r['hands']*10001),lambda r:r['hands'][0].update(lease_generation=None),lambda r:r.update(timeIndexValid=False)]:
   r=self.rows();mutate(r)
   with self.assertRaises(ValueError):self.convert(r)
 def test_no_inference_of_roster_or_phase_authority(self):
  p,a=self.convert(self.rows());r={'packetDigest':'b'*64,'sourceSha':'a'*40,'qualifiedExecution':True,'execution':{'observation':{'observedHorses':1000,'completeHorseCoverage':True}}}
  summary=module.summarize(a,r);self.assertFalse(summary['canonicalRosterVerified']);self.assertFalse(summary['completeCanonicalHorseCoverage']);self.assertFalse(summary['allPhasesVerified'])
 def phase_observation(self):
  row={'capability':{'captured':1},'eligibility':{'eligible':1},'qualification':{'owner-forced':1},'application':{'accepted':1},'reasons':{'owner_forced_not_independently_qualified':1}}
  return {'acceptedDecisions':1,'phaseProofSchema':{'version':'horse-fleet-phase-proof-v1','counterUnit':'selected_accepted_decisions'},'phaseEvidence':{f'phase{i}':json.loads(json.dumps(row)) for i in range(1,16)},'horses':[{'horseId':'PRIVATE-ID','cards':['PRIVATE-CARD']}]}
 def test_phase_aggregate_distinguishes_forced_and_independent_without_private_payload(self):
  o=self.phase_observation();result=module.phase_summary(o)
  self.assertEqual(result['phases']['phase8']['authorityProvenance'],{'independentlyQualified':0,'ownerForced':1,'unknown':0})
  self.assertFalse(result['allPhasesVerified']);self.assertNotIn('PRIVATE',json.dumps(result));self.assertEqual(result['phases']['phase8']['reasons'],{'owner_forced_not_independently_qualified':1})
  row=o['phaseEvidence']['phase8'];row['qualification']={'verified':1};row['reasons']={'protected_owner_independently_qualified':1}
  self.assertEqual(module.phase_summary(o)['phases']['phase8']['authorityProvenance']['independentlyQualified'],1)
 def test_legacy_verified_authority_is_unknown_not_independent_or_failed(self):
  o=self.phase_observation();row=o['phaseEvidence']['phase8'];row['qualification']={'verified':1};row['reasons']={'protected_owner_independently_admitted':1}
  self.assertEqual(module.phase_summary(o)['phases']['phase8']['authorityProvenance'],{'independentlyQualified':0,'ownerForced':0,'unknown':1})
  self.assertEqual(module.phase_summary({})['status'],'unknown')
 def test_phase_aggregate_refuses_mismatched_malformed_or_unbounded_counts(self):
  for mutate in [lambda o:o['phaseEvidence']['phase8']['qualification'].update(verified=1),lambda o:o['phaseEvidence']['phase8']['eligibility'].update(eligible=0),lambda o:o['phaseEvidence']['phase8']['reasons'].update(owner_forced_not_independently_qualified=True),lambda o:o['phaseEvidence']['phase8']['application'].update(private_actor=0),lambda o:o['phaseEvidence'].pop('phase15')]:
   o=self.phase_observation();mutate(o)
   with self.assertRaises(ValueError):module.phase_summary(o)
 def test_canonical_binding_controls_phase_summary(self):
  p,a=self.convert(self.rows());o=self.phase_observation();o.update(observedHorses=1,completeHorseCoverage=False)
  r={'packetDigest':a['packetDigest'],'sourceSha':a['sourceSha'],'qualifiedExecution':True,'execution':{'observation':o}}
  self.assertEqual(module.summarize(a,r)['phaseEvidence']['status'],'reported')
  r['sourceSha']='b'*40
  self.assertEqual(module.summarize(a,r)['phaseEvidence']['reason'],'canonical_binding_unverified')
 def test_closed_database_error_classification_redacts_messages(self):
  for state,expected in [('57014','database_statement_cancelled'),('55P03','database_lock_unavailable'),('42501','database_permission_denied'),('42703','database_schema_unavailable'),('28P01','database_authentication_failed'),('08006','database_connection_unavailable'),('XX000','database_unavailable_or_bounds')]:
   self.assertEqual(module.database_failure(f'psql: ERROR:  {state}: SECRET postgres://user:password@private-host CARD PLAYER QUERY'),expected)
  self.assertEqual(module.database_failure('SECRET connection failed postgres://private'), 'database_unavailable_or_bounds')
  q=module.query('2000-01-01T00:00:00.000Z','2000-01-01T00:15:00.000Z')
  self.assertIn("statement_timeout='1500ms'",q);self.assertIn("lock_timeout='250ms'",q)
  self.assertIn('WHERE l.hand_id IS NULL AND table_id=h.table_id AND hand_number=h.hand_number',q)
 def test_capture_diagnostics_preserves_bounds_gaps_and_unknown_without_private_keys(self):
  a={'selectedHands':759,'sourceOwnerCounts':{'classic':2,'lightning':757}}
  o={'selectedHands':759,'inspectedHands':200,'remainingHands':559,'validatedBytes':67108864,'acceptedDecisions':328,'boundReached':True,'captureUnfinished':True,'gaps':{'bound_reached':1,'SECRET-HORSE':2}}
  d=module.capture_diagnostics(a,o)
  self.assertEqual(d['gaps'],{'bound_reached':1,'other_retained_capture_gap':2});self.assertNotIn('SECRET',json.dumps(d));self.assertFalse(d['inspectedHandsIsContinuationCursor'])
  self.assertIsNone(module.capture_diagnostics(a,{})['boundReached'])
  self.assertIsNone(module.capture_diagnostics(a,{})['gaps'])
  over=dict(o);over['validatedBytes']=67108865
  self.assertEqual(module.capture_diagnostics(a,over)['validatedBytes'],67108865)
  self.assertEqual(module.capture_diagnostics(a,over)['validatedBytesLimit'],67108864)
  for flag in ['boundReached','captureUnfinished']:
   bad=dict(over);bad[flag]=False
   with self.assertRaises(ValueError):module.capture_diagnostics(a,bad)
  for field,value in [('inspectedHands',760),('remainingHands',-1),('validatedBytes',75497473),('acceptedDecisions',True),('boundReached',1)]:
   bad=dict(o);bad[field]=value
   with self.assertRaises(ValueError):module.capture_diagnostics(a,bad)
 def partition_fixture(self,hands=65):
  p,a=self.convert(self.rows());p['handKeys']=[f'{i:064x}' for i in range(hands)]
  a.update(packetDigest=module.digest(p),selectedHands=hands,sourceOwnerCounts={'classic':hands,'lightning':0})
  return p,a
 def partition_result(self,part,actors=(0,)):
  n=len(actors);row={'capability':{'captured':n},'eligibility':{'eligible':n},'qualification':{'refused':n},'application':{'refused':n},'reasons':{'utility_refused':n}}
  counts={part['horseIds'][i]:actors.count(i) for i in set(actors)}
  o={'packetDigest':module.digest(part),'sourceSha':part['sourceSha'],'window':part['window'],
   'selectedHands':len(part['handKeys']),'inspectedHands':len(part['handKeys']),'remainingHands':0,
   'validatedBytes':n*1000,'acceptedDecisions':n,'boundReached':False,'captureUnfinished':False,'gaps':{},
   'limits':{'shards':32,'hands':10000,'validatedBytes':64*1024*1024,'elapsedMs':30000},
   'observedHorses':len(counts),'completeHorseCoverage':False,
   'phaseProofSchema':{'version':'horse-fleet-phase-proof-v1','counterUnit':'selected_accepted_decisions'},
   'phaseEvidence':{f'phase{i}':json.loads(json.dumps(row)) for i in range(1,16)},
   'horses':[{'horseId':i,'acceptedDecisions':counts.get(i,0),
    'phaseStatusCounts':{f'phase{j}':[0,0,counts[i],0,0,0] for j in range(1,16)} if counts.get(i) else {},
    'phaseAcceptedApplications':{}} for i in part['horseIds']]}
  return {'packetDigest':module.digest(part),'sourceSha':part['sourceSha'],'qualifiedExecution':True,
   'execution':{'exitCode':2,'containerExitCode':2,'release':part['sourceSha'],'readOnly':True,'network':'none','horseJournalMountVerified':True,
    'sameServingIdentityAfter':True,'observerRemoved':True,'cleanupExitCode':0,'oomKilled':False,
    'servingContainer':'c'*64,'imageId':'sha256:'+'d'*64,'servingStartedAt':'2000-01-01T00:00:00Z','observation':o}}
 def test_partitions_are_predeclared_disjoint_and_never_truncate_or_resume(self):
  p,a=self.partition_fixture();parts=module.partition_packets(p,a)
  self.assertEqual([len(x['handKeys']) for x in parts],[64,1])
  self.assertEqual([k for x in parts for k in x['handKeys']],sorted(p['handKeys']))
  self.assertEqual(len(set(k for x in parts for k in x['handKeys'])),65)
  p,a=self.partition_fixture(1025)
  with self.assertRaises(ValueError):module.partition_packets(p,a)
  p,a=self.partition_fixture();p['handKeys'][1]=p['handKeys'][0];a['packetDigest']=module.digest(p)
  with self.assertRaises(ValueError):module.partition_packets(p,a)
  p,a=self.partition_fixture();a['snapshot']=''
  with self.assertRaises(ValueError):module.partition_packets(p,a)
 def test_private_union_counts_each_horse_once_and_retains_phase_refusals(self):
  p,a=self.partition_fixture();parts=module.partition_packets(p,a)
  results=[self.partition_result(parts[0],(0,1)),self.partition_result(parts[1],(1,2))]
  summary=module.bounded_summary(p,a,results)
  self.assertEqual(summary['observedHorses'],3);self.assertEqual(summary['acceptedDecisions'],4)
  self.assertTrue(summary['completeCapture']);self.assertFalse(summary['completeCanonicalHorseCoverage'])
  self.assertFalse(summary['allPhasesVerified']);self.assertFalse(summary['completePopulation'])
  self.assertEqual(summary['phaseEvidence']['phases']['phase7']['reasons'],{'utility_refused':4})
  self.assertNotIn(p['horseIds'][0],json.dumps(summary));self.assertNotIn('horses',summary)
  partial=module.bounded_summary(p,a,results[:1]);self.assertFalse(partial['completeCapture'])
  self.assertEqual(partial['observedHorses'],2)
 def test_union_refuses_duplicate_partition_changed_source_container_or_horse_counts(self):
  for mutate in [lambda r:r.update(packetDigest='0'*64),lambda r:r.update(sourceSha='b'*40),
   lambda r:r['execution'].update(servingContainer='e'*64),lambda r:r['execution'].update(observerRemoved=False),
   lambda r:r['execution']['observation'].update(window={}),
   lambda r:r['execution']['observation']['horses'][0]['phaseAcceptedApplications'].update(phase7=1),
   lambda r:r['execution']['observation']['horses'][0]['phaseStatusCounts'].update(phase7=[0]*6),
   lambda r:r['execution']['observation']['horses'][0].update(acceptedDecisions=2),
   lambda r:r['execution']['observation']['horses'][0].update(horseId='PRIVATE-ID'),
   lambda r:r['execution']['observation']['limits'].update(validatedBytes=128*1024*1024)]:
   p,a=self.partition_fixture();parts=module.partition_packets(p,a);results=[self.partition_result(x) for x in parts];mutate(results[1])
   with self.assertRaises(ValueError):module.bounded_summary(p,a,results)
  p,a=self.partition_fixture();parts=module.partition_packets(p,a);r=self.partition_result(parts[0])
  with self.assertRaises(ValueError):module.bounded_summary(p,a,[r,r])
 def test_bounds_and_gaps_prevent_complete_even_when_every_horse_is_observed(self):
  p,a=self.partition_fixture(64);part=module.partition_packets(p,a)[0];r=self.partition_result(part,tuple(range(1000)))
  summary=module.bounded_summary(p,a,[r]);self.assertTrue(summary['completeCanonicalHorseCoverage']);self.assertFalse(summary['allPhasesVerified'])
  o=r['execution']['observation'];o.update(boundReached=True,captureUnfinished=True,gaps={'bound_reached':1})
  summary=module.bounded_summary(p,a,[r]);self.assertFalse(summary['completeCanonicalHorseCoverage']);self.assertEqual(summary['observedHorses'],1000)
  o.update(boundReached=False,captureUnfinished=False,gaps={'capture_outside_window':1})
  self.assertFalse(module.bounded_summary(p,a,[r])['completeCanonicalHorseCoverage'])
 def test_phase_reason_counts_redact_unknown_text_and_preserve_known_refusals(self):
  o=self.phase_observation();row=o['phaseEvidence']['phase7'];row['qualification']={'refused':1};row['application']={'refused':1};row['reasons']={'PRIVATE-CARD PLAYER SECRET':1}
  summary=module.phase_summary(o);self.assertNotIn('PRIVATE',json.dumps(summary))
  self.assertEqual(summary['phases']['phase7']['reasons'],{'other_retained_phase_reason':1})
 def test_bounded_driver_uses_existing_cli_once_per_partition_and_preserves_partial(self):
  from unittest.mock import patch
  p,a=self.partition_fixture()
  with tempfile.TemporaryDirectory(prefix='fleet-contract-') as folder:
   root=Path(folder);packet=root/'packet.json';attestation=root/'attestation.json';ssh=root/'hssh'
   for path,value in [(packet,p),(attestation,a)]:path.write_text(json.dumps(value));path.chmod(0o600)
   ssh.write_text('unused fixture');ssh.chmod(0o700)
   calls=[]
   def run(command,**kw):
    calls.append(command);part=json.loads(Path(command[4]).read_text());out=Path(command[8])
    out.write_text(json.dumps(self.partition_result(part)));out.chmod(0o600)
    return subprocess.CompletedProcess(command,0,b'',b'')
   with patch.object(module.subprocess,'run',side_effect=run):summary=module.observe_bounded(str(packet),str(attestation),str(ssh),str(root/'result.json'))
   self.assertEqual(len(calls),2);self.assertEqual(calls[0][:4],['node','server/scripts/phase6d-population.mjs','fleet','--packet'])
   self.assertEqual(summary['observedHorses'],1);self.assertEqual((root/'result.json').stat().st_mode&0o777,0o600)
   with self.assertRaises(ValueError):module.observe_bounded(str(packet),str(attestation),str(ssh),str(root/'result.json'))
   self.assertEqual(len(calls),2)
 def test_bounded_driver_retains_valid_prefix_when_second_transport_fails(self):
  from unittest.mock import patch
  p,a=self.partition_fixture()
  with tempfile.TemporaryDirectory(prefix='fleet-partial-') as folder:
   root=Path(folder);packet=root/'packet.json';attestation=root/'attestation.json';ssh=root/'hssh'
   for path,value in [(packet,p),(attestation,a)]:path.write_text(json.dumps(value));path.chmod(0o600)
   ssh.write_text('fixture');ssh.chmod(0o700);calls=[]
   def run(command,**kw):
    calls.append(command)
    if len(calls)==2:return subprocess.CompletedProcess(command,2,b'',b'PRIVATE ERROR')
    part=json.loads(Path(command[4]).read_text());out=Path(command[8])
    out.write_text(json.dumps(self.partition_result(part)));out.chmod(0o600)
    return subprocess.CompletedProcess(command,0,b'',b'')
   with patch.object(module.subprocess,'run',side_effect=run):summary=module.observe_bounded(str(packet),str(attestation),str(ssh),str(root/'result.json'))
   self.assertEqual(len(calls),2);self.assertEqual(summary['completedPartitions'],1)
   self.assertEqual(summary['observedHorses'],1);self.assertFalse(summary['completeCapture'])
   self.assertFalse(summary['completeCanonicalHorseCoverage']);self.assertNotIn('PRIVATE',json.dumps(summary))
   self.assertEqual(summary['gaps'],{'partition_observation_unavailable':1})
   self.assertEqual(summary['partitionFailure'],{'code':'partition_cli_unclassified','completedPartitions':1})
 def test_partition_failure_projection_is_closed_and_never_echoes_private_output(self):
  for code in module.FLEET_FAILURE_CODES:
   run=subprocess.CompletedProcess([],2,json.dumps({'qualifiedExecution':False,'failureCode':code,'private':'secret'}).encode(),b'UUID TOKEN PRIVATE')
   self.assertEqual(module.partition_failure_code(ValueError('opaque'),run),code)
  for raw in [b'PRIVATE',b'{"qualifiedExecution":false,"failureCode":"secret"}',b'x'*4097]:
   run=subprocess.CompletedProcess([],3,raw,b'PRIVATE')
   self.assertEqual(module.partition_failure_code(ValueError('secret'),run),'partition_cli_unclassified')
  self.assertEqual(module.partition_failure_code(subprocess.TimeoutExpired(['PRIVATE'],115,stderr=b'SECRET')),'partition_timeout')
  self.assertEqual(module.partition_failure_code(FileNotFoundError('SECRET')),'partition_process_unavailable')
  self.assertEqual(module.partition_failure_code(ValueError('partition_deadline')),'partition_deadline')
  self.assertEqual(module.partition_failure_code(ValueError('SECRET')),'partition_result_unverified')
 def with_partition_reads(self,result,independent_actor=None):
  o=result['execution']['observation'];fields={'qualifiedReadDecisions':'qualifiedReadHorses','ownHistoryLoadedDecisions':'ownHistoryLoadedHorses','positiveSampleDecisions':'positiveSampleHorses','positiveSampleWithHistoryDecisions':'positiveSampleWithHistoryHorses','retainedHistoryRiverSampleDecisions':'retainedHistoryRiverSampleHorses'}
  for h in o['horses']:
   n=h['acceptedDecisions'];independent=h['horseId']==independent_actor
   h['retainedReceiptCounts']={'pooledPublicReads':0 if independent else n,'independentPublicReads':n if independent else 0}
   h['riverLearning']={k:n for k in fields};h['riverLearning']['qualifiedReadBasisCounts']={'independent_public_receipt' if independent else 'individual_scoped_basic_component_of_pooled_public_receipt':n}
  pooled=[h for h in o['horses'] if h['retainedReceiptCounts']['pooledPublicReads']>0]
  o['riverLearningEvidence']={'scope':'at_least_one_qualified_observer_context','counterMeaning':'maximum_scoped_opponent_samples_per_accepted_read','readBasis':'original_individual_scoped_basic_counters',**{v:sum(h['riverLearning'][k]>0 for h in o['horses']) for k,v in fields.items()},'pooledIndividualScopedBasicReadHorses':len(pooled),'pooledIndividualScopedBasicReadDecisions':sum(h['retainedReceiptCounts']['pooledPublicReads'] for h in pooled)}
  return result
 def test_bounded_union_preserves_public_and_river_reads_without_duplicate_horses(self):
  p,a=self.partition_fixture();parts=module.partition_packets(p,a)
  results=[self.with_partition_reads(self.partition_result(parts[0],(0,1))),self.with_partition_reads(self.partition_result(parts[1],(1,2)),p['horseIds'][2])]
  results[0]['execution']['observation']['horses'][0]['PRIVATE-CARDS']=['secret']
  out=module.bounded_summary(p,a,results);public=out['publicReadEvidence'];river=out['riverLearningEvidence']
  self.assertEqual(public['pooledPublicReadDecisions'],3);self.assertEqual(public['pooledPublicReadHorses'],2)
  self.assertEqual(public['independentPublicReadDecisions'],1);self.assertEqual(public['independentPublicReadHorses'],1)
  self.assertEqual(river['qualifiedReadDecisions'],4);self.assertEqual(river['qualifiedReadHorses'],3)
  self.assertEqual(river['retainedHistoryRiverSampleDecisions'],4);self.assertEqual(river['retainedHistoryRiverSampleHorses'],3)
  self.assertEqual(river['pooledIndividualScopedBasicReadDecisions'],3);self.assertEqual(river['pooledIndividualScopedBasicReadHorses'],2)
  self.assertFalse(river['durablePersistenceVerified']);self.assertFalse(river['strategyApplicationVerified'])
  self.assertNotIn('PRIVATE',json.dumps(out));self.assertNotIn(p['horseIds'][0],json.dumps(out))
  partial=module.bounded_summary(p,a,results[:1]);self.assertEqual(partial['riverLearningEvidence']['qualifiedReadHorses'],2);self.assertFalse(partial['completeCapture'])
 def test_bounded_reads_keep_legacy_unknown_and_refuse_inconsistent_new_evidence(self):
  p,a=self.partition_fixture();parts=module.partition_packets(p,a)
  results=[self.with_partition_reads(self.partition_result(parts[0])),self.partition_result(parts[1])]
  out=module.bounded_summary(p,a,results)
  self.assertEqual(out['publicReadEvidence']['status'],'unknown');self.assertEqual(out['riverLearningEvidence']['status'],'unknown')
  self.assertEqual(module.bounded_summary(p,a,[])['publicReadEvidence']['status'],'unknown')
  self.with_partition_reads(results[1]);results[1]['execution']['observation']['riverLearningEvidence']['qualifiedReadHorses']=2
  with self.assertRaises(ValueError):module.bounded_summary(p,a,results)
 def read_result(self):
  p,a=self.convert(self.rows());horses=[]
  for i,id in enumerate(p['horseIds']):
   n=int(i==0);horses.append({'horseId':id,'acceptedDecisions':n,'retainedReceiptCounts':{'pooledPublicReads':n},'riverLearning':{'qualifiedReadDecisions':n,'qualifiedReadBasisCounts':{'individual_scoped_basic_component_of_pooled_public_receipt':n},'ownHistoryLoadedDecisions':n,'positiveSampleDecisions':n,'positiveSampleWithHistoryDecisions':n,'retainedHistoryRiverSampleDecisions':n}})
  river={'scope':'at_least_one_qualified_observer_context','counterMeaning':'maximum_scoped_opponent_samples_per_accepted_read','readBasis':'original_individual_scoped_basic_counters','pooledIndividualScopedBasicReadHorses':1,'pooledIndividualScopedBasicReadDecisions':1,'qualifiedReadHorses':1,'ownHistoryLoadedHorses':1,'positiveSampleHorses':1,'positiveSampleWithHistoryHorses':1,'retainedHistoryRiverSampleHorses':1}
  r={'packetDigest':a['packetDigest'],'sourceSha':a['sourceSha'],'qualifiedExecution':True,'execution':{'observation':{'observedHorses':1,'acceptedDecisions':1,'horses':horses,'riverLearningEvidence':river}}};return p,a,r
 def test_public_reads_survive_summary_without_private_payload_or_independence_inference(self):
  p,a,r=self.read_result();r['execution']['observation']['horses'][0]['PRIVATE']=['CARD']
  out=module.summarize(a,r,p);self.assertEqual(out['publicReadEvidence']['pooledPublicReadDecisions'],1);self.assertEqual(out['publicReadEvidence']['independentPublicReadDecisions'],0)
  self.assertEqual(out['riverLearningEvidence']['pooledIndividualScopedBasicReadDecisions'],1);self.assertFalse(out['riverLearningEvidence']['allContextsVerified']);self.assertNotIn('10000000-',json.dumps(out));self.assertNotIn('PRIVATE',json.dumps(out));self.assertFalse(out['allPhasesVerified'])
 def test_read_summary_missing_packet_or_legacy_rows_remains_unknown(self):
  p,a,r=self.read_result();self.assertEqual(module.summarize(a,r)['publicReadEvidence']['status'],'unknown')
  legacy=json.loads(json.dumps(r));[h.update(retainedReceiptCounts={'phase7':h['acceptedDecisions']}) for h in legacy['execution']['observation']['horses']];self.assertEqual(module.summarize(a,legacy,p)['publicReadEvidence']['status'],'unknown')
  del r['execution']['observation']['horses'][0]['riverLearning'];self.assertEqual(module.summarize(a,r,p)['riverLearningEvidence']['status'],'unknown')
 def test_missing_legacy_core_counts_are_unknown_but_present_bad_counts_refuse(self):
  for missing in ['global','horse']:
   p,a,r=self.read_result();o=r['execution']['observation']
   del (o if missing=='global' else o['horses'][0])['acceptedDecisions']
   out=module.summarize(a,r,p);self.assertEqual(out['publicReadEvidence']['status'],'unknown');self.assertEqual(out['riverLearningEvidence']['status'],'unknown')
   o['horses'][1]['acceptedDecisions']=True
   with self.assertRaises(ValueError):module.summarize(a,r,p)
 def test_read_summary_refuses_false_counts_duplicate_actor_and_noncanonical_packet(self):
  mutations=[lambda p,r:r['execution']['observation']['horses'][0]['retainedReceiptCounts'].update(pooledPublicReads=True),lambda p,r:r['execution']['observation']['horses'][1].update(horseId=p['horseIds'][0]),lambda p,r:r['execution']['observation']['riverLearningEvidence'].update(pooledIndividualScopedBasicReadDecisions=2),lambda p,r:r['execution']['observation']['horses'][0]['riverLearning']['qualifiedReadBasisCounts'].update(independent_public_receipt=1),lambda p,r:p['horseIds'].pop()]
  for mutate in mutations:
   p,a,r=self.read_result();mutate(p,r)
   with self.assertRaises(ValueError):module.summarize(a,r,p)
 def test_configured_uri_is_internal_environment_not_arguments(self):
  e=module.database_environment({'DATABASE_URL':'postgresql://fixture:percent%21@127.0.0.1:5432/test?sslmode=require'})
  self.assertEqual(e['PGPASSWORD'],'percent!');self.assertEqual(e['PGSSLMODE'],'require');self.assertNotIn('DATABASE_URL',e)
 def indexed_fixture(self,actors=(0,1),start='2000-01-01T00:00:00.000Z',end='2000-01-01T00:00:01.000Z'):
  p,a=self.partition_fixture(1);p['window']={'startUtc':start,'endUtc':end};a['packetDigest']=module.digest(p)
  part=module.partition_packets(p,a)[0];r=self.partition_result(part,actors)
  return p,a,r,module.bounded_summary(p,a,[r])['indexedEvidenceLedger']
 def test_indexed_ledger_preserves_docker_nanosecond_identity(self):
  p,a,r,_=self.indexed_fixture()
  for timestamp in ['2026-10-28T16:09:46Z','2026-10-28T16:09:46.603Z','2026-10-28T16:09:46.603123456Z']:
   r['execution']['servingStartedAt']=timestamp
   ledger=module.bounded_summary(p,a,[r])['indexedEvidenceLedger']
   self.assertEqual(ledger['observations'][0]['servingStartedAt'],timestamp)
  for timestamp in ['2026-10-28T16:09:46.6031234567Z','2026-10-28T16:09:46.Z','PRIVATE']:
   r['execution']['servingStartedAt']=timestamp
   with self.assertRaisesRegex(ValueError,'indexed_ledger_binding'):module.bounded_summary(p,a,[r])
 def test_partition_validation_refusal_projection_is_closed(self):
  run=subprocess.CompletedProcess([],0,stdout=b'',stderr=b'PRIVATE')
  for reason in ['indexed_ledger_binding','partition_execution_binding','partition_horse_phases','river_counts','phase_counts','read_counts','private_result']:
   self.assertEqual(module.partition_failure_code(ValueError(reason),run),reason)
  self.assertEqual(module.partition_failure_code(json.JSONDecodeError('PRIVATE','PRIVATE',0),run),'partition_result_json_invalid')
  self.assertEqual(module.partition_failure_code(ValueError('PRIVATE'),run),'partition_result_unverified')
 def test_indexed_ledger_retains_private_ordinal_evidence_and_explicit_unknowns(self):
  p,a,r,ledger=self.indexed_fixture((0,0,1))
  self.assertEqual(ledger['rows'][0]['acceptedDecisions'],2)
  self.assertIsNone(ledger['rows'][0]['qualifiedOriginalReadDecisions'])
  self.assertIsNone(ledger['rows'][0]['pooledPublicReadDecisions'])
  self.assertEqual(ledger['rows'][2]['acceptedDecisions'],0)
  self.assertEqual(ledger['decisionCorrectness'],'unknown');self.assertEqual(ledger['planEffectPersistence'],'unknown')
  self.assertFalse(ledger['allPhasesVerified']);self.assertFalse(ledger['completePopulation'])
  self.assertNotIn(p['horseIds'][0],json.dumps(ledger))
  # Roster ordering in transport does not change stable ordinal mapping.
  p['horseIds'].reverse();a['packetDigest']=module.digest(p);r['packetDigest']=module.digest(p)
  o=r['execution']['observation'];o['packetDigest']=module.digest(p)
  again=module.bounded_summary(p,a,[r])['indexedEvidenceLedger']
  self.assertEqual(again['cohortDigest'],ledger['cohortDigest']);self.assertEqual(again['rows'],ledger['rows'])
 def test_indexed_ledger_does_not_promote_unreported_read_evidence(self):
  p,a,r,_=self.indexed_fixture((0,))
  # A numerical field without a validated public/read schema is not evidence.
  for h in r['execution']['observation']['horses']:
   h['riverLearning']={'qualifiedReadDecisions':h['acceptedDecisions']}
  ledger=module.bounded_summary(p,a,[r])['indexedEvidenceLedger']
  self.assertEqual(ledger['rows'][0]['acceptedDecisions'],1)
  self.assertIsNone(ledger['rows'][0]['qualifiedOriginalReadDecisions'])
  # Valid public counts still do not validate missing river schema/provenance.
  for h in r['execution']['observation']['horses']:
   h['retainedReceiptCounts']={'pooledPublicReads':h['acceptedDecisions'],'independentPublicReads':0}
  summary=module.bounded_summary(p,a,[r]);row=summary['indexedEvidenceLedger']['rows'][0]
  self.assertEqual(summary['publicReadEvidence']['status'],'reported')
  self.assertEqual(summary['riverLearningEvidence']['status'],'unknown')
  self.assertEqual(row['pooledPublicReadDecisions'],1)
  self.assertIsNone(row['qualifiedOriginalReadDecisions'])
 def test_indexed_union_disjoint_windows_union_horses_and_dedupe_exact_retries(self):
  _,_,_,one=self.indexed_fixture((0,1))
  _,_,_,two=self.indexed_fixture((1,2),'2000-01-01T00:00:01.000Z','2000-01-01T00:00:02.000Z')
  joined=module.union_indexed_ledgers([one,two,one])
  self.assertEqual(len(joined['observations']),2)
  self.assertEqual(sum(r['acceptedDecisions']>0 for r in joined['rows']),3)
  self.assertEqual(sum(r['acceptedDecisions'] for r in joined['rows']),4)
  self.assertEqual(joined['rows'][1]['acceptedDecisions'],2)
  self.assertIsNone(joined['rows'][1]['qualifiedOriginalReadDecisions'])
 def test_indexed_union_refuses_source_cohort_overlap_and_partial_duplicate_unions(self):
  _,_,_,one=self.indexed_fixture()
  _,_,_,two=self.indexed_fixture((1,2),'2000-01-01T00:00:01.000Z','2000-01-01T00:00:02.000Z')
  for key,value in [('sourceSha','b'*40),('cohortDigest','b'*64)]:
   changed=json.loads(json.dumps(two));changed[key]=value
   with self.assertRaises(ValueError):module.union_indexed_ledgers([one,changed])
  changed=json.loads(json.dumps(one));changed['observations'][0]['packetDigest']='e'*64
  with self.assertRaises(ValueError):module.union_indexed_ledgers([one,changed])
  joined=module.union_indexed_ledgers([one,two])
  with self.assertRaises(ValueError):module.union_indexed_ledgers([joined,one])
 def test_indexed_ledger_refuses_false_claims_reorder_private_fields_and_bad_counts(self):
  _,_,_,ledger=self.indexed_fixture()
  mutations=[lambda v:v.update(allPhasesVerified=True),lambda v:v.update(planEffectPersistence='verified'),
   lambda v:v.update(secret='PRIVATE'),lambda v:v['rows'][0].update(qualifiedOriginalReadDecisions=True),
   lambda v:v['rows'][0].update(acceptedDecisions=-1),lambda v:v['rows'].reverse(),
   lambda v:v['observations'][0].update(servingContainer='PRIVATE'),
   lambda v:v['rows'][0].update(horseId='PRIVATE')]
  for mutate in mutations:
   v=json.loads(json.dumps(ledger));mutate(v)
   with self.assertRaises(ValueError):module.validate_indexed_ledger(v)
 def test_indexed_ledger_partial_capture_never_claims_complete_and_missing_identity_is_not_fabricated(self):
  p,a=self.partition_fixture();part=module.partition_packets(p,a)[0];r=self.partition_result(part)
  summary=module.bounded_summary(p,a,[r]);self.assertFalse(summary['completeCapture'])
  self.assertIsNotNone(summary['indexedEvidenceLedger'])
  empty=module.bounded_summary(p,a,[]);self.assertIsNone(empty['indexedEvidenceLedger'])
if __name__=='__main__':
 import sys
 unittest.main(argv=[sys.argv[0],'PacketContracts'] if '--contracts' in sys.argv else None)
