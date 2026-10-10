"""Native temporary-only index installation guards; no production connections."""
import json, os, platform, shutil, subprocess, tempfile
from pathlib import Path
root = Path(__file__).resolve().parents[2]
pg = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parent = Path(os.environ.get('TMPDIR', tempfile.gettempdir())).resolve()
if platform.system() == 'Darwin' and not str(parent).startswith('/Volumes/SmarterWork/agent-work/'):
    raise RuntimeError('native scratch must be on owned external SSD')
env = {k:v for k,v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
def run(args, source=None, budget=20):
    r = subprocess.run(list(map(str,args)),input=source,text=True,capture_output=True,env=env,timeout=budget,cwd=root)
    if r.returncode: raise RuntimeError(r.stderr)
    return r.stdout
source = run(['node','scripts/ci/fixtures/funding-recovery-cover/build.mjs'])
with tempfile.TemporaryDirectory(prefix='funding-cover-',dir=parent) as name:
    cluster = Path(name); sock = cluster/'sock';sock.mkdir(mode=0o700)
    started = False
    try:
        run([pg/'initdb','-D',cluster/'db','-U','postgres','--auth=trust','--no-locale'])
        run([pg/'pg_ctl','-D',cluster/'db','-l',cluster/'server.log','-o',f"-k {sock} -p 55467 -c listen_addresses='' -c max_connections=8 -c shared_buffers=8MB",'-w','start'])
        started = True
        cmd = [pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','55467','-U','postgres','-d','postgres']
        version = int(run(cmd,'SHOW server_version_num;').strip())
        if not 170000 <= version < 180000: raise RuntimeError('PostgreSQL17 required')
        run(cmd,'CREATE ROLE service_role;')
        output = run(cmd,source)
        results = [json.loads(line) for line in output.splitlines() if line.startswith('{')]
        if len(results)!=1 or results[0].get('guardCases')!=8 or not results[0].get('matchingIndexAccepted') or not results[0].get('dataPreserved'):
            raise RuntimeError('actual guard fixture result refused')
        if run(cmd,"SELECT count(*) FROM pg_class WHERE relname IN ('tournament_participant_funding_receipts','idx_tournament_funding_recovery_cover');").strip()!='0':
            raise RuntimeError('temporary fixture leaked objects')
        print(json.dumps(dict(results[0],fixtureObjectsAbsent=True,serverVersion=version)))
    finally:
        if started: run([pg/'pg_ctl','-D',cluster/'db','-m','fast','-w','stop'],budget=10)
