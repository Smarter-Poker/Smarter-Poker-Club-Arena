#!/usr/bin/env python3
"""One explicit schema-only read, native dump and catalog sharing one snapshot.
CLI credentials stay in memory; never execute the CLI dry-run shell text.
"""
import argparse,hashlib,importlib.util,json,os,re,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--workdir',required=True);ap.add_argument('--project-ref',required=True);ap.add_argument('--pg-dump',required=True);ap.add_argument('--pg-bin',required=True);ap.add_argument('--output-dir',required=True);args=ap.parse_args()
 spec=importlib.util.spec_from_file_location('exporter',ROOT/'scripts/dr/native-supabase-export.py');n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)
 directory=Path(args.output_dir).absolute();n.destination(directory/'schema.sql');n.destination(directory/'catalog.json');n.linked_project(args.workdir,args.project_ref);env=n.cli_environment('/opt/homebrew/bin/supabase',args.workdir);env['PGSSLROOTCERT']=str(ROOT/'scripts/ci/certificates/supabase-prod-ca-2021.crt');env['PGAPPNAME']='schema-lineage-consistent-readonly';env['PGOPTIONS']='-c default_transaction_read_only=on -c idle_in_transaction_session_timeout=120s -c statement_timeout=90s';pg=Path(args.pg_bin)
 holder=subprocess.Popen([str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1'],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  holder.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SELECT pg_export_snapshot();\n');holder.stdin.flush();snapshot=holder.stdout.readline().strip()
  if not re.fullmatch(r'[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+',snapshot):raise RuntimeError('Read-only snapshot export failed; diagnostic omitted')
  schema=directory/'schema.sql.partial'
  with schema.open('xb') as f:
   os.chmod(schema,0o600);r=subprocess.run([args.pg_dump,'--schema-only','--verbose','--lock-wait-timeout=5s','--snapshot='+snapshot],env=env,stdout=f,stderr=subprocess.PIPE,timeout=90)
  if r.returncode:raise RuntimeError('Consistent native schema export failed; private diagnostic omitted')
  query=(ROOT/'scripts/schema-rebuild/catalog.sql').read_text().replace('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;','BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET TRANSACTION SNAPSHOT '+"'"+snapshot+"';",1)
  catalog=directory/'catalog.json.partial'
  with catalog.open('xb') as f:
   os.chmod(catalog,0o600);r=subprocess.run([str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1'],input=query.encode(),env=env,stdout=f,stderr=subprocess.PIPE,timeout=90)
  if r.returncode:raise RuntimeError('Consistent catalog read failed; private diagnostic omitted')
  reference=json.loads(catalog.read_text());holder.stdin.write('COMMIT;\n');holder.stdin.close();holder.wait(timeout=15)
  if holder.returncode:raise RuntimeError('Read-only snapshot owner did not complete')
  os.link(schema,directory/'schema.sql');os.link(catalog,directory/'catalog.json');schema.unlink();catalog.unlink()
  receipt={'captured':True,'sourceProject':args.project_ref,'sameExportedSnapshot':True,'schemaSHA256':hashlib.sha256((directory/'schema.sql').read_bytes()).hexdigest(),'catalogSHA256':hashlib.sha256((directory/'catalog.json').read_bytes()).hexdigest(),'counts':{k:len(v or []) for k,v in reference.items()},'dataIncluded':False,'restoreQualified':False};(directory/'capture-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
 finally:
  if holder.poll() is None:holder.kill();holder.wait(timeout=15)
if __name__=='__main__':
 try:main()
 except (RuntimeError,OSError,ValueError,subprocess.SubprocessError):print('Schema capture refused or failed; no qualified baseline promoted.',file=sys.stderr);sys.exit(1)
