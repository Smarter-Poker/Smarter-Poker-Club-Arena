from pathlib import Path
import queue,subprocess,sys,threading,time
pg,work,migration=map(Path,sys.argv[1:])
args=[str(pg/'psql'),'-X','-q','-h',str(work),'-p','56449','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
# Original reader admission ownership is observed before the candidate is tried;
# no elapsed-time threshold or fixed sleep supplies correctness.
owner=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
try:
 owner.stdin.write("BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0));\n\\echo OWNED\n");owner.stdin.flush()
 lines=queue.Queue()
 def read_lines():
  for line in owner.stdout:lines.put(line)
 threading.Thread(target=read_lines,daemon=True).start()
 ready=False;deadline=time.monotonic()+10
 while time.monotonic()<deadline:
  try:line=lines.get(timeout=max(0.01,deadline-time.monotonic()))
  except queue.Empty:break
  if line.strip()=='OWNED':ready=True;break
 assert ready,'original reader ownership barrier unavailable'
 attempt=subprocess.run(args+['-f',str(migration)],capture_output=True,text=True,timeout=10)
 assert attempt.returncode and 'SHAPED_PRIMARY_ORIGINAL_READER_OWNED' in attempt.stderr,attempt.stderr
 (work/'owned-admission.log').write_text(attempt.stdout+attempt.stderr)
 owner.stdin.write('ROLLBACK;\n\\q\n');owner.stdin.flush();owner.communicate(timeout=10)
 assert owner.returncode==0
 print('PASS concurrent original reader ownership refuses installation without waiting/override')
finally:
 if owner.poll() is None:owner.kill();owner.communicate()
