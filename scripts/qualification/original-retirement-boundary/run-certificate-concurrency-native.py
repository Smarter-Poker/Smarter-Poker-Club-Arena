from pathlib import Path
import os,shutil,subprocess,select,time
p=Path(__file__).resolve().parent;s=Path(os.environ['ORB_NATIVE_SOCKET']);pg=Path(os.environ['PG_BIN']);cmd=[str(pg/'psql'),'-X','-qAt','-h',str(s),'-p',os.environ['ORB_NATIVE_PORT'],'-U','postgres','-d','original_source_refs','-v','ON_ERROR_STOP=1']
source=(s/'finite245-raw-composition.sql').read_text().split('DO $cert$DECLARE c record;')[0]+'COMMIT;'
r=subprocess.run(cmd,input=source,text=True,capture_output=True,timeout=30);assert r.returncode==0,r.stderr
holder=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
try:
 holder.stdin.write("SELECT 'READY' FROM(SELECT pg_advisory_lock(hashtextextended('union-pnl-original-inventory-restoration',0))) held;\n");holder.stdin.flush()
 deadline=time.monotonic()+5;ready=False
 while time.monotonic()<deadline:
  if not select.select([holder.stdout],[],[],max(0,deadline-time.monotonic()))[0]:break
  line=holder.stdout.readline()
  if 'READY' in line:ready=True;break
 assert ready,'holder did not acquire exact original-certificate lock'
 r=subprocess.run(cmd,input="SELECT smarter_private.certify_original_inventory_restoration(42309154,'2026-10-12 07:00Z');",text=True,capture_output=True,timeout=10)
 assert r.returncode!=0 and 'original_inventory_certificate_writer_busy' in r.stderr,r.stderr
 holder.stdin.write("SELECT pg_advisory_unlock(hashtextextended('union-pnl-original-inventory-restoration',0));\n\\q\n");holder.stdin.flush();holder.communicate(timeout=5)
 r=subprocess.run(cmd,input="SELECT smarter_private.certify_original_inventory_restoration(42309154,'2026-10-12 07:00Z');DO $b$BEGIN IF(SELECT count(*) FROM smarter_private.original_inventory_restoration_certificates)<>1 THEN RAISE EXCEPTION 'certificate duplicated';END IF;END$b$;",text=True,capture_output=True,timeout=10);assert r.returncode==0,r.stderr
 r=subprocess.run(cmd,input="SELECT smarter_private.certify_original_inventory_restoration(42309154,'2026-10-12 07:00Z');",text=True,capture_output=True,timeout=10);assert r.returncode!=0 and 'unknown_or_replayed' in r.stderr,r.stderr
 print('PASS exact certificate advisory-holder busy refusal, durable1certificate, replay refusal; isolated only')
finally:
 if holder.poll() is None:holder.terminate();holder.communicate(timeout=5)
