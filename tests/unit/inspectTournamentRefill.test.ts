import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { createHash } from 'node:crypto';
import ts from 'typescript';

// A history fixture allows 5s to scan and 2s to reap its child. Keep another
// 5s for Python startup, module loading and result serialization under suite load.
const historyFixtureTimeoutMs = 12_000;

const script = resolve(__dirname, '../../scripts/ci/inspect-tournament-refill.py');
const source = readFileSync(script, 'utf8');
const workflowText = readFileSync(
  resolve(__dirname, '../../.github/workflows/inspect-tournament-refill.yml'),
  'utf8'
);
const tableId = '12345678-abcd-4321-abcd-123456789abc';
const originalLease = '22345678-abcd-4321-abcd-123456789abc';
const originalCoordinate = `${tableId}:123:${originalLease}`;
const originalCase = {
  handKey: createHash('sha256').update(originalCoordinate).digest('hex'),
  tableId,
  handId: '32345678-abcd-4321-abcd-123456789abc',
  handNumber: 123,
  leaseGeneration: originalLease,
  errorAt: '2026-10-26T15:24:41.823Z',
};
const caseInput = { version: 1, sourceRelease: 'a'.repeat(40), cases: [originalCase] };
function encodeCases(input: Buffer | string) {
  return spawnSync('python3', [script, '--encode-reference-cases', 'a'.repeat(40)], {
    input,
    encoding: 'utf8',
    timeout: 5000,
  });
}
it('admits only bounded unique original metadata before any SSH or runtime read', () => {
  const valid = encodeCases(JSON.stringify(caseInput));
  expect(valid.status, valid.stderr).toBe(0);
  expect(JSON.parse(Buffer.from(valid.stdout.trim(), 'base64').toString())).toEqual(caseInput);
  const invalid = [
    { ...caseInput, version: true },
    { ...caseInput, sourceRelease: 'b'.repeat(40) },
    { ...caseInput, command: 'private-secret' },
    { ...caseInput, cases: [] },
    { ...caseInput, cases: Array(7).fill(originalCase) },
    { ...caseInput, cases: [originalCase, originalCase] },
    { ...caseInput, cases: [{ ...originalCase, handKey: '0'.repeat(64) }] },
    { ...caseInput, cases: [{ ...originalCase, errorAt: '2026-99-99T15:24:41Z' }] },
    { ...caseInput, cases: [{ ...originalCase, handNumber: 1.5 }] },
    { ...caseInput, cases: [{ ...originalCase, leaseGeneration: 'current-lease-guessed' }] },
    { ...caseInput, cases: [{ ...originalCase, cards: ['As', 'Kd'] }] },
  ];
  for (const bad of [
    ...invalid.map((value) => JSON.stringify(value)),
    Buffer.from([0xff]),
    'x'.repeat(8193),
    JSON.stringify(caseInput).replace('"version":1', '"version":1,"version":1'),
  ]) {
    const result = encodeCases(bad);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toMatch(/private-secret|cards|current-lease|Traceback/);
  }
});

