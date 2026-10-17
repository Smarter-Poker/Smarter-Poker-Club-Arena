#!/usr/bin/env python3
"""Finite PG17 complete resolver qualification; no remote connections."""
from pathlib import Path
import subprocess,json,hashlib,shutil,tempfile,os,time,argparse
parser=argparse.ArgumentParser()
parser.add_argument('--pg-bin',type=Path,required=True)
parser.add_argument('--scratch',type=Path,required=True)
parser.add_argument('--migration',type=Path,default=Path(__file__).resolve().parents[2]/'supabase/migrations/20261016233224_weekly_routing_excludes_a_club_that_joined_after_its_week.sql')
args=parser.parse_args()
P=Path(__file__).resolve().parent/'fixtures/weekly-routing-period-membership'
PG=args.pg_bin.resolve();args.scratch.mkdir(parents=True,exist_ok=True)
O=Path(tempfile.mkdtemp(prefix='wr-',dir=args.scratch));C=O/'pg';C.mkdir();D=C/'data';started=False
assert not os.getenv('DATABASE_URL'), 'native qualification refuses a remote database URL'
PS=[str(PG/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(C),'-U','postgres','-d','postgres']
def run(cmd,s=None):
 r=subprocess.run(list(map(str,cmd)),input=s,text=True,capture_output=True,timeout=60);assert r.returncode==0,r.stdout+r.stderr;return r.stdout.strip()
def q(s,error=None):
 r=subprocess.run(PS,input=s,text=True,capture_output=True,timeout=60)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def uuid(s):return hashlib.md5(s.encode()).hexdigest()
def U(s):return "md5('"+s+"')::uuid"
u=U('union');A="'2026-10-05 07:00Z'::timestamptz";B="'2026-10-12 07:00Z'::timestamptz"
def call(fn='fn_resolve_accounting_routing_scope',a=A,b=B,kind="'union'",scope=u):return f"SELECT to_jsonb(club_ids) FROM {fn}({kind},{scope},{a},{b});"
def oracle(a=A,b=B):return f"SELECT coalesce(jsonb_agg(club_id ORDER BY club_id),'[]') FROM(SELECT uc.club_id FROM union_clubs uc WHERE uc.union_id={u} AND((isfinite({a}) AND isfinite({b}) AND {b}>{a}) IS NOT TRUE OR uc.joined_at IS NULL OR uc.joined_at<{b}) UNION SELECT rs.club_id FROM accounting_payable_earning_sources rs WHERE rs.coordinator_union_id={u} AND rs.earned_at>={a} AND rs.earned_at<{b})x;"
def check(change='',expected=None,a=A,b=B):
 s='BEGIN;'+change+'\n'+call(a=a,b=b)+oracle(a,b)+'ROLLBACK;';rows=q(s).splitlines();assert len(rows)==2,rows;assert json.loads(rows[0])==json.loads(rows[1]),rows
 if expected is not None:
  vals=[None if x is None else str(__import__('uuid').UUID(uuid(x))) for x in expected];vals=sorted(vals,key=lambda x:(x is None,x or ''));assert json.loads(rows[0])==vals,(rows[0],vals)
 return rows[0]
def fee(club='fee',source='fee-source',charged="'2026-10-04 07:00Z'",recognized="'2026-10-08 07:00Z'",owner=None):
 c='NULL' if club is None else U(club);o=u if owner is None else owner
 return f"INSERT INTO accounting_tournament_fee_sources(id,club_id,coordinator_union_id,tournament_id,charged_at,union_id,rake_credit)VALUES({U(source)},{c},{u},{U(source+'-event')},{charged},{o},3);INSERT INTO accounting_tournament_recognized_sources VALUES({U(source)},{U(source+'-event')},{recognized},'earned',3);INSERT INTO accounting_tournament_fee_recognitions VALUES({U(source+'-event')},{recognized},'recognized',{o});"
report={}
try:
 assert ' 17.' in run([PG/'postgres','--version'])
 run([PG/'initdb','-D',D,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with (D/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(C)+"'\nshared_buffers='8MB'\n")
 run([PG/'pg_ctl','-D',D,'-l',C/'server.log','-w','start']);started=True
 q('''CREATE ROLE service_role;CREATE TABLE fixture_control(caller boolean);INSERT INTO fixture_control VALUES(true);
 CREATE FUNCTION fn_caller_is_engine()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT caller FROM fixture_control$$;
 CREATE TABLE unions(id uuid PRIMARY KEY);CREATE TABLE clubs(id uuid PRIMARY KEY);
 CREATE TABLE union_clubs(union_id uuid,club_id uuid,joined_at timestamptz);CREATE INDEX membership_lookup ON union_clubs(union_id);
 CREATE TABLE fixture_cutoffs(club_id uuid,cutoff_at timestamptz);
 CREATE FUNCTION fn_ca_launch_accounting_club_cutoffs()RETURNS TABLE(club_id uuid,cutoff_at timestamptz) LANGUAGE sql STABLE AS $$SELECT * FROM fixture_cutoffs$$;
 CREATE TABLE accounting_cash_rake_sources(id uuid,rake_record_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,earned_at timestamptz,rake_credit numeric,contract jsonb);
 CREATE INDEX cash_club_coordinator_time ON accounting_cash_rake_sources(club_id,coordinator_union_id,earned_at);
 CREATE TABLE accounting_tournament_fee_sources(id uuid PRIMARY KEY,rake_record_id uuid,tournament_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,charged_at timestamptz,rake_credit numeric,contract jsonb);
 CREATE INDEX fee_club_coordinator ON accounting_tournament_fee_sources(club_id,coordinator_union_id);
 CREATE TABLE accounting_tournament_recognized_sources(source_id uuid PRIMARY KEY,tournament_id uuid,recognized_at timestamptz,disposition text,rake_credit numeric);
 CREATE TABLE accounting_tournament_fee_recognitions(tournament_id uuid PRIMARY KEY,recognized_at timestamptz,status text,union_id uuid);
 '''+(P/'earning-view.sql').read_text()+(P/'resolver-before.sql').read_text()+f";INSERT INTO unions VALUES({u});INSERT INTO clubs VALUES({U('standalone')});"+
 f"INSERT INTO union_clubs VALUES({u},{U('pre')},'2026-10-01'),({u},{U('late')},'2026-10-12 14:54:29Z'),({u},{U('edge')},{B}),({u},{U('legacy')},NULL);"+
 "REVOKE ALL ON FUNCTION fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz) FROM PUBLIC;")
 sig="'fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz)'::regprocedure"
 assert q(f'SELECT md5(pg_get_functiondef({sig}));')==hashlib.md5((P/'resolver-before.sql').read_bytes()).hexdigest()
 meta=q(f'SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl)FROM pg_proc WHERE oid={sig};')
 before=json.loads(q(call()));assert len(before)==4
 if args.migration:
  migration=args.migration.read_text();migration_sha=hashlib.sha256(migration.encode()).hexdigest()
  viewhash=q("SELECT md5(pg_get_viewdef('accounting_payable_earning_sources'::regclass,true));")
  if viewhash!='8eafef6d8f5e0d615b83baf14d1c0da4':
   (O/'NATIVE-VIEW-MISMATCH.sql').write_text(q("SELECT pg_get_viewdef('accounting_payable_earning_sources'::regclass,true);"));raise AssertionError('exact production view guard mismatch '+viewhash)
  q("""ALTER TABLE fixture_control ADD frozen boolean DEFAULT false, ADD boundary timestamptz, ADD sourceok boolean DEFAULT true, ADD generation text DEFAULT 'native-preserved-generation', ADD after_ddl text;
  CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT frozen FROM fixture_control$$;
  CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT boundary FROM fixture_control$$;
  CREATE SCHEMA smarter_private;CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text);
  CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT sourceok FROM fixture_control$$;
  CREATE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT generation FROM fixture_control$$;
  CREATE FUNCTION native_ddl_drift()RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN
   IF (SELECT after_ddl FROM fixture_control)='sources' AND md5(pg_get_functiondef('fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz)'::regprocedure))='e773d469ebeb010df4ac46757fca724e' THEN UPDATE fixture_control SET sourceok=false;END IF;
   IF (SELECT after_ddl FROM fixture_control)='generation' AND md5(pg_get_functiondef('fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz)'::regprocedure))='e773d469ebeb010df4ac46757fca724e' THEN UPDATE fixture_control SET generation='changed';END IF;
  END$$;CREATE EVENT TRIGGER native_guard_drift ON ddl_command_end EXECUTE FUNCTION native_ddl_drift();""")
  injections=[("SET LOCAL request.jwt.claims='{}';",'routing_period_operator_refused'),("SET LOCAL request.jwt.claim.role='service_role';",'routing_period_operator_refused'),('SET LOCAL ROLE service_role;','routing_period_operator_refused'),("SET LOCAL ca.break_window_migration_override='fixture';",'routing_period_freeze_or_override_refused'),('UPDATE fixture_control SET frozen=true;','routing_period_freeze_or_override_refused'),("UPDATE fixture_control SET boundary=clock_timestamp();",'routing_period_freeze_or_override_refused'),("INSERT INTO supabase_migrations.schema_migrations VALUES('20261016233224');",'routing_period_history_replay'),('UPDATE fixture_control SET sourceok=false;','routing_period_inventory_seal_required'),('UPDATE fixture_control SET generation=NULL;','routing_period_inventory_seal_required'),("GRANT EXECUTE ON FUNCTION fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz) TO PUBLIC;",'routing_period_preimage_authority_refused'),("ALTER FUNCTION fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz) SECURITY INVOKER;",'routing_period_preimage_authority_refused'),("ALTER FUNCTION fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz) STABLE;",'routing_period_preimage_authority_refused'),("ALTER FUNCTION fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz) SET search_path=pg_catalog;",'routing_period_preimage_authority_refused'),("ALTER FUNCTION fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz) OWNER TO service_role;",'routing_period_preimage_authority_refused'),("ALTER VIEW accounting_payable_earning_sources RENAME COLUMN source_id TO drifted_source_id;",'routing_period_exact_payable_view_required'),("UPDATE fixture_control SET after_ddl='sources';",'routing_period_inventory_seal_changed'),("UPDATE fixture_control SET after_ddl='generation';",'routing_period_inventory_seal_changed')]
  for inject,error in injections:
   q(migration.replace('BEGIN;','BEGIN;'+inject,1),error)
   assert q(f'SELECT md5(pg_get_functiondef({sig}));')==hashlib.md5((P/'resolver-before.sql').read_bytes()).hexdigest()
   assert q("SELECT sourceok AND generation='native-preserved-generation'FROM fixture_control;")=='t'
  q(migration.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'native_forced_rollback';END$$;COMMIT;"),'native_forced_rollback')
  assert q(f'SELECT md5(pg_get_functiondef({sig}));')==hashlib.md5((P/'resolver-before.sql').read_bytes()).hexdigest()
  # A real other backend owns the scheduler key; the actual installer must refuse.
  scheduler=subprocess.Popen(PS,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  scheduler.stdin.write("BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0));SELECT pg_sleep(1);COMMIT;\n");scheduler.stdin.close()
  for _ in range(100):
   if q("SELECT count(*)FROM pg_locks WHERE locktype='advisory' AND granted;")!='0':break
   time.sleep(.01)
  q(migration,'routing_period_scheduler_owned');scheduler.wait(timeout=10);assert scheduler.returncode==0
  q(migration)
  q(migration.replace('BEGIN;',"BEGIN;INSERT INTO supabase_migrations.schema_migrations VALUES('20261016233224');",1),'routing_period_history_replay')
  q(migration,'routing_period_preimage_authority_refused')
  report.update(actual_guarded_migration_qualified=True,migration_sha256=migration_sha,exact_native_view_md5=viewhash,installer_guard_refusals=len(injections)+3,atomic_rollback_and_postsource_generation_refusals=True)
 else:q((P/'resolver-after.sql').read_text())
 assert meta==q(f'SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl)FROM pg_proc WHERE oid={sig};')
 check(expected=['pre','legacy']);report['late_join_fail_before_pass_after']=True
 cases=1
 for a,b in [('NULL::timestamptz',B),(A,'NULL::timestamptz'),("'-infinity'::timestamptz",B),(A,"'infinity'::timestamptz"),(B,A),(A,A)]:check(expected=['pre','late','edge','legacy'],a=a,b=b);cases+=1
 cash=lambda club,t=A,owner=u:f"INSERT INTO accounting_cash_rake_sources(id,club_id,coordinator_union_id,earned_at,rake_credit)VALUES(md5(random()::text)::uuid,{'NULL' if club is None else U(club)},{owner},{t},1);"
 check(cash('late')+cash('removed')+cash('union')+cash(None),['pre','legacy','late','removed','union',None]);cases+=1
 for t,ok in [(A,True),(B,False),("NULL",False),("'infinity'",False),("'2026-10-04 07:00Z'",False)]:check(cash('cash',t),['pre','legacy']+(['cash']if ok else[]));cases+=1
 check(cash('foreign',A,U('other'))+cash('bank',A,'NULL'),['pre','legacy']);cases+=1
 for at,ok in [("'2026-10-05 07:00Z'",True),("'2026-10-05 07:00:01Z'",False),('NULL',True)]:check(cash('cash')+f"INSERT INTO fixture_cutoffs VALUES({U('cash')},{at});",['pre','legacy']+(['cash']if ok else[]));cases+=1
 check(fee(),['pre','legacy','fee']);cases+=1
 fee_cases=[("UPDATE accounting_tournament_recognized_sources SET disposition='refused';",False),("UPDATE accounting_tournament_recognized_sources SET rake_credit=4;",False),("UPDATE accounting_tournament_fee_recognitions SET union_id=NULL;",False),("UPDATE accounting_tournament_fee_sources SET union_id=NULL;UPDATE accounting_tournament_fee_recognitions SET union_id=NULL;",True),("UPDATE accounting_tournament_fee_recognitions SET status='pending';",False),("UPDATE accounting_tournament_fee_recognitions SET recognized_at='2026-10-09';",False),("UPDATE accounting_tournament_recognized_sources SET recognized_at="+B+";UPDATE accounting_tournament_fee_recognitions SET recognized_at="+B+';',False),("UPDATE accounting_tournament_recognized_sources SET recognized_at="+A+";UPDATE accounting_tournament_fee_recognitions SET recognized_at="+A+';',True),(f"INSERT INTO fixture_cutoffs VALUES({U('fee')},'2026-10-05 07:00Z');",False),(f"INSERT INTO fixture_cutoffs VALUES({U('fee')},'2026-10-04 07:00Z');",True),(f"INSERT INTO fixture_cutoffs VALUES({U('fee')},'2026-10-04 07:00Z');UPDATE accounting_tournament_fee_sources SET charged_at=NULL;",False),("UPDATE accounting_tournament_fee_sources SET charged_at=NULL;",True)]
 for change,ok in fee_cases:check(fee()+change,['pre','legacy']+(['fee']if ok else[]));cases+=1
 check(cash('fee',"'2026-10-04 07:00Z'")+fee(charged="'2026-10-05 07:00Z'")+f"INSERT INTO fixture_cutoffs VALUES({U('fee')},'2026-10-05 07:00Z');",['pre','legacy','fee']);cases+=1
 check(fee(None),['pre','legacy',None]);cases+=1
 for coordinator in ['NULL',U('other')]:check(fee()+f'UPDATE accounting_tournament_fee_sources SET coordinator_union_id={coordinator};',['pre','legacy']);cases+=1
 check(fee(charged="'2026-10-09 07:00Z'")+f"INSERT INTO fixture_cutoffs VALUES({U('fee')},'2026-10-09 07:00Z');",['pre','legacy']);cases+=1
 check(cash(None)+fee(None),['pre','legacy',None]);cases+=1
 check(fee('late'),['pre','legacy','late']);cases+=1
 check(cash('cash')+f"INSERT INTO fixture_cutoffs VALUES({U('cash')},NULL),({U('cash')},'2026-10-09');",['pre','legacy','cash']);cases+=1
 # Same finite interval guards preserve legacy input semantics outside the supported period.
 for a,b in [("'-infinity'::timestamptz",B),(A,"'infinity'::timestamptz")]:check(cash('cash',"'-infinity'")+cash('inf',"'infinity'"),a=a,b=b);cases+=1
 q(call(kind='NULL'),'invalid_accounting_routing_scope');q(call(kind="'wrong'"),'invalid_accounting_routing_scope');q(call(scope=U('missing')),'invalid_accounting_routing_scope');q('UPDATE fixture_control SET caller=false;'+call(),'service_role_required');q('UPDATE fixture_control SET caller=true;')
 got=json.loads(q(f"SELECT row_to_json(x)FROM fn_resolve_accounting_routing_scope('club',{U('standalone')},{A},{B})x;"));assert got['club_ids']==[str(__import__('uuid').UUID(uuid('standalone')))] and got['scope_key']=='club:'+str(__import__('uuid').UUID(uuid('standalone'))) and got['union_id']is None
 # Actual held-lock ordering: waiter reads membership committed by previous owner.
 key=f"hashtextextended('union-accounting:'||{u}::text||':'||extract(epoch FROM {A})::text||':'||extract(epoch FROM {B})::text,0)"
 holder=subprocess.Popen(PS,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 holder.stdin.write(f"BEGIN;SELECT pg_advisory_xact_lock({key});SELECT pg_sleep(1);INSERT INTO union_clubs VALUES({u},{U('afterlock')},'2026-10-01');COMMIT;\n");holder.stdin.close()
 for _ in range(100):
  if q("SELECT count(*)FROM pg_locks WHERE locktype='advisory' AND granted;")!='0':break
  time.sleep(.01)
 waiter=subprocess.Popen(PS,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 out,err=waiter.communicate(call(),timeout=10);assert waiter.returncode==0,err;assert str(__import__('uuid').UUID(uuid('afterlock')))in json.loads(out),out;holder.wait(timeout=10);assert holder.returncode==0,holder.stderr.read()
 q(f"DELETE FROM union_clubs WHERE club_id={U('afterlock')};")
 # Proportional volume: same few eligible clubs, many duplicate source rows.
 q(f"INSERT INTO accounting_cash_rake_sources(id,club_id,coordinator_union_id,earned_at,rake_credit) SELECT md5(n::text)::uuid,{U('cash')},{u},{A}+interval '1 hour',1 FROM generate_series(1,12000)n;"+fee('cash')+"INSERT INTO accounting_tournament_fee_sources SELECT md5(n::text||'fee')::uuid,rake_record_id,tournament_id,player_id,club_id,union_id,coordinator_union_id,charged_at,rake_credit,contract FROM accounting_tournament_fee_sources CROSS JOIN generate_series(1,6000)n;ANALYZE;")
 check(expected=['pre','legacy','cash'])
 component=(P/'earning-clubs.sql').read_text().replace('p_scope_id',u).replace('p_period_start',A).replace('p_period_end',B)
 old=f"SELECT uc.club_id FROM union_clubs uc WHERE uc.union_id={u} UNION SELECT rs.club_id FROM accounting_payable_earning_sources rs WHERE rs.coordinator_union_id={u} AND rs.earned_at>={A} AND rs.earned_at<{B};"
 plans=[json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+s))[0]for s in[old,component]]
 def nodes(n):
  yield n
  for x in n.get('Plans',[]):yield from nodes(x)
 ns=list(nodes(plans[1]['Plan']));assert any(n['Node Type']=='Recursive Union'for n in ns)
 fee_reads=[n for n in ns if n.get('Relation Name')=='accounting_tournament_fee_sources' and n.get('Actual Rows',0)>0]
 # Club keywalk may read one fee row; accepted-cash must avoid reading 6001 fee receipts.
 assert sum(n.get('Actual Rows',0)*n.get('Actual Loops',0)for n in fee_reads)<=4,fee_reads
 blocks=lambda x:sum(x['Plan'].get(k,0)for k in['Shared Hit Blocks','Shared Read Blocks'])
 assert blocks(plans[1])<blocks(plans[0]),(blocks(plans[0]),blocks(plans[1]))
 (O/'native-plans.json').write_text(json.dumps(plans,indent=2)+'\n')
 actual=q(f'SELECT md5(pg_get_functiondef({sig}));');assert actual==hashlib.md5((P/'resolver-after.sql').read_bytes()).hexdigest()
 report.update(evidence_directory=str(O),qualification='passed',boundary_cases=cases,actual_complete_resolver=True,exact_catalog_view_oracle=True,metadata_unchanged=True,private_acl_preserved=True,auth_invalid_scope_standalone_checked=True,held_lock_before_membership_read=True,union_own_and_null_club_retained=True,cash_rows=12000,fee_rows=6001,before_blocks=blocks(plans[0]),after_blocks=blocks(plans[1]),after_md5=actual,production_financial_operation_qualified=False)
 (O/'native-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
finally:
 if started:run([PG/'pg_ctl','-D',D,'-m','fast','-w','stop'])
 shutil.rmtree(C)
