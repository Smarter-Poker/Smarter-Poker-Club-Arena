#!/usr/bin/env python3
"""Exercise catalog fidelity against real isolated PostgreSQL, without Docker."""
import json,os,shutil,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
pg=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
parent=Path(os.environ.get('SCHEMA_TEST_SCRATCH','/Volumes/SmarterWork/agent-work/supabase-lineage-20261020'))
if not parent.is_dir() or parent.resolve()!=parent:raise SystemExit('Owned scratch directory required')
if os.uname().sysname=='Darwin' and not parent.is_relative_to('/Volumes/SmarterWork/agent-work'):raise SystemExit('External scratch required')
env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
work=Path(tempfile.mkdtemp(prefix='ct-',dir=parent));sock=work/'s';sock.mkdir();started=False
try:
 def command(args,sql=None):
  r=subprocess.run([str(x) for x in args],input=sql,text=True,capture_output=True,env=env,timeout=60)
  if r.returncode:raise RuntimeError(r.stderr)
  return r.stdout
 command([pg/'initdb','-D',work/'d','-U','fixture_owner','--auth-local=trust','--auth-host=reject','--no-locale'])
 with (work/'d/postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\nshared_buffers='16MB'\nwal_level=logical\n")
 command([pg/'pg_ctl','-D',work/'d','-l',work/'server.log','-w','start']);started=True
 psql=[pg/'psql','-X','-qAt','-h',sock,'-U','fixture_owner','-d','postgres','-v','ON_ERROR_STOP=1']
 command(psql,"""
 CREATE ROLE z_client; CREATE ROLE a_client;
 CREATE SCHEMA specimen;
 CREATE TYPE specimen.state AS ENUM ('open','closed');
 CREATE DOMAIN specimen.positive AS bigint CHECK (VALUE > 0);
 CREATE TYPE specimen.pair AS (amount specimen.positive, state specimen.state);
 CREATE TYPE specimen.int_span AS RANGE (subtype=integer);
 CREATE TABLE specimen.parent(id bigint PRIMARY KEY, state specimen.state) PARTITION BY RANGE(id);
 CREATE TABLE specimen.child PARTITION OF specimen.parent FOR VALUES FROM(1) TO(100);
 CREATE TABLE specimen.entries(id bigint GENERATED ALWAYS AS IDENTITY, amount specimen.positive, state specimen.state DEFAULT 'open', note text);
 ALTER TABLE specimen.entries ENABLE ROW LEVEL SECURITY;
 CREATE POLICY entry_read ON specimen.entries TO z_client,a_client USING(amount>0);
 GRANT SELECT(note) ON specimen.entries TO z_client;
 GRANT SELECT, INSERT ON specimen.entries TO a_client;
 CREATE SEQUENCE specimen.extreme AS bigint MINVALUE 1 MAXVALUE 9223372036854775807 START 8 INCREMENT 2 CACHE 3 CYCLE;
 ALTER SEQUENCE specimen.extreme OWNED BY specimen.entries.amount;
 COMMENT ON COLUMN specimen.entries.note IS 'catalog fixture note';
 CREATE PUBLICATION specimen_pub FOR TABLE specimen.entries (id,amount) WHERE (id > 0);
 CREATE FUNCTION specimen.acc(bigint,bigint) RETURNS bigint LANGUAGE SQL IMMUTABLE AS 'SELECT coalesce($1,0)+$2';
 CREATE AGGREGATE specimen.total(bigint)(SFUNC=specimen.acc,STYPE=bigint,INITCOND='0');
 ALTER DEFAULT PRIVILEGES IN SCHEMA specimen GRANT SELECT ON TABLES TO a_client;
 """)
 def capture():return json.loads(command(psql,(ROOT/'scripts/schema-rebuild/catalog.sql').read_text()))
 c=capture();rows={(x['schema'],x['name']):x for x in c['relations']}
 assert rows['specimen','child']['partitioned'] is True
 assert rows['specimen','child']['parents']==['specimen.parent']
 assert rows['specimen','parent']['partition_key']=='RANGE (id)'
 entry=rows['specimen','entries'];assert entry['rls'] is True
 assert entry['policies'][0]['roles']==['a_client','z_client'], 'roles must sort by name, not OID creation order'
 assert any(a['grantee']=='a_client' and a['privilege']=='INSERT' for a in entry['acl'])
 note=next(x for x in entry['columns'] if x['name']=='note')
 assert any(a['grantee']=='z_client' and a['privilege']=='SELECT' for a in note['acl'])
 seq=next(x for x in c['sequences'] if x['schema']=='specimen' and x['name']=='extreme')
 assert seq['max']=='9223372036854775807' and seq['cache']=='3' and seq['cycle'] is True
 assert seq['owned_by'][0]['column']=='amount'
 kinds={x['kind'] for x in c['types'] if x['schema']=='specimen'};assert {'c','d','e','r','m'}<=kinds
 aggregate=next(x for x in c['routines'] if x['schema']=='specimen' and x['name']=='total')
 assert aggregate['kind']=='a' and aggregate['aggregate']['initial']=='0'
 pub=next(x for x in c['publications'] if x['name']=='specimen_pub');assert pub['tables'][0]['columns']==['amount','id']
 assert any(x['comment']=='catalog fixture note' for x in c['comments'])
 assert all(x['count']==0 for x in c['unsupported_objects']), c['unsupported_objects']
 command(psql,'REVOKE SELECT,INSERT ON specimen.entries FROM a_client; GRANT INSERT ON specimen.entries TO a_client; GRANT SELECT ON specimen.entries TO a_client;')
 c2=capture();assert c==c2, 'semantic ACL comparison must ignore equivalent grant order'
 command(psql,'REVOKE INSERT ON specimen.entries FROM a_client;')
 c3=capture();assert c3!=c2, 'actual privilege loss must change the catalog'
 command(psql,'CREATE CAST (specimen.pair AS text) WITH INOUT;')
 c_cast=capture();assert next(x['count'] for x in c_cast['unsupported_objects'] if x['class']=='nonextension_user_casts')==1, 'explicit casts must remain visible while automatic internal range casts are covered by the type'
 command(psql,'CREATE STATISTICS specimen.unsupported_stats ON id,amount FROM specimen.entries;')
 c4=capture();assert next(x['count'] for x in c4['unsupported_objects'] if x['class']=='nonextension_extended_statistics')==1, 'unsupported object family must be visible, never silently omitted'
 print('PASS: real PG17 catalog covers 64-bit sequence bounds, ownership, ACL/column ACL semantics, name-sorted policy roles, partitions, composite/domain/enum/range types, aggregates, publications, comments and privilege-loss detection.')
finally:
 if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(work/'d'),'-m','immediate','-w','stop'],env=env,capture_output=True,timeout=30)
 shutil.rmtree(work)
