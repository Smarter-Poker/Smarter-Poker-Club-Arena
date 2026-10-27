from pathlib import Path
import os,shutil,subprocess,select,time
p=Path(__file__).resolve().parent;s=Path(os.environ['ORB_NATIVE_SOCKET']);pg=Path(os.environ['PG_BIN']);cmd=[str(pg/'psql'),'-X','-qAt','-h',str(s),'-p',os.environ['ORB_NATIVE_PORT'],'-U','postgres','-d','original_source_refs','-v','ON_ERROR_STOP=1']
def note(label):
 with(s/'certificate-concurrency-progress.log').open('a')as f:f.write(str(time.time())+' '+label+'\n')
note('load source')
source=(s/'finite245-raw-composition.sql').read_text().split('DO $cert$DECLARE c record;')[0]+'COMMIT;'
note('install source begin')
source_path=s/'certificate-concurrency-setup.sql';source_path.write_text(source)
with(s/'certificate-concurrency-setup.log').open('w')as capture:
 r=subprocess.run(cmd+['-f',str(source_path)],text=True,stdout=capture,stderr=subprocess.STDOUT,timeout=30)
assert r.returncode==0,(s/'certificate-concurrency-setup.log').read_text()[-2000:]
note('install source complete')
holder=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
try:
 note('holder send')
 holder.stdin.write("SELECT 'READY' FROM(SELECT pg_advisory_lock(hashtextextended('union-pnl-original-inventory-restoration',0))) held;\n");holder.stdin.flush()
 deadline=time.monotonic()+5;ready=False
 while time.monotonic()<deadline:
  if not select.select([holder.stdout],[],[],max(0,deadline-time.monotonic()))[0]:break
  line=holder.stdout.readline()
  if 'READY' in line:ready=True;break
 note('holder ready='+str(ready))
 assert ready,'holder did not acquire exact original-certificate lock'
 r=subprocess.run(cmd,input="SELECT smarter_private.certify_original_inventory_restoration(42309154,'2026-10-12 07:00Z');",text=True,capture_output=True,timeout=10)
 note('busy refusal returned')
 assert r.returncode!=0 and 'original_inventory_certificate_writer_busy' in r.stderr,r.stderr
 note('release holder')
 holder.stdin.write("SELECT pg_advisory_unlock(hashtextextended('union-pnl-original-inventory-restoration',0));\n\\q\n");holder.stdin.flush();holder.communicate(timeout=5)
 note('durable certificate begin')
 r=subprocess.run(cmd,input="SELECT smarter_private.certify_original_inventory_restoration(42309154,'2026-10-12 07:00Z');DO $b$BEGIN IF(SELECT count(*) FROM smarter_private.original_inventory_restoration_certificates)<>1 THEN RAISE EXCEPTION 'certificate duplicated';END IF;END$b$;",text=True,capture_output=True,timeout=10);assert r.returncode==0,r.stderr
 r=subprocess.run(cmd,input="SELECT smarter_private.certify_original_inventory_restoration(42309154,'2026-10-12 07:00Z');",text=True,capture_output=True,timeout=10);assert r.returncode!=0 and 'unknown_or_replayed' in r.stderr,r.stderr
 print('PASS exact certificate advisory-holder busy refusal, durable1certificate, replay refusal; isolated only')
finally:
 note('finally holder='+str(holder.poll()))
 if holder.poll() is None:holder.terminate();holder.communicate(timeout=5)