function referenceFixture(mode: string) {
  const extract = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      'import json,runpy,sys; print(json.dumps(runpy.run_path(sys.argv[1])["REFERENCE_DIAGNOSTIC_JS"]))',
      script,
    ],
    { encoding: 'utf8', timeout: 5000 }
  );
  expect(extract.status, extract.stderr).toBe(0);
  const program = JSON.parse(extract.stdout);
  const recordJs = ts.transpileModule(
    readFileSync(
      resolve(__dirname, '../../server/src/services/horseDecisionJournal/record.ts'),
      'utf8'
    ),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  const fixture = `
const {inspectReferenceRecords}=await import('data:text/javascript;base64,${Buffer.from(program).toString('base64')}');
const records=await import('data:text/javascript;base64,${Buffer.from(recordJs).toString('base64')}');
const input=${JSON.stringify(caseInput)}, c=input.cases[0], mode=${JSON.stringify(mode)};
const coordinate=${JSON.stringify(originalCoordinate)};
const snapshot={coordinate,decisionKey:'private-decision-id',requestId:9,
  opts:{},player:{seat:1,stack:100,bet:20,user_id:'private-player'},
  gameState:{gameMode:'tournament',gameVariant:'nlh',stage:'preflop',bigBlind:20,currentBet:40,
    players:[{seat:1,stack:100},{seat:2,stack:100,is_all_in:false}],
    actionHistory:[{stage:'preflop',action:'raise',seat:2}]}};
const decision={action:'all_in',tournamentPreflopAttribution:{route:'variant_price',referenceProposal:{action:'all_in',amount:null}}};
let sequence=0;
const record=(kind,body)=>records.makeHorseJournalRecord({producerId:'42345678-abcd-4321-abcd-123456789abc',sequence:++sequence,
 atMs:Date.parse(c.errorAt),sourceRelease:input.sourceRelease,kind,handKey:c.handKey,turnKey:'b'.repeat(64)},body);
const body={snapshot,decision,readFrame:{private:'private-secret'},cards:['As','Kd']};
const accepted={committedHandId:mode==='wrong-hand'?'wrong-id':c.handId,coordinate};
let rows=[record('decision',body),record('accepted_hand',accepted)];
if(mode==='tampered-record') rows[0]={...rows[0],body:rows[0].body+' '};
if(mode==='missing') rows=[];
if(mode==='ambiguous') rows.push(record('decision',body));
if(mode==='stale') rows=[records.makeHorseJournalRecord({...rows[0],atMs:Date.parse(c.errorAt)-3000},body),rows[1]];
const batch={status:'canonical_journal_export',sourceRelease:mode==='wrong-source'?'c'.repeat(40):input.sourceRelease,
 recordsByHand:[{handKey:c.handKey,records:rows}]};
const api={...records,shortStackNoFlatBb:12,
 anchorHorseDecisionHand:s=>({status:'anchored',coordinate:mode==='wrong-anchor'?'wrong':s.coordinate}),
 horseHandAnchorKey:a=>a.coordinate,horseCompletedHandKey:h=>h.coordinate,
 horsePhase6AttributionMismatch:()=> 'reference_shape'};
console.log(JSON.stringify(inspectReferenceRecords(input,batch,api)));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', fixture], {
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout + result.stderr).not.toMatch(
    /private-secret|private-player|private-decision|cards|As|Kd/
  );
  return JSON.parse(result.stdout);
}
it('classifies original-bound records with actual record hash validation and no private output', () => {
  const result = referenceFixture('ok');
  expect(result.status).toBe('observed');
  expect(result.cases[0]).toMatchObject({
    mismatch: 'reference_shape',
    route: 'variant_price',
    referenceAction: 'all_in',
    diagnosis: 'short_stack_variant_jam_public_shape',
    guards: {
      recordHashVerified: true,
      originalHandBound: true,
      oldJamOtherResponder: false,
      oldJamStackRatio: true,
      shortStackDepth: true,
    },
  });
  const checked = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      'import json,runpy,sys; m=runpy.run_path(sys.argv[1]); d=json.loads(sys.stdin.read()); print(json.dumps(m["sanitize_reference_result"](d["result"],d["input"])))',
      script,
    ],
    { input: JSON.stringify({ result, input: caseInput }), encoding: 'utf8', timeout: 5000 }
  );
  expect(checked.status, checked.stderr).toBe(0);
  expect(JSON.parse(checked.stdout)).toEqual(result);
});
it.each([
  'tampered-record',
  'missing',
  'ambiguous',
  'wrong-source',
  'wrong-hand',
  'wrong-anchor',
  'stale',
])('keeps %s original cases explicitly unknown', (mode) =>
  expect(referenceFixture(mode).status).toBe('unknown')
);
it('rejects extra or mistyped private output from the Node child rather than printing it', () => {
  const result = referenceFixture('ok');
  const fixture = `import json,runpy,sys
m=runpy.run_path(sys.argv[1]); d=json.loads(sys.stdin.read()); g=m['reference_diagnostic'].__globals__
g['bounded_command']=lambda *a,**k: json.dumps(d['result'])
print(json.dumps(m['reference_diagnostic'](d['input'])))`;
  for (const tamper of [
    { ...result, rawBody: 'private-secret' },
    { ...result, cases: [{ ...result.cases[0], cards: ['As', 'Kd'] }] },
    {
      ...result,
      cases: [
        {
          ...result.cases[0],
          guards: { ...result.cases[0].guards, shortStackDepth: 'private-secret' },
        },
      ],
    },
  ]) {
    const ran = spawnSync('python3', ['-B', '-c', fixture, script], {
      input: JSON.stringify({ input: caseInput, result: tamper }),
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(ran.status, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({
      status: 'unknown',
      reason: 'journal_or_runtime_unavailable',
      diagnostic: { stage: 'sanitizer', code: 'result_refused' },
    });
    expect(ran.stdout + ran.stderr).not.toMatch(/private-secret|cards|As|Kd/);
  }
});
function sanitize(lines: string[]) {
  const result = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      'import json,runpy,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps(m["summarize"](json.loads(sys.stdin.read()))))',
      script,
    ],
    { input: JSON.stringify(lines.join('\n')), encoding: 'utf8', timeout: 5000 }
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
function workerErrors(lines: string[]) {
  const ran = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      'import json,runpy,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps(m["worker_receipt_errors"](json.loads(sys.stdin.read()))))',
      script,
    ],
    { input: JSON.stringify(lines.join('\n')), encoding: 'utf8', timeout: 5000 }
  );
  expect(ran.status, ran.stderr).toBe(0);
  return JSON.parse(ran.stdout);
}

it('retains only the actual worker refusal table and precise timestamp, never a guessed hand', () => {
  const table = '12345678-abcd-4321-abcd-123456789abc';
  const node = spawnSync(
    process.execPath,
    [
      '-e',
      `console.error('[ServerTableEngine.${table}.horse_decision_worker_failed]', new Error('horse decision worker returned invalid policy receipt: reference_shape'));`,
    ],
    { encoding: 'utf8', timeout: 5000 }
  );
  expect(node.status).toBe(0);
  const lines = node.stderr
    .trimEnd()
    .split('\n')
    .map((line) => `2026-10-25T22:48:36.216123456Z ${line}`);
  const data = workerErrors([
    ...lines,
    `2026-10-25T22:48:36.216Z   requestId: 123, hand_id: '${table}', cards: ['As','Kd'], token: 'private-secret'`,
  ]);
  expect(data).toEqual({
    matchingRecords: 1,
    events: [
      { timestamp: '2026-10-25T22:48:36.216123456Z', code: 'reference_shape', tableId: table },
    ],
    eventsTruncated: false,
    handCoordinateAvailable: false,
  });
  expect(JSON.stringify(data)).not.toMatch(/private|secret|cards|requestId|hand_id|Error:|at /);
  const owner = readFileSync(
    resolve(__dirname, '../../server/src/engine/ServerTableEngineTurns.ts'),
    'utf8'
  );
  expect(owner).toContain(
    "reportError(error, 'ServerTableEngine.' + this.tableId + '.horse_decision_worker_failed')"
  );
});

it('refuses unrelated contexts, unknown codes, malformed coordinates and private suffixes', () => {
  const context =
    '[ServerTableEngine.12345678-abcd-4321-abcd-123456789abc.horse_decision_worker_failed]';
  const message = 'Error: horse decision worker returned invalid policy receipt: reference_shape';
  expect(
    workerErrors([
      `2026-10-25T22:48:36Z [Unrelated] ${context} ${message}`,
      `2026-10-25T22:48:36Z ${context} ${message}_unknown`,
      `2026-10-25T22:48:36Z ${context} ${message} private-secret`,
      `2026-99-99T22:48:36Z ${context} ${message}`,
      `${context} ${message}`,
      `2026-10-25T22:48:36Z ${context.replace('12345678', 'private')} ${message}`,
      `2026-10-25T22:48:36Z ${context} ${message}${' '.repeat(4096)}`,
      `2026-10-25T22:48:36Z ${context} Error: unknown`,
      `2026-10-25T22:48:36Z   ${message}`,
    ])
  ).toEqual({
    matchingRecords: 0,
    events: [],
    eventsTruncated: false,
    handCoordinateAvailable: false,
  });
});

it('finds worker refusals in the existing bounded stream and caps retained witnesses', () => {
  const line =
    '2026-10-25T22:48:36.216Z [ServerTableEngine.12345678-abcd-4321-abcd-123456789abc.horse_decision_worker_failed] Error: horse decision worker returned invalid policy receipt: reference_shape';
  const capped = workerErrors(Array(130).fill(line));
  expect(capped.matchingRecords).toBe(130);
  expect(capped.events).toHaveLength(128);
  expect(capped.eventsTruncated).toBe(true);
  const fixture = `
import json,os,runpy,sys,tempfile
m=runpy.run_path(sys.argv[1]); raw=json.loads(sys.stdin.read())
with tempfile.NamedTemporaryFile('w',suffix='.log',delete=False) as f: f.write(raw); path=f.name
producer='import sys; sys.stdout.write(open('+repr(path)+').read())'
try: print(json.dumps(m['process_history']([sys.executable,'-c',producer],max_bytes=2000000,seconds=5)))
finally: os.unlink(path)
`;
  const ran = spawnSync('python3', ['-B', '-c', fixture, script], {
    input: JSON.stringify(
      [line, ...Array(12000).fill('2026-10-25T22:49:00Z unrelated private-secret')].join('\n') +
        '\n'
    ),
    encoding: 'utf8',
    timeout: historyFixtureTimeoutMs,
  });
  expect(ran.status, ran.stderr).toBe(0);
  const data = JSON.parse(ran.stdout);
  expect(data.workerReceiptErrors).toMatchObject({
    matchingRecords: 1,
    eventsTruncated: false,
    handCoordinateAvailable: false,
  });
  expect(data.workerReceiptErrors.events).toHaveLength(1);
  expect(data.coverage).toMatchObject({ status: 'complete', fullTwoHourCoverageProven: false });
  expect(ran.stdout + ran.stderr).not.toMatch(/private|secret|Traceback/);
});
it('prints only allowlisted events, counts, timestamps and operational categories', () => {
  const data = sanitize([
    '2026-10-13T21:01:02.123456789Z [TournamentRecurring] registerHorses found no candidates: fleet 400, at-capacity/entered 200, not-a-club-member 190, lane/window-excluded 10 private@example.invalid token=secret',
    '2026-10-13T21:01:03Z [TournamentRecurring.board_error] Error: permission denied code=42501 player=12345678-aaaa-bbbb-cccc-123456789abc',
    '2026-10-13T21:01:04Z [TournamentRecurring] seat-first-precheck deadbeef: rpc_called=3 skipped_already_seated=7 skipped_table_full=4 verify_reads=5 seated=2 rpc_already_seated=8 rpc_table_full=6 rpc_refused=1 rpc_other_noop=9 private-token',
  ]);
  expect(data.register_no_candidates).toMatchObject({
    count: 1,
    lastTimestamp: '2026-10-13T21:01:02Z',
    counts: {
      fleet: 400,
      'at-capacity/entered': 200,
      'not-a-club-member': 190,
      'lane/window-excluded': 10,
    },
  });
  expect(data.board_error).toMatchObject({
    categories: { 'permission denied': 1 },
    sqlstates: { '42501': 1 },
  });
  expect(data.seat_first_precheck.counts).toEqual({
    rpc_called: 3,
    skipped_already_seated: 7,
    skipped_table_full: 4,
    verify_reads: 5,
    seated: 2,
    rpc_already_seated: 8,
    rpc_table_full: 6,
    rpc_refused: 1,
    rpc_other_noop: 9,
  });
  expect(JSON.stringify(data)).not.toMatch(/private|token|secret|deadbeef|12345678/);
});
it('drops unrelated, unknown, overlong and secret-only raw log records', () => {
  expect(
    sanitize([
      '2026-10-13T21:01:02Z [Auth] token=private-secret',
      '[TournamentRecurring.unknown] SQLSTATE=23502 arbitrary private message',
      '[TournamentRecurring] token=private-secret',
      '[TournamentRecurring.board_error] ' + 's'.repeat(4096),
    ])
  ).toEqual({});
});
it('uses manual trusted-default authority and maintained pinned SSH without runtime mutations', () => {
  const workflow = parse(workflowText);
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(workflow.jobs.inspect.if).toContain('github.event.repository.default_branch');
  expect(workflow.jobs.inspect.steps[0].with['persist-credentials']).toBe(false);
  expect(workflow.jobs.inspect.steps[0].with.ref).toBe('${{ github.sha }}');
  for (const text of [
    'HETZNER_HOST',
    'HETZNER_HOST_KEY',
    'HETZNER_SSH_PRIVATE_KEY',
    'StrictHostKeyChecking=yes',
    'GlobalKnownHostsFile=/dev/null',
    'BatchMode=yes',
    '100s ssh',
    'python3 -',
    'trap',
  ])
    expect(workflowText).toContain(text);
  expect(workflowText).not.toMatch(
    /repository_dispatch|schedule:|restart|docker exec|\.env|set -x|scp |ssh-keyscan|curl /
  );
  expect(source).toContain("'45m', '--tail', '10000'");
  expect(source).toContain('MAX_BYTES = 4 * 1024 * 1024');
  expect(source).toContain('time.monotonic() + 25');
  expect(source).toContain("health.get('releaseSha') != expected");
  expect(source).toContain("before[key] != after[key] for key in ('containerId', 'imageId')");
  expect(source).toContain('runtime_stable = before == after');
  expect(source).not.toMatch(
    /os\.environ|read(?:File|_text).*\.env|docker.*restart|systemctl|print\(raw|print\(error|print\(line/
  );
  expect(source).toContain("'docker', 'exec', '-i', CONTAINER, 'node', '--input-type=module'");
  expect(source).toContain("await import('/app/dist/engine/HorsePhase6Attribution.js')");
  expect(source).toContain('sanitize_reference_result(result, value)');
});

it('binds atomic creator event names to the actual producer contexts', () => {
  const producer = readFileSync(
    resolve(__dirname, '../../server/src/services/TournamentRecurringService.ts'),
    'utf8'
  );
  expect(producer).toContain('`TournamentRecurring.${context}_atomic_creation_failed`');
  for (const [row, context] of [
    ['sngRow', 'sng'],
    ['spinRow', 'spin'],
  ] as const) {
    expect(producer).toContain(`createSeatFirstGameAtomic(${row}, '${context}')`);
    const event = `${context}_atomic_creation_failed`;
    expect(source).toContain(`'${event}'`);
    expect(
      sanitize([
        `2026-10-13T21:02:03Z [TournamentRecurring.${event}] Error: statement timeout SQLSTATE=57014 private-id private-token`,
      ])
    ).toMatchObject({
      [event]: { count: 1, categories: { 'statement timeout': 1 }, sqlstates: { '57014': 1 } },
    });
  }
});
it.each([
  'stable',
  'standby',
  'down',
  'health-mismatch',
  'label-mismatch',
  'container-change',
  'instance-change',
  'malformed-health',
])(
  'runs actual Python health/container/main admission for %s without networking or raw output',
  (mode) => {
    const fixture = `
import contextlib,io,json,runpy,sys
m=runpy.run_path(sys.argv[1]); g=m['cli'].__globals__
expected='a'*40; mode=sys.argv[2]; reads=[]; health_reads=0
class Response:
 def __enter__(self): return self
 def __exit__(self,*args): pass
 def read(self,limit):
  global health_reads
  health_reads+=1
  if mode=='malformed-health': return b'private-token invalid-health'
  return json.dumps({'running':True,'liveness':'standby' if mode=='standby' else 'ok','releaseSha': 'b'*40 if mode=='health-mismatch' else expected,'instanceId': '2-bbbbbbbb' if mode=='instance-change' and health_reads>1 else '1-aaaaaaaa'}).encode()
def urlopen(*args,**kwargs):
 if mode=='down': raise OSError('private-token unavailable')
 return Response()
def command(args):
 reads.append(args)
 if args[1]=='container':
  if args[4]=='{{json .State}}': return json.dumps({'OOMKilled':True,'ExitCode':137,'Env':'private-token'})
  if args[4]=='{{.RestartCount}}': return '2'
  return ('e'*64 if mode=='container-change' and health_reads>0 else 'c'*64)+' sha256:'+'d'*64+' '+('b'*40 if mode=='label-mismatch' else expected)
 if args[1]=='events': return json.dumps({'Action':'oom','time':123,'Actor':{'Attributes':{'name':'club-arena-engine','token':'private-token'}}})
 return '2026-10-13T21:02:03Z [TournamentRecurring.spin_atomic_creation_failed] Error: statement timeout SQLSTATE=57014 private-token private-player-id'
g['urllib'].request.urlopen=urlopen; g['bounded_command']=command
g['process_history']=lambda: {'signals':{},'coverage':{'status':'complete','fullTwoHourCoverageProven':False}}
g['archived_process_history']=lambda: {'status':'observed','archives':[],'fullTwoHourCoverageProven':False}
out=io.StringIO(); err=io.StringIO()
with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err): status=m['cli'](['diagnostic',expected])
print(json.dumps({'status':status,'stdout':out.getvalue(),'stderr':err.getvalue(),'logReads':sum(args[1]=='logs' and args[-1]=='club-arena-engine' for args in reads),'healthReads':health_reads}))
`;
    const ran = spawnSync('python3', ['-B', '-c', fixture, script, mode], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(ran.status, ran.stderr).toBe(0);
    const result = JSON.parse(ran.stdout);
    expect(result.stdout + result.stderr).not.toMatch(
      /private-token|private-player-id|invalid-health|Traceback/
    );
    if (['stable', 'standby', 'down', 'instance-change', 'malformed-health'].includes(mode)) {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.healthReads).toBe(mode === 'down' ? 0 : 2);
      expect(JSON.parse(result.stdout).runtimeStable).toBe(mode !== 'instance-change');
      expect(JSON.parse(result.stdout).identityBefore.health).toBe(
        mode === 'down'
          ? 'unavailable'
          : mode === 'malformed-health'
            ? 'unreadable'
            : mode === 'standby'
              ? 'standby'
              : 'ok'
      );
      expect(result.logReads).toBe(1);
      expect(JSON.parse(result.stdout).coverage).toMatchObject({
        semantics: 'bounded-tail',
        recordsRead: 1,
        timestampedRecords: 1,
        oldestTimestamp: '2026-10-13T21:02:03Z',
        newestTimestamp: '2026-10-13T21:02:03Z',
        full45MinuteCoverageProven: false,
        healthyRefillProven: false,
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        restarts: {
          oomKilled: true,
          exitCode: 137,
          restartCount: 2,
          events: [{ action: 'oom', unixTime: 123 }],
        },
        engineSha: 'a'.repeat(40),
        instanceId: ['down', 'malformed-health'].includes(mode) ? null : '1-aaaaaaaa',
        rawLogsExported: false,
        readOnly: true,
        events: { spin_atomic_creation_failed: { count: 1 } },
      });
    } else {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({
        readOnly: true,
        status: 'diagnostic_refused',
        rawLogsExported: false,
      });
      expect(result.logReads).toBe(mode === 'container-change' ? 1 : 0);
    }
  }
);

it('reports bounded-tail record coverage independently of matched events and handles missing timestamps', () => {
  const fixture = `
