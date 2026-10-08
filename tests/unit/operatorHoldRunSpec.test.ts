import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function runSpec(kind: string, mutation = '') {
  return spawnSync(
    'python3',
    [
      '-B',
      '-c',
      `
import importlib.util,json,stat,sys
from unittest.mock import patch
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('runspec',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
i={'source':m.SOURCE,'handoffId':'a','instance':'1-abcd1234','container':'original','startedAt':'old','hostPid':11}
h={'sourceRelease':m.SOURCE,'handoffId':'a','sourceInstance':'1-abcd1234'}
p={'releaseSha':m.SOURCE,'imageId':'image'}
f={'kind':'operator_restart_fence_v1','handoffId':'a','container':'original','source':m.SOURCE}
data={'restart-fence.json':json.dumps(f).encode(),'operator-hold-required':json.dumps(i).encode(),'handoff.json':json.dumps(h).encode(),'operator-hold-predecessor-profile.json':json.dumps(p).encode(),'intent':b'a\\n','operator-hold-checkpoint-guard.mjs':b'g','operator-hold-rollback-bootstrap.mjs':b'b'}
r={'id':'original','startedAt':'old','pid':11,'image':'image','cmd':['node','dist/index.js'],'mounts':[]}
if sys.argv[2]=='replacement': r.update(id='new',pid=12,startedAt='new',cmd=m.COMMAND,mounts=[{'Type':'bind','Source':str(m.ROOT),'Destination':'/run/club-arena/operator-hold','RW':False}])
exec(sys.argv[3])
with patch.object(m,'private_file',side_effect=lambda path:data[path.name]),patch.object(m.os.path,'lexists',return_value=True),patch.object(m.Path,'lstat',return_value=SimpleNamespace(st_mode=stat.S_IFDIR|0o700,st_uid=0)):
 print(m.qualify(m.SOURCE,r))
`,
      `${process.cwd()}/server/scripts/operator-hold-run-spec.py`,
      kind,
      mutation,
    ],
    { encoding: 'utf8' }
  );
}

describe('operator hold original recovery run specification', () => {
  it('retains the exact unchanged original process without a restart', () => {
    expect(runSpec('original').stdout.trim()).toBe('original_owner');
  });
  it('admits a reconstructed predecessor only with exact preload and readonly mount', () => {
    expect(runSpec('replacement').stdout.trim()).toBe('rollback_preload');
  });
  it.each([
    "r['cmd']=['node','dist/index.js']",
    "r['mounts'][0]['RW']=True",
    "r['mounts'][0]['Source']='/somewhere/else'",
    "r['mounts']=[]",
    "r['mounts'].append(r['mounts'][0])",
    "data.pop('handoff.json')",
    "data.pop('restart-fence.json')",
    "data.pop('operator-hold-required')",
    "data['intent']=b'other\\n'",
    "r['image']='other'",
  ])('refuses an incomplete or inexact reconstructed authority: %s', (mutation) => {
    expect(runSpec('replacement', mutation).status).not.toBe(0);
  });
  it('does not treat original image/health alone as the original process', () => {
    expect(runSpec('original', "r['pid']=99").status).not.toBe(0);
  });
  it('connects fixed proof to both existing recovery owners before success', () => {
    for (const name of ['engine-supervisor.sh', 'engine-release-transaction.sh']) {
      const source = readFileSync(`${process.cwd()}/server/scripts/${name}`, 'utf8');
      expect(source).toContain('operator-hold-run-spec.py');
      expect(source).toContain('json .Config.Cmd');
      expect(source).toContain('json .Mounts');
    }
    const shell = readFileSync(
      `${process.cwd()}/server/scripts/legacy-engine-checkpoint.sh`,
      'utf8'
    );
    expect(shell.indexOf("root.parent/'operator-hold-required'")).toBeLessThan(
      shell.indexOf(
        '} | OPERATOR_CHECKPOINT_RESERVED_MS=8000 bounded_operator_command 27 docker exec'
      )
    );
    expect(shell).toContain("prior['mode']='resume-first-upgrade'");
    expect(shell).toContain('original intent identity changed');
    const transport = readFileSync(
      `${process.cwd()}/server/scripts/legacy-engine-checkpoint.mjs`,
      'utf8'
    );
    expect(transport).toContain("mode: operatorIntent.mode ?? 'first-upgrade'");
  });
});

