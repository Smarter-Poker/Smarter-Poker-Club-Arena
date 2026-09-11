#!/usr/bin/env python3
"""Explicit client-config capture, outside ordinary CI test discovery."""
import argparse,hashlib,json,shutil,subprocess
from pathlib import Path
EXPECTED='61f022e9ced004b5e67a2aaf22d394b6bc8285a69afe12654c5114c7c7cadba4'
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[4]);ap.add_argument('--output',type=Path,required=True);ap.add_argument('--test-file',default='TournamentFromTableConfig.test.ts');args=ap.parse_args();root=args.root.resolve()
    template=Path(__file__).with_name('phaseThreeCreateConfigCapture.test.ts.template');target=root/'tests/unit/phaseThreeCreateConfigCapture.test.ts'
    if digest(template)!=EXPECTED:raise SystemExit('Capture template hash mismatch')
    if target.exists():raise SystemExit('Capture test path already exists; refused overwrite')
    text=template.read_text();import re
    selected=root/'tests/unit'/args.test_file
    if selected.parent.resolve()!=(root/'tests/unit').resolve() or not selected.is_file() or not selected.name.endswith('.test.ts'):raise SystemExit('Expected an existing direct unit test file')
    original="'./TournamentFromTableConfig.test'"
    alternate='"./TournamentFromTableConfig.test"'
    token=original if original in text else alternate
    if text.count(token)!=1:raise SystemExit('Expected one explicit original client test import')
    text=text.replace(token,json.dumps('./'+selected.name[:-3]))
    materialized=text.encode();runtime_sha=hashlib.sha256(materialized).hexdigest()
    source_paths={selected,root/'src/lib/tournamentFromTableConfig.ts',root/'src/services/TournamentService.ts'}
    for _,spec in re.findall(r"(?:from\s+|import\s*\(\s*|import\s+)([\"'])([^\"']+)\1",text):
        if spec.startswith('.'):
            base=target.parent/spec
            candidates=[base,Path(str(base)+'.ts'),Path(str(base)+'.tsx')]
            source_paths.update(x.resolve() for x in candidates if x.is_file())
    source_before={str(x.relative_to(root)):digest(x) for x in sorted(source_paths)}
    candidates=re.findall(r"[\"'](/tmp/[^\"']+\.json)[\"']",text)
    if len(set(candidates))!=1:raise SystemExit('Expected exactly one original JSON capture output path')
    original_capture=candidates[0];capture=args.output.resolve()
    quoted=[q+original_capture+q for q in ["'",'"'] if q+original_capture+q in text]
    if len(quoted)!=1 or text.count(quoted[0])!=1:raise SystemExit('Expected one literal capture output path')
    text=text.replace(quoted[0],json.dumps(str(capture)))
    capture.parent.mkdir(parents=True,exist_ok=True)
    materialized=text.encode();runtime_sha=hashlib.sha256(materialized).hexdigest()
    before=digest(capture) if capture.exists() else None
    target.write_bytes(materialized)
    try:
        subprocess.run([str(root/'node_modules/.bin/vitest'),'run',str(target.relative_to(root))],cwd=root,check=True)
        if not capture.exists():raise SystemExit('Capture run did not produce JSON')
        data=json.loads(capture.read_text())
        if not isinstance(data,list) or not data:raise SystemExit('Capture output is empty or malformed')
        args.output.parent.mkdir(parents=True,exist_ok=True)
        if args.output.resolve()!=capture.resolve():shutil.copyfile(capture,args.output)
        source_after={str(x.relative_to(root)):digest(x) for x in sorted(source_paths)}
        if source_after!=source_before:raise SystemExit('Capture source changed during the run; refused stable-source evidence')
        manifest={'selected_test_file':str(selected.relative_to(root)),'materialized_capture_test_sha256':runtime_sha,'source_sha256':source_before,'sources_unchanged_during_capture':True,'template_sha256':EXPECTED,'capture_sha256':digest(capture),'capture_count':len(data),'capture_previous_sha256':before,'source_test_removed_from_default_discovery':True}
        args.output.with_suffix(args.output.suffix+'.manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
        print(json.dumps({'status':'captured','case_count':len(data),'template_sha256':EXPECTED}))
    finally:
        if target.exists() and digest(target)==runtime_sha:target.unlink()
        elif target.exists():raise SystemExit('Temporary test changed during capture; preserved for review')
if __name__=='__main__':main()
