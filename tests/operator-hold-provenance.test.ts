import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const script = resolve(root, 'scripts/ci/read-scoped-operator-hold-provenance.py');
function python(body: string) {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `import importlib.util,copy,json\ns=importlib.util.spec_from_file_location('observer',${JSON.stringify(script)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n${body}`,
    ],
    {
      cwd: root,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
      timeout: 10000,
    }
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
const fixture = `request={'releaseSha':'a'*40,'imageId':'sha256:'+'b'*64}
host={'releaseSha':'a'*40,'instanceId':'1-original'}
container={'containerId':'c'*64,'imageId':request['imageId'],'running':'true','startedAt':'2026-10-07T14:55:00Z','hostPid':'123','restartCount':'0'}
result={'schema':m.SCHEMA,'readOnly':True,'hostBefore':host,'hostAfter':copy.deepcopy(host),'containerBefore':container,'containerAfter':copy.deepcopy(container),'imageReleaseSha':'a'*40,'nodeVersion':'v22.23.2','argv':['node','dist/index.js'],'files':[{'path':'/app/dist/'+p,'bytes':100,'sha256':'d'*64} for p in m.FILES]}
`;
describe('exact operator-hold predecessor provenance', () => {
  it('accepts only the complete fixed immutable-runtime proof', () => {
    expect(
      python(
        fixture + `assert m.validate_result(result,request) is result\nprint(len(result['files']))`
      )
    ).toBe('14');
  });
  it.each([
    [`result['hostAfter']['instanceId']='2-successor'`, 'replaced process'],
    [`result['containerAfter']['restartCount']='1'`, 'same-container restart'],
    [
      `result['containerBefore']['running']='false';result['containerAfter']['running']='false'`,
      'stopped process',
    ],
    [`result['imageReleaseSha']='e'*40`, 'unbound image label'],
    [`result['files'].pop()`, 'truncated file census'],
    [`result['files'][0]['path']='/app/.env'`, 'unapproved path'],
    [`result['files'][0]['bytes']=True`, 'boolean size'],
    [`result['files'][0]['sha256']='unknown'`, 'unreadable hash'],
    [`result['argv']=['node','--inspect','dist/index.js']`, 'unapproved process invocation'],
    [`result['env']={'SECRET':'never archive'}`, 'extra sensitive fields'],
  ])('refuses %s (%s)', (mutation) => {
    python(
      fixture +
        mutation +
        `\ntry:\n m.validate_result(result,request)\nexcept (ValueError,RuntimeError,TypeError):\n pass\nelse:\n raise AssertionError('Invalid proof accepted')`
    );
  });
  it('refuses arbitrary commands, missing identity and shell syntax at selection', () => {
    python(
      `for v in [None,{}, {'releaseSha':'a'*40,'imageId':'sha256:'+'b'*64,'command':'restart'}, {'releaseSha':'$(id)','imageId':'sha256:'+'b'*64}]:\n try:\n  m.selection(v)\n except (ValueError,TypeError):\n  pass\n else:\n  raise AssertionError('Invalid request accepted')`
    );
  });
  it('binds actual fixed reads between matching host and process identities', () => {
    python(
      fixture +
        `calls=[]\nm.health=lambda origin: copy.deepcopy(host)\nm.container_identity=lambda name: copy.deepcopy(container)\ndef read(args):\n calls.append(args)\n if args[:3]==['docker','image','inspect']:return ('a'*40).encode()\n assert args[:4]==['docker','exec','c'*64,'node']\n assert args[4]=='-e' and args[5]==m.NODE_READ\n assert json.loads(args[6])==m.FILES\n return json.dumps({k:result[k] for k in ['nodeVersion','argv','files']}).encode()\nm.run_read=read\nassert m.remote(request)==result\nassert len(calls)==2`
    );
  });
  it('never transports scheduled observations and gives the explicit reader no release authority', () => {
    const workflow = readFileSync(
      resolve(root, '.github/workflows/production-integrity-audit.yml'),
      'utf8'
    );
    const job = workflow.slice(
      workflow.indexOf('\n  scoped_operator_hold_provenance:'),
      workflow.indexOf('\n  scoped_runtime_errors:')
    );
    expect(job).toContain("github.event_name == 'repository_dispatch'");
    expect(job).toContain('github.event.client_payload.operator_hold_provenance != null');
    expect(job).toContain('contents: read');
    expect(job).not.toMatch(/(?:actions|contents|issues): write/);
    expect(job).toContain('python3 scripts/ci/read-scoped-operator-hold-provenance.py');
    const source = readFileSync(script, 'utf8');
    expect(source).not.toMatch(
      /(?:process\.env|\/app\/\.env|docker.+(?:restart|stop|kill)|--inspect|gh workflow|dispatches)/
    );
    expect(source).toContain("'StrictHostKeyChecking=yes'");
  });
});
