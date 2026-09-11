#!/usr/bin/env python3
"""Run only on the existing disposable native fixture; never production.

The root creation fixture is reused for authenticated setup. Its original 15
checks are reported separately from this option extension's five assertions.
"""
import argparse,hashlib,importlib.util,json,re,subprocess,tempfile
from datetime import datetime,timezone
from pathlib import Path

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[3]);p.add_argument('--evidence',type=Path,required=True);p.add_argument('--compose-only',action='store_true');p.add_argument('--candidate-sql',type=Path);args=p.parse_args();root=args.root.resolve()
    base=root/'scripts/ci/probes/tournament-create-permission-native.sql';extension=root/'scripts/ci/probes/tournament-create-options-enabled-native.sql';module_path=root/'scripts/ci/rehearse-whole-phase-three-cutover.py'
    paths=[Path(__file__).resolve(),base,extension,module_path,root/'scripts/ci/fixtures/phase-three-creation-client-configs.json',root/'src/lib/tournamentFromTableConfig.ts',root/'src/services/TournamentService.ts']
    def hashes():return {str(x.relative_to(root)):hashlib.sha256(x.read_bytes()).hexdigest() for x in paths}
    if args.candidate_sql:paths.append(args.candidate_sql.resolve())
    source_before=hashes();sql=base.read_text();marker='SET CONSTRAINTS ALL IMMEDIATE;'
    if sql.count(marker)!=1 or len(re.findall(r'(?m)^BEGIN;',sql))!=1 or len(re.findall(r'(?m)^ROLLBACK;',sql))!=1:raise SystemExit('Creation fixture transaction markers changed')
    gate="""DO $current_option_creator$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_create_tournament_governed_legacy(uuid,jsonb)'::regprocedure)<>'855086582b43d915ed6bc4c124a34696'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_create_tournament(uuid,jsonb)'::regprocedure)<>'16305fb3739f13e64af6a1e8eb3bf165'
 THEN RAISE EXCEPTION 'Option rehearsal creator differs from the verified current source'; END IF;
END $current_option_creator$;"""
    candidate=''
    if args.candidate_sql:
        candidate=args.candidate_sql.read_text()
        if len(re.findall(r'(?m)^BEGIN;',candidate))!=1 or len(re.findall(r'(?m)^COMMIT;',candidate))!=1:raise SystemExit('Expected one atomic candidate transaction')
        candidate=re.sub(r'(?m)^BEGIN;\n?','',candidate,count=1)
        candidate=re.sub(r'(?m)^COMMIT;\n?','',candidate,count=1)
        candidate=candidate+'\n'+candidate
    sql=sql.replace('BEGIN;','BEGIN;\n'+gate+'\n'+candidate,1).replace(marker,extension.read_text()+'\n'+marker)
    out=Path(tempfile.mkdtemp(prefix='codex-tournament-create-options-'));(out/'rehearsal.sql').write_text(sql)
    if args.compose_only:
        print(json.dumps({'composed':True,'native_execution':False,'output_directory':str(out),'source_sha256':source_before}));return
    spec=importlib.util.spec_from_file_location('phase3_whole_for_create_options',module_path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    before=m.snapshot()
    run=subprocess.run([m.PSQL,'-X','-h',m.SOCKET,'-p','55473','-U','postgres','-d',m.DB,'-At','-v','ON_ERROR_STOP=1','-f',str(out/'rehearsal.sql')],capture_output=True,text=True)
    log=run.stdout+'\n'+run.stderr;(out/'psql.log').write_text(log)
    after=m.snapshot();source_after=hashes()
    values=[line.split('TOURNAMENT_CREATE_OPTIONS_EVIDENCE=',1)[1] for line in log.splitlines() if line.startswith('TOURNAMENT_CREATE_OPTIONS_EVIDENCE=')]
    evidence=json.loads(values[0]) if len(values)==1 else None
    diagnostics=[]
    for line in log.splitlines():
        if 'TOURNAMENT_CREATE_OPTIONS_DIAGNOSTIC=' in line:
            try:diagnostics.append(json.loads(line.split('TOURNAMENT_CREATE_OPTIONS_DIAGNOSTIC=',1)[1]))
            except json.JSONDecodeError:pass
    passed=run.returncode==0 and evidence is not None and before==after and source_before==source_after
    result={'at':datetime.now(timezone.utc).isoformat(),'status':'passed' if passed else 'failed','exit_code':run.returncode,'source_sha256':source_before,'sources_unchanged':source_before==source_after,'before':before,'after':after,'exact_rollback':before==after,'candidate_applied_twice':bool(args.candidate_sql),'option_evidence':evidence,'diagnostics':diagnostics,'base_creation_checks_reused':15,'option_assertions_reached':len(re.findall(r'OPTIONS:',log)),'output_directory':str(out),'log_tail':log.splitlines()[-45:]}
    args.evidence.parent.mkdir(parents=True,exist_ok=True);args.evidence.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'status':result['status'],'exit_code':run.returncode,'exact_rollback':before==after,'sources_unchanged':source_before==source_after,'option_evidence_present':evidence is not None,'diagnostics':diagnostics,'output_directory':str(out)}))
    raise SystemExit(0 if passed else 1)
if __name__=='__main__':main()