function bootPreflight(mutation: string) {
  return spawnSync(
    'python3',
    [
      '-B',
      '-c',
      `
import json,pathlib,stat,sys,tempfile
from unittest.mock import patch
from types import SimpleNamespace
source=pathlib.Path(sys.argv[1]).read_text()
code=source.split("<<'OPERATOR_BOOT_PREFLIGHT'\\n",1)[1].split('\\nOPERATOR_BOOT_PREFLIGHT',1)[0]
with tempfile.TemporaryDirectory(dir=sys.argv[2]) as tmp:
 root=pathlib.Path(tmp)/'operator-hold';root.mkdir(mode=0o700)
 control=pathlib.Path(tmp)/'control';control.mkdir()
 sha='e16d38f3e6693f55348fd3b7a470098bbc9a51dc'
 paths=['GameServer.js','engine/ServerTableEngineBase.js','engine/ServerTableEngineSeating.js','engine/ServerTableEngineDealing.js','handlers/admin.js','tournament/TournamentManagerBase.js','services/tableLease.js','services/supabase/client.js','releaseIdentity.js','http/createEngineHttpServer.js','engine/ServerTableEngine.js','maintenance/MaintenanceBreak.js','maintenance/freezeState.js','services/supabase/dataActorContext.js']
 p={'kind':'operator_hold_predecessor_v1','releaseSha':sha,'imageId':'image','runtimeNode':'v22.23.2','compiled':[{'path':'/app/dist/'+x,'sha256':'a'*64} for x in paths]}
 h={'kind':'operator_hold_handoff_v1','handoffId':'original','sourceRelease':sha,'sourceInstance':'1-a'}
 exec(sys.argv[3])
 for name,data in {'intent':b'original\\n','handoff.json':json.dumps(h).encode(),'restart-fence.json':json.dumps({'kind':'operator_restart_fence_v1','handoffId':'original','source':sha,'autohealPolicy':'always'}).encode(),'operator-hold-predecessor-profile.json':json.dumps(p).encode(),'operator-hold-checkpoint-guard.mjs':b'g','operator-hold-rollback-bootstrap.mjs':b'b'}.items():
  (root/name).write_bytes(data);(root/name).chmod(0o600)
 for name in ['operator-hold-predecessor-profile.json','operator-hold-checkpoint-guard.mjs','operator-hold-rollback-bootstrap.mjs']:
  (control/name).write_bytes((root/name).read_bytes());(control/name).chmod(0o600)
 marker=root.parent/'operator-hold-required';marker.write_text(json.dumps({'handoffId':'original','source':h['sourceRelease'],'instance':'1-a'}));marker.chmod(0o600)
 sys.argv=['preflight',str(root),'image',sha,str(control)]
 real=pathlib.Path.lstat
 def root_owned(path):
  r=real(path);return SimpleNamespace(st_mode=r.st_mode,st_uid=0,st_nlink=r.st_nlink)
 with patch.object(pathlib.Path,'lstat',root_owned): exec(compile(code,'owning_boot_preflight','exec'))
`,
      `${process.cwd()}/server/scripts/engine-up.sh`,
      process.cwd(),
      mutation,
    ],
    { encoding: 'utf8' }
  );
}

describe('operator rollback preflight before stopping the live owner', () => {
  it('accepts the complete exact authorized readonly recipe', () => {
    expect(bootPreflight('').status).toBe(0);
  });
  it.each([
    "h['sourceRelease']='b'*40;p['releaseSha']='b'*40",
    "h['sourceRelease']='a29a591da2efa8acb1a67cbb93f5e67af11cfc1f';p['releaseSha']=h['sourceRelease']",
    "h['sourceRelease']='4dbbd0672dd46d86116140cde77da1bd143c6b8f';p['releaseSha']=h['sourceRelease']",
    "p['kind']='other'",
    "p['runtimeNode']='unknown'",
    "p['compiled'].pop()",
    "p['compiled'][0]['sha256']='invalid'",
  ])('refuses invalid profile at pre-stop boundary: %s', (mutation) => {
    expect(bootPreflight(mutation).status).not.toBe(0);
  });
});

