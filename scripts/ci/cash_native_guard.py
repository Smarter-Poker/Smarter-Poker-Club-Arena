"""Private-only native catalog bootstrap/adaptation. No DB or business calls on import."""
import json,re
from pathlib import Path
def lit(x):return "'"+str(x).replace("'","''")+"'"
def compact(x):return json.dumps(x,separators=(',',':'))
def bootstrap(q,js,F):
 a=json.loads((F/'authority.json').read_text());before=json.loads((F/'function-before.json').read_text());after=json.loads((F/'function-after.json').read_text())
 # Actual source text compiled; schema dependency rake_records is provided by existing TQ fixture.
 q('CREATE UNIQUE INDEX native_rake_id_pk ON rake_records(id);')
 for o in a['owners']:
  if o['metadata']['prolang']=='12':continue
  q('SET check_function_bodies=off;'+o['definition']+';')
  name=re.search(r'FUNCTION (.*?)\(',o['definition']).group(1);sig=name+'()'
  q('REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;')
  if any(x.startswith('service_role=')for x in(o['metadata']['proacl']or[])):q('GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;')
 for name in ['accounting_cash_source_receipts','accounting_cash_source_work']:
  r=next(x for x in a['relations']if x['name']==name)
  cols=[c['attribute']['attname']+' '+c['type']+(' NOT NULL'if c['attribute']['attnotnull']else'')+(' DEFAULT '+c['default']if c['default']else'')for c in r['columns']]
  q('CREATE TABLE public.'+name+'('+','.join(cols)+');')
  for c in r['constraints']:q('ALTER TABLE public.'+name+' ADD CONSTRAINT '+c['conname']+' '+c['definition']+';')
  for i in r['indexes']:
   ix=i['relation']['relname']
   if q('SELECT to_regclass('+lit('public.'+ix)+')IS NULL;')=='t':q(i['definition']+';')
  for t in r['triggers']:
   if not t['tgisinternal']:q(t['definition']+';')
  if r['relation']['relrowsecurity']:q('ALTER TABLE '+name+' ENABLE ROW LEVEL SECURITY;')
  q('GRANT SELECT ON '+name+' TO service_role;')
 q('SET check_function_bodies=off;'+before['definition']+';REVOKE ALL ON FUNCTION '+before['signature']+' FROM PUBLIC,anon,authenticated,service_role;')
 if any(x.startswith('service_role=')for x in(before['metadata']['proacl']or[])):q('GRANT EXECUTE ON FUNCTION '+before['signature']+' TO service_role;')
 def owner():return js("SELECT jsonb_build_object('owner',pg_get_userbyid(proowner),'metadata',to_jsonb(p),'signature',"+lit(before['signature'])+",'definition',pg_get_functiondef(p.oid))FROM pg_proc p WHERE oid=to_regprocedure("+lit(before['signature'])+")")
 native_before=owner();native_after=js('BEGIN;SET LOCAL check_function_bodies=off;'+after['definition']+";SELECT jsonb_build_object('owner',pg_get_userbyid(proowner),'metadata',to_jsonb(p),'signature',"+lit(before['signature'])+",'definition',pg_get_functiondef(p.oid))FROM pg_proc p WHERE oid=to_regprocedure("+lit(before['signature'])+");ROLLBACK;")
 assert native_before['definition']==before['definition'] and native_after['definition']==after['definition']
 assert {k:v for k,v in native_before['metadata'].items()if k!='prosrc'}=={k:v for k,v in native_after['metadata'].items()if k!='prosrc'}
 native_owners=[]
 for o in a['owners']:
  name=re.search(r'FUNCTION (.*?)\(',o['definition']).group(1)
  native_owners.append(js("SELECT jsonb_build_object('definition',pg_get_functiondef(p.oid),'metadata',to_jsonb(p))FROM pg_proc p WHERE oid=to_regprocedure("+lit(name+'()')+")"))
 seed={'owners':native_owners};query=(F/'guard-select.sql').read_text().replace("expected->'owners'",'('+lit(compact(seed))+"::jsonb)->'owners'").replace('INTO actual;',';');native=js(query)
 def adapt(sql):return sql.replace(compact(a),compact(native)).replace(compact(before['metadata']),compact(native_before['metadata'])).replace(compact(after['metadata']),compact(native_after['metadata']))
 def seed_fixture():
  q("INSERT INTO rake_records(id)SELECT md5('cash-native-'||g)::uuid FROM generate_series(1,101)g;")
  q("INSERT INTO accounting_cash_source_receipts(id,rake_record_id,attempt,earned_at,source_fingerprint,status,reason,scope,result)SELECT md5('receipt-native-'||g)::uuid,md5('cash-native-'||g)::uuid,1,'2026-10-19'::timestamptz+(g%20)*interval '1 day','native','blocked','native',jsonb_build_object('kind',CASE WHEN g%10=0 THEN 'unknown'ELSE 'union'END,'id',CASE WHEN g%3=0 THEN '00000000-0000-0000-0000-000000000001'ELSE '00000000-0000-0000-0000-000000000002'END),'{}' FROM generate_series(1,100)g;")
  q("INSERT INTO accounting_cash_source_work SELECT rake_record_id,id,'native','blocked',1,clock_timestamp()FROM accounting_cash_source_receipts;")
 def files(root):return [next((Path(root)/'supabase/migrations').glob('*_'+slug+'.sql'))for slug in ['cash_refusal_scope_and_time_have_a_bounded_index','cash_refusal_scope_index_has_real_collected_statistics','cash_refusal_queries_scope_before_walking_blocked_receipts']]
 def install_fixture_prerequisites(root):
  # Private TQ dependency fixture; dedicated cash harness executes whole guarded migrations.
  seed_fixture()
  for file in files(root):
   text=file.read_text()
   if 'CREATE INDEX CONCURRENTLY'in text:q(text[:text.index('BEGIN;')])
   elif file.name.endswith('_cash_refusal_scope_index_has_real_collected_statistics.sql'):
    start=text.index('CREATE STATISTICS public.accounting_cash_receipts_scope_distribution');end=text.index('DO $cash_collected$',start);q(text[start:end])
   else:q('SET check_function_bodies=off;'+after['definition']+';')
   q('INSERT INTO supabase_migrations.schema_migrations(version,name,statements)VALUES('+lit(file.name[:14])+','+lit(file.name[15:-4])+',ARRAY['+lit(text)+']);')
  assert owner()==native_after
 return {'adapt':adapt,'before':native_before,'after':native_after,'authority':native,'owner':owner,'capture':lambda:js(query),'query':query,'install_fixture_prerequisites':install_fixture_prerequisites,'seed_fixture':seed_fixture,'files':files}