import json,runpy,sys
m=runpy.run_path(sys.argv[1]); lines=json.loads(sys.stdin.read())
print(json.dumps({'coverage':m['read_metadata']('\\n'.join(lines)), 'events':m['summarize']('\\n'.join(lines))}))
`;
  const inspect = (lines: string[]) => {
    const ran = spawnSync('python3', ['-B', '-c', fixture, script], {
      input: JSON.stringify(lines),
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(ran.status, ran.stderr).toBe(0);
    return JSON.parse(ran.stdout);
  };
  const valid = inspect([
    '2026-10-13T21:03:00.123Z unrelated private-id',
    'missing-time private-token',
    '2026-10-13T21:01:00Z unrelated earlier secret',
    '2026-99-99T21:01:00Z invalid timestamp',
  ]);
  expect(valid.events).toEqual({});
  expect(valid.coverage).toEqual({
    semantics: 'bounded-tail',
    recordsRead: 4,
    timestampedRecords: 2,
    oldestTimestamp: '2026-10-13T21:01:00Z',
    newestTimestamp: '2026-10-13T21:03:00.123Z',
    tailLimitReached: false,
    full45MinuteCoverageProven: false,
    healthyRefillProven: false,
  });
  expect(JSON.stringify(valid)).not.toMatch(/private|token|secret/);
  expect(inspect(['no-time', 'invalid-time']).coverage).toMatchObject({
    recordsRead: 2,
    timestampedRecords: 0,
    oldestTimestamp: null,
    newestTimestamp: null,
  });
  expect(inspect(Array(10000).fill('no-time')).coverage).toMatchObject({
    recordsRead: 10000,
    tailLimitReached: true,
    full45MinuteCoverageProven: false,
    healthyRefillProven: false,
  });
});

it('classifies actual Node Error output and source-owned atomic refusal literals without private text', () => {
  const reporter = readFileSync(
    resolve(__dirname, '../../server/src/services/errorReporter.ts'),
    'utf8'
  );
  expect(reporter).toContain('console.error(`[${context}]`, error)');
  const node = spawnSync(
    process.execPath,
    [
      '-e',
      `
