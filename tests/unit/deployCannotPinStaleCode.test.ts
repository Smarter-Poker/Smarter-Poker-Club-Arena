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
    // opens has to be acted on, which means polling for long enough to reach
    // :55 from the earliest tick at :40.
    const attempts = Number(WF.match(/seq 1 (\d+)/)![1]);
    const sleepSec = Number(WF.match(/sleep 15\n/) ? 15 : 0);
    expect(attempts * sleepSec).toBeGreaterThanOrEqual(13 * 60);
  });

  it('proceeding is safe because the engine drains itself first', () => {
    // The cap may only be short because a restart no longer voids hands.
    // If this ever stops being true, the cap must be reconsidered — which is
    // why the two are asserted in one test.
    const idx = read('server/src/index.ts');
    const shutdown = idx.slice(idx.indexOf('const shutdown'), idx.indexOf("process.on('SIGINT'"));
    expect(shutdown).toMatch(/drainHands\(\d+\)/);
    expect(read('server/src/GameServer.ts')).toMatch(/engine\.pauseAfterHand\(\)/);
  });

  it('the drain budget fits inside the grace the supervisor actually gives', () => {
    // engine-up.sh stops the container with an explicit grace period. A drain
    // longer than that grace is a drain that gets SIGKILLed halfway.
    const up = read('server/scripts/engine-up.sh');
    const grace = Number(up.match(/docker stop -t (\d+)/)![1]) * 1000;
    const budget = Number(read('server/src/index.ts').match(/drainHands\((\d+)\)/)![1]);
    expect(budget).toBeLessThan(grace);
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
