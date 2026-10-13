from pathlib import Path
import json,subprocess,hashlib,datetime,uuid
import argparse,os,sys,shutil,tempfile
I=Path(__file__).resolve().parent;R=I.parents[2];a=argparse.ArgumentParser();a.add_argument('--output',type=Path,required=True);args=a.parse_args();O=args.output.resolve();O.mkdir(parents=True,exist_ok=True);N=O;P=I
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote connection forbidden')
G=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin' if sys.platform=='darwin' else str(Path(shutil.which('psql')).parent)))
base=Path('/Volumes/SmarterWork/agent-work/weekly-standalone-selector-01a13099') if sys.platform=='darwin' else O.parent;B=Path(tempfile.mkdtemp(prefix='n-',dir=base));D=B/'d';S=B/'s';S.mkdir();port='56637'
def run(c,n,s=None):
 r=subprocess.run([str(x) for x in c],input=s,text=True,capture_output=True,timeout=60);(N/(n+'.stdout')).write_text(r.stdout);(N/(n+'.stderr')).write_text(r.stderr)
 if s is not None:(N/(n+'.sql')).write_text(s)
 if r.returncode:raise RuntimeError(n+':'+r.stderr[-2000:])
 return r.stdout.strip()
def sql(s,n):return run([G/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',S,'-p',port,'-U','postgres'],n,s)
def j(s,n):return json.loads(sql(s,n).splitlines()[-1])
def agg(q):return "SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]') FROM ("+q+")q;"
started=False
try:
 run([G/'initdb','-D',D,'-U','postgres','-A','trust','--no-locale','-E','UTF8'],'init');run([G/'pg_ctl','-D',D,'-l',B/'server.log','-o',f"-k {S} -p {port} -h ''",'-w','start'],'start');started=True
 auth=json.loads((P/'authorities.json').read_text());forty=json.loads((R/'scripts/qualification/original-flow-eligibility/current-source40.json').read_text());week=next(r['definition'] for r in forty if r['signature'].startswith('public.fn_union_week_start('))
 setup=(P/'selector-fixture.sql').read_text()+week+';'+(P/'calendar-support.sql').read_text()+';'+''.join(r['full_definition']+';' for r in sorted(auth['functions'],key=lambda r:'cutoff' not in r['signature']))+'CREATE VIEW accounting_payable_earning_sources WITH(security_invoker=true) AS '+auth['view']+';'
 setup+="""INSERT INTO accounting_cash_rake_sources(id,club_id,earned_at) VALUES(md5('neg-inf')::uuid,md5('club4')::uuid,'-infinity'),(md5('nullclub-inf')::uuid,NULL,'-infinity');
 INSERT INTO accounting_tournament_fee_sources(id,tournament_id,club_id,charged_at,rake_credit) VALUES(md5('nullT')::uuid,md5('nullTour')::uuid,NULL,NULL,2),(md5('charged-before')::uuid,md5('chargedBeforeTour')::uuid,md5('club1')::uuid,'2026-09-20 07:00Z',2);
 INSERT INTO accounting_tournament_recognized_sources VALUES(md5('nullT')::uuid,md5('nullTour')::uuid,'2026-10-06 07:00Z','earned',2),(md5('nullT')::uuid,md5('nullTour')::uuid,'2026-10-06 07:00Z','earned',2),(md5('charged-before')::uuid,md5('chargedBeforeTour')::uuid,'2026-10-06 07:00Z','earned',2);
 INSERT INTO accounting_tournament_fee_recognitions VALUES(md5('nullTour')::uuid,'2026-10-06 07:00Z','recognized',NULL),(md5('nullTour')::uuid,'2026-10-06 07:00Z','recognized',NULL),(md5('chargedBeforeTour')::uuid,'2026-10-06 07:00Z','recognized',NULL);"""
 sql(setup,'bootstrap');catalog=j("SELECT jsonb_build_object('version',version(),'calendar',pg_get_functiondef('fn_union_week_start(timestamptz)'::regprocedure),'calendar_md5',md5(pg_get_functiondef('fn_union_week_start(timestamptz)'::regprocedure)),'cutoff',pg_get_functiondef('fn_ca_launch_accounting_cutoff(text,uuid)'::regprocedure),'accepts',pg_get_functiondef('fn_ca_launch_accounting_accepts(uuid,timestamptz)'::regprocedure),'view',pg_get_viewdef('accounting_payable_earning_sources'::regclass,true));",'catalog');assert 'PostgreSQL 17.' in catalog['version'];assert catalog['calendar_md5']=='103f192a228084dad0e4268c36c82c4b'
 queries={n:(I/(n+'-second-selector.sql')).read_text().strip() for n in ['before','after']};ct=(I/'earning-ID-instrumentation-ctes.sql').read_text();raw=j("SELECT jsonb_build_object('cash',(SELECT jsonb_agg(to_jsonb(s)) FROM accounting_cash_rake_sources s),'fees',(SELECT jsonb_agg(to_jsonb(s)) FROM accounting_tournament_fee_sources s),'recognized',(SELECT jsonb_agg(to_jsonb(s)) FROM accounting_tournament_recognized_sources s),'recognitions',(SELECT jsonb_agg(to_jsonb(s)) FROM accounting_tournament_fee_recognitions s));",'raw-inputs')
 def bound(q,c='NULL'):return q.replace('v_to',"'2026-10-12 07:00Z'::timestamptz").replace('v_now',"'2026-10-13 21:05Z'::timestamptz").replace('p_club_id',c)
 oldids="SELECT source_type,source_id,club_id,earned_at FROM accounting_payable_earning_sources WHERE coordinator_union_id IS NULL AND earned_at<'2026-10-12 07:00Z' ORDER BY source_type,source_id,club_id,earned_at"
 newids=bound('WITH '+ct+' SELECT source_type,source_id,club_id,earned_at FROM accepted_earnings ORDER BY source_type,source_id,club_id,earned_at')
 def dt(t):return datetime.datetime.fromisoformat(t)
 hi=dt('2026-10-12T07:00:00+00:00')
 def before(t):return t is not None and (t=='-infinity' or (t!='infinity' and dt(t)<hi))
 results=[]
 cases={'no-cutoff':'','active':"INSERT INTO ca_launch_accounting_boundaries VALUES('club',md5('club1')::uuid,'2026-10-01 07:00Z',NULL),('club',md5('club2')::uuid,'2026-10-01 07:00Z',NULL),('union',md5('club3')::uuid,'2026-10-01 07:00Z',NULL);",'undone':'UPDATE ca_launch_accounting_boundaries SET undone_at=clock_timestamp();','mixed':"UPDATE ca_launch_accounting_boundaries SET undone_at=NULL WHERE scope_kind='club' AND scope_id=md5('club2')::uuid;"}
 for name,change in cases.items():
  if change:sql(change,name+'-setup')
  cuts=j(agg('SELECT * FROM ca_launch_accounting_boundaries ORDER BY scope_kind,scope_id'),name+'-boundaries');m={r['scope_id']:r['cutoff_at'] for r in cuts if r['scope_kind']=='club' and r['undone_at'] is None}
  def accept(c,t):return c not in m or m[c] is None or (t is not None and t not in ['infinity','-infinity'] and dt(t)>=dt(m[c]))
  expected=[]
  for r in raw['cash']:
   if r['coordinator_union_id'] is None and before(r['earned_at']) and accept(r['club_id'],r['earned_at']):expected.append({'source_type':'cash_rake_accrual','source_id':r['id'],'club_id':r['club_id'],'earned_at':r['earned_at']})
  for f in raw['fees']:
   for rs in raw['recognized']:
    if rs['source_id']!=f['id'] or rs['tournament_id']!=f['tournament_id']:continue
    for r in raw['recognitions']:
     if r['tournament_id']==f['tournament_id'] and f['coordinator_union_id'] is None and before(rs['recognized_at']) and accept(f['club_id'],f['charged_at']) and accept(f['club_id'],rs['recognized_at']) and rs['disposition']=='earned' and r['status']=='recognized' and rs['rake_credit']==f['rake_credit'] and rs['recognized_at'] is not None and rs['recognized_at']==r['recognized_at'] and f['union_id']==r['union_id']:expected.append({'source_type':'tournament_fee_accrual','source_id':f['id'],'club_id':f['club_id'],'earned_at':rs['recognized_at']})
  expected.sort(key=lambda r:(r['source_type'],r['source_id'],r['club_id'] or '~',r['earned_at'] or '~'));old=j(agg(oldids),name+'-old-IDs');new=j(agg(newids),name+'-new-IDs');assert old==new==expected,name
  (N/(name+'-independent-expected.json')).write_text(json.dumps(expected,indent=2)+'\n')
  for ti,target in enumerate(['club1','club4','absent']):
   uid=str(uuid.UUID(hashlib.md5(target.encode()).hexdigest()));want=[r for r in expected if r['club_id']==uid]
   oldtarget=oldids.replace(' ORDER BY'," AND club_id=md5('"+target+"')::uuid ORDER BY")
   newtarget=bound('WITH '+ct+' SELECT source_type,source_id,club_id,earned_at FROM accepted_earnings ORDER BY source_type,source_id,club_id,earned_at',"md5('"+target+"')::uuid")
   assert j(agg(oldtarget),f'{name}-{ti}-oldtargetIDs')==j(agg(newtarget),f'{name}-{ti}-newtargetIDs')==want

  outputs=[]
  for ci,c in enumerate(['NULL',"md5('club1')::uuid","md5('club4')::uuid","md5('absent')::uuid"]):
   a=j(agg(bound(queries['before'],c)),f'{name}-{ci}-old-output');b=j(agg(bound(queries['after'],c)),f'{name}-{ci}-new-output');assert a==b;outputs.append(a)
  results.append({'case':name,'accepted_rows':len(expected),'outputs':outputs,'raw_independent_multiset':True})
 # Native-only bounded callback proof; genuine functions restored afterward.
 funcs=[('fn_ca_launch_accounting_cutoff','text,uuid','p_kind text,p_id uuid','public.native_cutoff(p_kind,p_id)','native_cutoff',next(r['full_definition'] for r in auth['functions'] if 'cutoff' in r['signature'])),('fn_union_week_start','timestamptz','p_at timestamptz','public.native_week(p_at)','native_week',week)]
 counts={}
 for name,sig,params,expr,alias,definition in funcs:
  sql(f"CREATE SEQUENCE native_calls; ALTER FUNCTION {name}({sig}) RENAME TO {alias}; CREATE FUNCTION {name}({params}) RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$BEGIN PERFORM nextval('native_calls'); RETURN {expr};END$$;",name+'-counter-install')
  vals={}
  for label,q in queries.items():sql('ALTER SEQUENCE native_calls RESTART WITH 1;',name+'-'+label+'-restart');sql(bound(q)+';',name+'-'+label+'-run');vals[label]=int(sql('SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM native_calls;',name+'-'+label+'-count'))
  assert vals['after']<vals['before'];counts[name]=vals;sql(f'DROP FUNCTION {name}({sig}); ALTER FUNCTION {alias}({sig}) RENAME TO {name}; DROP SEQUENCE native_calls;',name+'-restore')
 # Error equivalence: other clubs and -infinity must not hide an accepted finite truncation error.
 sql("INSERT INTO accounting_cash_rake_sources(id,club_id,earned_at) VALUES(md5('invalid-min')::uuid,md5('club4')::uuid,'4714-11-24 00:00:00 BC');",'error-input')
 errors=[]
 for label,q in queries.items():
  sql("CREATE OR REPLACE FUNCTION native_result() RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE r jsonb;BEGIN "+agg(bound(q,"md5('club1')::uuid")).replace("SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]') FROM","SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]') INTO r FROM")+"RETURN jsonb_build_object('rows',r); EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('state',SQLSTATE,'message',SQLERRM);END$$;",label+'-error-wrapper');errors.append(j('SELECT native_result();',label+'-error'))
 assert errors[0]==errors[1]
 # Global and targeted mixed-inf/minimum BC errors, absent target success.
 error_pairs=[]
 for ci,c in enumerate(['NULL',"md5('club4')::uuid","md5('absent')::uuid"]):
  out=[]
  for label,q in queries.items():
   wrapper="CREATE OR REPLACE FUNCTION native_result() RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE r jsonb;BEGIN "+agg(bound(q,c)).replace("SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]') FROM","SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]') INTO r FROM")+"RETURN jsonb_build_object('rows',r); EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('state',SQLSTATE,'message',SQLERRM);END$$;SELECT native_result();"
   out.append(j(wrapper,f'extreme-{ci}-{label}'))
  assert out[0]==out[1];error_pairs.append(out)
 assert error_pairs[0][0]['state']==error_pairs[1][0]['state']=='22008';assert 'rows' in error_pairs[2][0]
 before=(I/'before-scope.sql').read_text().rstrip('\n');after=(I/'after-scope-candidate.sql').read_text().rstrip('\n');assert after.replace(queries['after'],queries['before'],1)==before
 prod=ct.replace('SELECT s.id,s.club_id,s.earned_at','SELECT s.club_id,s.earned_at').replace('SELECT s.id,s.club_id,s.charged_at','SELECT s.club_id,s.charged_at').replace("SELECT 'cash_rake_accrual'::text AS source_type,s.id AS source_id,s.club_id,s.earned_at",'SELECT s.club_id,s.earned_at').replace("SELECT 'tournament_fee_accrual'::text AS source_type,s.id AS source_id,s.club_id,s.recognized_at AS earned_at",'SELECT s.club_id,s.recognized_at AS earned_at');assert prod==(I/'earning-ctes.sql').read_text()
 import zoneinfo
 primitives=[]
 for name in ['no-cutoff','active','undone','mixed']:
  cuts=json.loads((N/(name+'-boundaries.stdout')).read_text());expected=json.loads((N/(name+'-independent-expected.json')).read_text());groups={}
  for r in expected:
   t=r['earned_at'];c=r['club_id']
   if t=='-infinity':w=t
   else:
    local=dt(t).astimezone(zoneinfo.ZoneInfo('America/Los_Angeles'));day=local.date()-datetime.timedelta(days=local.weekday());w=datetime.datetime.combine(day,datetime.time(),zoneinfo.ZoneInfo('America/Los_Angeles')).astimezone(datetime.timezone.utc).isoformat()
   if c not in groups or w=='-infinity' or (groups[c]!='-infinity' and w<groups[c]):groups[c]=w
  def quote(v):return 'NULL' if v is None else "'"+v.replace("'","''")+"'"
  prep="BEGIN;DELETE FROM accounting_cash_rake_sources WHERE id=md5('invalid-min')::uuid;TRUNCATE ca_launch_accounting_boundaries;"
  if cuts:prep+='INSERT INTO ca_launch_accounting_boundaries VALUES '+','.join('('+','.join(quote(r[k]) for k in ['scope_kind','scope_id','cutoff_at','undone_at'])+')' for r in cuts)+';'
  primitive_old="SELECT s.club_id,min(fn_union_week_start(s.earned_at)) AS first_week FROM accounting_payable_earning_sources s WHERE s.coordinator_union_id IS NULL AND s.earned_at<'2026-10-12 07:00Z' GROUP BY s.club_id ORDER BY s.club_id"
  primitive_new=bound('WITH '+prod+' SELECT s.club_id,LEAST(fn_union_week_start(min(s.earned_at)FILTER(WHERE isfinite(s.earned_at))),min(s.earned_at)) AS first_week FROM accepted_earnings s GROUP BY s.club_id ORDER BY s.club_id')
  outputs=[j(prep+agg(q)+'ROLLBACK;',f'{name}-primitive-{label}') for label,q in [('old',primitive_old),('new',primitive_new)]];assert outputs[0]==outputs[1]
  actual={r['club_id']:r['first_week'] if r['first_week']=='-infinity' else dt(r['first_week']).astimezone(datetime.timezone.utc).isoformat() for r in outputs[0]};assert actual==groups;primitives.append({'case':name,'outputs':outputs,'independent':groups})
 (N/'primitive-error-inverse.json').write_text(json.dumps({'errors':error_pairs,'primitive_groups':primitives,'other_scope_inverse_exact':True,'ID_instrumentation_predicates_exact':True},indent=2)+'\n')
 (N/'result.json').write_text(json.dumps({'cases':results,'callbacks':counts,'other_club_invaliddate':errors,'calendar_grid_reused':'458329 pairs/1353 errors retained unchanged authentic103f aggregate identity','no_production':True,'no_money_rpc':True,'no_performance_claim':True},indent=2)+'\n');print(json.dumps({'PASS':True,'counts':counts,'errors':errors,'rows':[r['accepted_rows'] for r in results]}))
finally:
 if started:run([G/'pg_ctl','-D',D,'-m','fast','-w','stop'],'stop')
 if (B/'server.log').exists():shutil.copyfile(B/'server.log',O/'server.log')
 shutil.rmtree(B);(O/'cleanup.json').write_text(json.dumps({'own_cluster_stopped':True,'own_cluster_removed':True,'production':False}))
