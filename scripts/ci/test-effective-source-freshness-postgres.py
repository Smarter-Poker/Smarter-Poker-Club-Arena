#!/usr/bin/env python3
"""PG17 regression for original prepare/split freshness; no payment simulation."""
from pathlib import Path
import argparse,json,os,shutil,subprocess,tempfile
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--pg-bin',required=True);p.add_argument('--scratch',required=True);a=p.parse_args()
pg=Path(a.pg_bin);base=ROOT/'scripts/ci/fixtures/effective-source-freshness';scratch=Path(tempfile.mkdtemp(prefix='ef-',dir=a.scratch));data=scratch/'d';started=False
psql=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',scratch,'-U','postgres','-d','postgres']
def run(cmd,sql=None,error=None):
 r=subprocess.run([str(x)for x in cmd],input=sql,text=True,capture_output=True,timeout=60)
 if error:assert r.returncode and error in r.stderr,(error,r.stdout,r.stderr)
 else:assert r.returncode==0,(r.stdout,r.stderr)
 return r.stdout.strip()
def q(sql,error=None):
 f=scratch/'query.sql';f.write_text(sql);return run(psql+['-f',f],error=error)
file=ROOT/'supabase/migrations/20261020164752_accounting_freshness_uses_original_source_and_admission_inde.sql'
source=file.read_text()
pre=['fabde84baa4d2bee303531de45c65c06','cb4c66d535d0b0584ec2dad3d6f26c13'];post=['59ffa64567422631e131fd3cc2b03552','2d8ab8647146824b837ee193b624834c']
hashes="SELECT md5(pg_get_functiondef('fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure)),md5(pg_get_functiondef('fn_rakeback_recompute_split(uuid,date,date)'::regprocedure))"
try:
 assert ' 17.'in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
 with(data/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(scratch)+"'\nshared_buffers='16MB'\ntemp_file_limit='64MB'\n")
 run([pg/'pg_ctl','-D',data,'-l',scratch/'server.log','-w','start']);started=True
 for name in ['setup.sql','plan.sql','semantics.sql']:q((base/name).read_text())
 assert q(hashes)=='|'.join(pre)
 # All faults are local synthetic metadata changes, never active production.
 q('ALTER VIEW accounting_effective_cash_rake_sources RENAME COLUMN contract TO changed_contract')
 q(source,'original_effective_cash_view_contract_changed')
 q('ALTER VIEW accounting_effective_cash_rake_sources RENAME COLUMN changed_contract TO contract;ALTER TABLE accounting_cash_atomic_contract_admissions ALTER COLUMN admitted_at DROP NOT NULL')
 q(source,'original_effective_cash_column_contract_changed')
 q('ALTER TABLE accounting_cash_atomic_contract_admissions ALTER COLUMN admitted_at SET NOT NULL;ALTER TABLE accounting_cash_atomic_contract_admissions DROP CONSTRAINT accounting_cash_atomic_contract_admissions_pkey')
 q(source,'original_admission_single_source_identity_contract_changed')
 q('ALTER TABLE accounting_cash_atomic_contract_admissions ADD PRIMARY KEY(source_id)')
 q('REVOKE EXECUTE ON FUNCTION fn_rakeback_recompute_split(uuid,date,date) FROM service_role')
 q(source,'original_freshness_owner_acl_contract_changed')
 q('GRANT EXECUTE ON FUNCTION fn_rakeback_recompute_split(uuid,date,date) TO service_role')
 q(source.replace(post[0],'00000000000000000000000000000000'),'native_qualified_freshness_postimage_required')
 assert q(hashes)=='|'.join(pre),'both owners must roll back atomically'
 q(source);assert q(hashes)=='|'.join(post)
 for line in source.splitlines():
  if line.startswith('-- @live-proof: '):assert q('SELECT '+line.split(': ',1)[1])=='t'
 q(source,'original_freshness_owner_preimage_changed')
 q((base/'restore-preimages.sql').read_text())
 q((base/'restore-preimages.sql').read_text().replace('DECLARE clubs uuid[];', '-- local intentional preimage fault\nDECLARE clubs uuid[];'))
 q(source,'original_freshness_owner_preimage_changed')
 print(json.dumps({'qualification':'passed','owners':2,'postimages':post,'generic_original_and_indexed_plan_contracts':True,'exact_full_predicate_and_boundary_comparisons':True,'view_column_pk_and_acl_faults':True,'atomic_postimage_rollback_replay_and_preimage_refusal':True,'metadata_preserved_by_installer':True,'production_installation':False,'limit':'No full accounting owner/calculator or payment behavior simulated; original owner rollback required after installation.'}))
finally:
 if started:run([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
 shutil.rmtree(scratch)