const error = new Error('[TournamentRecurring] spin atomic creation failed:\\n  SEAT_FIRST_CREATE_INVALID_CONFIG private-player-id private-token');
error.code = '22023';
console.error('[TournamentRecurring.spin_atomic_creation_failed]', error);
`,
    ],
    { encoding: 'utf8', timeout: 5000 }
  );
  expect(node.status).toBe(0);
  const data = sanitize(
    node.stderr
      .trimEnd()
      .split('\n')
      .map((line) => `2026-10-13T21:02:03.123Z ${line}`)
  );
  expect(data.spin_atomic_creation_failed).toMatchObject({
    count: 1,
    unclassifiedCount: 0,
    categories: { SEAT_FIRST_CREATE_INVALID_CONFIG: 1 },
    sqlstates: { '22023': 1 },
  });
  expect(JSON.stringify(data)).not.toMatch(/private|token|Error:|at /);
  const rpc = readFileSync(
    resolve(
      __dirname,
      '../../supabase/migrations/20260908043250_seat_first_board_creation_is_one_transaction.sql'
    ),
    'utf8'
  );
  for (const reason of [
    'SEAT_FIRST_CREATE_INVALID_REQUEST',
    'SEAT_FIRST_CREATE_UNKNOWN_CONFIG_KEY',
    'SEAT_FIRST_CREATE_INVALID_CONFIG',
    'SEAT_FIRST_CREATE_INVALID_BLINDS',
    'SEAT_FIRST_CREATE_IDEMPOTENCY_MISMATCH',
    'SEAT_FIRST_ATOMIC_PARTIAL_STATE',
  ]) {
    expect(rpc).toContain(`'${reason}`);
    expect(
      sanitize([
        `2026-10-13T21:02:03Z [TournamentRecurring.sng_atomic_creation_failed] Error: ${reason}: private-id`,
      ]).sng_atomic_creation_failed.categories
    ).toEqual({ [reason]: 1 });
  }
});
it('does not borrow unrelated, unknown, stale or excessive continuation classifications', () => {
  const data = sanitize([
    '2026-10-13T21:02:03Z [TournamentRecurring.spin_atomic_creation_failed] Error: private-unknown',
    '2026-10-13T21:02:03Z [Unrelated] other error',
    "2026-10-13T21:02:03Z   code: '22023'",
    '2026-10-13T21:02:03Z [TournamentRecurring.sng_atomic_creation_failed] Error: private-unknown',
    '2026-10-13T21:02:06Z   SEAT_FIRST_CREATE_INVALID_CONFIG',
  ]);
  expect(data.spin_atomic_creation_failed).toMatchObject({
    count: 1,
    unclassifiedCount: 1,
    categories: {},
    sqlstates: {},
  });
  expect(data.sng_atomic_creation_failed).toMatchObject({
    count: 1,
    unclassifiedCount: 1,
    categories: {},
    sqlstates: {},
  });
  const capped = sanitize([
    '2026-10-13T21:02:03Z [TournamentRecurring.spin_atomic_creation_failed] Error: private',
    ...Array(12).fill('2026-10-13T21:02:03Z     at private-stack'),
    "2026-10-13T21:02:03Z   code: '22023'",
  ]);
  expect(capped.spin_atomic_creation_failed.sqlstates).toEqual({});
  const missing = sanitize([
    '2026-10-13T21:02:03Z [TournamentRecurring.spin_atomic_creation_failed] Error: private',
    "  code: '22023'",
  ]);
  expect(missing.spin_atomic_creation_failed.sqlstates).toEqual({});
});

it('reads existing shutdown milestones without exporting table counts or raw records', () => {
  const milestones = [
    ['shutdown_fleet_started', '[GameServer] Shutting down...'],
    ['shutdown_horse_fleet_stopped', '[HorseFleet] Stopped'],
    ['shutdown_scheduled_stopped', '[ScheduledTournaments] Stopped'],
    ['shutdown_recurring_stopped', '[TournamentRecurring] Stopped'],
    ['shutdown_lifecycle_stopped', '[Lifecycle] Stopped'],
    ['shutdown_settler_stopped', '[RakebackSettler] Stopped'],
    ['shutdown_tables_drained', '[GameServer] Drained all 408 table(s) between hands'],
    [
      'shutdown_table_drain_elapsed',
      '[GameServer] Drain window elapsed with 2/408 table(s) still mid-hand - stopping anyway',
    ],
    ['shutdown_ownership_complete', '[GameServer] Shutdown complete.'],
  ];
  const logs = milestones.map(([, literal]) => `2026-10-18T20:55:24Z ${literal} private-secret`);
  const ran = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      'import json,runpy,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps(m["process_signals"](json.loads(sys.stdin.read()))))',
      script,
    ],
    { input: JSON.stringify(logs.join('\n')), encoding: 'utf8', timeout: 5000 }
  );
  expect(ran.status, ran.stderr).toBe(0);
  const data = JSON.parse(ran.stdout);
  expect(Object.keys(data).sort()).toEqual(milestones.map(([key]) => key).sort());
  for (const [key] of milestones) {
    expect(data[key]).toEqual({
      count: 1,
      lastTimestamp: '2026-10-18T20:55:24Z',
      causes: {},
      frames: [],
    });
  }
  expect(ran.stdout).not.toMatch(/private-secret|408|2\/408/);
  const streamed = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      'import json,runpy,sys; m=runpy.run_path(sys.argv[1]); raw=json.loads(sys.stdin.read()); print(json.dumps(m["process_history"]([sys.executable,"-c","import sys; sys.stdout.write("+repr(raw)+")"])))',
      script,
    ],
    { input: JSON.stringify(logs.join('\n') + '\n'), encoding: 'utf8', timeout: 5000 }
  );
  expect(streamed.status, streamed.stderr).toBe(0);
  const history = JSON.parse(streamed.stdout);
  expect(history.coverage.status).toBe('complete');
  expect(history.signals).toEqual(data);
  expect(streamed.stdout).not.toMatch(/private-secret|408|2\/408/);
});

