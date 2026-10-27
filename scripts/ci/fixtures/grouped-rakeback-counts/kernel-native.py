import os,subprocess,tempfile,socket,shutil,json,ast,time
from pathlib import Path
pg=Path(os.environ['PG_BIN']);w=Path(os.environ['GROUPED_NATIVE_WORK']);fx=Path(os.environ['GROUPED_NATIVE_FIXTURES'])
b=Path(tempfile.mkdtemp(prefix='batch-counts-',dir=w));started=False
with socket.socket()as s:s.bind(('127.0.0.1',0));port=str(s.getsockname()[1])
env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env['TMPDIR']=str(b)
def run(args,sql=None):
 r=subprocess.run(list(map(str,args)),input=sql,text=True,capture_output=True,env=env,timeout=180)
 assert not r.returncode,r.stderr;return r.stdout.strip()
def q(sql):return run([pg/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres'],sql)
bootstrap=(fx/'bootstrap.sql').read_text();cases=json.loads((fx/'cases.json').read_text())
rid="md5('record-1')::uuid";aid="md5('attr-'||md5('record-1')::uuid)::uuid"
clubs="ARRAY['10000000-0000-0000-0000-000000000001'::uuid,'10000000-0000-0000-0000-000000000002'::uuid,'10000000-0000-0000-0000-000000000003'::uuid]"
times="'2026-10-12 07:00Z','2026-10-19 07:00Z','2026-10-12 07:00Z','2026-10-12 09:00Z'"
old="SELECT jsonb_agg(jsonb_build_array(c::text,g,least(g+interval '2 hours','2026-10-19 07:00Z'),fn_rakeback_split_counts(c,'2026-10-12 07:00Z','2026-10-19 07:00Z',g,least(g+interval '2 hours','2026-10-19 07:00Z')))ORDER BY c,g)FROM unnest("+clubs+")c CROSS JOIN generate_series('2026-10-12 07:00Z'::timestamptz,'2026-10-19 07:00Z'::timestamptz-interval '1 microsecond',interval '2 hours')g"
new="SELECT jsonb_agg(jsonb_build_array(club_id::text,window_start,window_end,value)ORDER BY club_id,window_start)FROM prototype_grouped_counts("+clubs+",'2026-10-12 07:00Z','2026-10-19 07:00Z')"
try:
 run([pg/'initdb','-D',b/'d','-U','postgres','-A','trust','--no-locale','-E','UTF8']);run([pg/'pg_ctl','-D',b/'d','-l',b/'log','-o',f"-h 127.0.0.1 -k '' -p {port}",'-w','start']);started=True
 q(bootstrap);q("INSERT INTO clubs VALUES('10000000-0000-0000-0000-000000000003',false,NULL);CREATE TABLE launch_cutoffs(club_id uuid PRIMARY KEY,starts_at timestamptz);CREATE OR REPLACE FUNCTION fn_ca_launch_accounting_start(text,uuid,timestamptz)RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT greatest($3,coalesce((SELECT starts_at FROM launch_cutoffs WHERE club_id=$2),$3))$$;")
 q((fx/'original-cc867.sql').read_text());q((fx/'grouped-counts-kernel.sql').read_text())
 house="UPDATE clubs SET is_union=true,union_id=md5('union')::uuid WHERE id='10000000-0000-0000-0000-000000000002';UPDATE clubs SET union_id=md5('union')::uuid WHERE id='10000000-0000-0000-0000-000000000001';UPDATE rake_records SET club_id='10000000-0000-0000-0000-000000000002' WHERE id="+rid+";UPDATE rake_attributions SET club_id='10000000-0000-0000-0000-000000000002'WHERE rake_record_id="+rid+";UPDATE accounting_cash_rake_sources SET club_id='10000000-0000-0000-0000-000000000002',union_id=md5('union')::uuid,coordinator_union_id=md5('union')::uuid,contract=contract||jsonb_build_object('club_id','10000000-0000-0000-0000-000000000002','union_id',md5('union')::uuid,'coordinator_union_id',md5('union')::uuid,'is_union_house','true')WHERE rake_record_id="+rid
 passed=[]
 for mode in ['force_generic_plan','force_custom_plan']:
  for name,change,_ in cases:
   out=q('BEGIN;SET LOCAL plan_cache_mode='+mode+';'+change+(';'if change else '')+old+';'+new+';ROLLBACK;').splitlines();assert len(out)==2 and json.loads(out[0])==json.loads(out[1]),(mode,name,out);passed.append(mode+':'+name)
 # Actual UTC window generator follows a169-hour autumn week and167-hour spring week.
 for label,start,end,at in [('fall_dst_169h','2026-10-26 07:00Z','2026-11-02 08:00Z','2026-11-01 08:30Z'),('spring_dst_167h','2026-03-02 08:00Z','2026-03-09 07:00Z','2026-03-08 09:30Z')]:
  old_dst=old.replace('2026-10-12 07:00Z',start).replace('2026-10-19 07:00Z',end)
  new_dst=new.replace('2026-10-12 07:00Z',start).replace('2026-10-19 07:00Z',end)
  out=q("BEGIN;UPDATE rake_records SET created_at='"+at+"';UPDATE accounting_cash_rake_sources SET earned_at='"+at+"';"+old_dst+';'+new_dst+';ROLLBACK;').splitlines()
  assert len(out)==2 and json.loads(out[0])==json.loads(out[1]),(label,out)
  passed.append(label)
 q("INSERT INTO rake_records SELECT md5('bulk-record'||n)::uuid,md5('bulk-hand'||n)::uuid,'10000000-0000-0000-0000-000000000001',3,'2026-10-12 08:00Z'::timestamptz+make_interval(hours=>2*(n%84)::int),false,NULL,NULL,'{}' FROM generate_series(1,5000)n;INSERT INTO rake_attributions SELECT md5('bulk-attr'||r.id||c.id)::uuid,r.id,r.hand_id,md5('bulk-player'||c.id)::uuid,c.id,1 FROM rake_records r CROSS JOIN clubs c WHERE r.id IN(SELECT md5('bulk-record'||n)::uuid FROM generate_series(1,5000)n);INSERT INTO accounting_cash_accrual_batches SELECT md5('bulk-record'||n)::uuid,'accrued'FROM generate_series(1,5000)n;INSERT INTO accounting_cash_rake_sources SELECT md5('bulk-source'||a.id)::uuid,r.id,a.player_id,a.club_id,r.created_at,1,jsonb_build_object('attribution_id',a.id,'player_id',a.player_id,'club_id',a.club_id,'union_id',NULL,'coordinator_union_id',NULL),NULL,NULL FROM rake_records r JOIN rake_attributions a ON a.rake_record_id=r.id WHERE r.id IN(SELECT md5('bulk-record'||n)::uuid FROM generate_series(1,5000)n);ANALYZE")
 assert json.loads(q(old))==json.loads(q(new))
 body=(fx/'grouped-counts-kernel.sql').read_text().split('AS $grouped$\n',1)[1].split('\n$grouped$;',1)[0]
 body=body.replace('p_clubs',clubs).replace('v_from',"'2026-10-12 07:00Z'::timestamptz").replace('v_to',"'2026-10-19 07:00Z'::timestamptz")
 detailed=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+body))[0]
 (w/'grouped-body-plan.json').write_text(json.dumps(detailed,indent=2))
 def walk(node):
  yield node
  for child in node.get('Plans',[]):yield from walk(child)
 heavy={'records','attrs','batches','sources','house_proofs','membership','scoped','incomplete_pairs'}
 rescans=[{'cte':n.get('CTE Name'),'loops':n.get('Actual Loops'),'rows':n.get('Actual Rows')} for n in walk(detailed['Plan']) if n.get('Node Type')=='CTE Scan' and n.get('CTE Name')in heavy and n.get('Actual Loops',0)>1]
 assert not rescans,('repeated heavy materialized scans rejected',rescans)
 passed.append('actual_grouped_body_no_repeated_heavy_cte_rescans')
 timings={}
 for label,query in [('252_original_calls',old),('grouped_whole_week',new)]:
  plan=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+query))[0];(w/(label+'-plan.json')).write_text(json.dumps(plan));timings[label]={'execution_ms':plan['Execution Time'],'shared_hit_blocks':plan['Plan'].get('Shared Hit Blocks'),'shared_read_blocks':plan['Plan'].get('Shared Read Blocks')}
 result={'passed':True,'case_count':len(passed),'cases':passed,'local_5000_records_15000_attributions_84_windows_profile':timings,'limits':'Actual installed cc867 oracle versus fully grouped pure whole-week kernel. No keeper/freshness/lock integration, production profile, capacity or installation claim.'}
 (w/'grouped-counts-native-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
finally:
 if started:run([pg/'pg_ctl','-D',b/'d','-m','immediate','-w','stop'])
 shutil.rmtree(b)
