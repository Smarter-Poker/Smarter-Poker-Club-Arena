"""Observed original reader ownership refuses this exact installer, private PG only."""
import subprocess,threading,queue,uuid

def run(e,db,raw):
 env=e.env.copy();env['PGAPPNAME']='cash17-owned-reader-'+uuid.uuid4().hex[:8]
 cmd=[str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',str(e.port),'-U','postgres','-d',db,'-v','ON_ERROR_STOP=1']
 child=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,bufsize=1)
 ready=queue.Queue();lines=[]
 def read():
  for line in child.stdout:lines.append(line);ready.put(line.strip())
 threading.Thread(target=read,daemon=True).start()
 try:
  child.stdin.write("BEGIN;SELECT pg_advisory_xact_lock_shared(530090,1);SELECT 'ORIGINAL_READER_OWNED';\n");child.stdin.flush()
  while ready.get(timeout=10)!='ORIGINAL_READER_OWNED':pass
  code,stdout,stderr=e.sql(db,raw,label='cash17-original-reader-owned-installer-refusal',seconds=10,check=False)
  if code==0 or 'CASH17_ORIGINAL_HAND_OWNER_OR_FREEZE' not in stderr:raise RuntimeError('Observed owning reader did not refuse exact installer')
  e.report['migration_refusals'].append({'label':'cash17-original-reader-owned','observed':True,'source_mutex':[530090,1]})
 finally:
  if child.poll() is None:
   child.stdin.write('ROLLBACK;\n\\q\n');child.stdin.flush()
   try:child.wait(timeout=10)
   except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
  (e.output/'cash17-original-reader-barrier.stdout').write_text(''.join(lines))
  (e.output/'cash17-original-reader-barrier.stderr').write_text(child.stderr.read())
 if child.returncode!=0:raise RuntimeError('Owned reader barrier cleanup failed')
