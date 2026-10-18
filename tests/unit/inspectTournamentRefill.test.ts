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
  expect(source).toContain('before != after');
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
it.each(['stable', 'health-mismatch', 'label-mismatch', 'instance-change', 'malformed-health'])(
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
  return json.dumps({'running':True,'liveness':'ok','releaseSha': 'b'*40 if mode=='health-mismatch' else expected,'instanceId': '2-bbbbbbbb' if mode=='instance-change' and health_reads>1 else '1-aaaaaaaa'}).encode()
def urlopen(*args,**kwargs): return Response()
def command(args):
 reads.append(args)
 if args[1]=='container':
  if args[4]=='{{json .State}}': return json.dumps({'OOMKilled':True,'ExitCode':137,'Env':'private-token'})
  if args[4]=='{{.RestartCount}}': return '2'
  return 'b'*40 if mode=='label-mismatch' else expected
 if args[1]=='events': return json.dumps({'Action':'oom','time':123,'Actor':{'Attributes':{'name':'club-arena-engine','token':'private-token'}}})
 return '2026-10-13T21:02:03Z [TournamentRecurring.spin_atomic_creation_failed] Error: statement timeout SQLSTATE=57014 private-token private-player-id'
g['urllib'].request.urlopen=urlopen; g['bounded_command']=command
out=io.StringIO(); err=io.StringIO()
with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err): status=m['cli'](['diagnostic',expected])
print(json.dumps({'status':status,'stdout':out.getvalue(),'stderr':err.getvalue(),'logReads':sum(args[1]=='logs' for args in reads),'healthReads':health_reads}))
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
    if (mode === 'stable') {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.healthReads).toBe(2);
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
        instanceId: '1-aaaaaaaa',
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
      expect(result.logReads).toBe(mode === 'instance-change' ? 1 : 0);
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
