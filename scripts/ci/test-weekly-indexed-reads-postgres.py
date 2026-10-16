#!/usr/bin/env python3
"""Native exact coordinator WHERE fragment parity and bounded index path; local sockets only."""
import argparse,datetime,hashlib,itertools,json,os,shutil,subprocess,sys,tempfile,uuid
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--pg-bin',required=True);p.add_argument('--scratch',required=True);a=p.parse_args()
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote connection forbidden')
S=Path(a.scratch).resolve();R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/weekly-indexed-reads'
if sys.platform=='darwin' and not str(S).startswith('/Volumes/SmarterWork/agent-work/'):raise RuntimeError('external scratch required')
C=Path(tempfile.mkdtemp(prefix='wm-',dir=S));D=C/'d';pg=Path(a.pg_bin);started=False
psql=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',C,'-U','postgres','-d','postgres']
def run(cmd,text=None,error=None):
 r=subprocess.run([str(x) for x in cmd],input=text,text=True,capture_output=True,timeout=90)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(s,error=None):return run(psql,s,error)
pins=json.loads((F/'replacement.json').read_text());before=pins['old_watermark'];after=pins['new_watermark']
assert before.count('NOT COALESCE(rr.is_tournament,false)')==1
scope=(F/'scope-before.sql').read_text();helper=(F/'helper-before.sql').read_text()
migration=next((R/'supabase/migrations').glob('20261016184511_*')).read_text()
for key,original,old,new in [('scope',scope,before,after),('helper',helper,pins['old_cash'],pins['new_cash'])]:
 assert hashlib.md5(original.encode()).hexdigest()==pins[key+'_before']
 assert original.count(old)==1
 assert original.replace(old,new).replace(new,old)==original
 assert hashlib.md5(original.replace(old,new).encode()).hexdigest()==pins[key+'_after']
 assert '$old_query$'+old+'$old_query$' in migration and '$new_query$'+new+'$new_query$' in migration
u=str(uuid.UUID(int=1));c=str(uuid.UUID(int=2));outside=str(uuid.UUID(int=3));start='2026-10-05 07:00Z';end='2026-10-12 07:00Z'
# Load the actual fragment query with only SELECT projection changed from 1 to rr.id.
def query(fragment):
 assert fragment.startswith('IF EXISTS(')
 return fragment[len('IF EXISTS('):fragment.index(')) THEN')+1].replace('SELECT 1 FROM public.rake_records','SELECT rr.id FROM public.rake_records',1).replace('v_union.id',"'"+u+"'::uuid").replace('v_from',"'"+start+"'::timestamptz").replace('v_end',"'"+end+"'::timestamptz")
