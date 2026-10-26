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
CREATE TABLE public.hand_history(id uuid PRIMARY KEY,table_id uuid,hand_number bigint,created_at timestamptz);
CREATE INDEX idx_hand_history_created ON public.hand_history(created_at DESC);
CREATE TABLE public.hand_atomic_commits(hand_id uuid UNIQUE,table_id uuid,hand_number bigint,post_commit_completed_at timestamptz,post_commit_payload jsonb DEFAULT '{}'::jsonb,PRIMARY KEY(table_id,hand_number));
CREATE TABLE public.lightning_hand(hand_id uuid PRIMARY KEY,hand_history_id uuid,host_table_id uuid,hand_number bigint,settled_at timestamptz);
CREATE INDEX idx_lightning_hand_hand_history_id ON public.lightning_hand(hand_history_id);
CREATE TABLE smarter_private.hand_submissions(table_id uuid,hand_number bigint,lease_generation uuid,PRIMARY KEY(table_id,hand_number));
INSERT INTO public.ca_horse_active_roster SELECT ('10000000-0000-4000-8000-'||lpad(to_hex(i),12,'0'))::uuid FROM generate_series(1,1000)i;
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
  self.sql("INSERT INTO public.ca_horse_active_roster VALUES('10000000-0000-4000-8000-000000001001');")
  try:
   with self.assertRaises(ValueError):self.convert(self.rows())
  finally:self.sql("DELETE FROM public.ca_horse_active_roster WHERE horse_id='10000000-0000-4000-8000-000000001001';")
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
 def test_mixed_lightning_uses_private_original_receipt_not_classic_submission(self):
  self.sql("""INSERT INTO public.hand_history VALUES('20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002',1000002,'2026-10-25T19:01:02Z');
INSERT INTO public.lightning_hand VALUES('50000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002',1000002,'2026-10-25T19:01:03Z');
INSERT INTO public.hand_atomic_commits VALUES('20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002',1000002,'2026-10-25T19:01:03Z','{"accepted_hand_facts":{"horse_journal_identity":{"version":1,"lease_generation":"40000000-0000-4000-8000-000000000002"}}}');
INSERT INTO smarter_private.hand_submissions VALUES('30000000-0000-4000-8000-000000000002',1000002,'90000000-0000-4000-8000-000000000002');""")
  try:
   rows=self.rows();lightning=next(h for h in rows['hands'] if h['source_owner']=='lightning');self.assertEqual(lightning['lease_generation'],'40000000-0000-4000-8000-000000000002')
   packet,receipt=self.convert(rows);self.assertEqual(len(packet['handKeys']),2);self.assertEqual(receipt['sourceOwnerCounts'],{'classic':1,'lightning':1})
   self.sql("UPDATE public.hand_atomic_commits SET post_commit_payload='{}' WHERE hand_number=1000002;")
   with self.assertRaises(module.PacketGap) as gap:self.convert(self.rows())
   self.assertEqual(str(gap.exception),'lightning_original_lease_unavailable');self.assertEqual(gap.exception.counts['lightningMissingOriginalCoordinates'],1)
  finally:self.sql('DELETE FROM smarter_private.hand_submissions WHERE hand_number=1000002;DELETE FROM public.hand_atomic_commits WHERE hand_number=1000002;DELETE FROM public.lightning_hand;DELETE FROM public.hand_history WHERE hand_number=1000002;')
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
 def test_configured_uri_is_internal_environment_not_arguments(self):
  e=module.database_environment({'DATABASE_URL':'postgresql://fixture:percent%21@127.0.0.1:5432/test?sslmode=require'})
  self.assertEqual(e['PGPASSWORD'],'percent!');self.assertEqual(e['PGSSLMODE'],'require');self.assertNotIn('DATABASE_URL',e)
if __name__=='__main__':
 import sys
 unittest.main(argv=[sys.argv[0],'PacketContracts'] if '--contracts' in sys.argv else None)
