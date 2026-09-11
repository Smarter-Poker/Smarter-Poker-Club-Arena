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
 * script, the causal exact-release recovery and the recovery verifier. They
 * also pin the log redaction which keeps WebSocket bearer material out of
 * Caddy's upstream-error records.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const dockerfile = read('server/Dockerfile');
const engineUp = read('server/scripts/engine-up.sh');
const supervisor = read('server/scripts/engine-supervisor.sh');
const verifier = read('server/scripts/verify-recovery-stack.sh');
const autoheal = read('infra/monitoring/autoheal-compose.yml');
const caddyfiles = [read('server/Caddyfile'), read('infra/monitoring/engine-01/Caddyfile')];
const releaseTransaction = read('server/scripts/engine-release-transaction.sh');
const releaseObserver = read('server/scripts/observe-engine-release.sh');
const deployWorkflow = read('.github/workflows/auto-deploy-hetzner.yml');

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
  it('allows at least 15 seconds for a probe to reach a saturated event loop', () => {
    expect(imageTimeout).toBeGreaterThanOrEqual(15);
    expect(runTimeout).toBe(imageTimeout);
    expect(supervisorTimeout).toBeGreaterThanOrEqual(imageTimeout);
    expect(engineUp).toMatch(/--health-timeout="\$HEALTH_TIMEOUT"/);
    expect(supervisor).toContain('curl -sS --max-time "$curl_timeout"');
    expect(supervisor).toContain("--write-out $'\\n%{http_code}'");
    expect(supervisor).toContain('case "$http_code" in\n    200|503)');
  });

  it('gives every restarted engine at least five minutes to cold boot', () => {
    expect(imageStartPeriod).toBeGreaterThanOrEqual(300);
    expect(runStartPeriod).toBe(imageStartPeriod);
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

  it('requires exact serving identity after a causally-authorized recovery', () => {
    expect(supervisor).toContain('ENGINE_SUPERVISOR_FORCE_DESIRED');
    expect(supervisor).toContain('ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH');
    expect(supervisor).toContain('ENGINE_SUPERVISOR_LOCK_HELD');
    expect(supervisor).toContain('d.get("running") is True');
    expect(supervisor).toContain('d.get("liveness")=="ok"');
    // EXACT, AND PROVABLE BY THE RELEASE BEING RESTORED (2026-09-11). The pin
    // used to be the literal `d.get("releaseSha")==os.environ["EXPECTED_SHA"]`.
    // That field arrived with releaseIdentity.ts, and this function restores
    // the release ALREADY RUNNING, which predates it - so every deploy from
    // 15:37 UTC that day died restoring a healthy, exact, serving engine, and
    // the build that would publish the field was the build that could not
    // ship. A sealed release with no `releaseSha` proves itself with
    // `version`, the first eight characters of the same commit from the same
    // build. The two halves of that are pinned separately below so neither can
    // be dropped: a release that DOES publish the field must still match it
    // exactly, and the short road is open only when the field is absent.
    expect(supervisor).toContain('sha==expected');
    expect(supervisor).toContain('sha is None and d.get("version")==expected[:8]');
    // The fallback belongs to recovery alone. A new candidate is built from
    // source that has the field, so every candidate and publication proof
    // keeps the strict form.
    for (const strict of [releaseTransaction, releaseObserver, deployWorkflow]) {
      expect(strict).toContain('d.get("releaseSha")==os.environ["EXPECTED_SHA"]');
      expect(strict).not.toContain('d.get("version")==expected[:8]');
    }
    expect(supervisor).toContain('public_instance" = "$local_instance');
    expect(supervisor).not.toContain('BOOT_GRACE_SEC');
    expect(supervisor).not.toContain('FAIL_THRESHOLD');
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
