#!/usr/bin/env python3
"""Independently derive exact pending DDL metadata in native PG, without rows."""
import importlib.util,json,os,re,shutil,subprocess,sys,tempfile
from pathlib import Path
import forward
spec=importlib.util.spec_from_file_location('rebuild',Path(__file__).with_name('verify.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
forward.validate(v.ROOT,forward.entries());source=(v.ROOT/forward.PATH).read_text()
pg=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'));parent=v.validate_parent(os.environ.get('SCHEMA_TEST_SCRATCH',str(v.ROOT.parent)));work=Path(tempfile.mkdtemp(prefix='delta-',dir=parent));sock=work/'s';sock.mkdir();started=False;env={k:x for k,x in os.environ.items() if not k.startswith('PG')}
def run(args,source=None):
 r=subprocess.run([str(x) for x in args],input=source,text=True,capture_output=True,env=env,timeout=40)
 if r.returncode:raise RuntimeError('Independent schema metadata fixture refused: '+v.safe_error_line(r.stderr.splitlines()[0] if r.stderr else '',{}))
 return r.stdout.strip()
try:
 run([pg/'initdb','-D',work/'d','-U','supabase_admin','--auth-local=trust','--auth-host=reject','--no-locale'])
 with (work/'d/postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories="+v.lit(sock)+"\nshared_buffers='16MB'\n")
 run([pg/'pg_ctl','-D',work/'d','-l',work/'server.log','-w','start']);started=True
 cmd=[pg/'psql','-X','-qAt','-h',sock,'-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1']
 def sql(s):return run(cmd,s)
 sql('CREATE ROLE postgres;CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;GRANT CREATE ON SCHEMA public TO postgres;')
 # These three empty typed relations only derive index metadata. This is not
 # application runtime qualification; the full baseline gate supplies those.
 minimal='CREATE TABLE public.wallet_transactions(user_id uuid,created_at timestamptz,amount numeric(15,2),type text);CREATE TABLE public.tournament_escrow(tournament_id uuid,overlay_in numeric);CREATE TABLE public.ca_bbj_pool_snapshots(pool_id uuid,taken_at timestamptz,main numeric,backup numeric,promo numeric,is_baseline boolean);'
 functions=re.findall(r'^CREATE(?: OR REPLACE)? FUNCTION public\.[a-z_]+\(.*?^\$function\$;',source,re.M|re.S)
 tables=re.findall(r'^CREATE TABLE public\.ca_ledger_audit_[a-z_]+ \(.*?^\);',source,re.M|re.S)
 comments=re.findall(r"^COMMENT ON TABLE public\.ca_ledger_audit_[a-z_]+ IS\n  '(?:[^']|'')*';",source,re.M)
 indexes=re.findall(r'^CREATE INDEX CONCURRENTLY IF NOT EXISTS [^\n]+;',source,re.M)
 rls=re.findall(r'^ALTER TABLE public\.ca_ledger_audit_[a-z_]+ ENABLE ROW LEVEL SECURITY;',source,re.M)
 revokes=re.findall(r'^REVOKE ALL ON TABLE public\.ca_ledger_audit_marks,.*?;',source,re.M|re.S)
 acls=re.findall(r'^(?:REVOKE ALL|GRANT EXECUTE) ON FUNCTION [^\n]+;',source,re.M)
 assert [len(x) for x in [functions,tables,comments,indexes,rls,revokes,acls]]==[7,3,3,3,3,1,13]
 # Uncalled function bodies are kept byte-exact; body checking is performed
 # later against the actual complete schema by the exact original migration.
 sql('SET ROLE postgres;SET check_function_bodies=off;'+minimal+'\n'+'\n'.join(tables+comments+rls+revokes+functions+acls))
 sql('SET ROLE postgres;'+ '\n'.join(indexes))
 catalog=json.loads(sql((v.ROOT/'scripts/schema-rebuild/catalog.sql').read_text()))
 delta={'sourceSHA256':forward.SOURCE_SHA,'relations':[r for r in catalog['relations'] if r['schema']=='public' and r['name'] in forward.TABLES],'indexes':[i for r in catalog['relations'] for i in r.get('indexes') or [] if i['name'] in forward.INDEX_TABLES],'routines':catalog['routines'],'comments':[c for c in catalog['comments'] if c['object'] in {'table public.'+n for n in forward.TABLES}]}
 delta['indexes'].sort(key=lambda i:i['name'])
 assert all(r['owner']=='postgres' and r['rls'] and not r['force_rls'] and not r['policies'] and {a['grantee'] for a in r['acl']}=={'postgres'} for r in delta['relations'])
 for routine in delta['routines']:
  assert routine['owner']=='postgres' and routine['definer']
  expected_roles={'postgres'} if routine['name']=='fn_ca_ledger_audit_checkpoint_advance' else {'postgres','service_role'}
  assert {a['grantee'] for a in routine['acl']}==expected_roles and all(a['privilege']=='EXECUTE' and a['grantor']=='postgres' and not a['grantable'] for a in routine['acl'])
 target=v.BASE/'pending-hourly-sweep-catalog.json'
 if sys.argv[1:]==['--write-expectation']:target.write_text(json.dumps(delta,indent=2)+'\n')
 else:
  assert delta==forward.load_delta(v.BASE),'Native source-derived metadata differs from independent committed expectation'
  reference=json.loads((v.BASE/'pokeriq-catalog-reference.json').read_text());expected=forward.expected_catalog(reference,delta)
  assert len(expected['relations'])==len(reference['relations'])+3 and len(expected['routines'])==len(reference['routines'])+1
  bad=json.loads(json.dumps(reference));next(r for r in bad['routines'] if r['name']=='fn_chip_drift_since_baseline')['definition_md5']='0'*32
  try:forward.expected_catalog(bad,delta)
  except ValueError:pass
  else:raise AssertionError('Changed preimage accepted')
  for category in ['relations','routines','comments']:
   changed=json.loads(json.dumps(expected));changed[category].pop();assert v.compare(expected,changed),'Missing pending object was accepted'
 print('PASS: exact source-derived3table/3explicitindex/7routine/3comment metadata; no rows or business routines invoked.')
finally:
 if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(work/'d'),'-m','immediate','-w','stop'],capture_output=True,env=env,timeout=30)
 shutil.rmtree(work)