it('exports only typed restart events and exact process categories with bounded source frames', () => {
  const fixture = `
import json,runpy,sys
m=runpy.run_path(sys.argv[1]); raw=json.loads(sys.stdin.read())
print(json.dumps({'restarts':m['sanitize_restart_evidence']({'OOMKilled':True,'ExitCode':137,'Error':'private-secret'},'12',raw['events']), 'signals':m['process_signals'](raw['logs'])}))
`;
  const ran = spawnSync('python3', ['-B', '-c', fixture, script], {
    input: JSON.stringify({
      events: [
        {
          Action: 'oom',
          time: 123,
          Actor: { Attributes: { name: 'club-arena-engine', secret: 'private-secret' } },
        },
        {
          Action: 'die',
          time: 124,
          Actor: { Attributes: { name: 'club-arena-engine', exitCode: '137', signal: '9' } },
        },
        {
          Action: 'kill',
          time: 125,
          Actor: { Attributes: { name: 'other-container', exitCode: '137' } },
        },
        {
          Action: 'unknown-private',
          time: 126,
          Actor: { Attributes: { name: 'club-arena-engine' } },
        },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n'),
      logs: [
        '2026-10-18T14:25:00Z [GameServer.Unhandled_rejection] Error: fetch failed private-secret',
        '2026-10-18T14:25:00Z     at foo (/app/dist/services/leadership.js:123:4) private-secret',
        '2026-10-18T14:25:04Z     ETIMEDOUT private-secret',
        '2026-10-18T14:25:05Z [leadership] LOST LEADERSHIP private-player',
        '2026-10-18T14:25:06Z [GameServer] FATAL (GameServer.Unhandled_rejection) private-secret',
        '2026-10-18T14:25:07Z [Auth] out of memory private-secret',
      ].join('\n'),
    }),
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(ran.status, ran.stderr).toBe(0);
  const data = JSON.parse(ran.stdout);
  expect(data.restarts).toEqual({
    oomKilled: true,
    exitCode: 137,
    restartCount: 12,
    events: [
      { action: 'oom', unixTime: 123 },
      { action: 'die', unixTime: 124, exitCode: 137, signal: 9 },
    ],
  });
  expect(data.signals['GameServer.Unhandled_rejection']).toEqual({
    count: 1,
    lastTimestamp: '2026-10-18T14:25:00Z',
    causes: { 'fetch failed': 1 },
    frames: [{ path: 'services/leadership.js', line: 123 }],
  });
  expect(data.signals.leadership_lost.count).toBe(1);
  expect(data.signals.fatal_rejection.count).toBe(1);
  expect(JSON.stringify(data)).not.toMatch(/private|secret|Auth|ETIMEDOUT/);
});

it.each(['complete', 'size', 'time'])(
  'streams retained process errors with bounded memory and honest %s coverage',
  (mode) => {
    const fixture = `
import json,runpy,sys
m=runpy.run_path(sys.argv[1]); mode=sys.argv[2]
if mode=='complete':
 producer="print('2026-10-18T14:25:00Z [GameServer.Unhandled_rejection] Error: fetch failed private-secret'); print('2026-10-18T14:25:00Z     at f (/app/dist/services/leadership.js:123:4)'); [print('2026-10-18T14:50:00Z ordinary private-player private-secret') for _ in range(20000)]"
elif mode=='size': producer="print('x'*20000)"
else: producer="import time; print('private-secret',flush=True); time.sleep(30)"
r=m['process_history']([sys.executable,'-c',producer], max_bytes=1024 if mode=='size' else 2000000,seconds=0.05 if mode=='time' else 5)
print(json.dumps(r))
`;
    const ran = spawnSync('python3', ['-B', '-c', fixture, script, mode], {
      encoding: 'utf8',
      timeout: historyFixtureTimeoutMs,
    });
    expect(ran.status, ran.stderr).toBe(0);
    const data = JSON.parse(ran.stdout);
    expect(data.coverage.status).toBe(mode === 'complete' ? 'complete' : mode + '_bound');
    expect(data.coverage.fullTwoHourCoverageProven).toBe(false);
    if (mode === 'complete') {
      expect(data.coverage.recordsRead).toBe(20002);
      expect(data.signals['GameServer.Unhandled_rejection']).toMatchObject({
        count: 1,
        causes: { 'fetch failed': 1 },
        frames: [{ path: 'services/leadership.js', line: 123 }],
      });
      expect(data.coverage.oldestTimestamp).toBe('2026-10-18T14:25:00Z');
      expect(data.coverage.newestTimestamp).toBe('2026-10-18T14:50:00Z');
    }
    expect(ran.stdout + ran.stderr).not.toMatch(/private|secret|Traceback/);
  }
);

it('classifies only engine autoheal actions without returning container names or raw text', () => {
  const fixture = `
import json,runpy,sys
m=runpy.run_path(sys.argv[1]); print(json.dumps(m['autoheal_signals'](json.loads(sys.stdin.read()),'c'*64)))
`;
  const ran = spawnSync('python3', ['-B', '-c', fixture, script], {
    encoding: 'utf8',
    timeout: 5000,
    input: JSON.stringify(
      [
        '2026-10-18T14:25:00Z Container club-arena-engine is unhealthy Restarting container private-secret',
        '2026-10-18T14:25:01Z Container cccccccccccc restart failed private-secret',
        '2026-10-18T14:25:02Z Container other unhealthy restarting private-secret',
      ].join('\n')
    ),
  });
  expect(ran.status, ran.stderr).toBe(0);
  expect(JSON.parse(ran.stdout)).toEqual({
    unhealthy: { count: 1, lastTimestamp: '2026-10-18T14:25:00Z' },
    restart: { count: 2, lastTimestamp: '2026-10-18T14:25:01Z' },
    restart_failed: { count: 1, lastTimestamp: '2026-10-18T14:25:01Z' },
  });
  expect(ran.stdout + ran.stderr).not.toMatch(/private|secret|club-arena|cccccc/);
});

it('reads only two recent regular engine archives after a container replacement', () => {
  const fixture = `
import json,runpy,sys
from pathlib import Path
m=runpy.run_path(sys.argv[1]); g=m['archived_process_history'].__globals__; calls=[]
class Item:
 def __init__(self,name,age,symlink=False): self.name=name; self.age=age; self.link=symlink
 def is_symlink(self): return self.link
 def is_file(self): return True
 def stat(self): return type('Stat',(),{'st_mtime':g['time'].time()-self.age})()
 def __str__(self): return '/var/log/club-arena-engine/'+self.name
class Directory:
 def __init__(self,root): assert root=='/var/log/club-arena-engine'
 def glob(self,pattern):
  return [Item('engine-20261018T145500Z-started20261018T140000-aaaaaaaaaaaa-12345678.log.gz',10),Item('engine-20261018T135500Z-started20261018T130000-bbbbbbbbbbbb-87654321.log.gz',100),Item('engine-20261018T125500Z-started20261018T120000-cccccccccccc-12345678.log.gz',200),Item('private-secret.log.gz',0),Item('engine-20261018T115500Z-started20261018T110000-dddddddddddd-12345678.log.gz',10000),Item('engine-20261018T145501Z-started20261018T140000-eeeeeeeeeeee-12345678.log.gz',0,True)]
def history(args,**kwargs):
 calls.append(args)
 return {'signals':{},'coverage':{'status':'complete','fullTwoHourCoverageProven':False}}
g['Path']=Directory;g['process_history']=history
r=m['archived_process_history']();print(json.dumps({'result':r,'readCount':len(calls),'gzipOnly':all(a[:2]==['gzip','-cd'] for a in calls)}))
`;
  const ran = spawnSync('python3', ['-B', '-c', fixture, script], {
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(ran.status, ran.stderr).toBe(0);
  const data = JSON.parse(ran.stdout);
  expect(data.readCount).toBe(2);
  expect(data.gzipOnly).toBe(true);
  expect(data.result.archives.map((x: any) => x.imageIdPrefix)).toEqual(['12345678', '87654321']);
  expect(data.result.fullTwoHourCoverageProven).toBe(false);
  expect(ran.stdout + ran.stderr).not.toMatch(/private|secret|engine-2026|var\/log/);
});

it('reports kernel node OOM witnesses with explicit selected-container attribution only', () => {
  const fixture = `
import json,runpy,sys
m=runpy.run_path(sys.argv[1]); print(json.dumps(m['kernel_oom_signals'](json.loads(sys.stdin.read()),{'a'*12})))
`;
  const ran = spawnSync('python3', ['-B', '-c', fixture, script], {
    encoding: 'utf8',
    timeout: 5000,
    input: JSON.stringify(
      [
        '2026-10-18T14:25:00,000000+00:00 oom-kill:task_memcg=/system.slice/docker-' +
          'a'.repeat(64) +
          '.scope private-secret',
        '2026-10-18T14:25:00,010000+00:00 Memory cgroup out of memory: Killed process 1234 (node) private-secret',
        '2026-10-18T14:26:00,000000+00:00 Out of memory: Killed process 5678 (node) private-secret',
        '2026-10-18T14:26:00,000000+00:00 Out of memory: Killed process 7777 (other-private) private-secret',
      ].join('\n')
    ),
  });
  expect(ran.status, ran.stderr).toBe(0);
  const data = JSON.parse(ran.stdout);
  expect(data.events).toEqual([
    {
      timestamp: '2026-10-18T14:25:00.010000+00:00',
      nodePid: 1234,
      engineContainerMatched: true,
      containerIdPrefix: 'a'.repeat(12),
    },
    {
      timestamp: '2026-10-18T14:26:00+00:00',
      nodePid: 5678,
      engineContainerMatched: false,
      containerIdPrefix: null,
    },
  ]);
  expect(data.fullHistoryProven).toBe(false);
  expect(ran.stdout + ran.stderr).not.toMatch(/private|secret|other/);
});

const positiveCase = {
  handKey: originalCase.handKey,
  tableId,
  handId: originalCase.handId,
  handNumber: originalCase.handNumber,
  leaseGeneration: originalLease,
  decisionRecordSha256: 'd'.repeat(64),
};
const positiveInput = { version: 2, sourceRelease: 'a'.repeat(40), cases: [positiveCase] };
it('accepts explicit positive-calloff metadata without pretending it was an error', () => {
  const result = encodeCases(JSON.stringify(positiveInput));
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString())).toEqual(positiveInput);
  for (const bad of [
    { ...positiveCase, errorAt: originalCase.errorAt },
    { ...positiveCase, decisionRecordSha256: 'not-a-record-hash' },
    { ...positiveCase, decisionRecordSha256: undefined },
  ])
    expect(encodeCases(JSON.stringify({ ...positiveInput, cases: [bad] })).status).toBe(1);
});

function acceptedCalloffFixture(mode: string, postflop = false) {
  const extract = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      'import json,runpy,sys; print(json.dumps(runpy.run_path(sys.argv[1])["REFERENCE_DIAGNOSTIC_JS"]))',
      script,
    ],
    { encoding: 'utf8', timeout: 5000 }
  );
  expect(extract.status, extract.stderr).toBe(0);
  const program = JSON.parse(extract.stdout);
  const recordJs = ts.transpileModule(
    readFileSync(
      resolve(__dirname, '../../server/src/services/horseDecisionJournal/record.ts'),
      'utf8'
    ),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  const bindingJs = ts.transpileModule(
    readFileSync(resolve(__dirname, '../../server/src/engine/HorseDecisionHandBinding.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  const fixture = `
const {inspectAcceptedCalloffRecords}=await import('data:text/javascript;base64,${Buffer.from(program).toString('base64')}');
const records=await import('data:text/javascript;base64,${Buffer.from(recordJs).toString('base64')}');
const binding=await import('data:text/javascript;base64,${Buffer.from(bindingJs).toString('base64')}');
const mode=${JSON.stringify(mode)}, input=${JSON.stringify(positiveInput)},c=input.cases[0];
const coordinate=${JSON.stringify(originalCoordinate)};
const postflop=${postflop};
const actor='52345678-abcd-4321-abcd-123456789abc';
const snapshot={type:'DECIDE_FAST',generation:7,requestId:9,decisionTimeMs:1000,
 fence:c.tableId+':123:1:'+c.leaseGeneration+':7',handJournalContext:binding.captureHorseHandJournalContext([]),
 decisionKey:'private-decision-id',player:{seat:1,user_id:actor,stack:100,bet:20},gameState:{currentBet:120,gameVariant:'nlh'}};
if(postflop) {input.version=3;c.stage='flop';c.actorId=actor;c.seat=1;snapshot.gameState.stage='flop';snapshot.gameState.gameVariant='plo5';snapshot.gameState.pot=250;snapshot.gameState.contestablePot=225;snapshot.player.cards=['As','Kd','Qc','Jh','Ts'];}
if(postflop && ['turn','river'].includes(mode)) {c.stage=mode;snapshot.gameState.stage=mode;}
if(mode==='made-category') {snapshot.player.cards=['A','K','Q','J','T'].map(rank=>({rank,suit:'spades'}));snapshot.gameState.communityCards=['2','3','4'].map(rank=>({rank,suit:'hearts'}));}
if(mode==='wrong-stage') snapshot.gameState.stage='turn';
if(mode==='wrong-actor') c.actorId='62345678-abcd-4321-abcd-123456789abc';
if(mode==='wrong-seat') c.seat=2;
if(mode==='missing-contestable') delete snapshot.gameState.contestablePot;
if(mode==='zero-stack') snapshot.player.stack=0;
if(mode==='chips-behind'||mode==='diagnostic-call-price') snapshot.player.stack=101;
if(mode==='diagnostic-stack') snapshot.player.stack=0;
if(mode==='diagnostic-bet') snapshot.player.bet='20';
if(mode==='diagnostic-overflow') {snapshot.player.bet=-Number.MAX_VALUE;snapshot.gameState.currentBet=Number.MAX_VALUE;}
if(mode==='diagnostic-anchor') snapshot.fence=snapshot.fence.replace(':123:',':124:');
const decision={action:'all_in',tournamentPreflopAttribution:{route:'variant_price',referenceProposal:{action:'all_in',amount:null}}};
if(postflop) delete decision.tournamentPreflopAttribution;
if(mode==='wrong-route'||mode==='diagnostic-route') decision.tournamentPreflopAttribution.route='chart_open_jam';
if(mode==='diagnostic-final-action') decision.action='call';
if(mode==='diagnostic-reference-action') decision.tournamentPreflopAttribution.referenceProposal.action='call';
if(mode==='sized-reference'||mode==='diagnostic-amount') decision.tournamentPreflopAttribution.referenceProposal.amount=100;
const acceptedAction={seat:1,userId:actor,action:'all_in',amount:100,timestamp:1001,stage:postflop?c.stage:'preflop'};
const witness={handAnchor:binding.anchorHorseDecisionHand(snapshot),identity:{stage:postflop?c.stage:'preflop'},
 executionStatus:'intended',retirementReason:null,selected:{action:'all_in'},executedAction:'all_in',
 acceptedActions:[{intended:true,record:acceptedAction}]};
if(mode==='wrong-execution-stage') witness.identity.stage='turn';
if(mode==='wrong-execution-actor') acceptedAction.userId='62345678-abcd-4321-abcd-123456789abc';
if(mode==='coerced') witness.executionStatus='coerced';
if(mode==='fold-executed') witness.executedAction='fold';
let sequence=0;
const make=(kind,body,turnKey='b'.repeat(64))=>records.makeHorseJournalRecord({producerId:'42345678-abcd-4321-abcd-123456789abc',
 sequence:++sequence,atMs:1000,sourceRelease:input.sourceRelease,kind,handKey:c.handKey,turnKey},body);
const d=make('decision',{snapshot,decision,private:'private-secret'});
c.decisionRecordSha256=(['discover','discovery-ambiguous'].includes(mode)||mode.startsWith('diagnostic-'))?null:d.sha256;
const e=make('execution',witness,mode==='wrong-turn'?'c'.repeat(64):d.turnKey);
const hand={generation:123,fence:c.tableId+':123:'+c.leaseGeneration+':observe',handKey:c.tableId+':123',
 committedHandId:c.handId,actions:[{...acceptedAction,origin:'horse_policy',
 publicNode:{version:1,status:'captured',actorSeat:1,street:postflop?c.stage:'preflop'},
 observationIdentity:{version:1,status:'bound',handId:c.handId,actionOrdinal:0,observationId:c.handId+':0',sessionKey:'a'.repeat(64)}}]};
if(mode==='unbound') hand.actions[0].observationIdentity.actionOrdinal=1;
if(mode==='diagnostic-accepted') hand.committedHandId=actor;
const a=make('accepted_hand',hand,c.handKey);
let rows=mode==='diagnostic-empty'?[e,a]:[d,e,a];
if(mode==='duplicate-execution') rows.push(make('execution',witness));
if(mode==='discovery-ambiguous') rows.push(make('decision',{snapshot,decision}));
if(mode==='tampered-record') rows[0]={...d,body:d.body+' '};
if(mode==='wrong-decision') c.decisionRecordSha256='f'.repeat(64);
const api={...records,...binding,
 omahaNutStatus:mode==='made-category'?()=>({category:2}):undefined,
 horsePhase6AttributionMismatch:()=>mode==='phase6-refused'?'reference_shape':null,
 horseDecisionReceiptIsValid:()=>mode!=='invalid-receipt',
 reconcileHorseJournalHand:()=>({status:mode==='unreconciled'?'incomplete':'reconciled',gaps:mode==='unreconciled'?['input_mismatch']:[],
 matchedActions:1,acceptedHorseActions:1})};
const batch={status:'canonical_journal_export',sourceRelease:mode==='wrong-source'?'e'.repeat(40):input.sourceRelease,
 recordsByHand:[{handKey:c.handKey,records:rows}]};
console.log(JSON.stringify({input,result:inspectAcceptedCalloffRecords(input,batch,api)}));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', fixture], {
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout + run.stderr).not.toMatch(
    /private-secret|private-decision-id|"player"|currentBet|As|Kd|Qc|Jh|Ts/
  );
  return JSON.parse(run.stdout);
}

it('observes only an exact successful calloff joined to its intended same-turn execution and hand', () => {
  const { input, result } = acceptedCalloffFixture('ok');
  expect(result.status).toBe('observed');
  expect(result.cases[0]).toMatchObject({
    observation: 'accepted_variant_price_whole_stack_calloff',
    decisionRecordSha256: input.cases[0].decisionRecordSha256,
    guards: {
      exactDecisionBound: true,
      positiveStackCalloff: true,
      sameTurnExecution: true,
      intendedAllInAccepted: true,
      handReconciled: true,
    },
  });
  const checked = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      'import json,runpy,sys; m=runpy.run_path(sys.argv[1]); d=json.loads(sys.stdin.read()); print(json.dumps(m["sanitize_reference_result"](d["result"],d["input"])))',
      script,
    ],
    { input: JSON.stringify({ input, result }), encoding: 'utf8', timeout: 5000 }
  );
  expect(checked.status, checked.stderr).toBe(0);
  expect(JSON.parse(checked.stdout)).toEqual(result);
});
it.each([
  'zero-stack',
  'chips-behind',
  'wrong-route',
  'sized-reference',
  'coerced',
  'fold-executed',
  'wrong-turn',
  'duplicate-execution',
  'tampered-record',
  'wrong-decision',
  'phase6-refused',
  'invalid-receipt',
  'unbound',
  'unreconciled',
  'wrong-source',
  'discovery-ambiguous',
])('does not convert %s into positive calloff proof', (mode) => {
  const { result } = acceptedCalloffFixture(mode);
  expect(result.status).toBe('unknown');
  expect(result.cases?.[0]?.status).not.toBe('observed');
});
it('refuses private, false-guard and hash-substituted positive child output', () => {
  const { input, result } = acceptedCalloffFixture('ok');
  for (const tamper of [
    { ...result, private: 'private-secret' },
    { ...result, cases: [{ ...result.cases[0], amount: 100 }] },
    { ...result, cases: [{ ...result.cases[0], decisionRecordSha256: 'e'.repeat(64) }] },
    {
      ...result,
      cases: [{ ...result.cases[0], guards: { ...result.cases[0].guards, receiptValid: false } }],
    },
  ]) {
    const checked = spawnSync(
      'python3',
      [
        '-B',
        '-c',
        `import json,runpy,sys
m=runpy.run_path(sys.argv[1]); d=json.loads(sys.stdin.read());m['reference_diagnostic'].__globals__['bounded_command']=lambda *a,**k:json.dumps(d['result'])
print(json.dumps(m['reference_diagnostic'](d['input'])))`,
        script,
      ],
      { input: JSON.stringify({ input, result: tamper }), encoding: 'utf8', timeout: 5000 }
    );
    expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout)).toEqual({
      status: 'unknown',
      reason: 'journal_or_runtime_unavailable',
      diagnostic: { stage: 'sanitizer', code: 'result_refused' },
    });
    expect(checked.stdout + checked.stderr).not.toContain('private-secret');
  }
  expect(source).toContain("await import('/app/dist/services/horseDecisionJournal/review.js')");
  expect(source).toContain('api.reconcileHorseJournalHand(entry.records,c.handKey)');
  expect(source).toContain('api.bindHorseDecisionToCommittedHand(w,hand)');
});