old=query(before);new=query(after)
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',D,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with (D/'postgresql.conf').open('a') as h:h.write("\nlisten_addresses=''\nunix_socket_directories='"+str(C)+"'\n")
 run([pg/'pg_ctl','-D',D,'-l',C/'server.log','-w','start']);started=True
 q("CREATE TABLE daemon_state(daemon text PRIMARY KEY,high_water_mark timestamptz,high_water_mark_id uuid);CREATE TABLE rake_records(id uuid PRIMARY KEY,is_tournament boolean,tournament_id uuid,rake_amount numeric,club_id uuid,created_at timestamptz);CREATE TABLE fixture_clubs(club_id uuid);INSERT INTO fixture_clubs VALUES('"+c+"');CREATE FUNCTION fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) RETURNS TABLE(club_id uuid) LANGUAGE plpgsql STABLE AS $$BEGIN RETURN QUERY SELECT f.club_id FROM fixture_clubs f;END$$;CREATE INDEX idx_rake_records_date ON rake_records(created_at);CREATE INDEX rake_records_cash_positive_created ON rake_records(created_at,id) WHERE rake_amount>0 AND is_tournament IS NOT TRUE AND tournament_id IS NULL;")
 # Load both complete actual owners, then install exact candidate once locally.
 q("DROP FUNCTION fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz);CREATE TABLE fixture_control(frozen boolean);INSERT INTO fixture_control VALUES(false);CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT frozen FROM fixture_control$$;CREATE FUNCTION fn_active_maintenance_release_boundary() RETURNS timestamptz LANGUAGE sql AS $$SELECT NULL::timestamptz$$;CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);"+scope+';'+helper+";REVOKE ALL ON FUNCTION fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC;REVOKE ALL ON FUNCTION fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC;")
 metadata="SELECT jsonb_agg(jsonb_build_array(oid::regprocedure::text,proowner,prosecdef,provolatile,proconfig,proacl) ORDER BY oid) FROM pg_proc WHERE oid IN ('fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure,'fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure)"
 authority=q(metadata)
 for inject,error in [("UPDATE fixture_control SET frozen=true;",'weekly_index_reads_freeze_or_override_refused'),("SET LOCAL request.jwt.claims='{}';",'weekly_index_reads_operator_refused'),("SET LOCAL ca.break_window_migration_override='fixture';",'weekly_index_reads_freeze_or_override_refused'),("INSERT INTO supabase_migrations.schema_migrations VALUES('20261016184511');",'weekly_index_reads_history_replay'),("GRANT EXECUTE ON FUNCTION fn_process_weekly_accounting_scope(uuid,uuid) TO PUBLIC;",'weekly_index_reads_scope_preimage_authority_refused'),("GRANT EXECUTE ON FUNCTION fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) TO PUBLIC;",'weekly_index_reads_helper_preimage_authority_refused'),("DROP INDEX rake_records_cash_positive_created;",'weekly_index_reads_cash_index_required'),("ALTER TABLE daemon_state DROP CONSTRAINT daemon_state_pkey;",'weekly_index_reads_watermark_key_required')]:q(migration.replace('BEGIN;','BEGIN;'+inject,1),error)
 q(migration.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'fixture_abort';END$$;COMMIT;"),'fixture_abort')
 for key,sig in [('scope','fn_process_weekly_accounting_scope(uuid,uuid)'),('helper','fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)')]:assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")==pins[key+'_before']
 q(migration)
 for key,sig in [('scope','fn_process_weekly_accounting_scope(uuid,uuid)'),('helper','fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)')]:assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")==pins[key+'_after']
 assert authority==q(metadata)
 q("INSERT INTO supabase_migrations.schema_migrations VALUES('20261016184511');")
 q(migration,'weekly_index_reads_history_replay')
 q("DROP FUNCTION fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz);CREATE FUNCTION fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) RETURNS TABLE(club_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$BEGIN RETURN QUERY SELECT f.club_id FROM fixture_clubs f;END$$;")
 times=['2026-10-05 06:59:59Z',start,'2026-10-08 07:00Z',end,None,'-infinity','infinity']
 cases=[];values=[]
 def literal(v):return 'NULL' if v is None else "'"+str(v)+"'"
 for n,vals in enumerate(itertools.product([None,False,True],[None,str(uuid.UUID(int=9))],[None,-1,0,1],[u,c,outside,None],times),1):
  tour,event,amount,club,at=vals;rid=str(uuid.UUID(int=n));cases.append((rid,tour,event,amount,club,at))
  values.append('('+','.join(map(literal,[rid,tour,event,amount,club,at]))+')')
 q('INSERT INTO rake_records VALUES'+','.join(values)+';')
 marks=[('missing',None,None),('null',None,None),('before','2026-10-01 07:00Z',None),('equal_no_id','2026-10-08 07:00Z',None),('equal_lower_id','2026-10-08 07:00Z',str(uuid.UUID(int=1))),('equal_mid_id','2026-10-08 07:00Z',str(uuid.UUID(int=700))),('equal_higher_id','2026-10-08 07:00Z',str(uuid.UUID(int=999999))),('at_end',end,None),('after','2026-10-16 07:00Z',None),('positive_infinity','infinity',None),('negative_infinity','-infinity',None)]
 def ts(v):
  if v=='-infinity':return float('-inf')
  if v=='infinity':return float('inf')
  return datetime.datetime.fromisoformat(v.replace('Z','+00:00')).timestamp()
 for name,mark,mid in marks:
  q('TRUNCATE daemon_state;'+('' if name=='missing' else "INSERT INTO daemon_state VALUES('rakeback_settler',"+literal(mark)+','+literal(mid)+');'))
  expected=sorted(rid for rid,tour,event,amount,club,at in cases if tour is not True and event is None and amount is not None and amount>0 and club in [u,c] and at is not None and ts(start)<=ts(at)<ts(end) and (mark is None or ts(at)>ts(mark) or ts(at)==ts(mark) and (mid is None or rid>mid)))
  observed=[]
  for sql in [old,new]:observed.append(json.loads(q("SELECT coalesce(json_agg(id ORDER BY id),'[]') FROM ("+sql+") x(id)")))
  assert observed[0]==observed[1]==expected,(name,observed,expected)
 # Duplicate historical week data makes the cold no-result traversal observable without timing assertions.
 q("TRUNCATE rake_records;INSERT INTO rake_records SELECT md5(n::text)::uuid,false,NULL,1,'"+c+"','2026-10-08 07:00Z' FROM generate_series(1,50000)n;INSERT INTO rake_records SELECT md5(('excluded'||n)::text)::uuid,true,md5('tournament')::uuid,1,'"+c+"','2026-10-08 07:00Z' FROM generate_series(1,200000)n;TRUNCATE daemon_state;INSERT INTO daemon_state VALUES('rakeback_settler','2026-10-16 07:00Z',NULL);ANALYZE rake_records;")
 plans=[json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+s))[0] for s in [old,new]]
 def nodes(n):
  yield n
  for x in n.get('Plans',[]):yield from nodes(x)
 actual=list(nodes(plans[1]['Plan']))
 assert any(n.get('Index Name')=='rake_records_cash_positive_created' and 'InitPlan' in n.get('Index Cond','') for n in actual),plans[1]
 assert any(n.get('Function Name')=='fn_accounting_week_clubs' and n.get('Actual Loops')==0 for n in actual),plans[1]
 blocks=lambda x:sum(x['Plan'].get(k,0) for k in ['Shared Hit Blocks','Shared Read Blocks'])
 assert blocks(plans[0])>blocks(plans[1])*5,(blocks(plans[0]),blocks(plans[1]))
 result={'qualification':'passed','actual_installed_coordinator_fragment':True,'row_boundary_combinations':len(cases),'watermark_states':len(marks),'independent_python_expected_sets':True,'existing_partial_index_used':True,'watermark_is_index_bound':True,'unnecessary_cohort_function_not_executed':True,'old_blocks':blocks(plans[0]),'new_blocks':blocks(plans[1]),'metadata_not_changed':True,'full_financial_close_qualified':False,'before_fragment_sha256':hashlib.sha256(before.encode()).hexdigest()}
 result['actual_candidate_installation_rollback_replay_and_authority']=True;print(json.dumps(result))
finally:
 if started:run([pg/'pg_ctl','-D',D,'-m','fast','-w','stop'])
 shutil.rmtree(C)
