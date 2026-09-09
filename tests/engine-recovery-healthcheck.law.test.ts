/**
 * ENGINE RECOVERY MUST NOT TURN LOAD INTO AN OUTAGE.
 *
 * The engine runs hundreds of tables on one Node event loop. During the
 * 2026-09-07 incident, a five-second /health deadline expired under CPU
 * saturation, Docker marked the still-progressing process unhealthy, and
 * autoheal restarted every WebSocket connection. Its AUTOHEAL_START_PERIOD
 * was assumed to protect each reboot, but the sidecar implements it as one
 * sleep when the sidecar itself starts. Docker's health configuration is
 * recreated for every engine restart, and the probe itself must enforce the
 * full grace because Docker ends start-period after an early success.
 *
 * These tests pin the agreement between the image, the canonical docker-run
 * script, the independent host supervisor and the recovery verifier. They also
 * pin the log redaction which keeps WebSocket bearer material out of Caddy's
 * upstream-error records.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const dockerfile = read('server/Dockerfile');
const engineUp = read('server/scripts/engine-up.sh');
const supervisor = read('server/scripts/engine-supervisor.sh');
const supervisorInstaller = read('server/scripts/install-engine-supervisor.sh');
const verifier = read('server/scripts/verify-recovery-stack.sh');
const autoheal = read('infra/monitoring/autoheal-compose.yml');
const caddyfiles = [read('server/Caddyfile'), read('infra/monitoring/engine-01/Caddyfile')];

const seconds = (source: string, pattern: RegExp, label: string): number => {
  const match = source.match(pattern);
  expect(match, `${label} is missing`).toBeTruthy();
  return Number(match![1]);
};

describe('health verdicts tolerate load but still recover a sustained wedge', () => {
  const imageTimeout = seconds(dockerfile, /--timeout=(\d+)s/, 'image health timeout');
  const imageStartPeriod = seconds(
    dockerfile,
    /--start-period=(\d+)s/,
    'image health start-period'
  );
  const runTimeout = seconds(
    engineUp,
    /HEALTH_TIMEOUT="\$\{HEALTH_TIMEOUT:-(\d+)s\}"/,
    'run-spec health timeout'
  );
  const runStartPeriod = seconds(
    engineUp,
    /HEALTH_START_PERIOD="\$\{HEALTH_START_PERIOD:-(\d+)s\}"/,
    'run-spec health start-period'
  );
  const supervisorTimeout = seconds(
    supervisor,
    /HEALTH_TIMEOUT_SEC="\$\{HEALTH_TIMEOUT_SEC:-(\d+)\}"/,
    'supervisor health timeout'
  );
  const supervisorGrace = seconds(
    supervisor,
    /BOOT_GRACE_SEC="\$\{BOOT_GRACE_SEC:-(\d+)\}"/,
    'supervisor boot grace'
  );

  it('allows at least 15 seconds for a probe to reach a saturated event loop', () => {
    expect(imageTimeout).toBeGreaterThanOrEqual(15);
    expect(runTimeout).toBe(imageTimeout);
    expect(supervisorTimeout).toBeGreaterThanOrEqual(imageTimeout);
    expect(engineUp).toMatch(/--health-timeout="\$HEALTH_TIMEOUT"/);
    expect(supervisor).toMatch(/curl -sS --max-time "\$HEALTH_TIMEOUT_SEC"/);
  });

  it('gives every restarted engine at least five minutes to cold boot', () => {
    expect(imageStartPeriod).toBeGreaterThanOrEqual(300);
    expect(runStartPeriod).toBe(imageStartPeriod);
    expect(supervisorGrace).toBeGreaterThanOrEqual(imageStartPeriod);
    expect(engineUp).toMatch(/--health-start-period="\$HEALTH_START_PERIOD"/);
    // Docker ends start-period after an early successful check. The command
    // must independently suppress failures for PID 1's full first 300 seconds.
    for (const source of [dockerfile, engineUp]) {
      expect(source).toContain('/proc/1/stat');
      expect(source).toContain('/proc/uptime');
      expect(source).toContain('if(a<300)process.exit(0)');
      expect(source).toContain("j.running===true&&(l==='ok'||l==='standby')?0:1");
      expect(source).not.toContain("j.liveness!=='dead'");
    }
  });

  it('keeps bounded detection after the boot grace', () => {
    const interval = seconds(
      engineUp,
      /HEALTH_INTERVAL="\$\{HEALTH_INTERVAL:-(\d+)s\}"/,
      'health interval'
    );
    const retries = seconds(
      engineUp,
      /HEALTH_RETRIES="\$\{HEALTH_RETRIES:-(\d+)\}"/,
      'health retries'
    );
    expect(interval * retries).toBeLessThanOrEqual(60);
    expect(retries).toBeGreaterThanOrEqual(3);
    expect(engineUp).toMatch(/--health-interval="\$HEALTH_INTERVAL"/);
    expect(engineUp).toMatch(/--health-retries="\$HEALTH_RETRIES"/);
  });

  it('makes runtime verification fail if either safety floor drifts', () => {
    expect(verifier).toMatch(/MIN_HEALTH_TIMEOUT_NS="\$\{MIN_HEALTH_TIMEOUT_NS:-15000000000\}"/);
    expect(verifier).toMatch(
      /MIN_HEALTH_START_PERIOD_NS="\$\{MIN_HEALTH_START_PERIOD_NS:-300000000000\}"/
    );
    expect(verifier).toContain('{{json .Config.Healthcheck.Timeout}}');
    expect(verifier).toContain('{{json .Config.Healthcheck.StartPeriod}}');
    expect(verifier).toMatch(/HC_TEST=.*\.Config\.Healthcheck\.Test/);
    expect(verifier).toContain("grep -Fq 'if(a<300)'");
    expect(verifier).toContain(`grep -Fq "l==='ok'||l==='standby'"`);
  });

  it('does not misdescribe the sidecar one-time delay as restart grace', () => {
    expect(autoheal).toMatch(/sleeps once when the SIDECAR starts/);
    expect(autoheal).toMatch(/not a per-engine\s+# restart grace/);
    expect(autoheal).not.toMatch(/AUTOHEAL_START_PERIOD:.*after a restart/);
  });

  it('keeps a deliberate standby alive but restarts a semantic dead verdict', () => {
    expect(supervisor).toMatch(/curl -sS --max-time "\$HEALTH_TIMEOUT_SEC"/);
    expect(supervisor).not.toMatch(/curl -sf --max-time "\$HEALTH_TIMEOUT_SEC"/);
    expect(supervisor).toContain(`grep -q '"running":true'`);
    expect(supervisor).toContain(`grep -q '"liveness":"ok"'`);
    expect(supervisor).toContain(`grep -q '"liveness":"standby"'`);
    expect(supervisor).not.toContain(`! echo "$BODY" | grep -q '"liveness":"dead"'`);
    expect(supervisor).toContain('health reported liveness=dead');
  });
});

describe('Caddy never records the WebSocket credential carrier', () => {
  for (const [index, caddyfile] of caddyfiles.entries()) {
    it(`globally deletes Sec-Websocket-Protocol in Caddy config ${index + 1}`, () => {
      expect(caddyfile).toMatch(
        /log\s*\{\s*format filter\s*\{\s*request>headers>Sec-Websocket-Protocol delete/s
      );
      expect(caddyfile).not.toMatch(/Sec-Websocket-Protocol replace/);
    });
  }
});

describe('the supervisor never revives an uncommitted environment transaction', () => {
  it('uses restart policy as the durable pending-versus-committed transaction bit', () => {
    expect(engineUp).toContain('ENGINE_UP_RESTART_POLICY="${ENGINE_UP_RESTART_POLICY:-always}"');
    expect(engineUp).toMatch(/case "\$ENGINE_UP_RESTART_POLICY" in[\s\S]*?always \| no/);
    expect(engineUp).toContain('--restart "$ENGINE_UP_RESTART_POLICY"');
  });

  it('reconciles a killed pending target before its health start-period can trigger autoheal', () => {
    const startPeriod = seconds(
      engineUp,
      /HEALTH_START_PERIOD="\$\{HEALTH_START_PERIOD:-(\d+)s\}"/,
      'pending target health start-period'
    );
    const onBoot = seconds(supervisorInstaller, /OnBootSec=(\d+)s/, 'supervisor boot delay');
    const interval = seconds(supervisorInstaller, /OnUnitActiveSec=(\d+)s/, 'supervisor interval');
    expect(onBoot).toBeLessThan(startPeriod);
    expect(interval).toBeLessThan(startPeriod);
  });

  for (const state of ['running', 'created', 'exited', 'paused'] as const) {
    it(`recreates a ${state} restart=no candidate from canonical env without resuming it`, () => {
      const fixture = mkdtempSync(join(tmpdir(), 'supervisor-env-transaction-'));
      const bin = join(fixture, 'bin');
      const order = join(fixture, 'order');
      const canonicalEnv = join(fixture, 'canonical.env');
      const engineUp = join(fixture, 'engine-up');
      mkdirSync(bin);
      mkdirSync(join(fixture, 'state'));
      mkdirSync(join(fixture, 'metrics'));
      writeFileSync(canonicalEnv, 'FEATURE_FLAG=canonical\n', { mode: 0o600 });
      writeFileSync(join(bin, 'flock'), '#!/bin/sh\n[ -e /dev/fd/9 ]\n', { mode: 0o755 });
      writeFileSync(
        join(bin, 'docker'),
        `#!/bin/sh
echo "$*" >> "$ORDER_FILE"
case "$1:$2" in
  info:) exit 0 ;;
  container:inspect)
    case "$*" in
      *State.Status*) printf '%s\n' "$CONTAINER_STATE" ;;
      *RestartPolicy.Name*) printf '%s\n' no ;;
    esac
    exit 0
    ;;
  *) exit 0 ;;
esac
`,
        { mode: 0o755 }
      );
      writeFileSync(
        engineUp,
        `#!/bin/sh
[ "$ENGINE_UP_LOCK_HELD" = 1 ] || exit 91
[ -e /dev/fd/9 ] || exit 92
printf 'engine-up|%s|%s\n' "$ENV_FILE" "$ENGINE_UP_RESTART_POLICY" >> "$ORDER_FILE"
`,
        { mode: 0o755 }
      );

      try {
        const result = spawnSync(
          'bash',
          [resolve(process.cwd(), 'server/scripts/engine-supervisor.sh')],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH ?? ''}`,
              ORDER_FILE: order,
              CONTAINER_STATE: state,
              UP_SCRIPT: engineUp,
              CANONICAL_ENV_FILE: canonicalEnv,
              LOCK_FILE: join(fixture, 'engine.lock'),
              STATE_DIR: join(fixture, 'state'),
              TEXTFILE_DIR: join(fixture, 'metrics'),
            },
          }
        );
        expect(result.status, result.stderr).toBe(0);
        const actions = readFileSync(order, 'utf8').trim().split('\n');
        expect(actions).toContain('engine-up|/opt/club-arena/server/.env|always');
        expect(actions.some((action) => /^start\b/.test(action))).toBe(false);
        expect(actions.some((action) => /^unpause\b/.test(action))).toBe(false);
        expect(result.stdout).toContain('uncommitted/non-canonical restart policy');
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });
  }

  it('checks restart policy before every start, unpause, or boot-grace branch', () => {
    const policy = supervisor.indexOf('RESTART_POLICY=$(docker container inspect');
    expect(policy).toBeGreaterThan(-1);
    expect(policy).toBeLessThan(supervisor.indexOf('case "$STATUS" in'));
    expect(policy).toBeLessThan(supervisor.indexOf('docker unpause "$CONTAINER"'));
    expect(policy).toBeLessThan(supervisor.indexOf('docker start "$CONTAINER"'));
    expect(policy).toBeLessThan(supervisor.indexOf('STARTED_AT=$(docker container inspect'));
    expect(supervisor).toContain('ENV_FILE="$CANONICAL_ENV_FILE"');
    expect(supervisor).toContain('CANONICAL_ENV_FILE="/opt/club-arena/server/.env"');
    expect(supervisor).toContain('ENGINE_UP_RESTART_POLICY=always');
  });
});
