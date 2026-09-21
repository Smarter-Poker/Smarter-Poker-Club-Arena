import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Subprocess contract suite: these tests drive REAL child processes, so their
// wall time scales with machine load, not with the code under test. vitest's
// 5000ms default is a UNIT-test budget: the slowest test here measures 1589ms
// solo, and the pre-push hook runs this file in a 90-file suite at full width,
// where contention has been measured to stretch these runs by 7.1x and time
// them out. 90s is 56x the measured solo runtime - past anything observed,
// and still a real bound, so a genuinely hung child still fails the suite.
// File-scoped on purpose: no global testTimeout, no --no-file-parallelism.
vi.setConfig({ testTimeout: 90_000 });
import { sliceBetween } from './helpers/sourceWindow';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const transaction = read('server/scripts/engine-release-transaction.sh');
const installer = read('server/scripts/install-engine-supervisor.sh');
const checkpointShell = read('server/scripts/legacy-engine-checkpoint.sh');
const checkpointTransport = read('server/scripts/legacy-engine-checkpoint.mjs');
const predecessor758 = '758610f3f844406bbbaee2f5100ced36d84fb943';
const predecessorA0 = 'a0ab287d902879280f0c915e44f5222c5db4d7df';
const predecessor8825 = '8825af51817f379c4261658ca29ecc9d8d81932d';
const image8825 = 'sha256:7973b0cd170e7ea00a948f6376b17a201485c3e03ae47c06f0248b17a4bfae1c';
const image758 = 'sha256:0190d49e394fd2b12b1462730bb22c4c4d1c4d49564e19b192bb07e3754c5561';
const imageA0 = 'sha256:a58e0d3983b73b59bfc26e0ad55f67759730a7313d0280f80311fe20109658f6';
const countdownStart = transaction.indexOf('legacy_checkpoint_countdown() {');
const countdownEnd = transaction.indexOf('\npersist_break_deadline()', countdownStart);
const countdown = transaction.slice(countdownStart, countdownEnd);

