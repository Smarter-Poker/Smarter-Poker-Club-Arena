from pathlib import Path
import json,subprocess,hashlib,datetime,shutil
import argparse,tempfile,os,sys
P=Path(__file__).resolve().parent;R=P.parents[2];a=argparse.ArgumentParser();a.add_argument('--output',type=Path,required=True);args=a.parse_args();O=args.output.resolve();O.mkdir(parents=True,exist_ok=True);I=P
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote connection forbidden')
PG=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin' if sys.platform=='darwin' else str(Path(shutil.which('psql')).parent)))
base=Path('/Volumes/SmarterWork/agent-work/weekly-cohort-cutoff-01a13099') if sys.platform=='darwin' else O.parent;B=Path(tempfile.mkdtemp(prefix='native-semantic-',dir=base));D=B/'d';S=B/'s';S.mkdir();port='56633'
def run(args,name,stdin=None):
 q=subprocess.run([str(x) for x in args],input=stdin,text=True,capture_output=True,timeout=60);(O/(name+'.stdout')).write_text(q.stdout);(O/(name+'.stderr')).write_text(q.stderr)
 if stdin is not None:(O/(name+'.sql')).write_text(stdin)
 if q.returncode:raise RuntimeError(name+': '+q.stderr[-2000:])
 return q.stdout.strip()
