/**
 * A DEPLOY THAT PROVES ITSELF (2026-09-05).
 *
 * A deploy run reported success and shipped nothing: the container came back
 * on the OLD image and /health.version never changed. Every check the
 * workflow had compared what the engine SAID over HTTP against the target;
 * none remembered what was running BEFORE, and none asked the database what
 * the engine WROTE about itself. These pins keep the two halves of the fix
 * wired to each other and behaving.
 */
import { describe, expect, it, afterAll, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';

const root = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const WF = read('.github/workflows/auto-deploy-hetzner.yml');
const SCRIPT = resolve(root, 'scripts/ci/prove-engine-version-moved.mjs');

const workflowStep = (name: string): string => {
  const start = WF.indexOf(`- name: ${name}`);
  if (start < 0) throw new Error(`workflow step not found: ${name}`);
  const end = WF.indexOf('\n      - name: ', start + 1);
  return end < 0 ? WF.slice(start) : WF.slice(start, end);
};

const workflowRunBody = (name: string): string => {
  const step = workflowStep(name);
  const marker = '        run: |\n';
  const start = step.indexOf(marker);
  if (start < 0) throw new Error(`workflow run body not found: ${name}`);
  return step.slice(start + marker.length).replace(/^ {10}/gm, '');
};

const EXACT_AUTHORITY_PY = (() => {
  const stepStart = WF.indexOf(
    'name: Reconcile an already-serving target from exact database and host truth'
  );
  const stepEnd = WF.indexOf('- name:', stepStart + 10);
  const step = WF.slice(stepStart, stepEnd);
  const marker = `printf '%s' "$inventory" | python3 -c '\n`;
  const start = step.indexOf(marker) + marker.length;
  const end = step.indexOf(`\n          ' "$CONTAINER" "$EXPECTED_IMAGE_ID" "$PORT"`, start);
  if (start < marker.length || end < start) throw new Error('exact authority Python not found');
  return step.slice(start, end).replace(/^ {10}/gm, '');
})();

type DockerInspectRow = {
  Id: string;
  Name: string;
  Image: string;
  Config: { Labels: Record<string, string> };
  State: { Status: string; StartedAt: string };
  HostConfig: {
    RestartPolicy: { Name: string };
    PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  };
};

const exactEngineRow = (): DockerInspectRow => ({
  Id: 'container-id',
  Name: '/club-arena-engine',
  Image: 'sha256:target',
  Config: { Labels: { 'sp.role': 'engine', autoheal: 'true' } },
  State: { Status: 'running', StartedAt: '2026-09-09T18:00:00.000000000Z' },
  HostConfig: {
    RestartPolicy: { Name: 'always' },
    PortBindings: { '8080/tcp': [{ HostIp: '', HostPort: '8080' }] },
  },
});

const runExactAuthorityValidator = (rows: DockerInspectRow[]) =>
  spawnSync('python3', ['-c', EXACT_AUTHORITY_PY, 'club-arena-engine', 'sha256:target', '8080'], {
    input: JSON.stringify(rows),
    encoding: 'utf8',
  });

describe('the workflow records before and proves after', () => {
  it('resolves every requested ref to one immutable lowercase full commit before using it', () => {
    const checkout = WF.indexOf('name: Checkout the requested deployment ref');
    const target = WF.indexOf('name: Resolve the deployment target to one immutable commit');
    const record = WF.indexOf('name: Record the version production runs before the cutover');
    expect(checkout).toBeGreaterThan(-1);
    expect(target).toBeGreaterThan(checkout);
    expect(target).toBeLessThan(record);

    const block = WF.slice(target, WF.indexOf('- name:', target + 10));
    expect(block).toContain('id: target');
    expect(block).toContain("git rev-parse --verify 'HEAD^{commit}'");
    expect(block).toContain('^[0-9a-f]{40}$');
    expect(block).toContain('echo "SHA=$RESOLVED_SHA" >> "$GITHUB_ENV"');
    expect(block).toContain('echo "sha=$RESOLVED_SHA" >> "$GITHUB_OUTPUT"');

    expect(WF.match(/github\.event\.inputs\.ref_sha\s*\|\|\s*github\.sha/g) ?? []).toHaveLength(1);
    expect(WF.match(/TARGET_SHA: \$\{\{ steps\.target\.outputs\.sha \}\}/g) ?? []).toHaveLength(4);
    expect(WF).not.toMatch(/^\s+SHA:\s*\$\{\{/m);
  });

  it('records the pre-cutover version at the START of the job, best-effort', () => {
    const at = WF.indexOf('name: Record the version production runs before the cutover');
    expect(at).toBeGreaterThan(-1);
    expect(at, 'recorded before the dedupe decides anything').toBeLessThan(
      WF.indexOf('name: Skip if production already serves this commit')
    );
    const block = WF.slice(at, WF.indexOf('- name:', at + 10));
    expect(block).toContain('continue-on-error: true');
    expect(block).toContain('MODE: record');
    expect(block).toContain('node scripts/ci/prove-engine-version-moved.mjs');
  });

  it('dedupes only from exact database and host truth, repairing a stale current pointer without a restart', () => {
    const coarseStart = WF.indexOf('name: Skip if production already serves this commit');
    const exactStart = WF.indexOf(
      'name: Reconcile an already-serving target from exact database and host truth'
    );
    const exactEnd = WF.indexOf('- name:', exactStart + 10);
    const coarse = WF.slice(coarseStart, exactStart);
    const exact = WF.slice(exactStart, exactEnd);

    expect(WF.indexOf('name: Setup SSH key')).toBeLessThan(coarseStart);
    expect(coarse).toContain('public_match=true');
    const publicMatchBranch = coarse.slice(
      coarse.indexOf('if [ -n "$VER" ]'),
      coarse.indexOf('# 2026-08-24: RESTART COALESCING')
    );
    expect(publicMatchBranch).not.toContain('skip=true');
    expect(publicMatchBranch).not.toContain('exit 0');
    expect(exact).toContain('MODE: match');
    expect(exact).toContain('node scripts/ci/prove-engine-version-moved.mjs');
    expect(exact).toContain('flock -w 30 9');
    expect(exact).toContain('[ "$PORT" = "8080" ]');
    expect(exact).toContain('docker image inspect -f \'{{.Id}}\' "$TARGET_IMAGE"');
    expect(exact).toContain('docker ps -aq');
    expect(exact).toContain('docker container inspect $ids');
    expect(exact).toContain('labels(row).get("sp.role") == "engine"');
    expect(exact).toContain('labels(row).get("autoheal") != "true"');
    expect(exact).toContain('restart.get("Name") != "always"');
    expect(exact).toContain('exact_binding = {"8080/tcp": [{"HostIp": "", "HostPort": port}]}');
    expect(exact).toContain('[name(row) for row in named] != [container]');
    expect(exact).toContain('[name(row) for row in labelled] != [container]');
    expect(exact).toContain('[name(row) for row in publishers] != [container]');
    expect(exact).toContain("curl -q -sf --noproxy '*'");
    expect(exact).toContain('FINGERPRINT_AFTER="$(validate_all_state_identity)"');
    expect(exact).toContain('[ "$FINGERPRINT_AFTER" = "$FINGERPRINT_BEFORE" ]');
    expect(exact).toContain('docker tag "$EXPECTED_IMAGE_ID" "$CURRENT_IMAGE"');
    expect(exact).toContain('"$(validate_all_state_identity)" = "$FINGERPRINT_BEFORE"');
    expect(exact).toMatch(/case "\$HOST_RESULT"[\s\S]*?exact\)[\s\S]*?skip=true/);
    expect(exact).toMatch(/repaired\)[\s\S]*?skip=true/);

    const serverTests = WF.slice(
      WF.indexOf('name: Server tests must pass before anything is deployed'),
      WF.indexOf(
        '- name:',
        WF.indexOf('name: Server tests must pass before anything is deployed') + 10
      )
    );
    expect(serverTests).toContain("steps.exact_dedupe.outputs.skip != 'true'");
  });

  it('executes the dedupe authority validator and rejects every incomplete run spec or rogue all-state authority', () => {
    const valid = runExactAuthorityValidator([exactEngineRow()]);
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stdout.trim()).toBe('container-id|2026-09-09T18:00:00.000000000Z|sha256:target');

    const mutations: Array<(rows: DockerInspectRow[]) => void> = [
      (rows) => {
        rows[0].Config.Labels.autoheal = 'false';
      },
      (rows) => {
        rows[0].HostConfig.RestartPolicy.Name = 'unless-stopped';
      },
      (rows) => {
        rows[0].HostConfig.PortBindings['9090/tcp'] = [{ HostIp: '', HostPort: '9090' }];
      },
      (rows) => {
        rows[0].HostConfig.PortBindings['8080/tcp'][0].HostIp = '127.0.0.1';
      },
      (rows) => {
        rows[0].Image = 'sha256:rollback';
      },
      (rows) => {
        const rogue = exactEngineRow();
        rogue.Id = 'rogue-labelled';
        rogue.Name = '/rogue-labelled';
        rogue.State.Status = 'exited';
        rogue.HostConfig.PortBindings = {};
        rows.push(rogue);
      },
      (rows) => {
        const rogue = exactEngineRow();
        rogue.Id = 'rogue-publisher';
        rogue.Name = '/rogue-publisher';
        rogue.State.Status = 'exited';
        rogue.Config.Labels = {};
        rows.push(rogue);
      },
    ];

    for (const mutate of mutations) {
      const rows = [exactEngineRow()];
      mutate(rows);
      const rejected = runExactAuthorityValidator(rows);
      expect(rejected.status).toBe(1);
      expect(rejected.stdout).toBe('');
    }
  });

  it('re-proves after the lock-held promotion and confirms the committed pointer before release truth', () => {
    const prove = WF.indexOf("name: 'PROVE the version moved");
    const promote = WF.indexOf('name: Confirm the lock-held transaction promoted :current');
    expect(prove).toBeGreaterThan(-1);
    expect(prove).toBeGreaterThan(WF.indexOf('name: Verify — liveness'));
    expect(prove).toBeLessThan(promote);
    expect(prove).toBeLessThan(WF.indexOf('name: ROLLBACK'));
    const block = WF.slice(prove, WF.indexOf('- name:', prove + 10));
    expect(block).toContain('id: prove');
    expect(block).toContain('MODE: prove');
    expect(block).toMatch(/TIMEOUT_S: '240'/);
    expect(block, 'only a performed, HTTP-verified cutover may ask for DB proof').toContain(
      "if: steps.cutover.outputs.performed == 'true' && steps.health.outputs.verified == 'true'"
    );
    expect(block, 'no continue-on-error: a failed proof is a failed deploy').not.toContain(
      'continue-on-error'
    );

    const promotion = WF.slice(promote, WF.indexOf('- name:', promote + 10));
    expect(promotion).toContain("steps.cutover.outputs.performed == 'true'");
    expect(promotion).toContain("steps.health.outputs.verified == 'true'");
    expect(promotion).toContain("steps.prove.outcome == 'success'");
    expect(promotion).not.toContain('docker tag $IMAGE_REPO:$SHA $IMAGE_REPO:current');
    expect(promotion).toContain('CURRENT_ID="$(docker image inspect');
    expect(promotion).toContain('[ "$RESTART" = always ]');

    const cutover = WF.slice(
      WF.indexOf('name: Cut over to the new image'),
      WF.indexOf('name: Verify — liveness')
    );
    expect(cutover).toContain('PROMOTE_IMAGE_TO=$IMAGE_REPO:current');
    expect(cutover).toContain('REQUIRED_DATABASE_VERSION=${SHA:0:8}');
  });

  it('the database is told a deploy shipped only after cutover, proof, promotion, and the final guarantee', () => {
    const shipped = WF.match(/SHIPPED: \$\{\{ ([^\n]+) \}\}/)?.[1] ?? '';
    expect(shipped).toContain("steps.cutover.outcome == 'success'");
    expect(shipped).toContain("steps.cutover.outputs.performed == 'true'");
    expect(shipped).toContain("steps.health.outputs.verified == 'true'");
    expect(shipped).toContain("steps.prove.outcome == 'success'");
    expect(shipped).toContain("steps.promote.outcome == 'success'");
    expect(shipped).toContain("steps.guarantee.outcome == 'success'");
    expect(shipped).not.toContain("!= 'failure'");
    expect(shipped).not.toContain("!= 'cancelled'");
    expect(shipped).not.toContain("!= 'skipped'");
    expect(WF).toContain("steps.prove.outcome == 'failure' &&");
    expect(workflowStep('GUARANTEE the engine is running, with the right run-spec')).toContain(
      'id: guarantee'
    );
  });

  it('late health or database-proof failure first proves an already-restored rollback target without interrupting it', () => {
    const rollback = WF.slice(WF.indexOf('- name: ROLLBACK'), WF.indexOf('- name: GUARANTEE'));
    expect(rollback).toContain(
      "if: failure() && steps.pre.outcome == 'success' && steps.cutover.outputs.mutation_started == 'true'"
    );
    expect(rollback).toContain('/engine-supervisor.sh');
    expect(rollback).toContain('RECOVER_IF_NOT_RUNNING=1 ENSURE_RUNNING_ONLY=1');
    expect(rollback.indexOf('/engine-supervisor.sh')).toBeLessThan(
      rollback.indexOf('ENSURE_RUNNING_ONLY=1')
    );
    expect(rollback.match(/engine-up-with-maintenance-certificate\.sh/g) ?? []).toHaveLength(2);
    expect(rollback).toContain('PROMOTE_IMAGE_TO=$IMAGE_REPO:current');
    expect(rollback).toContain('PUBLIC_HEALTH_URL=$ENGINE_URL/health');
    expect(rollback).toContain('REQUIRED_DATABASE_VERSION=$ROLLBACK_VERSION');
    expect(rollback).not.toMatch(/^\s*~\/hssh "docker tag .*:previous .*:current"/m);
    expect(rollback).toContain('ROLLBACK DEFERRED');
    expect(rollback).toMatch(
      /if \[ "\$ROLLBACK_STATUS" = "75" \]; then[\s\S]*?left untouched[\s\S]*?exit 0/
    );
    expect(
      rollback
        .split('\n')
        .filter((line) => !/^\s*#/.test(line) && line.includes('/engine-up.sh'))
        .every((line) => line.includes('ENGINE_UP_SCRIPT='))
    ).toBe(true);
  });

  it('executes supervisor reconciliation before the final exact-state guarantee', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'deploy-guarantee-'));
    const order = resolve(fixture, 'order');
    const reconciled = resolve(fixture, 'reconciled');
    mkdirSync(fixture, { recursive: true });
    writeFileSync(
      resolve(fixture, 'hssh'),
      `#!/bin/sh
printf '%s\n' "$*" >> "$ORDER_FILE"
case "$*" in
  *engine-supervisor.sh*) : > "$RECONCILED_FILE"; exit 0 ;;
  *engine-up-with-maintenance-certificate.sh*) [ -f "$RECONCILED_FILE" ] || exit 91; exit 0 ;;
  *) exit 92 ;;
esac
`,
      { mode: 0o755 }
    );

    try {
      const result = spawnSync(
        'bash',
        [
          '-e',
          '-o',
          'pipefail',
          '-c',
          workflowRunBody('GUARANTEE the engine is running, with the right run-spec'),
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: fixture,
            ORDER_FILE: order,
            RECONCILED_FILE: reconciled,
            REPO_DIR: '/opt/club-arena',
            IMAGE_REPO: 'club-arena-engine',
            CONTAINER: 'club-arena-engine',
          },
        }
      );
      expect(result.status, result.stderr).toBe(0);
      const calls = readFileSync(order, 'utf8').trim().split('\n');
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('/engine-supervisor.sh');
      expect(calls[1]).toContain('ENSURE_RUNNING_ONLY=1');
      expect(calls[1]).toContain('/engine-up-with-maintenance-certificate.sh');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('runs recovery only after the host attests mutation, never after refusal or transport failure', () => {
    const guarantee = workflowStep('GUARANTEE the engine is running, with the right run-spec');
    const cutover = workflowStep('Cut over to the new image');
    expect(guarantee).toContain(
      "if: always() && steps.cutover.outcome != 'skipped' && steps.cutover.outputs.mutation_started == 'true'"
    );
    expect(cutover.indexOf('echo "mutation_started=false"')).toBeLessThan(
      cutover.indexOf('~/hssh "IMAGE=')
    );
    expect(cutover).toMatch(/if \[ "\$CUTOVER_STATUS" = "75" \]; then[\s\S]*?exit 0/);
    expect(cutover).toMatch(
      /if \[ "\$CUTOVER_STATUS" = "76" \]; then[\s\S]*?echo "mutation_started=true"[\s\S]*?exit "\$CUTOVER_STATUS"/
    );
    expect(cutover).toMatch(
      /if \[ "\$CUTOVER_STATUS" != "0" \]; then[\s\S]*?DID NOT ATTEST MUTATION[\s\S]*?exit "\$CUTOVER_STATUS"/
    );
    expect(
      cutover.indexOf(
        'echo "mutation_started=true"',
        cutover.indexOf('if [ "$CUTOVER_STATUS" = "76"')
      )
    ).toBeGreaterThan(cutover.indexOf('~/hssh "IMAGE='));

    const fixture = mkdtempSync(resolve(tmpdir(), 'deploy-cutover-state-'));
    const output = resolve(fixture, 'github-output');
    writeFileSync(
      resolve(fixture, 'hssh'),
      `#!/bin/sh
case "$*" in
  *engine-up-with-maintenance-certificate.sh*) exit "$CUTOVER_STATUS" ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 }
    );
    const run = (cutoverStatus: string) => {
      writeFileSync(output, '');
      const result = spawnSync(
        'bash',
        ['-e', '-o', 'pipefail', '-c', workflowRunBody('Cut over to the new image')],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: fixture,
            GITHUB_OUTPUT: output,
            CUTOVER_STATUS: cutoverStatus,
            IMAGE_REPO: 'club-arena-engine',
            SHA: '0123456789abcdef0123456789abcdef01234567',
            CONTAINER: 'club-arena-engine',
            REPO_DIR: '/opt/club-arena',
            ENGINE_URL: 'https://engine.example.invalid',
          },
        }
      );
      const state = Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('=', 2))
      );
      return { result, state };
    };

    try {
      const refused = run('75');
      expect(refused.result.status).toBe(0);
      expect(refused.state.mutation_started).toBe('false');
      expect(refused.state.performed).toBe('false');

      const mutatedFailure = run('76');
      expect(mutatedFailure.result.status).toBe(76);
      expect(mutatedFailure.state.mutation_started).toBe('true');
      expect(mutatedFailure.state.performed).toBe('false');

      const transportFailure = run('255');
      expect(transportFailure.result.status).toBe(255);
      expect(transportFailure.state.mutation_started).toBe('false');
      expect(transportFailure.state.performed).toBe('false');

      const completed = run('0');
      expect(completed.result.status).toBe(0);
      expect(completed.state.mutation_started).toBe('true');
      expect(completed.state.performed).toBe('true');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('the job budget grew by the proof, in both places the number lives', () => {
    const timeout = Number(WF.match(/timeout-minutes: (\d+)/)![1]);
    const jobTimeout = Number(WF.match(/JOB_TIMEOUT_S=\$\(\( (\d+) \* 60 \)\)/)![1]);
    expect(jobTimeout, 'the gate must know the real timeout').toBe(timeout);
    const reserve = Number(WF.match(/CUTOVER_RESERVE_S=(\d+)/)![1]);
    expect(reserve, 'reserve covers cutover + verify + a 4-minute proof').toBeGreaterThanOrEqual(
      300 + 240
    );
  });
});

describe('prove-engine-version-moved.mjs', () => {
  let server: Server;
  let port = 0;
  let healthVersion = 'deadbeef';
  let leaderVersion: string | null = 'deadbeef';
  let leaderHeartbeatAgeS = 0;
  let leaderReadable = true;
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/rest/v1/engine_leader')) {
        if (!leaderReadable) {
          res.statusCode = 503;
          res.end(JSON.stringify({ message: 'database unavailable' }));
          return;
        }
        res.end(
          JSON.stringify(
            leaderVersion === null
              ? []
              : [
                  {
                    engine_version: leaderVersion,
                    heartbeat_at: new Date(Date.now() - leaderHeartbeatAgeS * 1000).toISOString(),
                  },
                ]
          )
        );
        return;
      }
      res.end(JSON.stringify({ version: healthVersion, running: true }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());
  beforeEach(() => {
    healthVersion = 'deadbeef';
    leaderVersion = 'deadbeef';
    leaderHeartbeatAgeS = 0;
    leaderReadable = true;
  });

  // spawn, not spawnSync: the stub server lives on THIS event loop, and a
  // synchronous child would block it, so every fetch would hang for 15 s.
  const run = (env: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [SCRIPT], {
        env: {
          PATH: process.env.PATH ?? '',
          ENGINE_URL: `http://127.0.0.1:${port}`,
          SUPABASE_URL: `http://127.0.0.1:${port}`,
          SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
          POLL_S: '1',
          TIMEOUT_S: '1',
          ...env,
        },
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stdout += d.toString()));
      child.on('close', (status) => resolve({ status, stdout }));
    });

  it('record: reads the running version and never fails', async () => {
    leaderVersion = 'deadbeef';
    const r = await run({ MODE: 'record' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('pre-cutover engine version: deadbeef');
  });

  it('prove: FAILS when the version still equals the pre-cutover version', async () => {
    leaderVersion = 'deadbeef';
    const r = await run({
      MODE: 'prove',
      TARGET_SHA: '0123456789abcdef0123456789abcdef01234567',
      PRE_CUTOVER_VERSION: 'deadbeef',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error title=DEPLOY SHIPPED NOTHING::');
    expect(r.stdout).toContain('did not move');
  });

  it('prove: FAILS when a third build is answering', async () => {
    leaderVersion = 'feedface';
    const r = await run({
      MODE: 'prove',
      TARGET_SHA: '0123456789abcdef0123456789abcdef01234567',
      PRE_CUTOVER_VERSION: 'deadbeef',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('database leader reported feedface');
  });

  it('prove: passes only when the fresh database leader reports the target', async () => {
    leaderVersion = '01234567';
    const r = await run({
      MODE: 'prove',
      TARGET_SHA: '0123456789abcdef0123456789abcdef01234567',
      PRE_CUTOVER_VERSION: 'deadbeef',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PROVED');
  });

  it('match: permits dedupe only for the fresh exact database leader', async () => {
    leaderVersion = '01234567';
    const r = await run({
      MODE: 'match',
      TARGET_SHA: '0123456789abcdef0123456789abcdef01234567',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('MATCHED: fresh engine_leader reports 01234567');
  });

  it('match: fails closed without paging when the leader receipt is stale', async () => {
    leaderVersion = '01234567';
    leaderHeartbeatAgeS = 120;
    healthVersion = '01234567';
    const r = await run({
      MODE: 'match',
      TARGET_SHA: '0123456789abcdef0123456789abcdef01234567',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('NOT MATCHED');
    expect(r.stdout).not.toContain('DEPLOY SHIPPED NOTHING');
  });

  it('prove: fails closed when the database witness is unreadable even if HTTP has the target', async () => {
    leaderReadable = false;
    healthVersion = '01234567';
    const r = await run({
      MODE: 'prove',
      TARGET_SHA: '0123456789abcdef0123456789abcdef01234567',
      PRE_CUTOVER_VERSION: 'deadbeef',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('database leader witness was unreadable');
    expect(r.stdout).toContain('/health reported 01234567 (diagnostic only)');
  });

  it('prove: rejects a stale target heartbeat even when both witnesses name the target', async () => {
    leaderVersion = '01234567';
    leaderHeartbeatAgeS = 120;
    healthVersion = '01234567';
    const r = await run({
      MODE: 'prove',
      TARGET_SHA: '0123456789abcdef0123456789abcdef01234567',
      PRE_CUTOVER_VERSION: 'deadbeef',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('stale or invalid heartbeat');
  });

  it('prove: rejects a target that is not one lowercase full commit SHA', async () => {
    leaderVersion = '01234567';
    const r = await run({ MODE: 'prove', TARGET_SHA: '0123456789abcdef' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('immutable lowercase 40-hex commit');
  });

  it('prefers the engine_leader witness and says which one spoke', () => {
    const src = read('scripts/ci/prove-engine-version-moved.mjs');
    expect(src).toContain('FROM public.engine_leader WHERE id = true');
    expect(src).toContain('/rest/v1/engine_leader?select=engine_version,heartbeat_at');
    expect(src, 'a stale leader row is not proof').toContain('leader.heartbeatAgeS <= 60');
    expect(src, 'HTTP is diagnostic and busts the cache').toContain('/health?nocache=');
    expect(src).toContain('diagnostic only; want ${TARGET}');
    expect(src).toContain('database leader witness was unreadable');
    expect(src, 'raises the in-app notification publish-watchdog raises').toContain(
      '/rest/v1/rpc/fn_raise_notification'
    );
    expect(src).toContain('ca_incident_recipients?scope=eq.platform&active=eq.true');
  });
});
