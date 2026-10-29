"""Original continuation survives a transient real maintenance lane holder, bounded by 1s."""
import json,re,subprocess,time
from contextlib import contextmanager
from satellite_qualifier_fixture import module
MIGRATION='supabase/migrations/20261029064404_continuation_waits_for_a_bounded_maintenance_lane.sql'

def qualify(e,root,hand,db):
 b=module(root/'scripts/ci/fixtures/hand-continuation/build-maintenance-lane.py','maintenance_wait_builder')
 migration,rows,proof=b.render(MIGRATION)
 if migration!=(root/MIGRATION).read_text():raise RuntimeError('maintenance wait composition drift')
 auth="SELECT set_config('request.jwt.claim.role','service_role',true);SELECT set_config('app.smarter_data_actor','tournament-manager',true);SELECT set_config('app.smarter_tournament_id','86000000-0000-0000-0000-000000000001',true);SELECT set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000001',true);"
 def base(case,label):return (e.snapshot(case,label+'-data'),e.catalog_snapshot(case,label+'-catalog'),hand.private_snapshot(e,case,label+'-private'))
 def psql(case):return [str(e.pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(e.socket),'-p',str(e.port),'-U','postgres','-d',case]
 @contextmanager
 def holder(case):
  p=subprocess.Popen(psql(case),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=e.env)
  try:
   p.stdin.write('BEGIN;SELECT pg_advisory_xact_lock(530090,1);SELECT pg_advisory_lock(644044);\n');p.stdin.flush()
   deadline=time.monotonic()+4
   while e.sql(case,"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=644044 AND granted);",label='maintenance-holder-barrier')[1].strip()!='t':
    if p.poll() is not None or time.monotonic()>deadline:raise RuntimeError('exclusive holder barrier missing')
    time.sleep(.01)
   yield p
  finally:
   if p.poll() is None:
    p.stdin.write('COMMIT;\n');p.stdin.close();p.wait(timeout=4)
   if p.returncode:raise RuntimeError('exclusive holder failed:'+p.stderr.read())
 case=e.database(db)
 try:
  e.sql(case,'DO $$ BEGIN IF ('+proof+") IS DISTINCT FROM false THEN RAISE EXCEPTION 'WAIT_WITNESS_PREIMAGE';END IF;END$$;",label='maintenance-live-proof-before')
  pre=base(case,'wait-before')
  wrapper="BEGIN;\nSET LOCAL lock_timeout='1s';\nSET LOCAL statement_timeout='5s';\n"
  if migration.count(wrapper)!=1 or not migration.endswith('COMMIT;\n'):raise RuntimeError('wrong migration wrapper')
  inside=migration.replace(wrapper,"SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='5s';",1)[:-len('COMMIT;\n')]
  e.sql(case,'BEGIN;'+inside+'ROLLBACK;',label='maintenance-install-rollback')
  if pre!=base(case,'wait-after'):raise RuntimeError('installation rollback differs')
  for row in rows:
   for kind,change in [('acl','GRANT EXECUTE ON FUNCTION public.'+row['signature']+' TO anon;'),('config','ALTER FUNCTION public.'+row['signature']+' SET search_path=public;')]:
    clone=e.database(case);e.sql(clone,change,label='maintenance-drift-'+kind)
    before=base(clone,'drift-before');code,_,err=e.sql(clone,file=root/MIGRATION,label='maintenance-refuse-'+kind,check=False)
    if not code or 'HAND_CONTINUATION_WAIT_PREIMAGE_CHANGED' not in err or before!=base(clone,'drift-after'):raise RuntimeError('drift refusal failed')
    e.discard(clone)
  probe=(root/'scripts/ci/probes/hand-continuation-native.sql').read_text();prefix=probe[:probe.index('DO $boundaries$')]
  seed=('BEGIN;CREATE SCHEMA lane_native;'+(e.output/'opening.sql').read_text()+prefix+'SELECT pg_temp.retain_continuation(0);COMMIT;').replace('pg_temp.','lane_native.')
  e.sql(case,seed,label='maintenance-original-seed')
  original=hand.private_snapshot(e,case,'old-original-before')
  retain="SELECT lane_native.retain_continuation(1);"
  with holder(case):
   code,_,err=e.sql(case,'BEGIN;'+auth+retain+'COMMIT;',label='maintenance-old-real-failure',check=False)
   if not code or 'HAND_CONTINUATION_MAINTENANCE_BUSY' not in err:raise RuntimeError('old maintenance failure not reproduced')
  if original!=hand.private_snapshot(e,case,'old-original-after'):raise RuntimeError('old failure changed private original')
  e.sql(case,file=root/MIGRATION,label='maintenance-exact-candidate-install')
  e.sql(case,'SELECT '+proof+';',label='maintenance-live-proof-after')
  with holder(case) as held:
   pending=subprocess.Popen(psql(case),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=e.env)
   pending.stdin.write("BEGIN;SET LOCAL lock_timeout='50ms';"+auth+retain+"SELECT current_setting('lock_timeout');COMMIT;\n");pending.stdin.close()
   deadline=time.monotonic()+4
   while e.sql(case,"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=530090 AND objid=1 AND NOT granted);",label='maintenance-real-wait-observed')[1].strip()!='t':
    if pending.poll() is not None or time.monotonic()>deadline:raise RuntimeError('new original did not wait on real lane')
    time.sleep(.01)
   held.stdin.write('COMMIT;\n');held.stdin.close();held.wait(timeout=4)
   pending.wait(timeout=4);out=pending.stdout.read();err=pending.stderr.read()
   if pending.returncode or err or '50ms' not in out:raise RuntimeError('bounded wait did not continue/restore callerGUC:'+err)
  e.sql(case,"DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM smarter_private.hand_continuations WHERE hand_number=8600001 AND sequence=1 AND payload::jsonb#>>'{original,permit_id}'='86600000-0000-0000-0000-000000000001') THEN RAISE EXCEPTION 'SAME_ORIGINAL_NOT_PROGRESSING';END IF;END$$;",label='maintenance-same-original-progress')
  with holder(case):
   start=time.monotonic();code,_,err=e.sql(case,'BEGIN;'+auth+"SELECT lane_native.retain_continuation(2);COMMIT;",label='maintenance-long-holder-bounded',check=False)
   elapsed=time.monotonic()-start
   if not code or 'lock timeout' not in err or not .8<elapsed<3:raise RuntimeError('long maintenance wait unbounded or wrongrefusal:'+err)
  e.sql(case,'BEGIN;'+auth+retain+retain+'ROLLBACK;',label='maintenance-exact-original-replay')
  for x in rows:
   old=x['old'].replace("'","''")
   e.sql(case,"DO $$BEGIN IF replace(pg_get_functiondef('public."+x['signature']+"'::regprocedure),'PERFORM smarter_private.lock_hand_continuation_maintenance_lane();', '"+old+"') IS DISTINCT FROM $pre$"+x['definition']+"$pre$ THEN RAISE EXCEPTION 'OTHER_FUNCTION_BYTES_CHANGED'; END IF;END$$;",label='maintenance-reverse-exact-function')
  # The full existing actual financial/native suite re-executes after candidate installation.
  clean=e.database(db);e.sql(clean,file=root/MIGRATION,label='maintenance-full-native-candidate')
  before=base(clean,'full-before');code,out,err=e.sql(clean,'BEGIN;'+(e.output/'opening.sql').read_text()+probe+'ROLLBACK;',label='maintenance-all-original-boundaries',check=False)
  if code or err.count('CONTINUATION PASS:')!=37 or 'HAND_CONTINUATION_NATIVE_PASS' not in out:raise RuntimeError('actual original/financial/freeze boundaries failed:'+err)
  if before!=base(clean,'full-after'):raise RuntimeError('full native rollback differs')
  e.discard(clean)
  e.report['maintenance_lane_wait']={'passed':True,'old_55P03_reproduced':True,'real_wait_observed':True,'same_original_progress':True,'caller_lock_timeout_restored':True,'long_holder_seconds':elapsed,'native_original_boundaries':37,'installation_drift_refusals':6,'complete_rollback':True,'postimages':[{k:x[k] for k in ('signature','post_body_md5','post_full_md5')} for x in rows]}
 finally:e.discard(case)
