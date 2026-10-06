#!/usr/bin/env python3
"""Use the existing native image for a bounded EV-only authenticated lifecycle."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid


def execute(repo, image, output):
    assert re.fullmatch(r'sha256:[a-f0-9]{64}', image)
    prefix='tests/fixtures/ev-cashout-lifecycle/'
    name='ca-ev-lifecycle-'+uuid.uuid4().hex
    receipt={'scope':'authenticated-ev-cashout-native-lifecycle','product_certificate':False,'status':'failed','container_absent':False}
    env={key:os.environ[key] for key in ('PATH','HOME') if key in os.environ}
    def run(args, timeout=60):
        return subprocess.run(args,cwd=repo,env=env,capture_output=True,text=True,timeout=timeout,check=True).stdout
    created=False
    try:
        sha=run(['git','rev-parse','HEAD']).strip()
        receipt['source_revision']=sha
        assert run(['docker','image','inspect','--format','{{index .Config.Labels "com.smarter-poker.source-revision"}}',image]).strip()==sha
        assert not run(['docker','container','ls','-aq','--filter','name=^/'+name+'$']).strip()
        # Commit-bound fixture inputs; no checkout/environment/credential mounts.
        paths=run(['git','ls-files',prefix,'tests/fixtures/full-weekly-accounting','tests/fixtures/cash-participant-funding','tests/fixtures/union-weekly-basis/captured-cash-dependencies.json','supabase/migrations/20260917230925*','supabase/migrations/20260917232243*','server/src','server/package.json','server/package-lock.json','server/tsconfig.json']).splitlines()
        run(['git','diff','--exit-code','HEAD','--',*paths])
        receipt['source_sha256']={p:hashlib.sha256((repo/p).read_bytes()).hexdigest() for p in paths}
        output.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='ev-native-',dir=output.parent) as scratch:
            source=Path(scratch);source.chmod(0o755)
            for f in ['native.mjs','actor.mjs','diagnostics.mjs','captured-authorities.json']:
                assert prefix+f in paths
                shutil.copyfile(repo/prefix/f,source/f)
            chunks=run(['python3',prefix+'bootstrap.py'])
            (source/'chunks.json').write_text(chunks)
            (source/'server').mkdir()
            for directory in ['dist','node_modules']:
                shutil.copytree(repo/'server'/directory,source/'server'/directory,symlinks=False)
            shutil.copyfile(repo/'server/package.json',source/'server/package.json')
            args=['docker','run','--name',name,'--network','none','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','512','--memory','4g','--cpus','2','--tmpfs','/tmp:rw,nosuid,nodev,mode=1777','--tmpfs','/run:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700','--tmpfs','/var/lib/postgresql:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700','--mount',f'type=bind,src={source},dst=/ev,readonly','--entrypoint','node',image,'/ev/native.mjs']
            created=True
            try:
                result=subprocess.run(args,cwd=repo,env=env,capture_output=True,text=True,timeout=180)
            except subprocess.TimeoutExpired as error:
                receipt['runner_error']='CONTAINER_TIMEOUT'
                decode=lambda value:value.decode('utf-8',errors='replace') if isinstance(value,bytes) else value or ''
                result=subprocess.CompletedProcess(args,124,decode(error.stdout),decode(error.stderr))
            records=[]
            for line in (result.stdout+'\n'+result.stderr).splitlines():
                try:record=json.loads(line)
                except ValueError:continue
                if isinstance(record,dict) and record.get('scope')==receipt['scope']:
                    if record.get('kind')=='stage' and re.fullmatch(r'[a-zA-Z0-9_.-]{1,100}',str(record.get('stage',''))):
                        receipt['last_stage']=record['stage']
                    elif record.get('status') in ('passed','failed'):records.append(record)
            # The driver emits only schema-owned stage names and safe numeric/UUID outcomes.
            assert len(records)==1
            receipt['observation']=records[0]
            assert result.returncode==0 and records[0]['status']=='passed'
            receipt['status']='passed'
    except Exception as error:
        receipt['status']='failed'
        receipt.setdefault('runner_error',type(error).__name__ if type(error).__name__ in ('AssertionError','CalledProcessError','TimeoutExpired','OSError') else 'RUNNER_FAILURE')
    finally:
        try:
            if created:run(['docker','container','rm','--force',name])
            assert not run(['docker','container','ls','-aq','--filter','name=^/'+name+'$']).strip()
            receipt['container_absent']=True
        except Exception:receipt['status']='failed'
        output.mkdir(parents=True,exist_ok=True)
        (output/'ev-cashout-lifecycle.json').write_text(json.dumps(receipt,indent=2)+'\n')
    return receipt['status']=='passed'

if __name__=='__main__':
    sys.exit(0 if execute(Path(sys.argv[1]).resolve(),sys.argv[2],Path(sys.argv[3]).resolve()) else 1)
