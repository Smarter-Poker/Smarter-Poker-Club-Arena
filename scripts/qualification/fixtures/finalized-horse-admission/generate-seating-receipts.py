"""Restore exact empty current seat-custody relations in the finite native owner."""
import hashlib
import json
from pathlib import Path
BASE = Path(__file__).resolve().parent
capture = json.loads((BASE / 'seating-receipts.json').read_text())
def q(s): return "'" + s.replace("'", "''") + "'"
def ident(s): return '"' + s.replace('"', '""') + '"'
sql = ["BEGIN; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='2s'; SET LOCAL search_path=public,extensions,pg_temp; SET LOCAL check_function_bodies=off;",
 "DO $$ BEGIN IF session_user<>'fixture_bootstrap' OR current_database() !~ '^qual_spin_expiry_[0-9a-f]{32}$' OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>'' OR current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'SEAT_RECEIPT_PROVIDER_ISOLATION_REQUIRED'; END IF; END $$;"]
functions = {}
for r in capture['relations']:
 name = 'public.'+r['name']; assert r['owner']=='postgres' and r['policies'] is None
 cols=[]
 for c in r['columns']:
  assert not c['identity'] and not c['generated']
  cols.append(ident(c['name'])+' '+c['type']+(' DEFAULT '+c['default'] if c['default'] else '')+(' NOT NULL' if c['notnull'] else ''))
 sql += ['CREATE TABLE '+name+'('+','.join(cols)+');','ALTER TABLE '+name+' OWNER TO postgres;',
         'ALTER TABLE '+name+(' ENABLE' if r['relrowsecurity'] else ' DISABLE')+' ROW LEVEL SECURITY;',
         'ALTER TABLE '+name+(' FORCE' if r['relforcerowsecurity'] else ' NO FORCE')+' ROW LEVEL SECURITY;',
         'SET LOCAL ROLE postgres;','REVOKE ALL ON '+name+' FROM PUBLIC,anon,authenticated,service_role;']
 for acl in r['acl'].strip('{}').split(','):
  grantee,grants=acl.split('='); privileges,grantor=grants.split('/'); assert grantor=='postgres' and grantee in ('postgres','service_role') and '*' not in privileges
  mapping=dict(a='INSERT',r='SELECT',w='UPDATE',d='DELETE',D='TRUNCATE',x='REFERENCES',t='TRIGGER',m='MAINTAIN')
  sql.append('GRANT '+','.join(mapping[x] for x in privileges)+' ON '+name+' TO '+grantee+';')
 sql.append('RESET ROLE;')
 for c in r['constraints']:
  assert c['validated'] is True
  if c['type']!='t': sql.append('ALTER TABLE '+name+' ADD CONSTRAINT '+ident(c['name'])+' '+c['definition']+';')
 for i in r['indexes']:
  if i['constraint'] is None: sql.append(i['definition']+';')
 for t in r['triggers'] or []:
  if t['identity'] in functions: assert functions[t['identity']]==t['function_definition']
  else:
   functions[t['identity']]=t['function_definition'];sig='public.'+t['identity']
   assert t['function_owner']=='postgres' and t['function_acl'] in ('{postgres=X/postgres}','{postgres=X/postgres,service_role=X/postgres}')
   sql += [t['function_definition'].rstrip()+';','ALTER FUNCTION '+sig+' OWNER TO postgres;',
           'SET LOCAL ROLE postgres;','REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;',
           'GRANT EXECUTE ON FUNCTION '+sig+' TO postgres;','RESET ROLE;']
   if 'service_role=X/postgres' in t['function_acl']: sql += ['SET LOCAL ROLE postgres;','GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;','RESET ROLE;']
   sql.append('DO $$ BEGIN IF md5(pg_get_functiondef('+q(sig)+'::regprocedure)) IS DISTINCT FROM '+q(hashlib.md5(t['function_definition'].encode()).hexdigest())+" THEN RAISE EXCEPTION 'SEAT_RECEIPT_PROVIDER_FUNCTION_CHANGED'; END IF; END $$;")
  assert t['enabled']=='O';sql.append(t['definition']+';')
 sql.append('DO $$ BEGIN IF (SELECT pg_get_userbyid(relowner)<>\'postgres\' OR relrowsecurity IS DISTINCT FROM '+str(r['relrowsecurity']).lower()+' OR relforcerowsecurity IS DISTINCT FROM '+str(r['relforcerowsecurity']).lower()+' OR (SELECT array_agg(a::text ORDER BY a::text) FROM unnest(relacl) a) IS DISTINCT FROM '+q('{'+','.join(sorted(r['acl'].strip('{}').split(',')))+'}')+'::text[] FROM pg_class WHERE oid='+q(name)+'::regclass) THEN RAISE EXCEPTION \'SEAT_RECEIPT_PROVIDER_ACCESS_CHANGED\'; END IF; END $$;')
 # Verify the complete retained columns and all constraints/trigger/index sets.
 columns_query="(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'default',pg_get_expr(d.adbin,d.adrelid),'notnull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid="+q(name)+"::regclass AND a.attnum>0 AND NOT a.attisdropped)"
 queries=[(columns_query,r['columns']),
  ("(SELECT jsonb_agg(jsonb_build_object('name',conname,'type',contype,'definition',pg_get_constraintdef(oid),'validated',convalidated) ORDER BY conname) FROM pg_constraint WHERE conrelid="+q(name)+"::regclass)",sorted(r['constraints'],key=lambda c:c['name'])),
  ("(SELECT jsonb_agg(jsonb_build_object('name',tgname,'definition',pg_get_triggerdef(oid),'enabled',tgenabled) ORDER BY tgname) FROM pg_trigger WHERE tgrelid="+q(name)+"::regclass AND NOT tgisinternal)",sorted([{k:t[k] for k in ('name','definition','enabled')} for t in (r['triggers'] or [])],key=lambda t:t['name']) or None),
  ("(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'definition',pg_get_indexdef(i.indexrelid),'constraint',co.conname) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid LEFT JOIN pg_constraint co ON co.conindid=i.indexrelid AND co.conrelid=i.indrelid AND co.contype IN('p','u','x') WHERE i.indrelid="+q(name)+"::regclass)",sorted(r['indexes'],key=lambda i:i['name']))]
 for query,expected in queries:
  sql.append('DO $$ BEGIN IF '+query+' IS DISTINCT FROM '+(q(json.dumps(expected))+'::jsonb' if expected is not None else 'NULL::jsonb')+' THEN RAISE EXCEPTION '+q('SEAT_RECEIPT_PROVIDER_METADATA_CHANGED: '+name)+'; END IF; END $$;')
sql.append('COMMIT;')
(BASE/'seating-receipts.sql').write_text('\n'.join(sql)+'\n')
