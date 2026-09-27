"""Restore genuine current fee-custody relation for an isolated existing image."""
import argparse,json,re,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--capture',type=Path,required=True);a=p.parse_args();base=Path(__file__).resolve().parent
sources={}
def read(n):
 path=a.capture/n;sources[n]=hashlib.sha256(path.read_bytes()).hexdigest();d=json.loads(path.read_text());d=d.get('r',d);return json.loads(re.search(r'\n(\[.*\])\n</untrusted',json.loads(d['content'][0]['text'])['result'],re.S)[1])
r=next(x for x in read('first-terminal-catalog.json') if x['name']=='public.accounting_tournament_fee_custody_obligations')
functions=[x for x in read('first-additional-trigger-functions.json') if x['identity'] in ['fn_ca_legacy_fee_custody_is_append_only()','fn_ca_legacy_fee_custody_requires_terminal()']];assert len(functions)==2
name=r['name']
def q(v):return "'"+v.replace("'","''")+"'"
def i(v):return '"'+v.replace('"','""')+'"'
sql=["BEGIN; SET LOCAL timezone='UTC'; SET LOCAL search_path=public,extensions,pg_temp; SET LOCAL check_function_bodies=off;","DO $$ BEGIN IF session_user<>'fixture_bootstrap' OR current_database() !~ '^qual_spin_expiry_[0-9a-f]{32}$' OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>'' THEN RAISE EXCEPTION 'FEE_CUSTODY_PROVIDER_ISOLATION_REQUIRED'; END IF; END $$;"]
cols=[]
for c in r['columns']:
 assert not c['identity'] and not c['generated'];cols.append(i(c['name'])+' '+c['type']+(' DEFAULT '+c['default'] if c['default'] else '')+(' NOT NULL' if c['notnull'] else ''))
sql.append('CREATE TABLE '+name+'('+','.join(cols)+'); ALTER TABLE '+name+' OWNER TO postgres; ALTER TABLE '+name+' ENABLE ROW LEVEL SECURITY; REVOKE ALL ON '+name+' FROM PUBLIC,anon,authenticated,service_role;')
for c in r['constraints']:
 if not c['definition'].startswith('TRIGGER '):sql.append('ALTER TABLE '+name+' ADD CONSTRAINT '+i(c['name'])+' '+c['definition']+';')
for f in functions:
 sig='public.'+f['identity'];assert f['proacl']=='{postgres=X/postgres}'
 sql += [f['definition'].rstrip()+';','ALTER FUNCTION '+sig+' OWNER TO postgres; REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION '+sig+' TO postgres;']
 sql.append('DO $$ BEGIN IF md5(pg_get_functiondef('+q(sig)+'::regprocedure)) IS DISTINCT FROM '+q(f['md5'])+" THEN RAISE EXCEPTION 'FEE_CUSTODY_PROVIDER_SOURCE_CHANGED'; END IF; END $$;")
for t in r['triggers']:
 assert t['enabled']=='O';sql.append(t['definition']+';')
sql.append('COMMIT;');(base/'fee-custody-provider.sql').write_text('\n'.join(sql)+'\n');(base/'fee-custody-provider.json').write_text(json.dumps({'source_sha256':sources,'relation':r,'functions':functions,'financial_qualified':False},indent=2)+'\n')
print('Captured custody relation and two original guards rendered; native pending')
