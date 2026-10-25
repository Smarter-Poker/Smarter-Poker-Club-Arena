import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const script = resolve(__dirname, '../../scripts/ci/inspect-tournament-refill.py');
const source = readFileSync(script, 'utf8');
const workflowText = readFileSync(
  resolve(__dirname, '../../.github/workflows/inspect-tournament-refill.yml'),
  'utf8'
);
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
import json,runpy,sys
m=runpy.run_path(sys.argv[1]); raw=json.loads(sys.stdin.read())
producer='import sys; sys.stdout.write('+repr(raw)+')'
print(json.dumps(m['process_history']([sys.executable,'-c',producer],max_bytes=2000000,seconds=5)))
`;
  const ran = spawnSync('python3', ['-B', '-c', fixture, script], {
    input: JSON.stringify(
      [line, ...Array(12000).fill('2026-10-25T22:49:00Z unrelated private-secret')].join('\n') +
        '\n'
    ),
    encoding: 'utf8',
    timeout: 7000,
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
    /os\.environ|\.env|docker.*restart|systemctl|print\(raw|print\(error|print\(line/
  );
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

it('streams retained process errors beyond the noisy newest tail with bounded memory and honest coverage', () => {
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
  for (const mode of ['complete', 'size', 'time']) {
    const ran = spawnSync('python3', ['-B', '-c', fixture, script, mode], {
      encoding: 'utf8',
      timeout: 7000,
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
});

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