function supervisorBoundary(mode: 'dead-plain' | 'live-original') {
  const source = readFileSync(`${process.cwd()}/server/scripts/engine-supervisor.sh`, 'utf8');
  const tail = source.slice(source.indexOf('RUNNING_IMAGE_ID='));
  return spawnSync(
    'bash',
    [
      '-c',
      `
set -euo pipefail
DESIRED_SHA=desired; DESIRED_IMAGE_ID=image; DESIRED_LEGACY_UNLABELLED=false
CONTAINER=engine; AUTOHEAL_CONTAINER=autoheal; CONTROL_DIR=control
phase=0; mode="$1"
log(){ echo "LOG:$*"; }
die(){ echo "REFUSED:$*"; exit 1; }
recreate_or_die(){ echo RECONSTRUCT_PRELOAD; phase=1; }
operator_run_spec(){
 if [ "$phase" = 1 ]; then echo operator_hold_run_spec:rollback_preload
 elif [ "$mode" = live-original ]; then echo operator_hold_run_spec:original_owner
 else return 1; fi
}
autoheal_status(){ echo exited; }
ensure_autoheal_running(){ echo START_AUTOHEAL; }
prove_exact_desired_recovery(){ echo FINAL_PROOF; }
bounded_recovery_command(){
 shift
 case "$*" in
  *'.Image'*) echo image;;
  *'sp.release.sha'*) echo desired;;
  *'Labels "autoheal"'*) echo true;;
  *'sp.role'*) echo engine;;
  *'.HostConfig.RestartPolicy.Name'*) if [ "$mode" = live-original ]; then echo no; else echo always; fi;;
  *'.State.Status'*) if [ "$mode" = live-original ] || [ "$phase" = 1 ]; then echo running; else echo exited; fi;;
  *'docker start engine'*) echo UNSAFE_START_PLAIN >&2;;
  *'docker update --restart always'*) echo REARM_PLAIN >&2;;
  *) echo "UNEXPECTED:$*"; return 1;;
 esac
}
${tail}
`,
      'owned-supervisor-boundary',
      mode,
    ],
    { encoding: 'utf8' }
  );
}

describe('captured predecessor automatic restart boundary', () => {
  it('reconstructs a dead plain predecessor before any explicit start or rearm', () => {
    const result = supervisorBoundary('dead-plain');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RECONSTRUCT_PRELOAD');
    expect(result.stderr).not.toContain('UNSAFE_START_PLAIN');
    expect(result.stderr).not.toContain('REARM_PLAIN');
  });
  it('retains the live original owner with restart and autoheal fenced', () => {
    const result = supervisorBoundary('live-original');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('RECONSTRUCT_PRELOAD');
    expect(result.stdout).not.toContain('START_AUTOHEAL');
    expect(result.stderr).not.toContain('REARM_PLAIN');
    expect(result.stdout).toContain('FINAL_PROOF');
  });
  it('bounds streamed work and finalization inside the original absolute helper budget', () => {
    const source = readFileSync(
      `${process.cwd()}/server/scripts/legacy-engine-checkpoint.sh`,
      'utf8'
    );
    const fn = source.slice(
      source.indexOf('bounded_operator_command() {'),
      source.indexOf('\n# Persist intent')
    );
    const probe = (end: number, reserve: number, maximum: number) =>
      spawnSync(
        'bash',
        [
          '-c',
          `
      set -euo pipefail
      date() { printf 1000; }
      die() { printf '%s' "$*" >&2; exit 1; }
      timeout() { printf '%s\n' "$*"; }
      OPERATOR_CHECKPOINT_END_MS=${end}
      OPERATOR_CHECKPOINT_RESERVED_MS=${reserve}
      ${fn}
      bounded_operator_command ${maximum} original-command
    `,
        ],
        { encoding: 'utf8' }
      );
    expect(probe(40000, 8000, 27).stdout).toContain('27.000s original-command');
    expect(probe(11000, 8000, 27).stdout).toContain('1.000s original-command');
    expect(probe(10000, 8000, 27).status).not.toBe(0);
    expect(probe(10000, 8000, 27).stdout).not.toContain('original-command');
    expect(source).toContain(
      'OPERATOR_CHECKPOINT_RESERVED_MS=8000 bounded_operator_command 27 docker exec'
    );
    expect(source).toContain('bounded_operator_command 3 docker inspect');
    expect(source).toContain(
      'bounded_operator_command 5 python3 - "$CONTROL_DIR" "$CHECKPOINT_RESULT_FILE"'
    );
    const transaction = readFileSync(
      `${process.cwd()}/server/scripts/engine-release-transaction.sh`,
      'utf8'
    );
    expect(transaction).toContain(
      'timeout --signal=TERM --kill-after=1s "$(( LEGACY_CHECKPOINT_BUDGET_SECONDS - 1 ))s" "$LEGACY_CHECKPOINT" "$RUN_ID"'
    );
  });
  it('durably marks the interrupted fence before any restart-policy change', () => {
    const source = readFileSync(
      `${process.cwd()}/server/scripts/legacy-engine-checkpoint.sh`,
      'utf8'
    );
    expect(source.indexOf("<<'OPERATOR_REQUIRED_MARKER'")).toBeLessThan(
      source.indexOf('docker update --restart no')
    );
    expect(source).toContain('OPERATOR_CHECKPOINT_END_MS');
    expect(source).toContain("i['proofDeadline']=min(now+20000,int(sys.argv[2])-13000)");
    const transport = readFileSync(
      `${process.cwd()}/server/scripts/legacy-engine-checkpoint.mjs`,
      'utf8'
    );
    expect(transport).toContain(
      'Math.min(startedAt + workBudgetMs, operatorHold?.proofDeadline ?? Infinity)'
    );
  });
});