it('discovers one positive calloff within an explicitly bound accepted hand without exporting private records', () => {
  const { input, result } = acceptedCalloffFixture('discover');
  expect(input.cases[0].decisionRecordSha256).toBeNull();
  expect(result.status).toBe('observed');
  expect(result.cases[0].decisionRecordSha256).toMatch(/^[0-9a-f]{64}$/);
});

it('exports only exact bounded original tournament cash-yield events, including retained stream history', () => {
  const fixture = `
import json,runpy,sys
m=runpy.run_path(sys.argv[1]); line='2026-10-27T01:54:54.957590Z [SessionRotator] horse=4ea2c47b leaving table=e5904da2 for a tournament in 1 min (certain, 1 over four games)'
invalid=[line+' private-secret',line.replace('certain','other-private-reason'),line.replace('2026-10-27','2026-99-99'),line.replace('horse=4ea2c47b','horse=private-user'),line.replace(', 1 over',', 0 over')]
parsed=m['tournament_yields']('\\n'.join([line,*invalid]))
producer='print('+repr(line)+'); '+"[print('2026-10-27T02:00:00Z private-secret') for _ in range(12000)]"
history=m['process_history']([sys.executable,'-c',producer],max_bytes=2000000,seconds=5)
print(json.dumps({'parsed':parsed,'history':history,'bounded':m['tournament_yields']('\\n'.join([line]*130))}))
`;
  const ran = spawnSync('python3', ['-B', '-c', fixture, script], {
    encoding: 'utf8',
    timeout: historyFixtureTimeoutMs,
  });
  expect(ran.status, ran.stderr).toBe(0);
  const result = JSON.parse(ran.stdout);
  expect(result.parsed).toMatchObject({ matchingRecords: 1, eventsTruncated: false });
  expect(result.parsed.events).toEqual([
    {
      timestamp: '2026-10-27T01:54:54.957590Z',
      horseIdPrefix: '4ea2c47b',
      tableIdPrefix: 'e5904da2',
      minutesToStart: 1,
      reason: 'certain',
      excess: 1,
    },
  ]);
  expect(result.bounded).toMatchObject({
    matchingRecords: 130,
    eventsTruncated: true,
    cashoutCompletionProven: false,
  });
  expect(result.bounded.events).toHaveLength(128);
  expect(result.history.tournamentYields).toEqual(result.parsed);
  expect(result.history.coverage.status).toBe('complete');
  expect(ran.stdout + ran.stderr).not.toMatch(/private|secret|Traceback/);
});

