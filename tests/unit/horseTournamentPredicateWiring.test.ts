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
it('embeds fixed helper source and preserves reviewed v1/v2/v3 validators and awaited reference output', () => {
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
  // Independent pins bind the reviewed 361ec63 v3 composition; CI needs no Git history.
  const pins = {
    reference_cases: 'e3f25a6cc8cd650f69a4c5e2fd224e6eae861a5999d7049ca4c1ca19662d06dc',
    // V3 adds exact actor/seat/stage and a closed scalar summary; v1/v2
    // retain their original binding, witness, reconciliation and privacy guards.
    sanitize_positive_calloff_result:
      '43a342da367225e9b41bffbbb6f68b90e353a8fa24e68f56207469fa1f2d0ad9',
    sanitize_reference_result: '1ceef5c9bdc0f46c9ea45c312ac4a300dc90dcb41c8ecb2086710462d7c885b2',
    reference_diagnostic: '808e49bea3a0f1f411191bc9bbd5efe8d831fe308765bdcf5ea6ff91bb45e592',
    tournament_yields: '87d7b1c052ca72140bb659d31f3078f08c1ea7b4a867160b26ed440b8af511d4',
    booking_cap_refusals: '87a4f0a5a46c70db39f4449934b707fdf93198e14ca452db45e3959002335359',
    merge_bounded_events: '74acd6b31531f390fc05377eca361801aab44f301ee4d9ab8ef1055583e1ba81',
    process_history: '6c2ceb29ab7613e8119cd0b3f657976ab0020e8bcabad60e464592f7a77f10da',
  };
  const current = readFileSync(inspector, 'utf8');
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
  const currentFunctions = functions(current);
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  for (const [key, pin] of Object.entries(pins)) expect(sha(currentFunctions[key]), key).toBe(pin);
  // Exact reviewed v3 helper, including the shared awaited stdout flush.
  // Original tournament helpers are independently checked below.
  expect(sha(current.split("REFERENCE_DIAGNOSTIC_JS = r'''")[1].split("'''", 1)[0])).toBe(
    '55990741042849ad2984fc3b6dec83d3b96896bec1e1884336adb4d128e5107b'
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
it('version2 encodes an exact original full-list ordinal and refuses invalid or mixed key sets', () => {
  const v2 = { ...input, version: 2, cases: [{ ...input.cases[0], actionOrdinal: 0 }] };
  for (const ordinal of [0, 4095]) {
    const valid = { ...v2, cases: [{ ...v2.cases[0], actionOrdinal: ordinal }] };
    const result = spawnSync('python3', ['-B', inspector, '--encode-tournament-cases', source], {
      input: JSON.stringify(valid),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString())).toEqual(valid);
  }
  for (const invalid of [-1, 4096, 9007199254740992, 0.5, true, '0', null]) {
    const result = spawnSync('python3', ['-B', inspector, '--encode-tournament-cases', source], {
      input: JSON.stringify({ ...v2, cases: [{ ...v2.cases[0], actionOrdinal: invalid }] }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
  }
  const legacy = spawnSync('python3', ['-B', inspector, '--encode-tournament-cases', source], {
    input: JSON.stringify({ ...v2, version: 1 }),
    encoding: 'utf8',
  });
  expect(legacy.status).toBe(1);
});
// Exercise the ACTUAL private Node entrypoint emission under pipe backpressure.
// Imports/strategy return a fixed safe synthetic report; no production records.
const PIPE_EMISSION_PY = String.raw`
import json,os,runpy,subprocess,sys
m=runpy.run_path(sys.argv[1]); mode=sys.argv[2]; broken=sys.argv[3]=='broken'
report=json.loads(sys.stdin.read()); expected=json.dumps(report,separators=(',',':')).encode()+b'\n'
if mode=='tournament': entry=m['TOURNAMENT_DIAGNOSTIC_ADAPTER']
else:
 source=m['REFERENCE_DIAGNOSTIC_JS']; entry=source[source.index("if (process.argv[1] === '--reference-shape-diagnostic')"):]
prefix='const tournamentPredicateInputIsValid=()=>true;const loadInstalledTournamentPredicateApi=async()=>({});const inspectTournamentPredicateRecords=()=>('+json.dumps(report,separators=(',',':'))+');const inspectReferenceRecords=inspectTournamentPredicateRecords;const inspectAcceptedCalloffRecords=inspectTournamentPredicateRecords;\n'
program="""import vm from 'node:vm';
process.argv[1]='--reference-shape-diagnostic';
const context=vm.createContext({process,Buffer,console});
const source="""+json.dumps(prefix+entry)+""";
const module=new vm.SourceTextModule(source,{context,importModuleDynamically:async spec=>{
 const fields=spec.endsWith('ChannelHub.js')?{channelHub:{close(){}}}:spec.endsWith('journalTransport.js')?{exportCanonicalHorseJournalBatch(){return {}}}:spec.endsWith('HorseLogic.js')?{SHORT_STACK_NO_FLAT_BB:10}:{};
 const child=new vm.SyntheticModule(Object.keys(fields),function(){for(const [k,v]of Object.entries(fields))this.setExport(k,v)},{context});
 await child.link(()=>{});await child.evaluate();return child;
}});await module.link(()=>{});await module.evaluate();"""
r,w=os.pipe();os.set_blocking(w,False);filled=0
if broken: os.close(r)
else:
 while True:
  try:filled+=os.write(w,b'X'*4096)
  except BlockingIOError:break
p=subprocess.Popen(['node','--experimental-vm-modules','--input-type=module','-e',program],stdin=subprocess.PIPE,stdout=w,stderr=subprocess.PIPE)
os.close(w)
p.stdin.write(json.dumps({'version':1 if mode=='reference_v1' else 2,'sourceRelease':'a'*40,'cases':[]}).encode());p.stdin.close();p.stdin=None
# Hold the reader until early process exit or finite backpressure timeout.
try:p.wait(timeout=0.25)
except subprocess.TimeoutExpired:pass
raw=b''
if not broken:
 while True:
  chunk=os.read(r,65536)
  if not chunk:break
  raw+=chunk
 os.close(r)
_,err=p.communicate(timeout=5)
actual=raw[filled:] if not broken else b''
print(json.dumps({'mode':mode,'broken':broken,'exitCode':p.returncode,'expectedBytes':len(expected),'emittedBytes':len(actual),'complete':actual==expected,'rawPrivateDataExported':False,'stderrContainsPayload':expected[:-1] in err}))
`;
const emissionReport = {
  version: 2,
  status: 'observed',
  rawRecordsExported: false,
  replayVerified: false,
  activationAllowed: false,
  v56Causality: 'unknown',
  previousLevelBranch: 'unknown',
  sourceRelease: 'a'.repeat(40),
  cases: Array.from({ length: 6 }, (_, i) => ({
    handKey: String(i).repeat(64),
    status: 'observed',
    observation: 'accepted_original_tournament_payout_context',
    decisionRecordSha256: 'b'.repeat(64),
    executionRecordSha256: 'c'.repeat(64),
    acceptedRecordSha256: 'd'.repeat(64),
    decisionKeySha256: 'e'.repeat(64),
    actionOrdinal: 4095,
    payoutTermsDigest: 'f'.repeat(64),
    contextDigest: 'a'.repeat(64),
    phase7InputDigest: 'b'.repeat(64),
    finalizedLadderValidated: true,
    unitGridAndPoolReserveConserved: true,
    bubbleProtectionCaptured: true,
    completeOriginalContextProvenance: true,
    phase7ReceiptReadFrameBound: true,
    recordHashesVerified: true,
    originalHandBound: true,
    sameTurnExecution: true,
    intendedActionAccepted: true,
    handReconciled: true,
    bubbleProtectionEnabled: false,
  })),
};
it.each(['tournament', 'reference_v1', 'reference_v2'])(
  'flushes the actual %s Node entrypoint completely and fails closed on pipe errors',
  (mode) => {
    for (const broken of [false, true]) {
      const out = spawnSync(
        'python3',
        ['-B', '-c', PIPE_EMISSION_PY, inspector, mode, broken ? 'broken' : 'intact'],
        { input: JSON.stringify(emissionReport), encoding: 'utf8', timeout: 10000 }
      );
      expect(out.status, out.stderr).toBe(0);
      expect(JSON.parse(out.stdout)).toMatchObject(
        broken
          ? {
              exitCode: 1,
              emittedBytes: 0,
              rawPrivateDataExported: false,
              stderrContainsPayload: false,
            }
          : {
              exitCode: 0,
              complete: true,
              expectedBytes: 7052,
              emittedBytes: 7052,
              rawPrivateDataExported: false,
            }
      );
    }
  }
);
it('maps either private child pipe failure to the same sanitized unknown result', () => {
  const out = python(
    `g=m['reference_diagnostic'].__globals__
def refused(*a,**k):raise RuntimeError('private-payload-sentinel')
g['bounded_command']=refused;g['TOURNAMENT_PREDICATE_JS']='fixed-helper'
print(json.dumps([m['reference_diagnostic'](d),m['tournament_diagnostic'](d)]))`,
    input
  );
  expect(out.status, out.stderr).toBe(0);
  expect(JSON.parse(out.stdout)).toEqual(
    Array(2).fill({ status: 'unknown', reason: 'journal_or_runtime_unavailable' })
  );
  expect(out.stdout).not.toContain('private-payload-sentinel');
});
