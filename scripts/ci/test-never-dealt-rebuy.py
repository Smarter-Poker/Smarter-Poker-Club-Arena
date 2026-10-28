#!/usr/bin/env python3
"""Native PG17 original rebuy read-proof and ACL; no financial owner is mocked or called.
Uses recorded current catalog column types and anonymous actual two-generation shapes.
Full empty-catalog guards were separately qualified in isolated DR; this is scoped helper enforcement.
"""
import argparse,hashlib,json,os,signal,subprocess,sys
from pathlib import Path
sys.dont_write_bytecode=True
from satellite_qualifier_fixture import module
MIGRATION=Path('supabase/migrations/20261007031952_a_never_dealt_rebuy_keeps_its_original_paid_chair.sql')
DATA=Path('scripts/ci/fixtures/never-dealt-rebuy')
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--evidence',type=Path,required=True);p.add_argument('--socket-root',type=Path,required=True);a=p.parse_args()
 root=Path(__file__).resolve().parents[2];out=a.evidence.resolve();out.mkdir(parents=True,exist_ok=False);a.socket_root.mkdir(parents=True,exist_ok=True)
 native=module(root/'scripts/ci/test-mtt-unlimited.py','rebuy_pg_owner');e=native.Execution(root,out,a.pg_bin.resolve(),out,120,socket_parent=a.socket_root)
 e.report['scope']='actual never-dealt rebuy read-helper; no financial owner certification or production mutations'
 diamond_migration=Path('supabase/migrations/20261020143955_never_dealt_diamond_rebuy_proves_original_custody.sql')
 arrival_migration=Path('supabase/migrations/20261021172832_never_dealt_arrivals_keep_their_committed_move.sql')
 inputs=[MIGRATION,diamond_migration,arrival_migration,Path(__file__).relative_to(root),*sorted(DATA.glob('*.sql'))];e.report['source_sha256']={str(f):hashlib.sha256((root/f).read_bytes()).hexdigest() for f in inputs}
 for sig in native.CANCELLATION_SIGNALS:signal.signal(sig,native.interrupted)
 try:
  e.start();db=e.database();e.sql(db,file=root/DATA/'readonly-catalog.sql',label='recorded-native-read-catalog')
  e.sql(db,file=root/DATA/'anonymous-native-seed.sql',label='anonymous-original-two-rebuy-generations')
  e.sql(db,file=root/DATA/'original-helper.sql',label='actual-original-read-owner')
  e.sql(db,file=root/DATA/'before.sql',label='before-original-rebuy-refusal')
  e.sql(db,file=root/MIGRATION,label='exact-qualified-native-read-owner')
  _,stdout,_=e.sql(db,file=root/DATA/'native-boundaries.sql',label='native-original-funding-generation-rollback-acl')
  if stdout.splitlines().count('NEVER_DEALT_REBUY_NATIVE_PASS')!=1:raise RuntimeError('native completion absent')
  e.sql(db,file=root/DATA/'diamond-catalog.sql',label='diamond-recorded-catalog')
  successor=(root/diamond_migration).read_text()
  e.sql(db,query=successor.replace('COMMIT;','')+'\n'+(root/DATA/'native-boundaries.sql').read_text().replace('BEGIN;','SAVEPOINT boundary;').replace('ROLLBACK;','ROLLBACK TO boundary;')+'\n'+(root/DATA/'game-currency-matrix.sql').read_text().replace('BEGIN;','SAVEPOINT matrix;').replace('ROLLBACK;','ROLLBACK TO matrix;')+'\nROLLBACK;',label='successor-chip-boundaries')
  e.sql(db,file=root/DATA/'diamond-seed.sql',label='diamond-original-custody-generation')
  e.sql(db,file=root/DATA/'before.sql',label='before-diamond-rebuy-refusal')
  e.sql(db,file=root/diamond_migration,label='exact-diamond-custody-read-owner')
  _,diamond_stdout,_=e.sql(db,file=root/DATA/'diamond-boundaries.sql',label='diamond-native-boundaries-duplicates-acl')
  if diamond_stdout.splitlines().count('NEVER_DEALT_DIAMOND_NATIVE_PASS')!=1:raise RuntimeError('diamond completion absent')
  e.sql(db,file=root/DATA/'game-currency-matrix.sql',label='all-games-diamond-rebuy-reentry-matrix')
  e.sql(db,file=root/DATA/'arrival-catalog.sql',label='recorded-arrival-catalog')
  e.sql(db,query=(root/DATA/'arrival-seed.sql').read_text()+(root/DATA/'arrival-before.sql').read_text(),label='before-never-dealt-arrival-refusal')
  e.sql(db,file=root/arrival_migration,label='exact-arrival-read-owner')
  e.sql(db,file=root/DATA/'game-currency-matrix.sql',label='arrival-successor-retains-all-paid-generations')
  _,arrival_stdout,_=e.sql(db,query=(root/DATA/'arrival-seed.sql').read_text()+(root/DATA/'arrival-boundaries.sql').read_text(),label='arrival-boundaries-all-games-both-assets')
  if arrival_stdout.splitlines().count('NEVER_DEALT_ARRIVAL_NATIVE_PASS')!=1:raise RuntimeError('arrival completion absent')
  e.report.update(status='passed',passed=True,synthetic_only=True,game_currency_generation_cases=40,game_currency_arrival_cases=20)
 finally:
  e.close();(out/'never-dealt-rebuy-report.json').write_text(json.dumps(e.report,indent=2)+'\n')
 # Same required accounting-shard lifecycle; a failed expiry proof fails this entry.
 run_lightning_expiry_proof(root,a.pg_bin,a.socket_root)
def run_lightning_expiry_proof(root,pg_bin,socket_root):
 subprocess.run([sys.executable,str(root/'scripts/ci/test-lightning-rebuy-expiry-postgres.py')],
  env={**os.environ,'PG_BIN':str(pg_bin.resolve()),'TMPDIR':str(socket_root.resolve())},check=True)
if __name__=='__main__':main()
