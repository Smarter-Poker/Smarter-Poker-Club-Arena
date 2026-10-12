#!/usr/bin/env python3
"""One explicit immutable-runtime read. Never a release or mutation route."""
import base64
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

SCHEMA = 'operator-hold-runtime-provenance/v1'
HEALTH_TIMEOUT = 10
FILES = ['GameServer.js', 'engine/ServerTableEngineBase.js',
 'engine/ServerTableEngineSeating.js', 'engine/ServerTableEngineDealing.js',
 'engine/ServerTableEngine.js', 'handlers/admin.js', 'tournament/TournamentManagerBase.js',
 'services/tableLease.js', 'services/supabase/client.js', 'releaseIdentity.js',
 'http/createEngineHttpServer.js', 'maintenance/MaintenanceBreak.js',
 'maintenance/freezeState.js', 'services/supabase/dataActorContext.js']
# Fixed files only; no application imports, environment reads or inspector.
NODE_READ = r"""
const fs=require('node:fs'), crypto=require('node:crypto');
const args=fs.readFileSync('/proc/1/cmdline','utf8').split('\0').filter(Boolean);
if(JSON.stringify(args)!==JSON.stringify(['node','dist/index.js'])) throw Error('Runtime argv refused');
const binary=fs.statSync('/proc/1/exe'), reader=fs.statSync(process.execPath);
if(binary.dev!==reader.dev||binary.ino!==reader.ino) throw Error('Runtime binary differs');
const files=JSON.parse(process.argv[1]).map(relative=>{
 const path='/app/dist/'+relative, before=fs.lstatSync(path);
 if(!before.isFile()||before.size>2097152||fs.realpathSync(path)!==path) throw Error('File refused');
 const bytes=fs.readFileSync(path), after=fs.lstatSync(path);
 if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==before.size) throw Error('File changed');
 return {path,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
});
console.log(JSON.stringify({nodeVersion:process.version,argv:args,files}));
"""


def selection(value):
    if not isinstance(value, dict) or set(value) != {'releaseSha', 'imageId'}:
        raise ValueError('Exact release and image required')
    if not re.fullmatch('[0-9a-f]{40}', value.get('releaseSha', '')) or not re.fullmatch('sha256:[0-9a-f]{64}', value.get('imageId', '')):
        raise ValueError('Invalid identity')
    return value


def run_read(args):
    result = subprocess.run(args, capture_output=True, check=True, timeout=15)
    if len(result.stdout) > 131072:
        raise RuntimeError('Unbounded reply')
    return result.stdout


def container_identity(container):
    # Select fields explicitly; full Docker Config.Env must never be read.
    fmt = '{{.Id}} {{.Image}} {{.State.Running}} {{.State.StartedAt}} {{.State.Pid}} {{.RestartCount}}'
    fields = run_read(['docker', 'inspect', '--format', fmt, container]).decode().strip().split()
    if len(fields) != 6 or not re.fullmatch('[0-9a-f]{64}', fields[0]) or not re.fullmatch('sha256:[0-9a-f]{64}', fields[1]) or fields[2] != 'true' or not re.fullmatch(r'\d{4}-\d\d-\d\dT[\d:.]+Z', fields[3]) or not re.fullmatch('[1-9][0-9]*', fields[4]) or not fields[5].isdigit():
        raise RuntimeError('Container identity unavailable')
    return dict(zip(['containerId','imageId','running','startedAt','hostPid','restartCount'], fields))


def validate_result(result, request):
    if not isinstance(result, dict) or set(result) != {'schema','readOnly','hostBefore','hostAfter','containerBefore','containerAfter','imageReleaseSha','nodeVersion','argv','files'}:
        raise RuntimeError('Unknown proof fields')
    for field in ['hostBefore','hostAfter']:
        row=result[field]
        if not isinstance(row,dict) or set(row) != {'releaseSha','instanceId'} or not re.fullmatch('[0-9a-f]{40}',row['releaseSha'] or '') or not re.fullmatch('[A-Za-z0-9-]{1,100}',row['instanceId'] or ''):
            raise RuntimeError('Invalid native health identity')
    for field in ['containerBefore','containerAfter']:
        row=result[field]
        if not isinstance(row,dict) or set(row) != {'containerId','imageId','running','startedAt','hostPid','restartCount'} or not re.fullmatch('[0-9a-f]{64}',row['containerId'] or '') or not re.fullmatch('sha256:[0-9a-f]{64}',row['imageId'] or '') or row['running'] != 'true' or not re.fullmatch(r'\d{4}-\d\d-\d\dT[\d:.]+Z',row['startedAt'] or '') or not re.fullmatch('[1-9][0-9]*',row['hostPid'] or '') or not re.fullmatch('[0-9]+',row['restartCount'] or ''):
            raise RuntimeError('Invalid container identity')
    if result['schema'] != SCHEMA or result['readOnly'] is not True or result['hostBefore'] != result['hostAfter'] or result['containerBefore'] != result['containerAfter']:
        raise RuntimeError('Runtime changed')
    if result['hostBefore'].get('releaseSha') != request['releaseSha'] or result['imageReleaseSha'] != request['releaseSha'] or result['containerBefore'].get('imageId') != request['imageId']:
        raise RuntimeError('Runtime identity differs')
    if result['argv'] != ['node','dist/index.js'] or not re.fullmatch(r'v\d+\.\d+\.\d+',result['nodeVersion'] or ''):
        raise RuntimeError('Runtime executable unavailable')
    if not isinstance(result['files'],list) or len(result['files']) != len(FILES):
        raise RuntimeError('Incomplete runtime proof')
    for relative, row in zip(FILES,result['files']):
        if not isinstance(row,dict) or set(row) != {'path','bytes','sha256'} or row['path'] != '/app/dist/'+relative or type(row['bytes']) is not int or not 0 <= row['bytes'] <= 2097152 or not re.fullmatch('[0-9a-f]{64}',row['sha256'] or ''):
            raise RuntimeError('Invalid file proof')
    return result


