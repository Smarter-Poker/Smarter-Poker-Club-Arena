#!/usr/bin/env python3
"""Native PG17 original rebuy read-proof and ACL; no financial owner is mocked or called.
Uses recorded current catalog column types and anonymous actual two-generation shapes.
Full empty-catalog guards were separately qualified in isolated DR; this is scoped helper enforcement.
"""
import argparse,hashlib,json,signal,sys
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
 inputs=[MIGRATION,Path(__file__).relative_to(root),*sorted(DATA.glob('*.sql'))];e.report['source_sha256']={str(f):hashlib.sha256((root/f).read_bytes()).hexdigest() for f in inputs}
 for sig in native.CANCELLATION_SIGNALS:signal.signal(sig,native.interrupted)
 try:
  e.start();db=e.database();e.sql(db,file=root/DATA/'readonly-catalog.sql',label='recorded-native-read-catalog')
  e.sql(db,file=root/DATA/'anonymous-native-seed.sql',label='anonymous-original-two-rebuy-generations')
  e.sql(db,file=root/DATA/'original-helper.sql',label='actual-original-read-owner')
  e.sql(db,file=root/DATA/'before.sql',label='before-original-rebuy-refusal')
  e.sql(db,file=root/MIGRATION,label='exact-qualified-native-read-owner')
  _,stdout,_=e.sql(db,file=root/DATA/'native-boundaries.sql',label='native-original-funding-generation-rollback-acl')
  if stdout.splitlines().count('NEVER_DEALT_REBUY_NATIVE_PASS')!=1:raise RuntimeError('native completion absent')
  e.report.update(status='passed',passed=True,synthetic_only=True)
 finally:
  e.close();(out/'never-dealt-rebuy-report.json').write_text(json.dumps(e.report,indent=2)+'\n')
if __name__=='__main__':main()
