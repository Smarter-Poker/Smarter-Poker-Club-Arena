import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
const inspector = resolve(__dirname, '../../scripts/ci/inspect-tournament-refill.py');
const source = 'a'.repeat(40),
  table = '12345678-abcd-4321-abcd-123456789abc',
  lease = '22345678-abcd-4321-abcd-123456789abc';
const input = {
  version: 1,
  sourceRelease: source,
  cases: [
    {
      handKey: createHash('sha256').update(`${table}:123:${lease}`).digest('hex'),
      tableId: table,
      handId: '32345678-abcd-4321-abcd-123456789abc',
      handNumber: 123,
      leaseGeneration: lease,
      decisionRecordSha256: null,
    },
  ],
};
it('encodes only bounded exact tournament metadata through the actual inspector CLI', () => {
  const result = spawnSync('python3', ['-B', inspector, '--encode-tournament-cases', source], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString())).toEqual(input);
});
function python(code: string, payload: unknown) {
  return spawnSync(
    'python3',
    [
      '-B',
      '-c',
      `import json,runpy,sys\nm=runpy.run_path(sys.argv[1]);d=json.loads(sys.stdin.read())\n${code}`,
      inspector,
    ],
    { input: JSON.stringify(payload), encoding: 'utf8' }
  );
}
it('rejects duplicate, foreign, private and oversized metadata without echoing it', () => {
  for (const raw of [
    JSON.stringify({ ...input, sourceRelease: 'b'.repeat(40) }),
    JSON.stringify({ ...input, cases: Array(7).fill(input.cases[0]) }),
    JSON.stringify({ ...input, cases: [{ ...input.cases[0], cards: ['private-sentinel'] }] }),
    JSON.stringify(input).replace('"version":1', '"version":1,"version":1'),
    'x'.repeat(8193),
  ]) {
    const result = spawnSync('python3', ['-B', inspector, '--encode-tournament-cases', source], {
      input: raw,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('private-sentinel');
  }
});
it('embeds only the fixed protected helper source and preserves reference code bytes', () => {
  const result = spawnSync('python3', ['-B', inspector, '--host-script'], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  const extracted = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      'import ast,json,sys; tree=ast.parse(sys.stdin.read()); print(json.dumps(ast.literal_eval(tree.body[0].value)))',
    ],
    { input: result.stdout, encoding: 'utf8' }
  );
  expect(extracted.status).toBe(0);
  expect(JSON.parse(extracted.stdout)).toBe(
    readFileSync(
      resolve(__dirname, '../../scripts/ci/horse-tournament-predicate-proof.mjs'),
      'utf8'
    )
  );
  const original = spawnSync(
    'git',
    ['show', '3269d89eb93604ace0ab3c1f35049b59918c8d5c:scripts/ci/inspect-tournament-refill.py'],
    { encoding: 'utf8' }
  ).stdout;
  const current = readFileSync(inspector, 'utf8');
  const blocks = [
    'reference_cases',
    'sanitize_positive_calloff_result',
    'sanitize_reference_result',
    'reference_diagnostic',
    'tournament_yields',
    'booking_cap_refusals',
    'merge_bounded_events',
    'process_history',
  ];
  const functions = (text: string) =>
    JSON.parse(
      spawnSync(
        'python3',
        [
          '-B',
          '-c',
          'import ast,json,sys; s=sys.stdin.read(); t=ast.parse(s); print(json.dumps({n.name:ast.get_source_segment(s,n) for n in t.body if isinstance(n,ast.FunctionDef)}))',
        ],
        { input: text, encoding: 'utf8' }
      ).stdout
    );
  const a = functions(original),
    b = functions(current);
  for (const key of blocks) expect(b[key], key).toBe(a[key]);
  expect(current.split("REFERENCE_DIAGNOSTIC_JS = r'''")[1].split("'''", 1)[0]).toBe(
    original.split("REFERENCE_DIAGNOSTIC_JS = r'''")[1].split("'''", 1)[0]
  );
});
it('keeps unavailable runtime and untrusted child output sanitized unknown', () => {
  for (const result of [
    { status: 'unknown', reason: 'journal_or_runtime_unavailable' },
    { status: 'observed', cards: ['private-sentinel'] },
  ]) {
    const out = python(
      "g=m['tournament_diagnostic'].__globals__;g['TOURNAMENT_PREDICATE_JS']='fixed-helper';g['bounded_command']=lambda *a,**k:json.dumps(d['result']);print(json.dumps(m['tournament_diagnostic'](d['input'])))",
      { input, result }
    );
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      status: 'unknown',
      reason: 'journal_or_runtime_unavailable',
    });
    expect(out.stdout).not.toContain('private-sentinel');
  }
});
it('workflow wires a separate mutually exclusive optional mode through the pinned existing transport', () => {
  const workflow = readFileSync(
    resolve(__dirname, '../../.github/workflows/inspect-tournament-refill.yml'),
    'utf8'
  );
  for (const text of [
    'tournament_cases_json:',
    'TOURNAMENT_CASES_JSON: ${{ inputs.tournament_cases_json }}',
    '--encode-tournament-cases',
    '--host-script',
    "'$REFERENCE_CASES_B64' '$TOURNAMENT_CASES_B64'",
    'Case modes are mutually exclusive',
    'StrictHostKeyChecking=yes',
    'persist-credentials: false',
  ])
    expect(workflow).toContain(text);
});
it('actual CLI rejects mixed modes and dispatches only the separately validated mode', () => {
  const out = python(
    `import base64
calls=[];m['cli'].__globals__['main']=lambda *a:calls.append(a)
a=base64.b64encode(json.dumps(d).encode()).decode()
b=base64.b64encode(json.dumps({**d,'version':2}).encode()).decode()
good=m['cli'](['inspector',d['sourceRelease'],'',a]);mixed=m['cli'](['inspector',d['sourceRelease'],b,a])
print(json.dumps({'good':good,'mixed':mixed,'calls':calls}))`,
    input
  );
  expect(out.status, out.stderr).toBe(0);
  const value = JSON.parse(out.stdout);
  expect(value.good).toBe(0);
  expect(value.mixed).toBe(1);
  expect(value.calls).toEqual([[source, null, input]]);
});
it('actual main downgrades tournament proof for unavailable or changed runtime identity', () => {
  for (const mode of ['stable', 'unavailable', 'changed']) {
    const out = python(
      `import contextlib,io
before={'containerId':'c'*64,'imageId':'sha256:'+'d'*64,'health':'ok','instanceId':'1-12345678'}
after={**before}
if d['mode']=='unavailable': before['health']='unavailable';before['instanceId']=None;after={**before}
if d['mode']=='changed': after['instanceId']='2-12345678'
values=iter([before,after]);g=m['main'].__globals__
g['identity']=lambda e:next(values)
g['tournament_diagnostic']=lambda v:{'status':'observed'}
g['bounded_command']=lambda *a,**k:''
g['restart_evidence']=lambda:{}
g['process_history']=lambda:{}
g['archived_process_history']=lambda:{'archives':[]}
m['main'](d['input']['sourceRelease'],None,d['input'])`,
      { input, mode }
    );
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout).tournamentCases).toEqual(
      mode === 'stable'
        ? { status: 'observed' }
        : { status: 'unknown', reason: 'runtime_identity_unverified' }
    );
  }
});
