"""Real retained-save RPC versus the installed sibling projection lane, on private PG only."""
import subprocess,time
from contextlib import contextmanager
from satellite_qualifier_fixture import module
MIGRATION='supabase/migrations/20261029231647_retained_original_hands_share_their_tournament_table_lane.sql'
SHARED='supabase/migrations/20261003230910_a_tournament_table_s_hand_does_not_wait_for_its_sibling_tabl.sql'
WRITER='supabase/migrations/20261019151125_tournament_table_writers_wait_for_their_shared_lane.sql'

def qualify(e,root,hand,db):
 b=module(root/'scripts/ci/fixtures/hand-continuation/build-retain-shared-lane.py','retain_shared_builder')
 migration,before,after,proof=b.render()
 if migration!=(root/MIGRATION).read_text():raise RuntimeError('retain shared composition drift')
 auth="SELECT set_config('request.jwt.claim.role','service_role',true);SELECT set_config('app.smarter_data_actor','tournament-manager',true);SELECT set_config('app.smarter_tournament_id','86000000-0000-0000-0000-000000000001',true);SELECT set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000001',true);"
 table="'86100000-0000-0000-0000-000000000001'::uuid"
 tournament="'86000000-0000-0000-0000-000000000001'::uuid"
 def snapshot(case,label):return (e.snapshot(case,label+'-public'),e.catalog_snapshot(case,label+'-catalog'),hand.private_snapshot(e,case,label+'-private'))
 def psql(case):return [str(e.pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(e.socket),'-p',str(e.port),'-U','postgres','-d',case]
 @contextmanager
 def holder(case,sql):
  p=subprocess.Popen(psql(case),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=e.env)
  try:
   p.stdin.write("BEGIN;SET LOCAL statement_timeout='10s';"+sql+'SELECT pg_advisory_lock(316470);\n');p.stdin.flush()
   end=time.monotonic()+4
   while e.sql(case,"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=316470 AND granted);",label='retain-holder-barrier')[1].strip()!='t':
    if p.poll() is not None or time.monotonic()>end:raise RuntimeError('lane holder did not reach barrier:'+str(p.poll()))
    time.sleep(.01)
   yield p
  finally:
   if p.poll() is None:p.stdin.write('ROLLBACK;\n');p.stdin.close();p.wait(timeout=4)
   if p.returncode:raise RuntimeError('lane holder failed:'+p.stderr.read())
 case=e.database(db)
 try:
  e.sql(case,file=root/'supabase/migrations/20261029064404_continuation_waits_for_a_bounded_maintenance_lane.sql',label='retain-bounded-maintenance-preimage')
  # Install unchanged maintained lane definitions in this older captured closure.
  src=(root/SHARED).read_text();e.sql(case,src[src.index('CREATE FUNCTION public.fn_ca_f06_share_table_lane'):src.index('DO $subs$')],label='retain-installed-shared-lane')
  src=(root/WRITER).read_text();e.sql(case,src[src.index('CREATE FUNCTION smarter_private.f06_wait_table_lane'):src.index('DO $subs$')],label='retain-installed-projection-lane')
  pre=snapshot(case,'install-before')
  wrapper="BEGIN;\nSET LOCAL lock_timeout='1s';\nSET LOCAL statement_timeout='5s';\n"
  inside=migration.replace(wrapper,"SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='5s';",1).removesuffix('COMMIT;\n')
  e.sql(case,'BEGIN;'+inside+'ROLLBACK;',label='retain-install-rollback')
  if pre!=snapshot(case,'install-after'):raise RuntimeError('retain install rollback changed state')
  for sig in (b.SIG,b.LANE):
   for label,change in [('acl','GRANT EXECUTE ON FUNCTION '+sig+' TO anon;'),('config','ALTER FUNCTION '+sig+' SET search_path=public;')]:
    clone=e.database(case);e.sql(clone,change,label='retain-drift-'+label);state=snapshot(clone,'drift-before')
    code,_,err=e.sql(clone,file=root/MIGRATION,label='retain-refuse-'+label,check=False)
    if not code or 'HAND_CONTINUATION_SHARED_LANE_PREIMAGE_CHANGED' not in err or state!=snapshot(clone,'drift-after'):raise RuntimeError('retain drift accepted')
    e.discard(clone)
  clean=e.database(case)
  probe=(root/'scripts/ci/probes/hand-continuation-native.sql').read_text();prefix=probe[:probe.index('DO $boundaries$')]
  seed=('BEGIN;CREATE SCHEMA retain_lane_native;'+(e.output/'opening.sql').read_text()+prefix+'SELECT pg_temp.retain_continuation(0);COMMIT;').replace('pg_temp.','retain_lane_native.')
  e.sql(case,seed,label='retain-original-seed')
  e.sql(case,"BEGIN;SET LOCAL session_replication_role=replica;INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id) VALUES('86100000-0000-0000-0000-000000000002','Sibling projection',"+tournament+",'running','live',0,'tournament','20000000-0000-0000-0000-000000000001');COMMIT;",label='retain-sibling-seed')
  call='SELECT retain_lane_native.retain_continuation(1);'
  request="BEGIN;SET LOCAL lock_timeout='150ms';SET LOCAL statement_timeout='2s';"+auth+call+'COMMIT;'
  sibling="SELECT smarter_private.f06_wait_table_lane('86100000-0000-0000-0000-000000000002');"
  state=hand.private_snapshot(e,case,'retain-old-before')
  with holder(case,sibling):
   code,_,err=e.sql(case,request,label='retain-old-sibling-projection-blocks',check=False)
   if not code or 'lock timeout' not in err or 'fn_ca_lock_settlement_lane_for_tournament' not in err:raise RuntimeError('exclusive retain regression not reproduced:'+err)
  if state!=hand.private_snapshot(e,case,'retain-old-after'):raise RuntimeError('failed retain changed original')
  e.sql(case,file=root/MIGRATION,label='retain-exact-install')
  with holder(case,sibling):e.sql(case,request,label='retain-new-sibling-projection-progress')
  e.sql(case,"SELECT "+proof+';',label='retain-live-proof')
  e.sql(case,"DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM smarter_private.hand_continuations WHERE hand_number=8600001 AND sequence=1 AND permit_id='86600000-0000-0000-0000-000000000001') THEN RAISE EXCEPTION 'retain original did not progress';END IF;END$$;",label='retain-original-progress')
  # A same-table writer, terminal authority, and lease replacement still exclude retention.
  for label,lock in [('same-table','SELECT 1 FROM public.tables WHERE id='+table+' FOR UPDATE;'),('terminal','SELECT public.fn_ca_lock_settlement_lane_for_tournament('+tournament+');'),('lease','SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id='+tournament+' FOR UPDATE;')]:
   state=hand.private_snapshot(e,case,label+'-before')
   with holder(case,lock):
    code,_,err=e.sql(case,request,label='retain-exclusion-'+label,check=False)
    if not code or 'lock timeout' not in err:raise RuntimeError('retain exclusion lost:'+label+err)
   if state!=hand.private_snapshot(e,case,label+'-after'):raise RuntimeError('refused retain changed original:'+label)
  # Reverse direction: a successful retained save holds T shared until COMMIT.
  with holder(case,auth+call):
   code,_,err=e.sql(case,"BEGIN;SET LOCAL lock_timeout='150ms';SELECT public.fn_ca_lock_settlement_lane_for_tournament("+tournament+');ROLLBACK;',label='retain-blocks-terminal',check=False)
   if not code or 'lock timeout' not in err:raise RuntimeError('terminal bypassed retained save')
  e.sql(case,'BEGIN;'+auth+call+call+'ROLLBACK;',label='retain-identical-duplicate')
  e.sql(case,"DO $$BEGIN IF pg_get_functiondef('"+b.SIG+"'::regprocedure) IS DISTINCT FROM $post$"+after+"$post$ THEN RAISE EXCEPTION 'retain unexpected bytes';END IF;END$$;",label='retain-exact-postimage')
  e.sql(clean,file=root/MIGRATION,label='retain-full-boundaries-install')
  state=snapshot(clean,'retain-native-before');code,out,err=e.sql(clean,'BEGIN;'+(e.output/'opening.sql').read_text()+probe+'ROLLBACK;',label='retain-full-original-financial-boundaries',check=False)
  if code or err.count('CONTINUATION PASS:')!=37 or 'HAND_CONTINUATION_NATIVE_PASS' not in out:raise RuntimeError('retain full native failed:'+err)
  if state!=snapshot(clean,'retain-native-after'):raise RuntimeError('retain native rollback differs')
  e.discard(clean)
  e.report['retain_shared_lane']={'passed':True,'old_sibling_shared_lane_timeout':True,'new_same_original_progress':True,'same_table_exclusion':True,'lease_exclusion':True,'terminal_exclusion_both_directions':True,'exact_duplicate':True,'native_original_boundaries':37,'installation_refusals':4,'complete_rollback':True,'scope':'actual installed projection lane held open by sibling; not a reproduction of the unknown statistics-row holder'}
 finally:e.discard(case)
