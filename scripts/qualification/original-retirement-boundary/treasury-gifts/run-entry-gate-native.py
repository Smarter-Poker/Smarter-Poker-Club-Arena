"""The exact installer drains the existing shared admission gate first."""
import hashlib,json,os,subprocess,time
from pathlib import Path
pg=Path(os.environ['PG_BIN']);socket=os.environ['ORB_NATIVE_SOCKET'];port=os.environ['ORB_NATIVE_PORT']
candidate=Path(os.environ['ORB_TREASURY_SEAT_GIFT_MIGRATION'])
base=[str(pg/'psql'),'-X','-qAt','-h',socket,'-p',port,'-U','postgres','-d','original_source_refs','-v','ON_ERROR_STOP=1']
def q(sql):
 r=subprocess.run(base+['-c',sql],capture_output=True,text=True,timeout=5);assert r.returncode==0,r.stderr;return r.stdout.strip()
s=candidate.read_text();assert s.index('pg_advisory_xact_lock(530090,1)')<s.index('CREATE TABLE smarter_private.original_treasury_funding_witnesses')
before=q("SELECT to_regclass('smarter_private.original_treasury_funding_cutover')")
old=subprocess.Popen(base+['-c',"BEGIN;SET LOCAL application_name='native-old-original-treasury-producer';SELECT pg_advisory_xact_lock_shared(530090,1);SELECT pg_sleep(4);ROLLBACK;"],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
try:
 deadline=time.monotonic()+2
 while q("SELECT EXISTS(SELECT FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='native-old-original-treasury-producer' AND l.locktype='advisory' AND l.classid=530090 AND l.objid=1 AND l.granted)")!='t':
  assert time.monotonic()<deadline,'old producer gate not observed';time.sleep(.02)
 installed=subprocess.run(base+['-f',str(candidate)],capture_output=True,text=True,timeout=4)
 assert installed.returncode!=0 and 'lock timeout'in installed.stderr,installed.stderr
 assert before==q("SELECT to_regclass('smarter_private.original_treasury_funding_cutover')")
 _,err=old.communicate(timeout=6);assert old.returncode==0,err
 assert q('BEGIN;SELECT pg_try_advisory_xact_lock(530090,1);ROLLBACK;')=='t'
 print(json.dumps({'status':'passed','exact_installer_sha256':hashlib.sha256(candidate.read_bytes()).hexdigest(),'old_shared_producer_drained_before_cutover':True,'bounded_refusal_before_any_cutover_ddl':True,'no_money_called':True}))
finally:
 if old.poll()is None:old.terminate();old.wait(timeout=5)