function probe(patch: Record<string, unknown> = {}, httpStatus = 200) {
  const maintenance = {
    active: true,
    phase: 'counting_down',
    durableConfirmed: true,
    remainingMs: 299_000,
    breakEndsAt: Date.now() + 299_000,
    readyForRestart: false,
    unparkedTables: 3,
    ...patch,
  };
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
MIN_BREAK_REMAINING_MS=285000
curl() { printf '%s\\n%s' "$CHECKPOINT_TEST_BODY" "$CHECKPOINT_TEST_HTTP"; }
${countdown}
legacy_checkpoint_countdown
`,
    ],
    {
      encoding: 'utf8',
      timeout: 3_000,
      env: {
        ...process.env,
        CHECKPOINT_TEST_BODY: JSON.stringify({ running: true, maintenance }),
        CHECKPOINT_TEST_HTTP: String(httpStatus),
      },
    }
  );
}

describe('the exact legacy checkpoint enters the existing release transaction', () => {
  it('checks the installed custody contract before saving intent or opening inspector access', () => {
    const prerequisite = checkpointShell.indexOf('--mixed-custody-contract');
    const intent = checkpointShell.indexOf('CHECKPOINT_INTENT="$(python3');
    const inspector = checkpointShell.indexOf('node --input-type=module');
    expect(prerequisite).toBeGreaterThan(0);
    expect(prerequisite).toBeLessThan(intent);
    expect(intent).toBeLessThan(inspector);
    const check = checkpointShell.slice(checkpointShell.lastIndexOf('\nif ', prerequisite), intent);
    expect(check).toContain(predecessor8825);
    expect(check).toContain('engine-release-database-proof.py');
    expect(check).toContain(
      "die 'installed mixed-custody contract unavailable or incompatible; checkpoint not started'"
    );
  });

  it.each([0, 1, 124])(
    'preserves the one-shot intent until the installed prerequisite passes (exit %s)',
    (status) => {
      const requestRoot = mkdtempSync(join(tmpdir(), 'legacy-custody-prerequisite-'));
      try {
        const block = checkpointShell.slice(
          checkpointShell.indexOf('# Installed SQL is a prerequisite'),
          checkpointShell.indexOf('{ cat "$CONTROL_DIR/legacy-engine-checkpoint-guard.mjs";')
        );
        expect(block).toContain('--mixed-custody-contract');
        const result = spawnSync(
          'bash',
          [
            '-c',
            `set -euo pipefail
die() { echo "$*" >&2; exit 1; }
timeout() { printf '%s\\n' "$*"; return "$PREREQUISITE_STATUS"; }
curl() { printf '%s' "$PREREQUISITE_HEALTH"; }
CONTROL_DIR=/immutable-reviewed-control
LEGACY_SHA=${predecessor8825}
REQUEST_ROOT="$PREREQUISITE_ROOT"
RUN_ID=35405450271-1
REQUEST=(unused unused unused unused aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
CONTAINER_ID=c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66
STARTED_AT=2026-09-18T21:55:50.88305198Z
HOST_PID=1231816
${block}
printf '%s' inspector-boundary-reached
`,
          ],
          {
            encoding: 'utf8',
            timeout: 3000,
            env: {
              ...process.env,
              PREREQUISITE_STATUS: String(status),
              PREREQUISITE_ROOT: requestRoot,
              PREREQUISITE_HEALTH: JSON.stringify({
                running: true,
                version: predecessor8825.slice(0, 8),
                releaseSha: predecessor8825,
                instanceId: '1-3846b8bb',
                maintenance: {
                  active: true,
                  phase: 'counting_down',
                  durableConfirmed: true,
                  remainingMs: 299000,
                },
              }),
            },
          }
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(status === 0 ? 0 : 1);
        expect(result.stdout).toContain('--mixed-custody-contract');
        expect(result.stdout.includes('inspector-boundary-reached')).toBe(status === 0);
        const intent = join(requestRoot, '35405450271-1.legacy-checkpoint-intent');
        expect(existsSync(intent)).toBe(status === 0);
        if (status === 0) {
          expect(JSON.parse(readFileSync(intent, 'utf8'))).toMatchObject({
            retryAllowed: false,
            source: predecessor8825,
            runId: '35405450271-1',
          });
        }
      } finally {
        rmSync(requestRoot, { recursive: true, force: true });
      }
    }
  );

  it.each([
    [predecessor8825, image8825, 0],
    [predecessor8825, image758, 1],
    [predecessor758, image758, 0],
    [predecessorA0, imageA0, 0],
    [predecessorA0, image758, 1],
    [predecessor758, imageA0, 1],
    [
      '2f4e33560bcd23bfb5cc731f31816b2c2e2847e5',
      'sha256:3796b874331fee7d3b0824472df65e9fe613306a5175d3a211fdf8158bdab852',
      0,
    ],
    [predecessor758, 'sha256:' + 'a'.repeat(64), 1],
    ['a'.repeat(40), image758, 1],
  ])('binds sealed predecessor %s to its exact immutable image', (sha, image, status) => {
    const selection = checkpointShell.slice(
      checkpointShell.indexOf('LEGACY_SHA="$(timeout'),
      checkpointShell.indexOf('\nIDENTITY=')
    );
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
CONTROL_DIR=/unexecuted-fixture
die() { exit 1; }
timeout() { case "\${*: -1}" in desired-sha) printf '%s' "$PROFILE_SHA";; desired-image-id) printf '%s' "$PROFILE_IMAGE";; *) exit 2;; esac; }
${selection}
printf '%s' "$LEGACY_IMAGE"
`,
      ],
      {
        encoding: 'utf8',
        timeout: 3000,
        env: { ...process.env, PROFILE_SHA: sha, PROFILE_IMAGE: image },
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
    if (status === 0) expect(result.stdout).toBe(image);
  });

  it.each([
    predecessor8825,
    predecessor758,
    predecessorA0,
    '2f4e33560bcd23bfb5cc731f31816b2c2e2847e5',
  ])('retains the existing recovery event only for capable predecessor %s', (sha) => {
    const entry = transaction.indexOf(
      '    if ! LEGACY_COUNTDOWN_END=',
      transaction.indexOf('LEGACY_CHECKPOINT_REQUIRED=0')
    );
    const action = transaction.slice(entry, transaction.indexOf('      bounded_sleep 5', entry));
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
CHECKPOINT_PREDECESSOR_SHA="$PROFILE_SHA"
CHECKPOINT_758_SHA=${predecessor758}
CHECKPOINT_A0_SHA=${predecessorA0}
CHECKPOINT_8825_SHA=${predecessor8825}
CERTIFICATE_RC=2
RECOVERY_ADMISSION_MISSED=0
legacy_checkpoint_countdown() { return 1; }
request_recovery_window() { printf 'existing-event:%s' "$RECOVERY_ADMISSION_MISSED"; }
${action}
fi
`,
      ],
      { encoding: 'utf8', timeout: 3000, env: { ...process.env, PROFILE_SHA: sha } }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      [predecessor8825, predecessor758, predecessorA0].includes(sha) ? 'existing-event:1' : ''
    );
  });

  it('passes only the seal-selected closed profile into the native transport', () => {
    expect(checkpointShell).toContain('node --input-type=module - "$INSTANCE" "$LEGACY_SHA"');
    const production = checkpointTransport.slice(
      checkpointTransport.indexOf("if (process.argv[1] === '-'")
    );
    expect(production).toContain('const checkpointRelease = process.argv[3]');
    expect(production).toContain('].includes(checkpointRelease)');
    expect(production).toContain(predecessor758);
    expect(production).toContain(predecessorA0);
    expect(production).toContain('releaseSha: checkpointRelease');
  });
  it.each([false, true])(
    'allows a durable countdown with old ready=%s for checkpoint only',
    (ready) => {
      const result = probe({ readyForRestart: ready });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^[1-9][0-9]*\n$/);
    }
  );

  it('retains the complete degraded-health body for checkpoint admission', () => {
    const result = probe({}, 503);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ['last hand announcement', { phase: 'last_hand' }],
    ['unconfirmed countdown', { durableConfirmed: false }],
    ['inactive maintenance', { active: false }],
    ['short remaining duration', { remainingMs: 284_999 }],
    ['short absolute boundary', { breakEndsAt: Date.now() + 280_000 }],
    ['string duration', { remainingMs: '299000' }],
    ['boolean boundary', { breakEndsAt: true }],
    ['absent boundary', { breakEndsAt: null }],
  ])('refuses %s before any checkpoint operation', (_label, patch) => {
    const result = probe(patch);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('refuses an unrelated HTTP failure', () => {
    expect(probe({}, 500).status).toBe(1);
  });

  it('binds the exception to the exact sealed predecessor after the immutable image build', () => {
    expect(transaction).toContain('LEGACY_CHECKPOINT_SHA=2f4e33560bcd23bfb5cc731f31816b2c2e2847e5');
    const build = transaction.indexOf('"$IMAGE_BUILDER" "$REPO_DIR" "$SHA" "$IMAGE_REF"');
    const predecessor = transaction.indexOf('CHECKPOINT_PREDECESSOR_SHA=', build);
    const bind = transaction.indexOf(
      '[ "$CHECKPOINT_PREDECESSOR_SHA" = "$LEGACY_CHECKPOINT_SHA" ]',
      predecessor
    );
    const wait = transaction.indexOf('\nwhile :; do', bind);
    expect(build).toBeGreaterThan(0);
    expect(predecessor).toBeGreaterThan(build);
    expect(bind).toBeGreaterThan(predecessor);
    expect(wait).toBeGreaterThan(bind);
  });

  it('holds the engine lock and proves the actual predecessor before invoking exactly once', () => {
    const lock = transaction.indexOf("acquire_engine_lock 'maintenance cutover'");
    const freshness = transaction.indexOf('source_target_is_current', lock);
    const entry = transaction.indexOf('legacy_checkpoint_countdown)', freshness);
    const noReplay = transaction.indexOf('[ "$LEGACY_CHECKPOINT_ATTEMPTED" = 0 ]', entry);
    const readiness = transaction.indexOf('prove_rollback_readiness', noReplay);
    const attempted = transaction.indexOf('LEGACY_CHECKPOINT_ATTEMPTED=1', readiness);
    const invoke = transaction.indexOf('"$LEGACY_CHECKPOINT" "$RUN_ID"', attempted);
    expect(lock).toBeGreaterThan(0);
    expect(freshness).toBeGreaterThan(lock);
    expect(entry).toBeGreaterThan(freshness);
    expect(noReplay).toBeGreaterThan(entry);
    expect(readiness).toBeGreaterThan(noReplay);
    expect(attempted).toBeGreaterThan(readiness);
    expect(invoke).toBeGreaterThan(attempted);
    const reclassification = transaction.slice(freshness, entry);
    expect(reclassification).toContain('"$RELEASE_SEAL" get desired-sha');
    expect(reclassification).toContain(
      '[ "$CHECKPOINT_PREDECESSOR_SHA" != "$LEGACY_CHECKPOINT_SHA" ]'
    );
    expect(reclassification).toContain('LEGACY_CHECKPOINT_REQUIRED=0');
    expect(transaction.slice(lock, invoke)).not.toContain('MUTATION_STARTED=1');
    expect(
      sliceBetween(transaction, '"$LEGACY_CHECKPOINT" "$RUN_ID"', '\n    BREAK_END_EPOCH=0')
    ).toContain("die 'legacy checkpoint or cleanup refused; release cannot continue'");
  });

  it('requires the unchanged strict certificate and full reserve after cleanup before prepare', () => {
    const invoke = transaction.indexOf('"$LEGACY_CHECKPOINT" "$RUN_ID"');
    const certificate = transaction.indexOf('maintenance_certificate)', invoke);
    const refusal = transaction.indexOf(
      '[ "$LEGACY_CHECKPOINT_ATTEMPTED" = 1 ] && [ "$CERTIFICATE_RC" -ne 0 ]',
      certificate
    );
    const persist = transaction.indexOf('\n  persist_break_deadline', refusal);
    const prepare = transaction.indexOf('PREPARE_OUTPUT="$(bounded_break_command', persist);
    expect(certificate).toBeGreaterThan(invoke);
    expect(refusal).toBeGreaterThan(certificate);
    expect(persist).toBeGreaterThan(refusal);
    expect(prepare).toBeGreaterThan(persist);
    const strict = transaction.slice(
      transaction.indexOf('maintenance_certificate() {'),
      countdownStart
    );
    for (const predicate of [
      'm.get("readyForRestart") is True',
      'm.get("durableConfirmed") is True',
      'm.get("unparkedTables")==0',
      'remaining<int(__import__("os").environ["MIN_BREAK_MS"])',
    ]) {
      expect(strict).toContain(predicate);
    }
    expect(transaction).toContain('BREAK_CUTOVER_PROOF_SECONDS=150');
    expect(transaction).toContain('BREAK_ROLLBACK_RESERVE_SECONDS=135');
  });

  it('ships all helper bytes in the immutable generation without rejecting old core generations', () => {
    const required = installer.slice(
      installer.indexOf('REQUIRED_FILES=('),
      installer.indexOf('CORE_FILES=(')
    );
    const core = installer.slice(installer.indexOf('CORE_FILES=('), installer.indexOf('\ndie()'));
    for (const file of [
      'legacy-engine-checkpoint.sh',
      'legacy-engine-checkpoint.mjs',
      'legacy-engine-checkpoint-guard.mjs',
    ]) {
      expect(required).toContain(file);
      expect(core).not.toContain(file);
    }
    const shellChecks = installer.slice(
      installer.indexOf('  for script in \\\n'),
      installer.indexOf('  for script in engine-release-seal.py')
    );
    expect(shellChecks).toContain('legacy-engine-checkpoint.sh');
    expect(shellChecks).toContain('bash -n "$GENERATION_STAGE/$script"');
    const stage = read('.github/workflows/stage-engine-release.yml');
    expect(stage).toContain(
      "'server/**' ':(exclude)server/**/*.test.ts' ':(exclude)server/sim/**' ':(exclude)server/qualification/**'"
    );
  });
});

// The production Python entrypoint runs here with an isolated HTTP transport.
// No database call, environment file, inspector or engine process is touched.
function contractPreflight(payload: unknown, failure = '', sha = predecessor8825) {
  return spawnSync(
    'python3',
    [
      '-c',
      `
import contextlib, importlib.util, io, json, os, sys
from urllib.error import HTTPError, URLError
spec=importlib.util.spec_from_file_location('release_proof', 'server/scripts/engine-release-database-proof.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
requests=[]; limits=[]; messages=io.StringIO()
m.read_fixed_env=lambda path: {'SUPABASE_URL':'https://kuklfnapbkmacvwxktbh.supabase.co','SUPABASE_SERVICE_ROLE_KEY':'isolated-secret-must-not-print'}
class Response:
    def __enter__(self): return self
    def __exit__(self,*args): return False
    def read(self,limit):
        limits.append(limit)
        if os.environ['RPC_FAILURE']=='json': return b'{'
        if os.environ['RPC_FAILURE']=='oversize': return b' '*limit
        return os.environ['RPC_PAYLOAD'].encode()
class Transport:
    def open(self,request,timeout):
        requests.append({'url':request.full_url,'method':request.get_method(),'timeout':timeout})
        failure=os.environ['RPC_FAILURE']
        if failure.isdigit(): raise HTTPError(request.full_url,int(failure),'denied',{},None)
        if failure=='timeout': raise TimeoutError('isolated-secret-must-not-print')
        if failure=='network': raise URLError('isolated-secret-must-not-print')
        return Response()
m.build_opener=lambda *handlers: Transport()
m.read_leader=lambda *args: (_ for _ in ()).throw(AssertionError('not the elected-leader mode'))
m.time.sleep=lambda *args: (_ for _ in ()).throw(AssertionError('no retry'))
sys.argv=['engine-release-database-proof.py','--env-file','/unread-fixture','--sha',os.environ['RPC_SHA'],'--mixed-custody-contract']
rc=0
with contextlib.redirect_stdout(messages),contextlib.redirect_stderr(messages):
    try: m.main()
    except SystemExit as e: rc=e.code
print(json.dumps({'exit':rc,'requests':requests,'limits':limits,'messages':messages.getvalue()}))
`,
    ],
    {
      encoding: 'utf8',
      timeout: 3000,
      env: {
        ...process.env,
        RPC_PAYLOAD: JSON.stringify(payload),
        RPC_FAILURE: failure,
        RPC_SHA: sha,
      },
    }
  );
}

describe('installed mixed custody contract prerequisite', () => {
  const qualified = JSON.parse(
    read('tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json')
  );
  const run = (payload: unknown, failure = '', sha = predecessor8825) => {
    const result = contractPreflight(payload, failure, sha);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout);
    expect(outcome.messages).not.toContain('isolated-secret-must-not-print');
    return outcome;
  };

  it('reads the exact qualified service-role catalog once through the pinned read-only RPC', () => {
    const outcome = run(qualified);
    expect(outcome.exit).toBe(0);
    expect(outcome.requests).toEqual([
      {
        url: 'https://kuklfnapbkmacvwxktbh.supabase.co/rest/v1/rpc/fn_f06_mixed_custody_contract',
        method: 'GET',
        timeout: 5,
      },
    ]);
    expect(outcome.limits).toEqual([65537]);
  });

  it.each(['401', '403', '404', '500', 'timeout', 'network', 'json', 'oversize'])(
    'refuses %s without retry or leaking response/credential values',
    (failure) => {
      const outcome = run(qualified, failure);
      expect(outcome.exit).toBe(1);
      expect(outcome.requests).toHaveLength(1);
      expect(outcome.messages).toContain('prerequisite unconfirmed');
      expect(outcome.messages).toContain('checkpoint not started');
    }
  );

  it.each([
    'signature',
    'definition_md5',
    'body_md5',
    'owner',
    'acl',
    'security_definer',
    'config',
    'volatility',
  ])('refuses drift in each function %s', (field) => {
    for (let i = 0; i < qualified.functions.length; i += 1) {
      const drift = structuredClone(qualified);
      drift.functions[i][field] =
        field === 'security_definer' ? Number(drift.functions[i][field]) : null;
      expect(run(drift).exit, `${qualified.functions[i].signature} ${field}`).toBe(1);
    }
  });

  it.each(['missing', 'duplicate', 'empty', 'unknown-kind', 'null'])(
    'refuses a %s catalog',
    (kind) => {
      let drift = structuredClone(qualified);
      if (kind === 'missing') drift.functions.pop();
      if (kind === 'duplicate') drift.functions.push(drift.functions[0]);
      if (kind === 'empty') drift.functions = [];
      if (kind === 'unknown-kind') drift.kind = 'unqualified';
      if (kind === 'null') drift = null;
      expect(run(drift).exit).toBe(1);
    }
  );

  it('refuses an unrelated predecessor before contacting the database', () => {
    const outcome = run(qualified, '', predecessor758);
    expect(outcome.exit).toBe(1);
    expect(outcome.requests).toEqual([]);
  });
});
