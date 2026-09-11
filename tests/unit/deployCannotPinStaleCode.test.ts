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
    // (2026-09-10: the coalescing path that raised "NOT DEPLOYED" is gone with
    // the spacing gate; every skip that remains announces itself through the
    // DID NOT DEPLOY step, and a decline that should have shipped is RED.)
    expect(WF).toMatch(/::warning title=DID NOT DEPLOY::/);
    expect(WF).toMatch(/::error title=DID NOT SHIP::/);
    // Was PROCEEDING ON STALENESS CAP, which announced the workflow giving up
    // and restarting on live tables. That path is gone; the no-op path that
    // remains is a break that never opened, and it must be just as loud.
    expect(WF).toMatch(/::warning title=BREAK NEVER OPENED::/);
  });
});

describe('there is no bypass around current restart authority', () => {
  const gate = WF.slice(
    WF.indexOf('Wait for the maintenance break'),
    WF.indexOf('Prepare one-use sealed cutover authority')
  );

  it('requires the full maintenance certificate and fails closed', () => {
    expect(gate).toContain('m.get("active") is True');
    expect(gate).toContain('m.get("durableConfirmed") is True');
    expect(gate).toContain('m.get("readyForRestart") is True');
    expect(gate).toContain('m.get("phase")=="counting_down"');
    expect(gate).toContain('m.get("unparkedTables")==0');
    expect(gate).toContain('int(m.get("remainingMs") or 0)>=180000');
    expect(gate).toContain('echo "skip=true" >> $GITHUB_OUTPUT');
  });

  it('has no force, legacy, staleness, or straggler restart path', () => {
    expect(gate).not.toMatch(
      /github\.event\.inputs\.force|LEGACY ENGINE|STALE_MIN|STRAGGLER_NOW|RESTARTING ON A STRAGGLER/
    );
  });
});

/**
 * ONE BUILD THAT CAN NEVER CERTIFY ITS OWN REPLACEMENT (Dan 2026-09-11).
 *
 * 404948b3 froze tournament tables mid-hand (#4225 fixes it), and a table
 * frozen mid-hand never parks, so that build could never open
 * readyForRestart: 514, 526 and 523 tables stayed unparked through three
 * countdowns and the fix could not ship. The header of this file names the
 * shape: a condition the fleet can never satisfy is not a gate, it is a
 * deadlock. Dan chose a one-time exception bound to that one build over
 * waiting for the process to die on its own.
 *
 * These pins keep it exactly that narrow: one build, one expiry, never an
 * input, every other clause of the certificate still required, and the build
 * re-proved on the host under the engine lock before anything is touched.
 */
describe('the one frozen-build exception is one build, one night, re-proved on the host', () => {
  const gate = WF.slice(
    WF.indexOf('Wait for the maintenance break'),
    WF.indexOf('Prepare one-use sealed cutover authority')
  );
  const cutover = WF.slice(
    WF.indexOf('name: Cut over to the new image'),
    WF.indexOf('name: Verify — liveness')
  );

  it('names exactly one build, as a job constant that expires, never as an input', () => {
    const builds = [...WF.matchAll(/^\s+FROZEN_BUILD_OVERRIDE: '([^']*)'\s*$/gm)].map((m) => m[1]);
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatch(/^[0-9a-f]{8}$/);
    const until = WF.match(/^\s+FROZEN_BUILD_OVERRIDE_UNTIL: '([^']+)'\s*$/m)?.[1] ?? '';
    // One night, not a standing door: it must die within a day of the
    // incident it was granted for.
    expect(Date.parse(until)).toBeGreaterThan(0);
    expect(Date.parse(until)).toBeLessThanOrEqual(Date.parse('2026-09-12T00:00:00Z'));
    const inputs = WF.slice(WF.indexOf('  workflow_dispatch:'), WF.indexOf('\nconcurrency:'));
    expect(inputs).not.toMatch(/frozen/i);
  });

  it('the runner uses it only for that build, inside a durable counting-down break with time left', () => {
    expect(gate).toMatch(/date -u -d "\$FROZEN_BUILD_OVERRIDE_UNTIL" \+%s/);
    expect(gate).toContain('[ "$(date -u +%s)" -lt "$UNTIL_EPOCH" ]');
    const predicate = gate.slice(
      gate.indexOf('FROZEN_STATE=$('),
      gate.indexOf('read -r FROZEN_VERDICT')
    );
    expect(predicate).toContain('str(d.get("version") or "")==f');
    expect(predicate).toContain('d.get("running") is True');
    expect(predicate).toContain('m.get("active") is True');
    expect(predicate).toContain('m.get("phase")=="counting_down"');
    expect(predicate).toContain('m.get("durableConfirmed") is True');
    expect(predicate).toContain('"CUT" if 200000<=rem<=235000');
    // It only ever answers when the full certificate did not: a READY break
    // still takes the ordinary path.
    expect(gate).toContain(
      'if [ "$STATE" != "READY" ] && [ "$STATE" != "ERR" ] && [ -n "$FROZEN" ]; then'
    );
    expect(gate).toContain('echo "frozen_override=true" >> $GITHUB_OUTPUT');
  });

  it('the host re-proves the exact build under the engine lock before any mutation', () => {
    const chosen = cutover.indexOf(
      'if [ "${{ steps.drain.outputs.frozen_override }}" = "true" ]; then'
    );
    const lock = cutover.indexOf('exec 9>/var/lock/club-arena-engine-up.lock');
    const check = cutover.indexOf('str(d.get(\\"version\\") or \\"\\")==\\"$FROZEN\\"');
    const marker = cutover.indexOf("echo '$MUTATION_MARKER'");
    expect(chosen).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(chosen);
    expect(check).toBeGreaterThan(lock);
    expect(marker).toBeGreaterThan(check);
    // Every other clause of the certificate is shared by both answers.
    expect(cutover).toContain(
      'base=d.get(\\"running\\") is True and isinstance(m,dict) and m.get(\\"active\\") is True and m.get(\\"phase\\")==\\"counting_down\\" and m.get(\\"durableConfirmed\\") is True and int(m.get(\\"remainingMs\\") or 0)>=180000;'
    );
    expect(cutover).toContain('frozen=base and len(\\"$FROZEN\\")==8');
    expect(cutover).toContain('sys.exit(0 if (ok or frozen) else 75)');
  });
});
