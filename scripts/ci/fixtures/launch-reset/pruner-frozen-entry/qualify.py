"""Finite native qualification of the frozen pruner entry; no production."""
from pathlib import Path
import argparse,os,subprocess,tempfile,json,hashlib,shutil
p=argparse.ArgumentParser();p.add_argument('--repository',type=Path,required=True);p.add_argument('--scratch',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--node',default=shutil.which('node'));p.add_argument('--pg-module',type=Path,required=True);p.add_argument('--migration',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
here=Path(__file__).resolve().parent;fixture=a.repository/'scripts/ci/fixtures/launch-reset';bootstrap=fixture/'original-bootstrap.sql'
assert hashlib.sha256(bootstrap.read_bytes()).hexdigest()==json.loads((fixture/'fixture-hashes.json').read_text())[bootstrap.name]
for name,digest in json.loads((here/'fixture-pins.json').read_text()).items():assert hashlib.sha256((a.repository/name).read_bytes()).hexdigest()==digest,'Frozen pruner fixture changed: '+name
assert ' 17.' in subprocess.check_output([str(a.pg_bin/'initdb'),'--version'],text=True)
a.scratch.mkdir(parents=True,exist_ok=True)
def cmd(args,env=None):
 r=subprocess.run([str(x) for x in args],env=env,capture_output=True,text=True,timeout=90)
 if r.returncode:raise AssertionError(r.stderr[-4000:])
 return r.stdout
with tempfile.TemporaryDirectory(prefix='pl-',dir=a.scratch) as temp:
 root=Path(temp);sock=root/'s';sock.mkdir();data=root/'d'
 cmd([a.pg_bin/'initdb','-D',data,'-U','journal_test','-A','trust','--no-locale','-E','UTF8'])
 with (data/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\n")
 started=False
 try:
  cmd([a.pg_bin/'pg_ctl','-D',data,'-l',root/'log','-w','start']);started=True
  env=dict(os.environ,PGHOST=str(sock),PGPORT='5432',PGUSER='journal_test',PGDATABASE='postgres',PGSSLMODE='disable',PRUNER_PREIMAGE=str(fixture/'pruner-lane/expected.sql'),PRUNER_DEPENDENCIES=str(fixture/'pruner-lane/ordinary-dependencies.sql'),PRUNER_BOOTSTRAP=str(bootstrap),PRUNER_PG_MODULE=str(a.pg_module.resolve()),PRUNER_MIGRATION=str(a.migration.resolve()))
  result=json.loads(cmd([a.node,here/'witness.mjs'],env));result.update(migration_sha256=hashlib.sha256(a.migration.read_bytes()).hexdigest(),original_source_md5='c978edad9c8a6b2e93a4cb3016ab96ec')
  a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
 finally:
  if started:cmd([a.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
