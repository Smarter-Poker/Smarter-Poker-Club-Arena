"""Real pre-fix provider hook: policy admission precedes ledger DDL."""
from pathlib import Path
import argparse,hashlib,json,os,re,shutil,subprocess,tempfile,tarfile
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--candidate',type=Path,required=True);p.add_argument('--scratch',type=Path,required=True)
p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--pg-module',type=Path,required=True)
p.add_argument('--output',type=Path,required=True);p.add_argument('--node',default=shutil.which('node'))
a=p.parse_args();here=Path(__file__).resolve().parent/'fixtures'/'launch-reset'/'provider-policy-hook'
pins=json.loads((here/'source-pins.json').read_text())
for name,digest in pins['files'].items():
 if hashlib.sha256((here/name).read_bytes()).hexdigest()!=digest:raise AssertionError('Provider fixture changed: '+name)
sql=a.candidate.read_text();source_sha=hashlib.sha256(sql.encode()).hexdigest()
policies=[sql.index('CREATE POLICY '+n) for n in ['launch_current_settlement_invoices','launch_current_credit_invoices']]
ledger=[m.start() for m in re.finditer(r'ALTER TABLE public\.chip_ledger\b|CREATE TRIGGER aaa_launch_closing_leg\b',sql)]
assert len(ledger)==4 and max(policies)<min(ledger),'Invoice policies must precede every closing ledger DDL lock'
def cmd(args,env=None):
 r=subprocess.run([str(x) for x in args],env=env,capture_output=True,text=True,timeout=120)
 if r.returncode:raise AssertionError(r.stderr[-5000:])
 return r.stdout
assert ' 17.' in cmd([a.pg_bin/'pg_config','--version'])
a.scratch.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='po-',dir=a.scratch) as temp:
 root=Path(temp)
 with tarfile.open(here/pins['archive']) as archive:archive.extractall(root,filter='data')
 source=next(root.glob('supabase-supautils-*'))
 assert hashlib.sha256((source/'Makefile').read_bytes()).hexdigest()==pins['makefile_sha256']
 cmd(['make','-C',source,'PG_CONFIG='+str(a.pg_bin/'pg_config'),'PG_VERSION=17','PG_CFLAGS=-std=c11 -Wextra -Wall -Wno-ignored-attributes -Wno-declaration-after-statement -Wno-vla -Wno-long-long','-j2'])
 library=next(x for x in source.glob('supautils.*') if x.suffix in ['.so','.dylib'])
 data=root/'d';sock=root/'s';sock.mkdir()
 cmd([a.pg_bin/'initdb','-D',data,'-U','journal_test','-A','trust','--no-locale','-E','UTF8'])
 with (data/'postgresql.conf').open('a') as f:
  f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\nsession_preload_libraries='"+str(library)+"'\nsupautils.superuser='journal_test'\nsupautils.policy_grants='{\"ordering_writer\":[\"auth.users\"]}'\n")
 started=False
 try:
  cmd([a.pg_bin/'pg_ctl','-D',data,'-l',root/'log','-w','start']);started=True
  env=dict(os.environ,PGHOST=str(sock),PGUSER='journal_test',PGDATABASE='postgres',PGPORT='5432',PGSSLMODE='disable',QUALIFIED_PG_MODULE=str(a.pg_module.resolve()))
  result=json.loads(cmd([a.node,here/'witness.mjs'],env))
  result.update(candidate_sha256=source_sha,provider_source_commit=pins['commit'],provider_source_archive_sha256=pins['files'][pins['archive']],candidate_order_bound=True,production_actions=False)
  a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
 finally:
  if started:cmd([a.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
