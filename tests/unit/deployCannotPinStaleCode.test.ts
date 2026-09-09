/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A GREEN DEPLOY MUST ACTUALLY DEPLOY (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Found by asking the database what the engine was running: `engine_leader`
 * had sat on build 6aa60e39 for three and a half hours across ~15 merges,
 * while every `auto-deploy-hetzner` run reported success.
 *
 * The mechanism: the drain gate waits for `handsInFlightTotal` to reach ZERO
 * before it will restart the engine. On this platform that number is never
 * zero — the horse fleet deals ~200 hands a minute across ~71 tables, so
 * roughly seventy hands are in flight at any instant of any day. All sixteen
 * polls therefore fail every single time, and the "staleness cap" below them
 * is not a rare backstop: it is the ONLY path a deploy ever takes. At six
 * hours, that is how old production code was allowed to get.
 *
 * This is the same shape as the bug the gate's own comments record for
 * `humansSeatedTotal` — "a table EMPTYING can take forever and, with horses
 * seated, never happens" — reproduced one level down. A condition that a
 * healthy production fleet can never satisfy is not a gate, it is a deadlock.
 *
 * What makes a short cap safe is the SIGTERM drain: the engine parks every
 * table at a hand boundary before it stops, on every restart path, inside the
 * grace Docker gives it. These two must stay in step, so they are pinned
 * together here.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const WF = read('.github/workflows/auto-deploy-hetzner.yml');
const CUTOVER = read('server/scripts/engine-up-with-maintenance-certificate.sh');
const ENGINE_UP = read('server/scripts/engine-up.sh');

describe('the drain gate cannot pin production on stale code', () => {
  it('the deploy has a path that actually lands, and it is not a staleness cap', () => {
    /**
     * REWRITTEN 2026-09-01, and the staleness cap it used to pin is GONE.
     *
     * The cap existed because the gate above it waited for a moment when no
     * table was mid-hand, which a fleet dealing ~290 hands a minute never
     * reports. So the cap was not a backstop, it was the only path - and what
     * it did was restart the engine straight through live play once the build
     * got old enough.
     *
     * The engine now declares a five-minute break, parks every table between
     * hands, and opens `maintenance.readyForRestart`. There is a real,
     * routinely-reachable path again, so nothing has to be forced through.
     */
    expect(WF).not.toMatch(/MAX_ENGINE_AGE_SEC/);
    expect(WF).toMatch(/readyForRestart/);
    // And the deploy must never simply give up on the window: a break that
    // opens has to be acted on. #3070 (2026-09-05): the fixed 56 x 15 s poll
    // gave up 23 s before the :55 break once builds grew past its budget, and
    // production sat four merges behind while every run reported success.
    // The poll is now SIZED TO THE NEXT :56 (plus a 90 s margin), capped by
    // what the job has left after a cutover reserve, and a run that cannot
    // reach the gate says so and exits rather than sleeping to the same answer.
    expect(WF).toMatch(/SECS_TO_GATE=\$\(\( \(56 - MIN_NOW\) \* 60 - SEC_NOW \)\)/);
    expect(WF).toMatch(/ATTEMPTS=\$\(\( \(SECS_TO_GATE \+ 90\) \/ POLL_S \)\)/);
    expect(WF).toMatch(/for i in \$\(seq 1 \$ATTEMPTS\); do/);
    expect(WF).toMatch(/sleep 15\n/);
    expect(WF).toMatch(/BUDGET_CAP_S=\$\(\( JOB_TIMEOUT_S - ELAPSED_S - CUTOVER_RESERVE_S \)\)/);
    expect(WF).toMatch(/if \[ "\$SECS_TO_GATE" -gt "\$BUDGET_CAP_S" \]; then/);
    // The job itself leaves room for a full hour's wait plus the cutover: a
    // tick at :35 with an 18-minute build still reaches :55 inside 40 minutes.
    const timeout = Number(WF.match(/timeout-minutes: (\d+)/)![1]);
    expect(timeout).toBeGreaterThanOrEqual(40);
  });

  it('proceeding is safe because the engine drains itself first', () => {
    // The cap may only be short because a restart no longer voids hands.
    // If this ever stops being true, the cap must be reconsidered — which is
    // why the two are asserted in one test.
    const idx = read('server/src/index.ts');
    const shutdown = idx.slice(
      idx.indexOf('async function performShutdown'),
      idx.indexOf("process.on('SIGINT'")
    );
    const gameServer = read('server/src/GameServer.ts');
    expect(shutdown).toMatch(/await gameServer\.stop\(\)/);
    expect(shutdown).not.toMatch(/Promise\.race/);
    expect(gameServer).toMatch(/engine\.pauseAfterHand\(/);
  });

  it('the authoritative shutdown deadline fits inside the supervisor grace', () => {
    // engine-up.sh stops the container with an explicit grace period. A
    // shutdown deadline longer than that grace is one Docker defeats with a
    // SIGKILL before the engine can report unresolved ownership.
    const up = read('server/scripts/engine-up.sh');
    const grace = Number(up.match(/docker stop -t (\d+)/)![1]) * 1000;
    const deadlineParts = read('server/src/index.ts').match(/SHUTDOWN_DEADLINE_MS = (\d+)_?(\d*)/)!;
    const deadline = Number(`${deadlineParts[1]}${deadlineParts[2]}`);
    expect(deadline).toBeLessThan(grace);
  });

  it('a run that ships nothing says so loudly, not quietly', () => {
    // Both no-op paths must annotate. An agent reading `gh run list` sees
    // only "success"; a warning surfaces in the run header without anyone
    // thinking to open the log of a green run. This is how three and a half
    // hours of staleness went unnoticed.
    expect(WF).toMatch(/::warning title=NOT DEPLOYED::/);
    // Was PROCEEDING ON STALENESS CAP, which announced the workflow giving up
    // and restarting on live tables. That path is gone; the no-op path that
    // remains is a break that never opened, and it must be just as loud.
    expect(WF).toMatch(/::warning title=BREAK NEVER OPENED::/);
  });
});

describe('the maintenance certificate has no stale-code escape hatch', () => {
  const gate = (): string =>
    WF.slice(
      WF.indexOf('Wait for the maintenance break'),
      WF.indexOf('- name: Cut over to the new image')
    );

  it('requires exact durable and restart-ready booleans', () => {
    expect(gate()).toMatch(
      /m\.get\("readyForRestart"\) is True and m\.get\("durableConfirmed"\) is True/
    );
    expect(gate()).toMatch(/"durableConfirmed" not in m/);
    expect(gate()).toMatch(/DURABLE CERTIFICATE UNAVAILABLE/);
    expect(gate()).toMatch(/skip=true/);
  });

  it('contains no age, straggler, legacy, or manual bypass', () => {
    const runnable = gate()
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(runnable).not.toMatch(
      /STALE_MIN|BEHIND_MIN|STRAGGLER_NOW|RESTARTING ON A STRAGGLER|LEGACY/
    );
    expect(runnable).not.toMatch(/skipping the break gate/);
    expect(runnable).not.toMatch(/github\.event\.inputs\.force/);
  });

  it('revalidates against the sole container immediately before cutover', () => {
    const cutover = WF.slice(
      WF.indexOf('- name: Cut over to the new image'),
      WF.indexOf('- name: Verify — liveness')
    );
    expect(cutover).toContain('engine-up-with-maintenance-certificate.sh');
    expect(cutover).toContain('MIN_BREAK_LEFT_MS=180000');
    expect(CUTOVER).toMatch(/127\.0\.0\.1:\$\{PORT\}\/health/);
    expect(CUTOVER).toMatch(/Cache-Control: no-cache/);
    expect(CUTOVER).toContain('label=sp.role=engine');
    expect(CUTOVER).toContain('docker ps -aq');
    expect(CUTOVER).toContain('row.get("HostPort") == host_port');
    expect(CUTOVER).toContain('[ "$LABELLED" = "$CONTAINER" ]');
    expect(CUTOVER).toContain('[ "$PUBLISHED" = "$CONTAINER" ]');
    expect(CUTOVER).toContain('FINGERPRINT_AFTER="$(container_fingerprint)"');
    expect(CUTOVER).toContain('m.get("active") is True');
    expect(CUTOVER).toContain('m.get("phase") == "counting_down"');
    expect(CUTOVER).toContain('m.get("durableConfirmed") is True');
    expect(CUTOVER).toContain('m.get("readyForRestart") is True');
    expect(CUTOVER).toContain('unparked == 0');
    expect(CUTOVER).toContain('remaining >= floor');
    expect(CUTOVER).toContain('end_delta >= floor');
    expect(CUTOVER).toContain('skew <= max_skew');
  });

  it('holds one host lock from the fresh certificate read through engine-up', () => {
    // The public-health poll is only an early wait.  Restart authority is the
    // direct-container certificate read by the host-side wrapper after it has
    // acquired the same flock used by engine-up and the supervisor.  The
    // wrapper then hands that already-held descriptor to engine-up; two
    // adjacent SSH commands would recreate the race this law exists to stop.
    const lockAt = CUTOVER.indexOf('exec 9>"$LOCK_FILE"');
    const acquiredAt = CUTOVER.indexOf('flock -w "$LOCK_WAIT_S" 9', lockAt);
    const directCertificateAt = CUTOVER.lastIndexOf('BODY="$(read_direct_health)"');
    const durableAuthorityAt = CUTOVER.lastIndexOf('m.get("durableConfirmed") is True');
    const invokeAt = CUTOVER.lastIndexOf('\ninvoke_engine_up');
    const lockLifetime = CUTOVER.slice(acquiredAt, invokeAt);
    const invoke = CUTOVER.slice(
      CUTOVER.indexOf('invoke_engine_up()'),
      CUTOVER.indexOf('\nexact_port_binding()', CUTOVER.indexOf('invoke_engine_up()'))
    );

    expect(lockAt).toBeGreaterThan(-1);
    expect(acquiredAt).toBeGreaterThan(lockAt);
    expect(directCertificateAt).toBeGreaterThan(acquiredAt);
    expect(durableAuthorityAt).toBeGreaterThan(directCertificateAt);
    expect(invokeAt).toBeGreaterThan(durableAuthorityAt);
    expect(lockLifetime).not.toContain('exec 9>&-');
    expect(invoke).toContain('ENGINE_UP_LOCK_HELD=1 "$ENGINE_UP_SCRIPT"');

    const workflowCutover = WF.slice(
      WF.indexOf('- name: Cut over to the new image'),
      WF.indexOf('- name: Verify — liveness')
    );
    expect(workflowCutover.match(/engine-up-with-maintenance-certificate\.sh/g) ?? []).toHaveLength(
      1
    );
    const remoteCommands = workflowCutover
      .split('\n')
      .filter((line) => !/^\s*#/.test(line) && line.includes('~/hssh '));
    expect(remoteCommands).toHaveLength(2);
    expect(remoteCommands[0]).toContain('ENGINE_UP_SCRIPT=');
    expect(remoteCommands[0]).toContain('engine-up-with-maintenance-certificate.sh');
    expect(remoteCommands[1]).toContain('/var/log/club-arena-engine/');
  });

  it('treats ENGINE_UP_LOCK_HELD as a verified descriptor handoff, never a boolean bypass', () => {
    const lock = ENGINE_UP.slice(
      ENGINE_UP.indexOf('LOCK_FILE="${LOCK_FILE:-/var/lock/club-arena-engine-up.lock}"'),
      ENGINE_UP.indexOf('CONTAINER="${CONTAINER:-club-arena-engine}"')
    );
    expect(lock).toContain("os.path.samefile('/dev/fd/9', sys.argv[1])");
    expect(lock).toContain("open('/proc/self/fdinfo/9'");
    expect(lock).toContain('FLOCK\\s+ADVISORY\\s+WRITE');
    expect(lock).toContain('flock -n 9');
    expect(lock).toContain('ENGINE_UP_LOCK_HELD=1 without fd 9 owning the $LOCK_FILE flock');
    expect(lock).toContain('inherited fd 9 does not own the $LOCK_FILE flock');
    expect(lock).toMatch(/if \[ "\$\{ENGINE_UP_LOCK_HELD:-0\}" = "1" \]; then/);
    expect(lock).toMatch(/else[\s\S]*?exec 9>"\$LOCK_FILE"[\s\S]*?flock -w 180 9/);
  });

  it('rejects an open-but-unlocked fd 9 instead of acquiring the lock on a forged handoff', () => {
    // engine-up runs only on the Linux host. Its ownership proof deliberately
    // uses Linux fdinfo because `flock -n 9` cannot distinguish an inherited
    // lock from a lock it just acquired itself.
    if (process.platform !== 'linux') return;

    const fixture = mkdtempSync(join(tmpdir(), 'engine-up-lock-'));
    const lockFile = join(fixture, 'engine.lock');
    const missingEnv = join(fixture, 'missing.env');
    const engineUp = resolve(process.cwd(), 'server/scripts/engine-up.sh');
    const invoke = (acquire: boolean) =>
      spawnSync(
        'bash',
        [
          '-c',
          `exec 9>"$1"; ${acquire ? 'flock 9;' : ''} ENGINE_UP_LOCK_HELD=1 LOCK_FILE="$1" ENV_FILE="$2" bash "$3"`,
          'engine-up-lock-test',
          lockFile,
          missingEnv,
          engineUp,
        ],
        { encoding: 'utf8' }
      );

    try {
      const forged = invoke(false);
      expect(forged.status).toBe(1);
      expect(forged.stdout).toContain('without fd 9 owning the');
      expect(forged.stdout).not.toContain('env file missing or empty');

      const inherited = invoke(true);
      expect(inherited.status).toBe(1);
      expect(inherited.stdout).toContain('env file missing or empty');
      expect(inherited.stdout).not.toContain('without fd 9 owning the');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('records host-attested mutation/performed state and does not recover an unstarted cutover', () => {
    const cutover = WF.slice(
      WF.indexOf('- name: Cut over to the new image'),
      WF.indexOf('- name: Verify — liveness')
    );
    expect(cutover).toContain('echo "mutation_started=false" >> $GITHUB_OUTPUT');
    expect(cutover).toContain('echo "performed=false" >> $GITHUB_OUTPUT');
    expect(cutover).toMatch(/if \[ "\$CUTOVER_STATUS" = "75" \]; then[\s\S]*?exit 0/);
    expect(cutover).toMatch(
      /if \[ "\$CUTOVER_STATUS" = "76" \]; then[\s\S]*?echo "mutation_started=true"[\s\S]*?exit "\$CUTOVER_STATUS"/
    );
    expect(cutover).toMatch(
      /if \[ "\$CUTOVER_STATUS" != "0" \]; then[\s\S]*?DID NOT ATTEST MUTATION[\s\S]*?exit "\$CUTOVER_STATUS"/
    );
    expect(cutover).toMatch(
      /echo "mutation_started=true" >> \$GITHUB_OUTPUT[\s\S]*?echo "performed=true"/
    );
    expect(cutover).toMatch(/echo "performed=true" >> \$GITHUB_OUTPUT/);

    const rollback = WF.slice(
      WF.indexOf('ROLLBACK — restore the last known-good image'),
      WF.indexOf('GUARANTEE the engine is running')
    );
    expect(rollback).toContain("steps.cutover.outputs.mutation_started == 'true'");
    expect(rollback).not.toContain("steps.cutover.outputs.performed == 'false'");
  });

  it('a skipped or cleanly refused cutover cannot run the final guarantee', () => {
    const guarantee = WF.slice(
      WF.indexOf('- name: GUARANTEE the engine is running'),
      WF.indexOf('- name: Retention')
    );
    expect(guarantee).toContain("steps.cutover.outcome != 'skipped'");
    expect(guarantee).toContain("steps.cutover.outputs.mutation_started == 'true'");

    const cutover = WF.slice(
      WF.indexOf('- name: Cut over to the new image'),
      WF.indexOf('- name: Verify — liveness')
    );
    expect(cutover).toMatch(/if \[ "\$CUTOVER_STATUS" = "75" \]; then[\s\S]*?exit 0/);
    expect(cutover).toMatch(/CUTOVER DID NOT ATTEST MUTATION/);
  });

  it('never uses plain engine-up to replace a running container during rollback or guarantee', () => {
    const rollback = WF.slice(WF.indexOf('- name: ROLLBACK'), WF.indexOf('- name: Retention'));
    expect(rollback).toContain('RECOVER_IF_NOT_RUNNING=1');
    expect(rollback).toContain('engine-up-with-maintenance-certificate.sh');
    expect(rollback).toContain('ROLLBACK_STATUS" = "75"');
    expect(rollback).toContain('ROLLBACK DEFERRED');
    expect(rollback).toContain('ENSURE_RUNNING_ONLY=1');
    expect(rollback).toContain('ENGINE IDENTITY REQUIRES OPERATOR');

    const executableLines = rollback
      .split('\n')
      .filter((line) => !/^\s*#/.test(line) && line.includes('/engine-up.sh'));
    expect(executableLines.length).toBeGreaterThan(0);
    expect(executableLines.every((line) => line.includes('ENGINE_UP_SCRIPT='))).toBe(true);
    expect(CUTOVER).toContain('if [ "$CONTAINER_STATE" != "running" ]; then');
    expect(CUTOVER).toContain('[ "$RECOVER_IF_NOT_RUNNING" = "1" ]');
    expect(CUTOVER).toContain('if [ "$ENSURE_RUNNING_ONLY" = "1" ]; then');
    expect(CUTOVER).toContain('leaving it untouched');
  });
});
