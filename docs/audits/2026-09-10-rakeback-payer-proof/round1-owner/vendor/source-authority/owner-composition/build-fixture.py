#!/usr/bin/env python3
"""Rebuild an isolated, empty native schema from captured production catalog.
No production data or credentials are loaded. Definitions and cash-path triggers
are installed verbatim; seed rows are inserted before enabling the trigger graph.
"""
import json,re
from pathlib import Path
p=Path(__file__).resolve().parent
tables={x['schema']+'.'+x['name']:x for f in p.glob('table-catalog-*.json') for x in json.loads(f.read_text())}
funcs={x['signature']:x for f in p.glob('function-catalog-*.json') for x in json.loads(f.read_text())}
triggers=list({x['definition']:x for f in p.glob('trigger-catalog*.json') for x in json.loads(f.read_text())}.values())
for t in triggers:
 if 'function_definition' in t: funcs[t['signature']]={'signature':t['signature'],'definition':t['function_definition'],'body_md5':t['body_md5'],'grants':t['grants'],'owner':t['owner']}
q=lambda s:'"'+s.replace('"','""')+'"'
sql=["CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE EXTENSION pg_trgm; CREATE EXTENSION pgcrypto WITH SCHEMA extensions; CREATE EXTENSION \"uuid-ossp\" WITH SCHEMA public; SET check_function_bodies=off;",
"CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;",
"CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;",
"CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;",
"CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;"]
for seq in sorted({m[1] for t in tables.values() for c in t['columns'] if c['default'] for m in re.finditer(r"nextval\('([^']+)'::regclass\)",c['default'])}):
 sql.append('CREATE SEQUENCE '+seq+';')
sql.append('CREATE SEQUENCE public.chip_ledger_chain_seq AS bigint START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 NO CYCLE;')
for name,t in sorted(tables.items()):
 cols=[]
 for c in t['columns']:
  v=q(c['name'])+' '+c['type']
  if c['generated']:v+=' GENERATED ALWAYS AS ('+c['default']+') STORED'
  elif c['identity']:v+=' GENERATED '+('ALWAYS' if c['identity']=='a' else 'BY DEFAULT')+' AS IDENTITY'
  # Defaults are restored verbatim after the function catalog is installed.
  if c['not_null']:v+=' NOT NULL'
  cols.append(v)
 sql.append('CREATE TABLE '+name+' ('+',\n'.join(cols)+');')
(p/'schema-tables.sql').write_text('\n'.join(sql)+'\n')
sql=['SET check_function_bodies=off;']
for f in sorted(funcs.values(),key=lambda x:x['signature']):
 sql.append(f['definition'].rstrip()+';')
 sql.append('REVOKE ALL ON FUNCTION public.'+f['signature']+' FROM PUBLIC,anon,authenticated,service_role;')
 if not f['grants'] or re.search(r'(?:^|[,{])=X/',f['grants']):sql.append('GRANT EXECUTE ON FUNCTION public.'+f['signature']+' TO PUBLIC;')
 if f['grants'] and 'anon=X/' in f['grants']:sql.append('GRANT EXECUTE ON FUNCTION public.'+f['signature']+' TO anon;')
 if f['grants'] and 'service_role=X/' in f['grants']:sql.append('GRANT EXECUTE ON FUNCTION public.'+f['signature']+' TO service_role;')
 if f['grants'] and 'authenticated=X/' in f['grants']:sql.append('GRANT EXECUTE ON FUNCTION public.'+f['signature']+' TO authenticated;')
(p/'schema-functions.sql').write_text('\n'.join(sql)+'\n')
sql=[]
for name,t in sorted(tables.items()):
 for c in t['columns']:
  if c['default'] and not c['generated'] and not c['identity']:
   sql.append('ALTER TABLE '+name+' ALTER COLUMN '+q(c['name'])+' SET DEFAULT '+c['default']+';')
(p/'schema-defaults.sql').write_text('\n'.join(sql)+'\n')
sql=[];missing=set()
for name,t in sorted(tables.items()):
 for c in t['constraints']:
  if c['type'] not in ('f','t'):sql.append('ALTER TABLE '+name+' ADD CONSTRAINT '+q(c['name'])+' '+c['definition']+';')
  elif c['type']=='f':
   ref=re.search(r'REFERENCES ([^ (]+)',c['definition'])[1];ref=ref if '.' in ref else 'public.'+ref
   if ref not in tables:missing.add(ref)
 for i in t['indexes']:
  if not any(c['name']==i['name'].split('.')[-1].strip(chr(34)) for c in t['constraints']):sql.append(i['definition']+';')
(p/'schema-constraints.sql').write_text('\n'.join(sql)+'\n')
sql=[]
for name,t in sorted(tables.items()):
 for c in t['constraints']:
  if c['type']=='f':sql.append('ALTER TABLE '+name+' ADD CONSTRAINT '+q(c['name'])+' '+c['definition']+';')
(p/'schema-foreign-keys.sql').write_text('\n'.join(sql)+'\n')
(p/'schema-triggers.sql').write_text('\n'.join(t['definition']+';' for t in triggers)+'\n')
(p/'catalog-summary.json').write_text(json.dumps({'tables':len(tables),'functions':len(funcs),'triggers':len(triggers),'missing_foreign_tables':sorted(missing)},indent=2)+'\n')
print((p/'catalog-summary.json').read_text())