def sql(s,n):return run([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',S,'-p',port,'-U','postgres'],n,s)
def j(s,n):return json.loads(sql(s,n).splitlines()[-1])
def query(q):return "SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]') FROM ("+q+")q;"
started=False
try:
 run([PG/'initdb','-D',D,'-U','postgres','-A','trust','--no-locale','-E','UTF8'],'init')
 run([PG/'pg_ctl','-D',D,'-l',B/'server.log','-o',f"-k {S} -p {port} -h ''",'-w','start'],'start');started=True
 auth=json.loads((P/'authorities.json').read_text());funcs=sorted(auth['functions'][:2],key=lambda x:'cutoff' not in x['signature'])
 before=(I/'before-helper.sql').read_text();after=(I/'after-helper.sql').read_text();ctes=(I/'earning-ctes.sql').read_text()
 setup=(R/'scripts/qualification/weekly-first-week-aggregate/selector-fixture.sql').read_text().split('INSERT INTO clubs')[0]+"""
 CREATE TABLE accounting_agreement_history(id bigint,entity_key text,entity_type text,observed_at timestamptz,after_terms jsonb);
 CREATE TABLE accounting_rakeback_period_calculations(club_id uuid,coordinator_union_id uuid,period_start date,period_end date);
 CREATE TABLE settlement_periods(club_id uuid,union_id uuid,start_at timestamptz,end_at timestamptz);
 CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('native.engine',true) IS DISTINCT FROM 'false'$$;
 """+'\n'.join(r['full_definition'].rstrip()+';' for r in funcs)+"CREATE VIEW accounting_payable_earning_sources WITH(security_invoker=true) AS "+auth['view']+';'+before+';'
 setup+="""
 INSERT INTO clubs SELECT md5('club'||g)::uuid,CASE WHEN g=8 THEN true WHEN g=7 THEN NULL ELSE false END FROM generate_series(1,8)g;
 INSERT INTO accounting_cash_rake_sources(id,club_id,union_id,coordinator_union_id,earned_at,rake_credit)
 SELECT md5('cash'||g)::uuid,CASE WHEN g%11=0 THEN NULL WHEN g%17=0 THEN md5('union1')::uuid ELSE md5('club'||(1+g%5))::uuid END,md5('union1')::uuid,CASE WHEN g%13=0 THEN md5('union2')::uuid ELSE md5('union1')::uuid END,
 CASE g%9 WHEN 0 THEN NULL WHEN 1 THEN '-infinity'::timestamptz WHEN 2 THEN 'infinity'::timestamptz WHEN 3 THEN '2026-10-05 06:59:59Z' WHEN 4 THEN '2026-10-05 07:00Z' WHEN 5 THEN '2026-10-06 06:59:59Z' WHEN 6 THEN '2026-10-06 07:00Z' WHEN 7 THEN '2026-10-06 07:00:01Z' ELSE '2026-10-12 07:00Z' END,1 FROM generate_series(1,900)g;
 INSERT INTO accounting_tournament_fee_sources(id,tournament_id,club_id,union_id,coordinator_union_id,charged_at,rake_credit)
 SELECT md5('fee'||g)::uuid,md5('t'||g)::uuid,CASE WHEN g%11=0 THEN NULL WHEN g%17=0 THEN md5('union1')::uuid ELSE md5('club'||(1+g%5))::uuid END,CASE WHEN g%19=0 THEN NULL ELSE md5('union1')::uuid END,CASE WHEN g%13=0 THEN md5('union2')::uuid ELSE md5('union1')::uuid END,
 CASE g%7 WHEN 0 THEN NULL WHEN 1 THEN '-infinity'::timestamptz WHEN 2 THEN 'infinity'::timestamptz WHEN 3 THEN '2026-10-06 06:59:59Z' WHEN 4 THEN '2026-10-06 07:00Z' ELSE '2026-10-06 07:00:01Z' END,2 FROM generate_series(1,700)g;
 INSERT INTO accounting_tournament_recognized_sources
 SELECT id,tournament_id,CASE (row_number()OVER(ORDER BY id))%7 WHEN 0 THEN NULL WHEN 1 THEN '2026-10-05 06:59:59Z' WHEN 2 THEN '2026-10-05 07:00Z' WHEN 3 THEN '2026-10-06 06:59:59Z' WHEN 4 THEN '2026-10-06 07:00Z' WHEN 5 THEN '2026-10-06 07:00:01Z' ELSE '2026-10-12 07:00Z' END::timestamptz,CASE (row_number()OVER(ORDER BY id))%5 WHEN 0 THEN 'cancelled' ELSE 'earned' END,CASE (row_number()OVER(ORDER BY id))%6 WHEN 0 THEN 3 ELSE 2 END FROM accounting_tournament_fee_sources;
 INSERT INTO accounting_tournament_fee_recognitions SELECT s.tournament_id,CASE (row_number()OVER(ORDER BY s.id))%8 WHEN 0 THEN rs.recognized_at+interval '1 second' ELSE rs.recognized_at END,CASE (row_number()OVER(ORDER BY s.id))%9 WHEN 0 THEN 'pending' ELSE 'recognized' END,CASE (row_number()OVER(ORDER BY s.id))%10 WHEN 0 THEN md5('union2')::uuid ELSE s.union_id END FROM accounting_tournament_fee_sources s JOIN accounting_tournament_recognized_sources rs ON rs.source_id=s.id;
 INSERT INTO accounting_tournament_recognized_sources SELECT * FROM accounting_tournament_recognized_sources WHERE source_id=md5('fee1')::uuid;
 INSERT INTO accounting_tournament_fee_recognitions SELECT * FROM accounting_tournament_fee_recognitions WHERE tournament_id=md5('t1')::uuid;
 INSERT INTO accounting_agreement_history VALUES(1,'a','union_clubs','2026-10-04 07:00Z',jsonb_build_object('club_id',md5('club6')::uuid,'union_id',md5('union2')::uuid)),(2,'a','union_clubs','2026-10-05 07:00Z',jsonb_build_object('club_id',md5('club6')::uuid,'union_id',md5('union1')::uuid)),(3,'a','union_clubs','2026-10-05 07:00Z',jsonb_build_object('club_id',md5('club6')::uuid,'union_id',md5('union2')::uuid)),(4,'a','union_clubs','2026-10-06 07:00Z',jsonb_build_object('club_id',md5('club7')::uuid,'union_id',md5('union1')::uuid));
 INSERT INTO accounting_rakeback_period_calculations VALUES(md5('club6')::uuid,md5('union1')::uuid,'2026-10-05','2026-10-11');
 INSERT INTO settlement_periods VALUES(md5('club8')::uuid,md5('union1')::uuid,'2026-10-05 07:00Z','2026-10-12 07:00Z');
 """
 sql(setup,'bootstrap-authentic-d787-view-accepts-cutoff')
 catalog=j("SELECT jsonb_build_object('version',version(),'helper_md5',md5(pg_get_functiondef('fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure)),'helper',pg_get_functiondef('fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure),'cutoff',pg_get_functiondef('fn_ca_launch_accounting_cutoff(text,uuid)'::regprocedure),'accepts',pg_get_functiondef('fn_ca_launch_accounting_accepts(uuid,timestamptz)'::regprocedure),'view',pg_get_viewdef('accounting_payable_earning_sources'::regclass,true));",'authentic-catalog');assert catalog['helper_md5']=='d7873c8b3dd2a0ef8df48be321dd9a2f';assert 'PostgreSQL 17.' in catalog['version']
 bind={'p_union_id':"md5('union1')::uuid",'p_from':"'2026-10-05 07:00Z'::timestamptz",'p_to':"'2026-10-12 07:00Z'::timestamptz"}
 def bound(s):
  for k,v in bind.items():s=s.replace(k,v)
  return s
 oldq="SELECT source_type,source_id,club_id FROM accounting_payable_earning_sources s WHERE coordinator_union_id=md5('union1')::uuid AND earned_at>='2026-10-05 07:00Z' AND earned_at<'2026-10-12 07:00Z' ORDER BY source_type,source_id,club_id"
 newq=bound('WITH '+ctes+' SELECT source_type,source_id,club_id FROM accepted_earnings ORDER BY source_type,source_id,club_id')
 raw=j("SELECT jsonb_build_object('cash',(SELECT jsonb_agg(to_jsonb(s)) FROM accounting_cash_rake_sources s),'fees',(SELECT jsonb_agg(to_jsonb(s)) FROM accounting_tournament_fee_sources s),'recognized',(SELECT jsonb_agg(to_jsonb(s)) FROM accounting_tournament_recognized_sources s),'recognitions',(SELECT jsonb_agg(to_jsonb(s)) FROM accounting_tournament_fee_recognitions s));",'raw-independent-inputs')
 def dt(x):return datetime.datetime.fromisoformat(x)
 lo=dt('2026-10-05T07:00:00+00:00');hi=dt('2026-10-12T07:00:00+00:00');union=hashlib.md5(b'union1').hexdigest();union=str(__import__('uuid').UUID(union))
 def inwindow(t):return t is not None and t not in ['infinity','-infinity'] and lo<=dt(t)<hi
 results=[]
 cases={'no-cutoff':'','active-cutoff':"INSERT INTO ca_launch_accounting_boundaries VALUES('club',md5('club1')::uuid,'2026-10-06 07:00Z',NULL),('club',md5('club2')::uuid,'2026-10-06 07:00Z',NULL),('union',md5('club3')::uuid,'2026-10-10 07:00Z',NULL);",'undone-cutoff':'UPDATE ca_launch_accounting_boundaries SET undone_at=clock_timestamp();','mixed-cutoff':"UPDATE ca_launch_accounting_boundaries SET undone_at=NULL WHERE scope_kind='club' AND scope_id=md5('club2')::uuid;"}
 for name,change in cases.items():
  if change:sql(change,name+'-inputs')
  cuts=j(query("SELECT * FROM ca_launch_accounting_boundaries ORDER BY scope_kind,scope_id"),name+'-boundaries');m={r['scope_id']:r['cutoff_at'] for r in cuts if r['scope_kind']=='club' and r['undone_at'] is None}
  def accepted(c,t):return c not in m or m[c] is None or (t is not None and t not in ['infinity','-infinity'] and dt(t)>=dt(m[c]))
  expected=[]
  for c in raw['cash']:
   if c['coordinator_union_id']==union and inwindow(c['earned_at']) and accepted(c['club_id'],c['earned_at']):expected.append({'source_type':'cash_rake_accrual','source_id':c['id'],'club_id':c['club_id']})
  for f in raw['fees']:
   for rs in raw['recognized']:
    if rs['source_id']!=f['id'] or rs['tournament_id']!=f['tournament_id']:continue
    for r in raw['recognitions']:
     if r['tournament_id']!=f['tournament_id']:continue
     if f['coordinator_union_id']==union and inwindow(rs['recognized_at']) and accepted(f['club_id'],f['charged_at']) and accepted(f['club_id'],rs['recognized_at']) and rs['disposition']=='earned' and r['status']=='recognized' and rs['rake_credit']==f['rake_credit'] and rs['recognized_at'] is not None and rs['recognized_at']==r['recognized_at'] and f['union_id']==r['union_id']:expected.append({'source_type':'tournament_fee_accrual','source_id':f['id'],'club_id':f['club_id']})
  expected.sort(key=lambda r:(r['source_type'],r['source_id'],r['club_id'] or '~'))
  oldids=j(query(oldq),name+'-old-accepted');newids=j(query(newq),name+'-new-accepted');assert oldids==newids==expected,name+' accepted IDs/multiplicity'
  sql(before+';',name+'-restore-before');oldclubs=j(query("SELECT * FROM fn_accounting_week_clubs(md5('union1')::uuid,NULL,'2026-10-05 07:00Z','2026-10-12 07:00Z')"),name+'-old-cohort')
  sql(after+';',name+'-candidate');newclubs=j(query("SELECT * FROM fn_accounting_week_clubs(md5('union1')::uuid,NULL,'2026-10-05 07:00Z','2026-10-12 07:00Z')"),name+'-new-cohort');assert oldclubs==newclubs
  expclubs={r['club_id'] for r in expected if r['club_id'] is not None and r['club_id']!=union}|{str(__import__('uuid').UUID(hashlib.md5(('club'+str(i)).encode()).hexdigest())) for i in [6,7,8]};assert [r['club_id'] for r in newclubs]==sorted(expclubs)
  (O/(name+'-independent-expected.json')).write_text(json.dumps(expected,indent=2)+'\n');results.append({'case':name,'accepted_rows':len(expected),'cohort':newclubs,'independent_expected':True})
 # No history/calculation/period support must not mask earning losses.
 sql('TRUNCATE accounting_agreement_history,accounting_rakeback_period_calculations,settlement_periods;','remove-mask-arms')
 sql(before+';','nomask-old');a=j(query("SELECT * FROM fn_accounting_week_clubs(md5('union1')::uuid,NULL,'2026-10-05 07:00Z','2026-10-12 07:00Z')"),'nomask-old-cohort');sql(after+';','nomask-new');b=j(query("SELECT * FROM fn_accounting_week_clubs(md5('union1')::uuid,NULL,'2026-10-05 07:00Z','2026-10-12 07:00Z')"),'nomask-new-cohort');assert a==b
 # Native-only PL wrapper counts authentic cutoff calls; genuine definition restored afterward.
 cutoff=next(r['full_definition'] for r in funcs if 'cutoff' in r['signature']);sql('CREATE SEQUENCE native_cutoff_calls;ALTER FUNCTION fn_ca_launch_accounting_cutoff(text,uuid) RENAME TO native_authentic_cutoff;CREATE FUNCTION fn_ca_launch_accounting_cutoff(p_kind text,p_id uuid) RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN PERFORM nextval(\'public.native_cutoff_calls\'); RETURN public.native_authentic_cutoff(p_kind,p_id);END$$;','native-counter-wrapper')
 counts={}
 for label,definition in [('old',before),('new',after)]:
  sql(definition+'; ALTER SEQUENCE native_cutoff_calls RESTART WITH 1;','count-'+label+'-prepare');sql("SELECT * FROM fn_accounting_week_clubs(md5('union1')::uuid,NULL,'2026-10-05 07:00Z','2026-10-12 07:00Z');",'count-'+label+'-run');counts[label]=int(sql('SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM native_cutoff_calls;','count-'+label+'-value'))
 candidates=j(query(bound('WITH '+ctes+' SELECT club_id FROM earning_clubs ORDER BY club_id')),'distinct-candidate-clubs');assert counts['new']==len(candidates) and counts['old']>counts['new']
 sql('DROP FUNCTION fn_ca_launch_accounting_cutoff(text,uuid);ALTER FUNCTION native_authentic_cutoff(text,uuid) RENAME TO fn_ca_launch_accounting_cutoff;','restore-authentic-cutoff')
 # Identical caller/input/errors including malformed agreement UUID.
 sql("CREATE FUNCTION native_outcome(u uuid,c uuid,f timestamptz,t timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE v jsonb;BEGIN SELECT COALESCE(jsonb_agg(club_id ORDER BY club_id),'[]') INTO v FROM fn_accounting_week_clubs(u,c,f,t);RETURN jsonb_build_object('rows',v);EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('state',SQLSTATE,'message',SQLERRM);END$$;",'outcome-wrapper')
 params=["NULL,NULL,'2026-10-05 07:00Z','2026-10-12 07:00Z'","md5('union1')::uuid,md5('club1')::uuid,'2026-10-05 07:00Z','2026-10-12 07:00Z'","md5('union1')::uuid,NULL,NULL,'2026-10-12 07:00Z'","md5('union1')::uuid,NULL,'-infinity','2026-10-12 07:00Z'","md5('union1')::uuid,NULL,'2026-10-12 07:00Z','2026-10-05 07:00Z'","NULL,md5('absent')::uuid,'2026-10-05 07:00Z','2026-10-12 07:00Z'","NULL,md5('club8')::uuid,'2026-10-05 07:00Z','2026-10-12 07:00Z'","NULL,md5('club7')::uuid,'2026-10-05 07:00Z','2026-10-12 07:00Z'","md5('absentunion')::uuid,NULL,'2026-10-05 07:00Z','2026-10-12 07:00Z'"]
 controls=[]
 for n,p in enumerate(params):
  outcomes=[]
  for label,definition in [('old',before),('new',after)]:sql(definition+';',f'control-{n}-{label}-prepare');outcomes.append(j('SELECT native_outcome('+p+');',f'control-{n}-{label}'))
  assert outcomes[0]==outcomes[1];controls.append(outcomes[0])
 sql("INSERT INTO accounting_agreement_history VALUES(900,'bad','union_clubs','2026-10-06 07:00Z',jsonb_build_object('club_id','malformed','union_id',md5('union1')::uuid));",'malformed-history-input')
 bad=[]
 for label,definition in [('old',before),('new',after)]:sql(definition+';',label+'-error-prepare');bad.append(j("SELECT native_outcome(md5('union1')::uuid,NULL,'2026-10-05 07:00Z','2026-10-12 07:00Z');",label+'-malformed-error'))
 assert bad[0]==bad[1] and bad[0]['state']=='22P02'
 denied=[]
 for label,definition in [('old',before),('new',after)]:sql(definition+';',label+'-caller-prepare');denied.append(j("SET native.engine='false';SELECT native_outcome(md5('union1')::uuid,NULL,'2026-10-05 07:00Z','2026-10-12 07:00Z');",label+'-caller-refusal'))
 assert denied[0]==denied[1] and denied[0]['state']=='42501'
 (O/'semantic-result.json').write_text(json.dumps({'pg':catalog['version'],'cases':results,'nomask_equal':True,'callback_counts':counts,'distinct_candidate_clubs':len(candidates),'native_wrapper_only':True,'authentic_cutoff_restored':True,'controls':controls,'malformed':bad,'caller_refusal':denied,'no_money_rpc':True,'no_production':True,'no_performance_claim':True,'migration_allocated':False},indent=2)+'\n');print('PASS authentic PG17 pure cohort/accepted IDs/multiplicity/independent expectations/callback bounds/errors; no production or migration')
finally:
 if started:run([PG/'pg_ctl','-D',D,'-m','fast','-w','stop'],'stop')

shutil.copyfile(B/'server.log',O/'server.log') if (B/'server.log').exists() else None
shutil.rmtree(B);(O/'cleanup.json').write_text(json.dumps({'own_cluster_stopped':True,'own_cluster_removed':True,'production':False}))