it('keeps only typed original booking-cap request context and never infers RUNNING status', () => {
  const fixture = `
import json,runpy,sys
m=runpy.run_path(sys.argv[1]); prefix='2026-10-27T02:54:01.000000Z [TournamentRecurring] horse_entry_cap_refused '
record={'version':1,'tournamentId':'bbbbbbbb-2222-4222-8222-222222222222','horseId':'aaaaaaaa-1111-4111-8111-111111111111','sqlstate':'23514','load':4,'attemptedAt':'2026-10-27T02:54:00.000Z'}
line=prefix+json.dumps(record)
invalid=[prefix+json.dumps(dict(record, private='secret')),prefix+json.dumps(dict(record, load=True)),prefix+json.dumps(dict(record, sqlstate='55000')),prefix+json.dumps(dict(record, horseId='private-user')),line+' private-secret',line.replace('02:54:01','02:54:00').replace('02:54:00.000Z','02:55:00.000Z'),prefix+json.dumps(record)[:-1]+',"load":5}']
parse=m.get('booking_cap_refusals',lambda raw:{'matchingRecords':0,'events':[]})
parsed=parse('\\n'.join([line,*invalid]))
producer='print('+repr(line)+'); '+"[print('2026-10-27T02:55:00Z private-secret') for _ in range(12000)]"
history=m['process_history']([sys.executable,'-c',producer],max_bytes=2000000,seconds=5)
print(json.dumps({'parsed':parsed,'history':history,'bounded':parse('\\n'.join([line]*130))}))
`;
  const ran = spawnSync('python3', ['-B', '-c', fixture, script], {
    encoding: 'utf8',
    timeout: historyFixtureTimeoutMs,
  });
  expect(ran.status, ran.stderr).toBe(0);
  const result = JSON.parse(ran.stdout);
  expect(result.parsed).toMatchObject({ matchingRecords: 1, runningEntryProven: false });
  expect(result.parsed.events).toEqual([
    {
      timestamp: '2026-10-27T02:54:01.000000Z',
      attemptedAt: '2026-10-27T02:54:00.000Z',
      horseIdPrefix: 'aaaaaaaa',
      tournamentIdPrefix: 'bbbbbbbb',
      sqlstate: '23514',
      load: 4,
    },
  ]);
  expect(result.bounded).toMatchObject({ matchingRecords: 130, eventsTruncated: true });
  expect(result.bounded.events).toHaveLength(128);
  expect(result.history.bookingCapRefusals).toEqual(result.parsed);
  expect(ran.stdout + ran.stderr).not.toMatch(/private|secret|111111111111|222222222222|Traceback/);
});

const emptySelectionCounts = {
  decisionRecords: 1,
  selectedRecords: 1,
  finalActionMismatch: 0,
  referenceRouteMismatch: 0,
  referenceActionMismatch: 0,
  referenceAmountMismatch: 0,
  stackShapeMismatch: 0,
  callPriceShapeMismatch: 0,
  notWholeStackCall: 0,
  matchingShape: 0,
};
it.each([
  ['diagnostic-empty', { ...emptySelectionCounts, decisionRecords: 0, selectedRecords: 0 }],
  ['wrong-decision', { ...emptySelectionCounts, selectedRecords: 0 }],
  ['diagnostic-final-action', { ...emptySelectionCounts, finalActionMismatch: 1 }],
  ['diagnostic-route', { ...emptySelectionCounts, referenceRouteMismatch: 1 }],
  ['diagnostic-reference-action', { ...emptySelectionCounts, referenceActionMismatch: 1 }],
  ['diagnostic-amount', { ...emptySelectionCounts, referenceAmountMismatch: 1 }],
  ['diagnostic-stack', { ...emptySelectionCounts, stackShapeMismatch: 1 }],
  ['diagnostic-bet', { ...emptySelectionCounts, callPriceShapeMismatch: 1 }],
  ['diagnostic-overflow', { ...emptySelectionCounts, callPriceShapeMismatch: 1 }],
  ['diagnostic-call-price', { ...emptySelectionCounts, notWholeStackCall: 1 }],
] as const)(
  'explains %s only with bounded validated selection counts, preserving unknown',
  (mode, counts) => {
    const { input, result } = acceptedCalloffFixture(mode);
    expect(result.status).toBe('unknown');
    expect(result.cases[0]).toEqual({
      handKey: input.cases[0].handKey,
      status: 'unknown',
      reason: 'matching_decision_missing',
      selectionCounts: counts,
    });
    const checked = spawnSync(
      'python3',
      [
        '-B',
        '-c',
        'import json,runpy,sys; m=runpy.run_path(sys.argv[1]); d=json.loads(sys.stdin.read()); print(json.dumps(m["sanitize_reference_result"](d["result"],d["input"])))',
        script,
      ],
      { input: JSON.stringify({ input, result }), encoding: 'utf8', timeout: 5000 }
    );
    expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout)).toEqual(result);
  }
);
it.each(['diagnostic-anchor', 'diagnostic-accepted', 'tampered-record', 'wrong-source'])(
  'does not emit selection counts before %s validation',
  (mode) => {
    const { result } = acceptedCalloffFixture(mode);
    expect(result.status).toBe('unknown');
    expect(result.cases?.[0]?.selectionCounts).toBeUndefined();
  }
);

it('refuses private or inconsistent diagnostic counts without emitting child output', () => {
  const { input, result } = acceptedCalloffFixture('diagnostic-final-action');
  const row = result.cases[0];
  const counts = row.selectionCounts;
  for (const bad of [
    { ...row, selectionCounts: { ...counts, private: 'private-secret' } },
    { ...row, selectionCounts: { ...counts, decisionRecords: true } },
    { ...row, selectionCounts: { ...counts, decisionRecords: 257 } },
    { ...row, selectionCounts: { ...counts, finalActionMismatch: -1 } },
    { ...row, selectionCounts: { ...counts, referenceRouteMismatch: 1 } },
    { ...row, selectionCounts: { ...counts, matchingShape: 1, finalActionMismatch: 0 } },
    { ...row, selectionCounts: { ...counts, selectedRecords: 0, finalActionMismatch: 0 } },
    { ...row, reason: 'original_snapshot_binding_mismatch' },
    { ...row, reason: 'calloff_shape_not_observed' },
    { ...row, status: 'observed' },
  ]) {
    const checked = spawnSync(
      'python3',
      [
        '-B',
        '-c',
        `import json,runpy,sys
m=runpy.run_path(sys.argv[1]); d=json.loads(sys.stdin.read());m['reference_diagnostic'].__globals__['bounded_command']=lambda *a,**k:json.dumps(d['result'])
print(json.dumps(m['reference_diagnostic'](d['input'])))`,
        script,
      ],
      {
        input: JSON.stringify({ input, result: { ...result, cases: [bad] } }),
        encoding: 'utf8',
        timeout: 5000,
      }
    );
    expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout)).toEqual({
      status: 'unknown',
      reason: 'journal_or_runtime_unavailable',
      diagnostic: { stage: 'sanitizer', code: 'result_refused' },
    });
    expect(checked.stdout + checked.stderr).not.toContain('private-secret');
  }
});

