#!/usr/bin/env python3
from pathlib import Path
import argparse, importlib.util, subprocess, tempfile, json, hashlib, datetime, re
p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--evidence',type=Path,required=True);args=p.parse_args();root=args.root.resolve()
assert '/.agent-trees/' in str(root)
s=importlib.util.spec_from_file_location('creation_snapshot',root/'scripts/ci/rehearse-whole-phase-three-cutover.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
assert m.read_sql("SELECT current_database()||'|'||(SELECT count(*) FROM auth.users)||'|'||(SELECT count(*) FROM public.tournaments)||'|'||(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())")=='full_stage1|15|12|0'
expected={'fn_create_tournament(uuid,jsonb)':'16305fb3739f13e64af6a1e8eb3bf165','fn_create_tournament_governed_legacy(uuid,jsonb)':'855086582b43d915ed6bc4c124a34696','fn_game_creation_access(uuid)':'9e4a5c8d56a65b18468e37f2e69d0b92','fn_can_create_games(uuid,uuid)':'374920cb04b1766473797b1f5a0d728c'}
for name,value in expected.items():assert m.read_sql("SELECT md5(prosrc) FROM pg_proc WHERE oid='public."+name+"'::regprocedure")==value
paths=[Path(__file__),root/'scripts/ci/probes/tournament-edit-current-native.sql',root/'scripts/ci/fixtures/phase-three-creation-client-configs.json',root/'scripts/ci/rehearse-whole-phase-three-cutover.py']
fixture=json.loads(paths[2].read_text());paths += [root/n for n in fixture['source_sha256']]
def hashes():return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
inputs=hashes();assert all(inputs[n]==v for n,v in fixture['source_sha256'].items())
before=m.snapshot();out=Path(tempfile.mkdtemp(prefix='codex-edit-permission-'))
run=subprocess.run([m.PSQL,'-X','-h',m.SOCKET,'-p','55473','-U','postgres','-d',m.DB,'-At','-v','ON_ERROR_STOP=1','-f',str(paths[1])],capture_output=True,text=True)
log=run.stdout+run.stderr;(out/'run.log').write_text(log);after=m.snapshot();after_inputs=hashes()
rows=[x.split('=',1)[1] for x in run.stdout.splitlines() if x.startswith('EDIT_NATIVE_EVIDENCE=')];e=json.loads(rows[0]) if len(rows)==1 else None
passed=run.returncode==0 and before==after and inputs==after_inputs and e is not None
r={'recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'passed' if passed else 'failed','exit_code':run.returncode,'exact_rollback':before==after,'source_inputs_stable':inputs==after_inputs,'assertions':len(re.findall('NOTICE:  EDIT_PASS:',log)),'evidence':e,'source_sha256':inputs,'native_baseline_function_md5':expected,'current_edit_function_md5':{'fn_execute_managed_game_command':'a5aa98c192ec5be6f73a21fd71b855ff','fn_update_managed_game':'d85ca8d75218cdc0911c2fbdb1e73ff9'},'before':before,'after':after,'output_directory':str(out),'coverage_limits':['Complete displayed-option matrix and live browser are not certified by this native create/edit probe.'],'failure_tail':run.stderr.splitlines()[-20:] if not passed else []}
args.evidence.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({k:r[k] for k in ['status','exit_code','exact_rollback','source_inputs_stable','assertions','output_directory','failure_tail']}));raise SystemExit(0 if passed else 1)
