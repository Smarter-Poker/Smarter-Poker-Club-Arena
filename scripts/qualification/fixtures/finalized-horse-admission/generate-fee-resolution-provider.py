"""Restore exact captured fee guard dependencies inside isolated provider only."""
import argparse,json,re,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--capture',type=Path,required=True);a=p.parse_args();base=Path(__file__).resolve().parent
sources={}
def read(n):
 path=a.capture/n;sources[n]=hashlib.sha256(path.read_bytes()).hexdigest();d=json.loads(path.read_text())['r'];return json.loads(re.search(r'\n(\[.*\])\n</untrusted',json.loads(d['content'][0]['text'])['result'],re.S)[1])
relations=read('first-fee-resolution-catalog.json');functions=read('first-fee-resolution-dependency.json')+read('first-fee-resolution-functions.json')
def q(v):return "'"+v.replace("'","''")+"'"
def i(v):return '"'+v.replace('"','""')+'"'
sql=["BEGIN; SET LOCAL timezone='UTC'; SET LOCAL search_path=public,extensions,pg_temp; SET LOCAL check_function_bodies=off;", "DO $$ BEGIN IF session_user<>'fixture_bootstrap' OR current_database() !~ '^qual_spin_expiry_[0-9a-f]{32}$' OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>'' THEN RAISE EXCEPTION 'FEE_GUARD_PROVIDER_ISOLATION_REQUIRED'; END IF; END $$;"]
for r in relations:
 name='public.'+r['name'];cols=[]
 for c in r['columns']:
  assert not c['identity'] and not c['generated'];cols.append(i(c['name'])+' '+c['type']+(' DEFAULT '+c['default'] if c['default'] else '')+(' NOT NULL' if c['notnull'] else ''))
 sql.append('CREATE TABLE '+name+'('+','.join(cols)+');')
 sql.append('ALTER TABLE '+name+' OWNER TO postgres; ALTER TABLE '+name+' ENABLE ROW LEVEL SECURITY; REVOKE ALL ON '+name+' FROM PUBLIC,anon,authenticated,service_role;')
 for c in r['constraints']:
  if c['type']!='t':sql.append('ALTER TABLE '+name+' ADD CONSTRAINT '+i(c['name'])+' '+c['definition']+';')
for r in functions:
 sig='public.'+r['identity'];sql += [r['definition'].rstrip()+';','ALTER FUNCTION '+sig+' OWNER TO postgres;','REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;','GRANT EXECUTE ON FUNCTION '+sig+' TO postgres;']
 assert r['proacl']=='{postgres=X/postgres}'
 sql.append('DO $$ BEGIN IF md5(pg_get_functiondef('+q(sig)+'::regprocedure)) IS DISTINCT FROM '+q(r['md5'])+" THEN RAISE EXCEPTION 'FEE_GUARD_PROVIDER_SOURCE_CHANGED'; END IF; END $$;")
for r in relations:
 for t in r['triggers']:
  assert t['enabled']=='O';sql.append(t['definition']+';')
sql.append('COMMIT;')
(base/'fee-resolution-provider.sql').write_text('\n'.join(sql)+'\n')
(base/'fee-resolution-provider.json').write_text(json.dumps({'source_sha256':sources,'relations':relations,'functions':functions,'financial_qualified':False},indent=2)+'\n')
print(json.dumps({'relations':len(relations),'functions':len(functions),'financial_qualified':False}))
