#!/usr/bin/env python3
"""Exact grouped source counts and their original keeper, isolated PostgreSQL17."""
import argparse,json,os,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin' if sys.platform=='darwin'else'/usr/lib/postgresql/17/bin')));p.add_argument('--scratch',type=Path,required=True);p.add_argument('--output',type=Path);a=p.parse_args()
assert __debug__,'optimized financial qualification refused'
assert a.scratch.is_dir(),'existing scratch required'
if sys.platform=='darwin':assert str(a.scratch.resolve()).startswith('/Volumes/SmarterWork/agent-work/'),'external SSD required'
fx=root/'scripts/ci/fixtures/grouped-rakeback-counts';migrations=list((root/'supabase/migrations').glob('*_rakeback_counts_group_the_original_closed_week_once.sql'));assert len(migrations)==1
work=a.scratch/'grouped-rakeback-counts-qualification';work.mkdir(exist_ok=True)
env=os.environ.copy();env.update(PG_BIN=str(a.pg_bin),GROUPED_NATIVE_WORK=str(work),GROUPED_NATIVE_FIXTURES=str(fx),GROUPED_NATIVE_MIGRATION=str(migrations[0]),TMPDIR=str(work))
for lane in ['kernel-native.py','keeper-native.py']:
 r=subprocess.run([sys.executable,'-B',str(fx/lane)],env=env,text=True,capture_output=True,timeout=180)
 assert r.returncode==0,r.stdout+r.stderr
 print(r.stdout,end='')
result={'passed':True,'kernel':json.loads((work/'grouped-counts-native-result.json').read_text()),'keeper':json.loads((work/'keeper-native-result.json').read_text()),'limits':'Local exact counts/keeper/installer qualification only; whole84-window atomic query must fit remaining original240-second statement and90-second soft admission. Production budget, financial writer throughput and wallet delivery remain unverified.'}
if a.output:a.output.write_text(json.dumps(result,indent=2)+'\n')