def remote(request):
    before=health('http://127.0.0.1:8080')
    initial=container_identity('club-arena-engine')
    if before['releaseSha'] != request['releaseSha'] or initial['imageId'] != request['imageId']:
        raise RuntimeError('Requested engine not serving')
    label=run_read(['docker','image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',initial['imageId']]).decode().strip()
    if label != request['releaseSha']:
        raise RuntimeError('Immutable image differs')
    native=json.loads(run_read(['docker','exec',initial['containerId'],'node','-e',NODE_READ,json.dumps(FILES)]))
    return validate_result({'schema':SCHEMA,'readOnly':True,'hostBefore':before,
      'hostAfter':health('http://127.0.0.1:8080'),'containerBefore':initial,
      'containerAfter':container_identity('club-arena-engine'),'imageReleaseSha':label,**native},request)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('Health redirect refused')


def health(origin='https://engine.smarter.poker'):
    url = origin+'/health?runtime_observation=' + str(time.time_ns())
    with urllib.request.build_opener(NoRedirect).open(url, timeout=HEALTH_TIMEOUT) as r:
        if r.status != 200:
            raise RuntimeError('Health unavailable')
        body = r.read(262145)
    if len(body) > 262144:
        raise RuntimeError('Health size refused')
    value = json.loads(body)
    if not re.fullmatch('[0-9a-f]{40}', value.get('releaseSha', '')) or not re.fullmatch('[A-Za-z0-9-]{1,100}', value.get('instanceId', '')):
        raise RuntimeError('Health identity unavailable')
    return {k: value[k] for k in ['releaseSha', 'instanceId']}

def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--remote':
        request = selection(json.loads(base64.b64decode(sys.argv[2], validate=True)))
        print(json.dumps(remote(request)))
        return
    if len(sys.argv) != 1 or os.environ.get('GITHUB_EVENT_NAME') != 'repository_dispatch':
        raise RuntimeError('Explicit observation dispatch required')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    if event.get('action') != 'audit-production-integrity':
        raise RuntimeError('Wrong event')
    request = selection(event.get('client_payload', {}).get('operator_hold_provenance'))
    host = os.environ.get('HETZNER_HOST', '')
    key = os.environ.get('HETZNER_SSH_PRIVATE_KEY', '')
    pin = os.environ.get('HETZNER_HOST_KEY', '')
    if not re.fullmatch('[A-Za-z0-9.-]+', host) or host.startswith('-') or not key.strip() or not pin.strip():
        raise RuntimeError('Configured read transport unavailable')
    before = health()
    if before['releaseSha'] != request['releaseSha']:
        raise RuntimeError('Requested engine not serving')
    directory = Path(tempfile.mkdtemp(prefix='operator-provenance-', dir=os.environ['RUNNER_TEMP']))
    try:
        for name, content in [('key', key), ('known_hosts', pin)]:
            path = directory/name
            path.write_text(content+'\n')
            path.chmod(0o600)
        for args in [['ssh-keygen', '-y', '-f', str(directory/'key')], ['ssh-keygen', '-l', '-f', str(directory/'known_hosts')]]:
            subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=5)
        encoded = base64.b64encode(json.dumps(request).encode()).decode()
        # Only validated release/image identity enters the fixed reader.
        # Host, account, container, file list and command stay fixed.
        args = ['ssh', '-i', str(directory/'key'), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
                '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=/dev/null',
                '-o', 'UserKnownHostsFile='+str(directory/'known_hosts'), '-o', 'ConnectTimeout=10',
                'root@'+host, "python3 - --remote '"+encoded+"'"]
        reply = subprocess.run(args, input=Path(__file__).read_bytes(), capture_output=True, timeout=70)
        if reply.returncode or len(reply.stdout) > 262144:
            raise RuntimeError('Scoped transport unavailable')
        result = validate_result(json.loads(reply.stdout), request)
        after = health()
        if before != after or result.get('hostBefore') != before or result.get('hostAfter') != after:
            raise RuntimeError('Public and host engine identity changed or differ')
        output = {**result, 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'diagnosticOnly': True}
        serialized = json.dumps(output, indent=2)+'\n'
        if key in serialized or pin in serialized:
            raise RuntimeError('Observation refused')
        destination = Path('artifacts/operator-hold-provenance')
        destination.mkdir(parents=True, exist_ok=True)
        target = destination/'observation.json'
        target.write_text(serialized)
        target.chmod(0o600)
        print('Read-only immutable runtime proof saved. No production action performed.')
    finally:
        shutil.rmtree(directory)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Runtime provenance unavailable. No production action performed.', file=sys.stderr)
        sys.exit(1)
