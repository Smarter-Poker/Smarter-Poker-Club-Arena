#!/usr/bin/env python3
"""Execute prospective clock duration/deadline SQL locally on one disposable PG17.
No remote URL is accepted. This is the duration layer, not clock activation proof.
"""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,tempfile
repo=Path(__file__).resolve().parents[2]
pg=Path(os.environ.get('POKER_AUDIT_PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
captured=json.loads(subprocess.check_output([os.environ.get('POKER_AUDIT_NODE','node'),str(repo/'scripts/dev/clock-duration-runtime.mjs')],text=True))
root=Path(tempfile.mkdtemp(prefix='ca-clock-duration-pg17-'));cluster=root/'cluster';sock=root/'socket';sock.mkdir()
port=str(35000+os.getpid()%10000)
logpath=Path('/tmp/codex-clock-duration-pg17.log')
with logpath.open('w') as log:
 try:
  assert ' 17.' in subprocess.check_output([str(pg/'postgres'),'--version'],text=True)
  subprocess.run([str(pg/'initdb'),'-D',str(cluster),'--auth=trust','--no-locale'],check=True,stdout=log,stderr=log)
  subprocess.run([str(pg/'pg_ctl'),'-D',str(cluster),'-o',f'-k {sock} -p {port} -c listen_addresses=','-w','start'],check=True,stdout=log,stderr=log)
  psql=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(sock),'-p',port,'-d','postgres']
  def q(sql,expected=None):
   run=subprocess.run(psql,input=sql,text=True,capture_output=True,timeout=30)
   if expected:
    assert run.returncode and expected in run.stderr,run.stderr
    return
   if run.returncode:raise RuntimeError(run.stderr)
   return run.stdout.strip()
  q('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA smarter_private;')
  path=repo/'docs/audits/2026-09-10-k01-production-clock/clock-duration.sql'
  q(path.read_text())
  raw=json.dumps(captured['rows']).replace("'","''")
  actual=json.loads(q("SELECT jsonb_agg(smarter_private.fn_ca_clock_duration(x->'structure',(x->>'index')::integer,x->>'format'<>'mtt',true,(x->>'entryClosed')::boolean) ORDER BY ord) FROM jsonb_array_elements('"+raw+"'::jsonb) WITH ORDINALITY r(x,ord);"))
  for row,sql in zip(captured['rows'],actual):
   assert row['proposed']==sql,(row,sql)
   row['sql']=sql
  for item in captured['refused_rows']:
   raw=json.dumps(item['structure']).replace("'","''")
   q("SELECT smarter_private.fn_ca_clock_duration('"+raw+"',0,false,true,false);",item['expectedError'])
  q("SELECT smarter_private.fn_ca_clock_duration('[]',0,false,false,false);",'persisted structure')
  q("SELECT smarter_private.fn_ca_clock_due_transition('[{}]',0,clock_timestamp(),60000000);",'CLOCK_LEVEL_NOT_DUE')
  q("SELECT smarter_private.fn_ca_clock_due_transition('[{}]',0,NULL,60000000);",'CLOCK_CANONICAL_TIME_REQUIRED')
  q("SELECT smarter_private.fn_ca_clock_due_transition('[{}]',0,clock_timestamp(),0);",'CLOCK_CANONICAL_TIME_REQUIRED')
  q("SELECT smarter_private.fn_ca_clock_instant('infinity');",'CLOCK_FINITE_INSTANT_REQUIRED')
  q("SELECT smarter_private.fn_ca_clock_instant('-infinity');",'CLOCK_FINITE_INSTANT_REQUIRED')
  checks=q("""
  DO $proof$
  DECLARE a timestamptz:=clock_timestamp()-interval '10 minutes';r jsonb;s jsonb;BEGIN
   r:=smarter_private.fn_ca_clock_due_transition('[{},{}]',0,a,60000000);
   IF (r->>'next_level')::integer<>1 OR (r->>'next_anchor')::timestamptz<>a+interval '1 minute' THEN RAISE EXCEPTION '0 to1 deadline regression';END IF;
   IF (r->>'next_anchor')::timestamptz>=clock_timestamp()-interval '8 minutes' THEN RAISE EXCEPTION 'late advance reset';END IF;
   s:=smarter_private.fn_ca_clock_due_transition('[{},{},{},{}]',1,(r->>'next_anchor')::timestamptz,60000000);
   IF (s->>'next_anchor')::timestamptz<>a+interval '2 minutes' THEN RAISE EXCEPTION 'overdue debt erased';END IF;
   r:=smarter_private.fn_ca_clock_due_transition('[{},{"isBreak":true},{"isBreak":true},{}]',0,a,60000000);
   IF (r->>'next_level')::integer<>3 OR (r->>'next_anchor')::timestamptz<>a+interval '1 minute' THEN RAISE EXCEPTION 'break row consumed time';END IF;
   r:=smarter_private.fn_ca_clock_due_transition('[{},{"isBreak":true},{"isBreak":true}]',0,a,60000000);
   IF (r->>'next_level')::integer<>3 THEN RAISE EXCEPTION 'trailing break overflow boundary';END IF;
   IF smarter_private.fn_ca_clock_instant('2026-09-10 12:34:56.123456+00')<>smarter_private.fn_ca_clock_instant('2026-09-10 08:34:56.123456-04') THEN RAISE EXCEPTION 'timestamp replay mismatch';END IF;
   IF smarter_private.fn_ca_clock_epoch_seconds(a,a-interval '1 minute',a-interval '1 second')<>0 THEN RAISE EXCEPTION 'prelevel interval credited';END IF;
   IF smarter_private.fn_ca_clock_epoch_seconds(a,a-interval '1 minute',a+interval '1 minute')<>60 THEN RAISE EXCEPTION 'partial interval unclipped';END IF;
   IF smarter_private.fn_ca_clock_epoch_seconds(a,a+interval '1 minute',a+interval '2 minutes')<>60 THEN RAISE EXCEPTION 'level interval lost';END IF;
   IF smarter_private.fn_ca_clock_instant(NULL) IS NOT NULL THEN RAISE EXCEPTION 'null replay instant changed';END IF;
   IF extract(epoch FROM smarter_private.fn_ca_clock_interval(1))*1000000<>1 THEN RAISE EXCEPTION 'one microsecond rerounded';END IF;
   IF extract(epoch FROM smarter_private.fn_ca_clock_interval(1000001))*1000000<>1000001 THEN RAISE EXCEPTION 'fractional second rerounded';END IF;
   IF extract(epoch FROM smarter_private.fn_ca_clock_interval(9007199254740991))*1000000<>9007199254740991 THEN RAISE EXCEPTION 'large exact duration lost precision';END IF;
  END $proof$;
  SELECT true;
  """)
  assert checks=='t',checks
  captured['summary']={'native_duration_rows':len(actual),'proposed_mismatches':0,'old_manager_duration_mismatches':sum('oldManagerMs'in r and r['oldManagerMs']!=r['proposed']['durationMs'] for r in captured['rows']),'old_client_duration_mismatches':sum('oldClientMs'in r and r['oldClientMs']!=r['proposed']['durationMs'] for r in captured['rows']),'admitted_producer_configurations':len(captured['producers']),'actual_producer_rows':sum('producer' in r and r['producer'] is not None for r in captured['rows']),'duration_admission_refusals':len(captured['refused_rows']),'other_refusal_cases':6,'deadline_and_epoch_cases':13,'production_writes':False}
  captured['sql_sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
  Path('/tmp/codex-clock-duration-results.json').write_text(json.dumps(captured,indent=2)+'\n')
  print(json.dumps(captured['summary'],indent=2),flush=True)
 finally:
  if cluster.exists():subprocess.run([str(pg/'pg_ctl'),'-D',str(cluster),'-m','immediate','stop'],stdout=log,stderr=log)
  shutil.rmtree(root)