it('v3 admits only exact actor, seat and postflop stage metadata', () => {
  const c = {
    ...positiveCase,
    actorId: '52345678-abcd-4321-abcd-123456789abc',
    seat: 1,
    stage: 'flop',
  };
  const input = { ...positiveInput, version: 3, cases: [c] };
  expect(encodeCases(JSON.stringify(input)).status).toBe(0);
  for (const change of [
    { stage: 'preflop' },
    { stage: undefined },
    { actorId: 'unknown' },
    { seat: 0 },
    { seat: true },
    { seat: 11 },
    { cards: ['As'] },
  ])
    expect(encodeCases(JSON.stringify({ ...input, cases: [{ ...c, ...change }] })).status).toBe(1);
  expect(encodeCases(JSON.stringify({ ...input, version: 2 })).status).toBe(1);
});
it('v3 observes original postflop scalars without requiring a preflop reference', () => {
  const { input, result } = acceptedCalloffFixture('ok', true);
  expect(result.status).toBe('observed');
  expect(result.version).toBe(3);
  expect(result.cases[0].snapshotSummary).toEqual({
    stage: 'flop',
    variant: 'plo5',
    call: 100,
    stack: 100,
    pot: 250,
    contestablePot: 225,
    contestablePotPresent: true,
    ownCardCount: 5,
    readFramePresent: false,
    ownMadeCategory: null,
    finalAction: 'all_in',
  });
  const checked = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      `import json,runpy,sys
m=runpy.run_path(sys.argv[1]);d=json.loads(sys.stdin.read());print(json.dumps(m['sanitize_reference_result'](d['result'],d['input'])))`,
      script,
    ],
    { input: JSON.stringify({ input, result }), encoding: 'utf8' }
  );
  expect(checked.status, checked.stderr).toBe(0);
});
it.each([
  'wrong-execution-stage',
  'wrong-execution-actor',
  'wrong-stage',
  'wrong-actor',
  'wrong-seat',
  'wrong-turn',
  'tampered-record',
  'wrong-source',
  'unbound',
  'unreconciled',
  'coerced',
  'chips-behind',
  'duplicate-execution',
  'wrong-decision',
  'invalid-receipt',
])('v3 preserves %s as unknown', (mode) => {
  const { input, result } = acceptedCalloffFixture(mode, true);
  expect(result.status).toBe('unknown');
  const checked = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      `import json,runpy,sys
m=runpy.run_path(sys.argv[1]);d=json.loads(sys.stdin.read());print(json.dumps(m['sanitize_reference_result'](d['result'],d['input'])))`,
      script,
    ],
    { input: JSON.stringify({ input, result }), encoding: 'utf8' }
  );
  expect(checked.status, checked.stderr).toBe(0);
});
it('v3 never substitutes public pot for absent contestable pot', () => {
  expect(
    acceptedCalloffFixture('missing-contestable', true).result.cases[0].snapshotSummary
  ).toMatchObject({ pot: 250, contestablePot: null, contestablePotPresent: false });
});

it('v3 refuses private fields, invalid scalar types and false witnesses at the output boundary', () => {
  const { input, result } = acceptedCalloffFixture('ok', true);
  for (const mutation of [
    { cards: ['As'] },
    { stage: 'turn' },
    { variant: 'private-secret' },
    { stack: true },
    { call: 99 },
    { contestablePotPresent: false },
    { ownCardCount: 7 },
    { ownMadeCategory: 10 },
    { readFramePresent: 'private-secret' },
  ]) {
    const bad = {
      ...result,
      cases: [
        {
          ...result.cases[0],
          snapshotSummary: { ...result.cases[0].snapshotSummary, ...mutation },
        },
      ],
    };
    const checked = spawnSync(
      'python3',
      [
        '-B',
        '-c',
        `import json,runpy,sys
m=runpy.run_path(sys.argv[1]);d=json.loads(sys.stdin.read());m['reference_diagnostic'].__globals__['bounded_command']=lambda *a,**k:json.dumps(d['result']);print(json.dumps(m['reference_diagnostic'](d['input'])))`,
        script,
      ],
      { input: JSON.stringify({ input, result: bad }), encoding: 'utf8' }
    );
    expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout)).toEqual({
      status: 'unknown',
      reason: 'journal_or_runtime_unavailable',
      diagnostic: { stage: 'sanitizer', code: 'result_refused' },
    });
    expect(checked.stdout + checked.stderr).not.toMatch(/private-secret|As/);
  }
});

it.each(['turn', 'river'])('v3 binds a valid %s calloff using its original stage', (mode) => {
  const { result } = acceptedCalloffFixture(mode, true);
  expect(result.status).toBe('observed');
  expect(result.cases[0].snapshotSummary.stage).toBe(mode);
});

it('v3 derives only a bounded category when the installed deterministic API and original physical cards are available', () => {
  expect(
    acceptedCalloffFixture('made-category', true).result.cases[0].snapshotSummary.ownMadeCategory
  ).toBe(2);
});

it('flushes the actual diagnostic writer through a backpressured child pipe before exit', () => {
  const fixture = `
import json,runpy,subprocess,sys,time
program=runpy.run_path(sys.argv[1])['REFERENCE_DIAGNOSTIC_JS']
start=program.index('  await new Promise(resolve=>{')
end=program.index('  process.exit(0);',start)+len('  process.exit(0);')
report={'status':'unknown','reason':'x'*200000}
writer='const report='+json.dumps(report)+';'+program[start:end]
child=subprocess.Popen([sys.argv[2],'--input-type=module'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
child.stdin.write(writer.encode());child.stdin.close()
time.sleep(.05)
raw=child.stdout.read();error=child.stderr.read();code=child.wait(timeout=5)
assert code==0 and not error and json.loads(raw)==report and raw.endswith(b'\\n')
print(json.dumps({'complete':True,'bytes':len(raw)}))
`;
  const ran = spawnSync('python3', ['-B', '-c', fixture, script, process.execPath], {
    encoding: 'utf8',
    timeout: 8000,
  });
  expect(ran.status, ran.stderr).toBe(0);
  expect(JSON.parse(ran.stdout)).toMatchObject({ complete: true });
});

it('separates bounded child stderr from JSON and classifies host failures without leaking bytes', () => {
  const fixture = `
import json,runpy,sys
m=runpy.run_path(sys.argv[1]); g=m['reference_diagnostic'].__globals__
read=m['bounded_command']; failure=m['DiagnosticCommandFailure']
raw=read([sys.argv[2],'-e',"process.stderr.write('private-secret');process.stdout.write('{}')"],separate_stderr=True)
assert json.loads(raw)=={}
for code in ('nonzero_exit','timeout','output_bound'):
 def fail(*a,**k): raise failure(code)
 g['bounded_command']=fail
 assert m['reference_diagnostic']({})['diagnostic']=={'stage':'child_transport','code':code}
for raw,stage in [('private-secret\\n{}','stdout_parse'),('{}','sanitizer'),(json.dumps({'status':'unknown','reason':'journal_or_runtime_unavailable','diagnostic':{'stage':'private-secret','code':'exception'}}),'sanitizer')]:
 g['bounded_command']=lambda *a,**k:raw
 assert m['reference_diagnostic']({'version':3})['diagnostic']['stage']==stage
try: read([sys.argv[2],'-e',"process.stderr.write('private-secret');process.exit(7)"],separate_stderr=True)
except failure as error: assert error.code=='nonzero_exit'
else: raise AssertionError()
try: read([sys.argv[2],'-e',"process.stderr.write('x'.repeat(4*1024*1024+1))"],separate_stderr=True)
except failure as error: assert error.code=='output_bound'
else: raise AssertionError()
print(json.dumps({'bounded':True}))
`;
  const ran = spawnSync('python3', ['-B', '-c', fixture, script, process.execPath], {
    encoding: 'utf8',
    timeout: 8000,
  });
  expect(ran.status, ran.stderr).toBe(0);
  expect(JSON.parse(ran.stdout)).toEqual({ bounded: true });
  expect(ran.stdout + ran.stderr).not.toContain('private-secret');
});

it('runs the actual child entry point with noisy modules and closed import failure stages', () => {
  const fixture = `
import json,re,runpy,subprocess,sys,urllib.parse
m=runpy.run_path(sys.argv[1]); program=m['REFERENCE_DIAGNOSTIC_JS']
for mode in ('noise','throw','missing'):
 def module(match):
  path=match.group(1)
  body="console.log('private-secret'); console.warn('private-secret');"
  if path.endswith('/journalTransport.js'):
   body += "throw Error('private-secret');" if mode=='throw' else ("export const exportCanonicalHorseJournalBatch=()=>null;" if mode=='noise' else '')
  if path.endswith('/ChannelHub.js'): body+='export const channelHub={close(){}};'
  return "import('data:text/javascript,"+urllib.parse.quote(body,safe='')+"')"
 child=re.sub(r"import\\('(/app/[^']+)'\\)",module,program)
 ran=subprocess.run([sys.argv[2],'--input-type=module','-e',child,'--','--reference-shape-diagnostic'],input=json.dumps({'version':3,'sourceRelease':'a'*40,'cases':[]}),text=True,capture_output=True,timeout=5)
 assert ran.returncode==0 and not ran.stderr
 report=json.loads(ran.stdout)
 assert 'private-secret' not in ran.stdout
 if mode=='noise': assert report['reason']=='journal_source_or_shape_mismatch'
 else: assert report['diagnostic']=={'stage':'module_load_journal' if mode=='throw' else 'export_contract','code':'exception'}
print(json.dumps({'childVerified':True}))
`;
  const ran = spawnSync('python3', ['-B', '-c', fixture, script, process.execPath], {
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(ran.status, ran.stderr).toBe(0);
  expect(JSON.parse(ran.stdout)).toEqual({ childVerified: true });
});
