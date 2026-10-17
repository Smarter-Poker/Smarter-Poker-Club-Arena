#!/usr/bin/env python3
"""Exact full helper/statement functions; finite native-only PG17 qualification."""
import argparse,hashlib,json,os,shutil,subprocess,sys,tempfile
from pathlib import Path
R=Path(__file__).resolve().parents[2];default_fixtures=R/'scripts/ci/fixtures/weekly-cash-first-clubs';default_fixtures=default_fixtures if default_fixtures.is_dir()else Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',default=os.getenv('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'if sys.platform=='darwin'else'/usr/lib/postgresql/17/bin'));ap.add_argument('--scratch',type=Path);ap.add_argument('--migration',type=Path);ap.add_argument('--installer-only',action='store_true');ap.add_argument('--fixtures',type=Path,default=default_fixtures);a=ap.parse_args();F=a.fixtures.resolve();scratch=(a.scratch or F).resolve();assert not os.getenv('DATABASE_URL')
if sys.platform=='darwin':assert str(scratch).startswith('/Volumes/SmarterWork/agent-work/')
C=Path(tempfile.mkdtemp(prefix='native-',dir=scratch));D=C/'d';PG=Path(a.pg_bin);started=False
PS=[PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',C,'-U','postgres','-d','postgres']
def run(cmd,s=None,error=None):
 r=subprocess.run(list(map(str,cmd)),input=s,text=True,capture_output=True,timeout=90)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(s,error=None):return run(PS,s,error)
def U(x):return "md5('"+x+"')::uuid"
u=U('union');A="'2026-10-05 07:00Z'::timestamptz";B="'2026-10-12 07:00Z'::timestamptz"
def uid(x):return str(__import__('uuid').UUID(hashlib.md5(x.encode()).hexdigest()))
H='fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)';S='fn_issue_scope_weekly_accounting(text,uuid,timestamptz,timestamptz)'
files={n:(F/(n+'.sql')).read_text()for n in ['helper-before','helper-after','statement-before','statement-after']}
def install(which):return files['helper-'+which]+';\n'+files['statement-'+which]+';\n'
def hcall():return f"SELECT coalesce(jsonb_agg(club_id ORDER BY club_id),'[]')FROM fn_accounting_week_clubs({u},NULL,{A},{B});"
def oracle():return f"""SELECT coalesce(jsonb_agg(club_id ORDER BY club_id),'[]')FROM(
 SELECT rs.club_id FROM accounting_payable_earning_sources rs WHERE rs.coordinator_union_id={u} AND rs.earned_at>={A} AND rs.earned_at<{B}
 UNION SELECT (h.after_terms->>'club_id')::uuid FROM accounting_agreement_history h WHERE h.entity_type='union_clubs'AND h.after_terms->>'union_id'={u}::text AND((h.observed_at<={A} AND NOT EXISTS(SELECT FROM accounting_agreement_history newer WHERE newer.entity_type=h.entity_type AND newer.entity_key=h.entity_key AND newer.observed_at<={A} AND(newer.observed_at,newer.id)>(h.observed_at,h.id)))OR(h.observed_at>{A} AND h.observed_at<{B}))
 UNION SELECT pc.club_id FROM accounting_rakeback_period_calculations pc WHERE pc.coordinator_union_id={u} AND pc.period_start=({A} AT TIME ZONE 'America/Los_Angeles')::date AND pc.period_end=({B} AT TIME ZONE 'America/Los_Angeles')::date-1
 UNION SELECT sp.club_id FROM settlement_periods sp WHERE sp.union_id={u} AND sp.start_at={A} AND sp.end_at={B})allclubs WHERE club_id IS NOT NULL AND club_id<>{u};"""
def fee(club='fee',source='fee-source',owner=None):
 c='NULL'if club is None else U(club);o=u if owner is None else owner
 return f"INSERT INTO accounting_tournament_fee_sources(id,club_id,coordinator_union_id,tournament_id,charged_at,union_id,rake_credit)VALUES({U(source)},{c},{u},{U(source+'-event')},'2026-10-04 07:00Z',{o},3);INSERT INTO accounting_tournament_recognized_sources VALUES({U(source)},{U(source+'-event')},'2026-10-08 07:00Z','earned',3);INSERT INTO accounting_tournament_fee_recognitions VALUES({U(source+'-event')},'2026-10-08 07:00Z','recognized',{o});"
def cash(club='cash',t=A,owner=u):return f"INSERT INTO accounting_cash_rake_sources(id,club_id,coordinator_union_id,earned_at,rake_credit)VALUES(md5(random()::text)::uuid,{'NULL'if club is None else U(club)},{owner},{t},1);"
cases=0
# Whole-function old/new output and independent exact-view/history oracle.
def parity(change='',expected=None):
 global cases
 outs=[]
 for which in ['before','after']:
  raw=q('BEGIN;'+install(which)+change+hcall()+oracle()+'ROLLBACK;').splitlines();assert len(raw)==2,raw;assert json.loads(raw[0])==json.loads(raw[1]),raw
  if expected is not None:assert json.loads(raw[0])==sorted(uid(z)for z in expected),(raw,expected)
  outs.append(raw[0])
 assert outs[0]==outs[1],outs;cases+=1
# Statement calls real full function and helper; dependencies deterministic fixture-only documents.
def statement(which,change='',clubs=None,error=None,standalone=False):
 clubs=clubs or[];scope=U('standalone')if standalone else u;kind='club'if standalone else'union';union='NULL'if standalone else u
 periods=''.join(f"INSERT INTO settlement_periods VALUES({U('period-'+c)},{U(c)},{union},{A},{B},'settled');"for c in clubs)
 validated=f"SELECT set_config('app.accounting_validated_scope','{kind}:'||{scope}::text||':'||{A}::text||':'||{B}::text,true);"
 call=f"SELECT fn_issue_scope_weekly_accounting('{kind}',{scope},{A},{B});"
 docs="SELECT coalesce(jsonb_agg(jsonb_build_array(club_id,period_id,invoice_type,from_entity_id,to_entity_id,gross_amount,net_amount,deductions,breakdown,status,message_sent)ORDER BY club_id),'[]')FROM settlement_invoices;"
 return q('BEGIN;'+install(which)+change+periods+validated+call+docs+'ROLLBACK;',error).splitlines()
report={}
try:
 assert ' 17.'in run([PG/'postgres','--version']);run([PG/'initdb','-D',D,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with(D/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(C)+"'\nshared_buffers='8MB'\n")
 run([PG/'pg_ctl','-D',D,'-l',C/'server.log','-w','start']);started=True
 q("""CREATE TABLE fixture_control(caller boolean,ready boolean,delivered boolean,users integer);INSERT INTO fixture_control VALUES(true,true,true,1);
 CREATE FUNCTION fn_caller_is_engine()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT caller FROM fixture_control$$;
 CREATE TABLE fixture_cutoffs(club_id uuid PRIMARY KEY,cutoff_at timestamptz);
 CREATE FUNCTION fn_ca_launch_accounting_cutoff(text,uuid)RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT cutoff_at FROM fixture_cutoffs WHERE club_id=$2$$;
 CREATE FUNCTION fn_ca_launch_accounting_club_cutoffs()RETURNS TABLE(club_id uuid,cutoff_at timestamptz)LANGUAGE sql STABLE AS $$SELECT * FROM fixture_cutoffs$$;
 CREATE TABLE unions(id uuid PRIMARY KEY);CREATE TABLE clubs(id uuid PRIMARY KEY,is_union boolean);
 CREATE TABLE union_clubs(union_id uuid,club_id uuid,joined_at timestamptz);
 CREATE TABLE accounting_cash_rake_sources(id uuid,rake_record_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,earned_at timestamptz,rake_credit numeric,contract jsonb);
 CREATE INDEX accounting_cash_rake_sources_club_coordinator_earned ON accounting_cash_rake_sources(club_id,coordinator_union_id,earned_at);
 CREATE TABLE accounting_tournament_fee_sources(id uuid PRIMARY KEY,rake_record_id uuid,tournament_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,charged_at timestamptz,rake_credit numeric,contract jsonb);
 CREATE INDEX accounting_tournament_fee_sources_coordinator_club ON accounting_tournament_fee_sources(coordinator_union_id,club_id)WHERE coordinator_union_id IS NOT NULL;
 CREATE INDEX accounting_tournament_fee_sources_club_event ON accounting_tournament_fee_sources(club_id,tournament_id);
 CREATE TABLE accounting_tournament_recognized_sources(source_id uuid PRIMARY KEY,tournament_id uuid,recognized_at timestamptz,disposition text,rake_credit numeric);
 CREATE INDEX accounting_tournament_recognized_sources_week ON accounting_tournament_recognized_sources(recognized_at,tournament_id);
 CREATE TABLE accounting_tournament_fee_recognitions(tournament_id uuid PRIMARY KEY,recognized_at timestamptz,status text,union_id uuid);
 CREATE INDEX accounting_tournament_fee_recognitions_week ON accounting_tournament_fee_recognitions(recognized_at,tournament_id);
 CREATE TABLE accounting_agreement_history(id bigint,entity_key text,entity_type text,observed_at timestamptz,after_terms jsonb);
 CREATE TABLE accounting_rakeback_period_calculations(club_id uuid,coordinator_union_id uuid,period_start date,period_end date);
 CREATE TABLE settlement_periods(id uuid PRIMARY KEY,club_id uuid,union_id uuid,start_at timestamptz,end_at timestamptz,status text);
 CREATE TABLE settlement_invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,period_id uuid,invoice_type text,from_entity_type text,from_entity_id text,to_entity_type text,to_entity_id text,gross_amount numeric,net_amount numeric,deductions numeric,breakdown jsonb,status text,notes text,message_sent boolean DEFAULT false);
 CREATE TABLE accounting_invoice_deliveries(invoice_id uuid,recipient_id uuid,message_id uuid,notification_id uuid);
 CREATE TABLE social_messages(id uuid,media_metadata jsonb,message_type text);CREATE TABLE notifications(id uuid,user_id uuid,metadata jsonb);
 CREATE FUNCTION fn_union_week_start(timestamptz)RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT date_trunc('week',$1 AT TIME ZONE 'America/Los_Angeles')AT TIME ZONE 'America/Los_Angeles'$$;
 CREATE FUNCTION fn_club_weekly_accounting_summary(uuid)RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('ready_to_issue',ready,'total_rake_funding',100,'retained_by_club',30,'total_paid_by_club',70)FROM fixture_control$$;
 CREATE FUNCTION fn_deliver_accounting_invoice(uuid)RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN UPDATE settlement_invoices SET message_sent=(SELECT delivered FROM fixture_control)WHERE id=$1;RETURN jsonb_build_object('success',(SELECT delivered FROM fixture_control));END$$;
 CREATE FUNCTION fn_accounting_party_users(text,uuid)RETURNS TABLE(user_id uuid)LANGUAGE sql STABLE AS $$SELECT md5(n::text)::uuid FROM fixture_control CROSS JOIN LATERAL generate_series(1,users)n$$;
 """+(F/'actual-earning-view.sql').read_text()+(F/'resolver-current.sql').read_text()+';\n'+install('before')+
 f"INSERT INTO unions VALUES({u});INSERT INTO clubs VALUES({U('standalone')},false),({U('union')},true);"+
 f"REVOKE ALL ON FUNCTION {H} FROM PUBLIC;REVOKE ALL ON FUNCTION {S} FROM PUBLIC;")
 metadata=q(f"SELECT jsonb_agg(jsonb_build_array(oid::regprocedure::text,proowner,prosecdef,provolatile,proconfig,proacl)ORDER BY oid::regprocedure::text)FROM pg_proc WHERE oid IN('{H}'::regprocedure,'{S}'::regprocedure);")
 pins=json.loads((F/'replacements.json').read_text())
 for p in pins:assert q(f"SELECT md5(pg_get_functiondef('{H if p['kind']=='helper'else S}'::regprocedure));")==p['before']
 default_migration=R/'supabase/migrations/20261017012658_weekly_coordinator_skips_redundant_earning_club_witnesses.sql'
 migration_path=a.migration or(default_migration if default_migration.is_file()else F/'20261017012658_weekly_coordinator_skips_redundant_earning_club_witnesses.sql')
 migration=migration_path.read_text()
 assert q("SELECT md5(pg_get_viewdef('accounting_payable_earning_sources'::regclass,true));")=='8eafef6d8f5e0d615b83baf14d1c0da4'
 q("""ALTER TABLE fixture_control ADD frozen boolean DEFAULT false,ADD boundary timestamptz,ADD sourceok boolean DEFAULT true,ADD generation text DEFAULT 'preserved',ADD after_ddl text;
 CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT frozen FROM fixture_control$$;
 CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT boundary FROM fixture_control$$;
 CREATE SCHEMA smarter_private;CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text);
 CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT sourceok FROM fixture_control$$;
 CREATE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT generation FROM fixture_control$$;
 CREATE ROLE fixture_owner;
 CREATE FUNCTION native_ddl_drift()RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN
  IF md5(pg_get_functiondef('fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure))='e5ec460a159bfb46735d99be1a0738a3' THEN
   IF(SELECT after_ddl FROM fixture_control)='source' THEN UPDATE fixture_control SET sourceok=false;END IF;
   IF(SELECT after_ddl FROM fixture_control)='generation' THEN UPDATE fixture_control SET generation='changed';END IF;
  END IF;
 END$$;CREATE EVENT TRIGGER native_guard_drift ON ddl_command_end EXECUTE FUNCTION native_ddl_drift();""")
 refusals=[("SET LOCAL request.jwt.claims='{}';",'operator_refused'),("SET LOCAL request.jwt.claim.role='service_role';",'operator_refused'),('SET LOCAL ROLE fixture_owner;','operator_refused'),("SET LOCAL ca.break_window_migration_override='fixture';",'freeze_or_override_refused'),('UPDATE fixture_control SET frozen=true;','freeze_or_override_refused'),('UPDATE fixture_control SET boundary=clock_timestamp();','freeze_or_override_refused'),("INSERT INTO supabase_migrations.schema_migrations VALUES('20261017012658');",'history_replay'),('UPDATE fixture_control SET sourceok=false;','inventory_seal_required'),('UPDATE fixture_control SET generation=NULL;','inventory_seal_required'),("ALTER VIEW accounting_payable_earning_sources RENAME COLUMN source_id TO drifted_source_id;",'view_drift'),("UPDATE fixture_control SET after_ddl='source';",'inventory_seal_changed'),("UPDATE fixture_control SET after_ddl='generation';",'inventory_seal_changed')]
 for sig0,kind in[(H,'helper'),(S,'statement')]:
  for ddl in['GRANT EXECUTE ON FUNCTION '+sig0+' TO PUBLIC;','ALTER FUNCTION '+sig0+' SECURITY INVOKER;','ALTER FUNCTION '+sig0+' SET search_path=pg_catalog;','ALTER FUNCTION '+sig0+' OWNER TO fixture_owner;']:
   refusals.append((ddl,kind+'_preimage_authority_refused'))
 for inject,error in refusals:
  q(migration.replace('BEGIN;','BEGIN;'+inject,1),'weekly_club_reads_'+error)
  for pin in pins:assert q("SELECT md5(pg_get_functiondef('"+(H if pin['kind']=='helper'else S)+"'::regprocedure));")==pin['before']
  assert q("SELECT sourceok AND generation='preserved'FROM fixture_control;")=='t'
 q(migration.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'native_forced_rollback';END$$;COMMIT;"),'native_forced_rollback')
 for pin in pins:assert q("SELECT md5(pg_get_functiondef('"+(H if pin['kind']=='helper'else S)+"'::regprocedure));")==pin['before']
 holder=subprocess.Popen(list(map(str,PS)),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 holder.stdin.write("BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0));SELECT pg_sleep(1);COMMIT;\n");holder.stdin.close()
 import time
 for _ in range(100):
  if q("SELECT count(*)FROM pg_locks WHERE locktype='advisory' AND granted;")!='0':break
  time.sleep(.01)
 q(migration,'weekly_club_reads_scheduler_owned');holder.wait(timeout=10);assert holder.returncode==0
 q(migration)
 q(migration.replace('BEGIN;',"BEGIN;INSERT INTO supabase_migrations.schema_migrations VALUES('20261017012658');",1),'weekly_club_reads_history_replay')
 q(migration,'weekly_club_reads_helper_preimage_authority_refused')
 report.update(actual_migration_sha256=hashlib.sha256(migration.encode()).hexdigest(),guard_refusals=len(refusals)+3,atomic_both_function_rollback=True,source40_generation_preserved=True,positive_install_and_replay_refusal=True)
 assert metadata==q(f"SELECT jsonb_agg(jsonb_build_array(oid::regprocedure::text,proowner,prosecdef,provolatile,proconfig,proacl)ORDER BY oid::regprocedure::text)FROM pg_proc WHERE oid IN('{H}'::regprocedure,'{S}'::regprocedure);")
 for p in pins:assert q(f"SELECT md5(pg_get_functiondef('{H if p['kind']=='helper'else S}'::regprocedure));")==p['after']
 if a.installer_only:
  report.update(qualification='passed',metadata_unchanged=True,pins=[{k:v for k,v in pin.items()if k not in['old','new']}for pin in pins],production_financial_operation_qualified=False)
  (scratch/'native-installer-final-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report));sys.exit(0)
 parity(expected=[])
 parity(cash()+fee('cash'),['cash']);parity(fee(),['fee'])
 for t,yes in[(A,True),(B,False),("NULL",False),("'infinity'",False),("'2026-10-04 07:00Z'",False)]:parity(cash(t=t),['cash']if yes else[])
 for at,yes in[("'2026-10-05 07:00Z'",True),("'2026-10-05 07:00:01Z'",False),('NULL',True)]:parity(cash()+f"INSERT INTO fixture_cutoffs VALUES({U('cash')},{at});",['cash']if yes else[])
 parity(cash(owner=U('other'))+cash('bank',owner='NULL'),[]);parity(cash(None)+fee(None),[]);parity(cash('union')+fee('union'),[])
 changes=[("UPDATE accounting_tournament_recognized_sources SET disposition='refused';",False),("UPDATE accounting_tournament_recognized_sources SET rake_credit=4;",False),("UPDATE accounting_tournament_fee_recognitions SET status='pending';",False),("UPDATE accounting_tournament_fee_recognitions SET union_id=NULL;",False),("UPDATE accounting_tournament_fee_sources SET union_id=NULL;UPDATE accounting_tournament_fee_recognitions SET union_id=NULL;",True),("UPDATE accounting_tournament_fee_sources SET coordinator_union_id=NULL;",False),("UPDATE accounting_tournament_fee_recognitions SET recognized_at='2026-10-09';",False),(f"UPDATE accounting_tournament_recognized_sources SET recognized_at={B};UPDATE accounting_tournament_fee_recognitions SET recognized_at={B};",False),(f"UPDATE accounting_tournament_recognized_sources SET recognized_at={A};UPDATE accounting_tournament_fee_recognitions SET recognized_at={A};",True),(f"INSERT INTO fixture_cutoffs VALUES({U('fee')},'2026-10-05 07:00Z');",False),(f"INSERT INTO fixture_cutoffs VALUES({U('fee')},'2026-10-04 07:00Z');",True)]
 for change,yes in changes:parity(fee()+change,['fee']if yes else[])
 parity(cash('fee',"'2026-10-04 07:00Z'")+fee()+f"INSERT INTO fixture_cutoffs VALUES({U('fee')},'2026-10-04 08:00Z');UPDATE accounting_tournament_fee_sources SET charged_at='2026-10-05';",['fee'])
 history=f"INSERT INTO accounting_agreement_history VALUES(1,'departed','union_clubs','2026-10-01',jsonb_build_object('club_id',{U('departed')},'union_id',{u})),(2,'departed','union_clubs','2026-10-04',jsonb_build_object('club_id',{U('departed')},'union_id',{U('other')})),(3,'member','union_clubs','2026-10-01',jsonb_build_object('club_id',{U('member')},'union_id',{u})),(4,'member','union_clubs','2026-10-08',jsonb_build_object('club_id',{U('member')},'union_id',{U('other')})),(5,'during','union_clubs','2026-10-08',jsonb_build_object('club_id',{U('during')},'union_id',{u})),(6,'later','union_clubs','2026-10-12 07:00Z',jsonb_build_object('club_id',{U('later')},'union_id',{u}));"
 parity(history,['member','during']);parity(f"INSERT INTO accounting_rakeback_period_calculations VALUES({U('cert')},{u},'2026-10-05','2026-10-11');INSERT INTO settlement_periods VALUES({U('sp')},{U('period')},{u},{A},{B},'settled');",['cert','period'])
 # Whole statement output and actual invoice fields agree, including union-own and standalone scopes.
 stmtcases=[(cash(),['cash'],False),(fee(),['fee'],False),(cash('union')+cash(),['cash'],False),(history,['member','during'],False),('', ['standalone'],True)]
 for change,clubs,standalone in stmtcases:
  old=statement('before',change,clubs,standalone=standalone);new=statement('after',change,clubs,standalone=standalone);assert old==new,(old,new);assert len(json.loads(new[-1]))==len(clubs);cases+=1
 for change,clubs,error in[(cash(),[],'weekly_statement_period_missing_or_duplicated'),(cash(None),[],'weekly_statement_period_missing_or_duplicated'),(cash(),['cash'],'club_weekly_statement_requires_reconciliation'),(cash(),['cash'],'club_weekly_statement_delivery_incomplete')]:
  if error.endswith('reconciliation'):change+='UPDATE fixture_control SET ready=false;'
  if error.endswith('delivery_incomplete'):change+='UPDATE fixture_control SET delivered=false;'
  for which in['before','after']:statement(which,change,clubs,error=error)
  cases+=1
 # Authentication and unsupported periods retain the same refusal before discovery.
 for which in['before','after']:
  q('BEGIN;'+install(which)+'UPDATE fixture_control SET caller=false;'+hcall(),'service_role_required')
  for bad in ['NULL::timestamptz',"'infinity'::timestamptz",B]:q('BEGIN;'+install(which)+f"SELECT * FROM fn_accounting_week_clubs({u},NULL,{bad},{B});",'invalid_accounting_scope')
  q('BEGIN;'+install(which)+f"SELECT fn_issue_scope_weekly_accounting('union',{u},NULL,{B});",'weekly_statement_requires_closed_week')
  q('BEGIN;'+install(which)+f"SELECT fn_issue_scope_weekly_accounting('union',{u},{A},{B});",'weekly_statement_requires_validated_scope')
 # Actual full functions with nested ANALYZE plans, duplicate cash and unrelated event volume.
 q(f"INSERT INTO accounting_cash_rake_sources(id,club_id,coordinator_union_id,earned_at,rake_credit)SELECT md5(n::text)::uuid,{U('cash')},{u},{A}+interval '1 hour',1 FROM generate_series(1,12000)n;"+fee('cash')+"UPDATE accounting_tournament_recognized_sources SET recognized_at='2026-09-01';UPDATE accounting_tournament_fee_recognitions SET recognized_at='2026-09-01';"+
 f"INSERT INTO accounting_tournament_fee_recognitions SELECT md5(n::text||'event')::uuid,{A}+interval '1 hour','recognized',{U('other')} FROM generate_series(1,8000)n;ANALYZE;")
 plans=[]
 for which in['before','after']:
  offset=(C/'server.log').stat().st_size
  settings="LOAD 'auto_explain';SET auto_explain.log_min_duration=0;SET auto_explain.log_nested_statements=on;SET auto_explain.log_analyze=on;SET auto_explain.log_buffers=on;SET auto_explain.log_timing=off;SET auto_explain.log_format=json;"
  q(settings+install(which)+hcall());text=(C/'server.log').read_text()[offset:]
  decoder=json.JSONDecoder();found=[]
  for part in text.split('plan:\n')[1:]:
   try:z=decoder.raw_decode(part.lstrip())[0]
   except ValueError:continue
   if 'SELECT COALESCE(array_agg(w.id ORDER BY w.id)'in z.get('Query Text',''):found.append(z)
  assert len(found)==1,text[-3000:];plans.append(found[0])
 def nodes(n):
  yield n
  for child in n.get('Plans',[]):yield from nodes(child)
 scans=lambda p:[n for n in nodes(p['Plan'])if n.get('Relation Name')=='accounting_tournament_fee_recognitions']
 before_events=sum(n.get('Actual Rows',0)*n.get('Actual Loops',0)for n in scans(plans[0]));after_events=sum(n.get('Actual Rows',0)*n.get('Actual Loops',0)for n in scans(plans[1]));assert before_events>=8000 and after_events==0,(before_events,after_events)
 blocks=lambda p:p['Plan'].get('Shared Hit Blocks',0)+p['Plan'].get('Shared Read Blocks',0)
 assert blocks(plans[1])<blocks(plans[0]),(blocks(plans[0]),blocks(plans[1]))
 # Exact statement discovery query; full actual statement already exercised above.
 for label in['before','after']:
  source=files['statement-'+label];x=source[source.index('SELECT COALESCE(array_agg(x.club_id'):source.index(' FOREACH club IN ARRAY clubs')];x=x.replace(' INTO clubs','').replace('scope.union_id',u).replace('scope.standalone_club_id','NULL::uuid').replace('p_from',A).replace('p_to',B)
  q(install(label));plan=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+x))[0];plans.append(plan)
 assert blocks(plans[3])<blocks(plans[2]),(blocks(plans[2]),blocks(plans[3]))
 (scratch/'weekly-cash-first-native-plans.json').write_text(json.dumps(plans,indent=2)+'\n')
 report.update(qualification='passed',semantic_cases=cases,actual_full_helper_and_statement=True,independent_view_history_oracle=True,metadata_unchanged=True,null_error_behavior_preserved=True,full_helper_recognition_events_before=before_events,full_helper_recognition_events_after=after_events,full_helper_blocks_before=blocks(plans[0]),full_helper_blocks_after=blocks(plans[1]),statement_discovery_blocks_before=blocks(plans[2]),statement_discovery_blocks_after=blocks(plans[3]),cash_rows=12000,unrelated_recognition_rows=8000,pins=[{k:v for k,v in p.items()if k not in['old','new']}for p in pins],production_financial_operation_qualified=False)
 (scratch/'weekly-cash-first-native-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
finally:
 if started:run([PG/'pg_ctl','-D',D,'-m','fast','-w','stop'])
 shutil.rmtree(C)
