#!/usr/bin/env python3
"""Private PG17 cash17 preparation; no production connection or financial PASS until final parent qualification."""
import argparse,hashlib,json,pathlib,sys
sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'scripts/ci'))
from satellite_qualifier_fixture import module
native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','cash17_execution')
p=argparse.ArgumentParser();p.add_argument('--output',type=pathlib.Path,required=True);p.add_argument('--input',type=pathlib.Path,required=True);p.add_argument('--pg-bin',type=pathlib.Path,required=True);p.add_argument('--socket-root',type=pathlib.Path,required=True);p.add_argument('--keep-prepared',action='store_true');args=p.parse_args()
for path in (args.output,args.input,args.socket_root):
 if not str(path.resolve()).startswith('/Volumes/SmarterWork/agent-work/'):raise SystemExit('Owned SSD paths required')
args.output.mkdir(parents=True,exist_ok=False);args.socket_root.mkdir(parents=True,exist_ok=True)
e=native.Execution(ROOT,args.output,args.pg_bin,args.output,300,socket_parent=args.socket_root)
try:
 e.start();db=e.database()
 for name in ('foundation.sql','current-authorities.sql'):
  f=args.input/'base'/name;e.report['source_sha256'][str(f)]=hashlib.sha256(f.read_bytes()).hexdigest();e.sql(db,file=f,label=name,seconds=180)
 e.sql(db,file=ROOT/'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql',label='existing-original-opening')
 e.sql(db,file=ROOT/'supabase/migrations/20260918092329_retained_hand_submission_atomic_acknowledgement.sql',label='original-journal')
 for name in ['actual-public-schema-additions.sql', 'actual-retired-qualification-shape.sql', 'actual-unexecuted-inventory-shape.sql', 'actual-diamond-variant.sql', 'actual-lightning-marker-shape.sql', 'actual-lightning-seats.sql', 'actual-f06-share-lane.sql', 'current-actual-overlay.sql', 'actual-seat-rebase-shape.sql', 'actual-jackpot-financial-shape.sql', 'actual-resume-mark-key.sql']:
  e.sql(db,file=args.input/'parent-components'/name,label=name,seconds=60)
 e.sql(db,'CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);',label='typed-local-history-shape-not-installation-proof')
 e.sql(db,file=args.input/'parent-components/parent22132-body-only.sql',label='pending-parent-body-machinery-only',seconds=60)
 e.sql(db,file=ROOT/'scripts/qualification/cash-original17/native-body-machinery.sql',label='cash17-wrapper-body-compilation',seconds=30)
 e.report['status']='native_body_compiled_no_financial_qualification'
 e.report['database']=db
 e.report['pg_bin']=str(args.pg_bin)
 e.report['limits']='Parent30/source-overlay/actual17 opening/connected financial cases pending; no money PASS claimed'
except BaseException as exc:e.report['failure']=repr(exc)
finally:
 if not (args.keep_prepared and e.report['status']=='native_body_compiled_no_financial_qualification'):e.close()
 (args.output/'result.json').write_text(json.dumps(e.report,indent=2)+'\n');print(json.dumps({'status':e.report['status'],'failure':e.report.get('failure'),'cleanup':e.report['cleanup']}))
