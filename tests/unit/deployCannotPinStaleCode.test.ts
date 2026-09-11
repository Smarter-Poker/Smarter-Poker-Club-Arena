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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const WF = read('.github/workflows/auto-deploy-hetzner.yml');
const TRANSACTION = read('server/scripts/engine-release-transaction.sh');
const OBSERVER = read('server/scripts/observe-engine-release.sh');

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
    expect(WF).not.toMatch(/MAX_ENGINE_AGE_SEC|STALENESS_CAP/);
    expect(TRANSACTION).toContain('maintenance_certificate()');
    expect(TRANSACTION).toContain('m.get("readyForRestart") is True');
    expect(TRANSACTION).toContain('m.get("unparkedTables")==0');
    // The durable host transaction owns the cold build and waits until the
    // certificate itself appears. It fails at its absolute deadline; it does
    // not return a successful staged-only outcome.
    const build = TRANSACTION.indexOf('"$IMAGE_BUILDER" "$REPO_DIR" "$SHA" "$IMAGE_REF"');
    const wait = TRANSACTION.indexOf('while :; do', build);
    const certificate = TRANSACTION.indexOf('maintenance_certificate)', wait);
    expect(build).toBeGreaterThan(0);
    expect(wait).toBeGreaterThan(build);
    expect(certificate).toBeGreaterThan(wait);
    expect(TRANSACTION.slice(wait, certificate)).toContain('CERTIFICATE_DEADLINE');
    expect(TRANSACTION).toContain('bounded_sleep 15');

    // The Actions observer has room to see intake assignment plus the entire
    // host-owned transaction and a substantial transport/proof margin.
    const timeout = Math.max(
      ...[...WF.matchAll(/timeout-minutes: (\d+)/g)].map((match) => Number(match[1]))
    );
    const observeSeconds = Number(
      OBSERVER.match(/OBSERVE_SECONDS="\$\{ENGINE_RELEASE_OBSERVE_SECONDS:-(\d+)\}"/)![1]
    );
    const handoffSeconds = Number(
      OBSERVER.match(
        /INVOCATION_WAIT_SECONDS="\$\{ENGINE_RELEASE_INVOCATION_WAIT_SECONDS:-(\d+)\}"/
      )![1]
    );
    expect(timeout * 60).toBeGreaterThanOrEqual(observeSeconds + handoffSeconds + 20 * 60);
    expect(WF).toContain('Dispatch the staged SHA through the durable Hetzner intake');
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

  it('a run cannot report shipped without a durable result and independent proof', () => {
    expect(WF).toContain('[ "$UNIT_RESULT" = success ] && [ "$RESULT_SHA" = "$SHA" ]');
    expect(WF).toContain('case "$RESULT" in sealed|already-released)');
    expect(WF).toMatch(
      /shipped: .*steps\.release\.outputs\.result == 'sealed'.*steps\.verify\.outputs\.verified == 'true'/
    );
    expect(WF).toContain('SHIPPED: ${{ needs.deploy.outputs.shipped }}');
    expect(WF).toContain("steps.release.outputs.result || 'not completed'");
    expect(WF).toContain("STRICT_RECEIPT: '1'");
  });
});

describe('there is no bypass around current restart authority', () => {
  const gate = TRANSACTION.slice(
    TRANSACTION.indexOf('maintenance_certificate()'),
    TRANSACTION.indexOf('validate_candidate_image()')
  );

  it('requires the full maintenance certificate and fails closed', () => {
    expect(gate).toContain('m.get("active") is True');
    expect(gate).toContain('m.get("durableConfirmed") is True');
    expect(gate).toContain('m.get("readyForRestart") is True');
    expect(gate).toContain('m.get("phase")=="counting_down"');
    expect(gate).toContain('m.get("unparkedTables")==0');
    expect(gate).toContain('MIN_BREAK_MS');
    expect(gate).not.toContain('skip=true');
    expect(TRANSACTION).toContain(
      "die 'the engine did not present a restart certificate with enough proof time remaining'"
    );
  });

  it('has no force, legacy, staleness, or straggler restart path', () => {
    expect(gate).not.toMatch(
      /github\.event\.inputs\.force|LEGACY ENGINE|STALE_MIN|STRAGGLER_NOW|RESTARTING ON A STRAGGLER/
    );
  });
});
