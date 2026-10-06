#!/usr/bin/env python3
"""PG17 private custody transition regression; full native financial proof is separate."""
import argparse,hashlib,json,signal,sys
from pathlib import Path
sys.dont_write_bytecode=True
from satellite_qualifier_fixture import module
MIGRATION=Path('supabase/migrations/20261006184554_a_retired_cash_hand_keeps_its_original_custody.sql')
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--socket-root',type=Path,required=True);a=p.parse_args()
 root=Path(__file__).resolve().parents[2];out=a.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
 native=module(root/'scripts/ci/test-mtt-unlimited.py','cash_pg_owner')
 # The maintained older Execution chooses /tmp for its private socket. Redirect
 # only that allocation to the explicit owned root, retaining all lifecycle checks.
 a.socket_root.mkdir(parents=True,exist_ok=True);allocate=native.tempfile.mkdtemp
 def owned_socket(*args,**kwargs):
  if kwargs.get('dir')=='/tmp':kwargs['dir']=a.socket_root.resolve()
  return allocate(*args,**kwargs)
 native.tempfile.mkdtemp=owned_socket
 try:e=native.Execution(root,out,a.pg_bin.resolve(),out,180)
 finally:native.tempfile.mkdtemp=allocate
 e.report['scope']='actual private custody transitions and ACL only; full four-case native financial proof separate'
 inputs=[MIGRATION,Path('scripts/ci/probes/retired-cash-custody-native.sql'),Path(__file__).relative_to(root)]
 e.report['source_sha256']={str(f):hashlib.sha256((root/f).read_bytes()).hexdigest() for f in inputs}
 for sig in native.CANCELLATION_SIGNALS:signal.signal(sig,native.interrupted)
 try:
  e.start();db=e.database();e.sql(db,'CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA smarter_private;GRANT USAGE ON SCHEMA smarter_private TO anon,authenticated,service_role;',label='empty-private-catalog')
  s=(root/MIGRATION).read_text();header=s[:s.index('INSERT INTO smarter_private.retired_cash_hand_qualification')]
  e.sql(db,header+'COMMIT;',label='exact-native-custody-source')
  _,stdout,_=e.sql(db,file=root/'scripts/ci/probes/retired-cash-custody-native.sql',label='native-transitions-authority-and-rollback')
  if stdout.splitlines().count('RETIRED_CASH_CUSTODY_NATIVE_PASS')!=1:raise RuntimeError('native completion absent')
  e.report.update(status='passed',passed=True,synthetic_only=True)
 finally:
  e.close();(out/'cash-custody-report.json').write_text(json.dumps(e.report,indent=2)+'\n')
if __name__=='__main__':main()
