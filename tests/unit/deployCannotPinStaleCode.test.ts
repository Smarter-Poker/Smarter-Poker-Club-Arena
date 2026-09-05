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

/**
 * The shutdown budgets moved from inline literals to named constants
 * (DRAIN_BUDGET_MS / SHUTDOWN_CAP_MS) on 2026-09-01, so these pins resolve the
 * value through the name instead of matching `drainHands(28000)`. The property
 * being asserted is unchanged -- only the way the number is spelled in the
 * source moved. Falls back to a literal so an inlined value still reads.
 */
function budgetFrom(src: string, callPattern: RegExp): number {
  const m = src.match(callPattern);
  if (!m) throw new Error(`no match for ${callPattern}`);
  const token = m[1];
  if (/^[0-9_]+$/.test(token)) return Number(token.replace(/_/g, ''));
  const decl = src.match(new RegExp(`const ${token} = ([0-9_]+);`));
  if (!decl) throw new Error(`${token} is not declared as a numeric constant`);
  return Number(decl[1].replace(/_/g, ''));
}

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
    const shutdown = idx.slice(idx.indexOf('const shutdown'), idx.indexOf("process.on('SIGINT'"));
    // A budget, literal or named -- see budgetFrom above for why.
    expect(shutdown).toMatch(/drainHands\([A-Za-z0-9_]+\)/);
    expect(read('server/src/GameServer.ts')).toMatch(/engine\.pauseAfterHand\(\)/);
  });

  it('the drain budget fits inside the grace the supervisor actually gives', () => {
    // engine-up.sh stops the container with an explicit grace period. A drain
    // longer than that grace is a drain that gets SIGKILLed halfway.
    const up = read('server/scripts/engine-up.sh');
    const grace = Number(up.match(/docker stop -t (\d+)/)![1]) * 1000;
    const budget = budgetFrom(read('server/src/index.ts'), /drainHands\(([A-Za-z0-9_]+)\)/);
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AND THE ESCAPE HATCH BEHIND THAT PATH IS REACHABLE (2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The block above pins that a landable path EXISTS. This one pins that the
 * hatch behind it - the one that fires when a straggler table can never park -
 * can actually be reached. It could not, from the day it was written.
 *
 * It gates on `BEHIND_MIN >= STALE_MIN`, and BEHIND_MIN came from
 * `git show -s --format=%ct "$LIVE"` guarded by `git cat-file -e`.
 * actions/checkout defaults to fetch-depth: 1, so the only commit object on
 * the runner is the one being deployed. Dating the LIVE sha always failed, the
 * else branch printed "treating as not-stale", BEHIND_MIN stayed 0, and the
 * comparison could never be true.
 *
 * Run 33656444491: production had served 93d167b5 for 798 minutes, a break WAS
 * running, 40 tables never parked - every precondition the hatch exists for -
 * and it printed "could not date the live commit (93d167b5) - treating as
 * not-stale", then BREAK NEVER OPENED, and shipped nothing. The engine
 * carrying the fix for the unparked tables was stranded behind those same
 * unparked tables.
 *
 * The second failure was timing. The hatch was evaluated only AFTER all 56
 * attempts. Run 33662583560: gate opened 17:47:24, break ran 17:55-18:00, loop
 * ended 18:01:24, engine restarted 18:02:24 - two and a half minutes after the
 * window closed, while the step printed "Restarting inside the break".
 *
 * Both were invisible because nothing pinned them.
 */
describe('the escape hatch behind that path is reachable', () => {
  /** The block that decides how far behind production is. */
  const dating = (): string => {
    const start = WF.indexOf('BEHIND_MIN=0');
    expect(start, 'the gate must still compute BEHIND_MIN').toBeGreaterThan(0);
    const end = WF.indexOf('STALE_MIN=', start);
    expect(end, 'STALE_MIN must still follow the dating block').toBeGreaterThan(start);
    return WF.slice(start, end);
  };

  const pollLoop = (): string => {
    const start = WF.indexOf('for i in $(seq 1 $ATTEMPTS)');
    expect(start).toBeGreaterThan(0);
    const end = WF.indexOf('done', start);
    expect(end).toBeGreaterThan(start);
    return WF.slice(start, end);
  };

  it('dates the live commit in a way a shallow checkout cannot defeat', () => {
    const block = dating();
    const usesLocalGit = /git\s+(show|cat-file)/.test(block);
    const hasRemoteFallback = /api\.github\.com\/repos\/.*\/commits\//.test(block);
    expect(
      !usesLocalGit || hasRemoteFallback,
      'BEHIND_MIN is computed from local git with no remote fallback. The checkout is ' +
        'fetch-depth: 1, so the live commit object is not on the runner and this always ' +
        'answers "not-stale" - which silently disarms the escape hatch.'
    ).toBe(true);
  });

  it('does not try to rescue it with a plain git fetch', () => {
    // /health reports an ABBREVIATED sha, and fetch requires a full one:
    // "fatal: couldn't find remote ref 93d167b5", verified against a real
    // depth-1 clone of this repo. A fetch is not a valid fix.
    expect(/git\s+fetch[^\n]*\$\{?LIVE\}?/.test(dating())).toBe(false);
  });

  it('still fails closed when the commit cannot be dated at all', () => {
    // Unknown staleness must never read as stale enough to restart.
    expect(dating()).toMatch(/BEHIND_MIN=0/);
    expect(dating()).toMatch(/treating as not-stale/);
  });

  it('decides while the break is still open, not after the poll outlives it', () => {
    expect(
      /STRAGGLER_NOW=yes/.test(pollLoop()),
      'nothing inside the poll loop escalates, so the gate waits out all 56 attempts and ' +
        'restarts after the break has already ended - the unannounced restart the break ' +
        'exists to prevent.'
    ).toBe(true);
  });

  it('can only fire on a break that is actually counting down', () => {
    // last_hand is the :53 warning, not the break. Escalating there would
    // restart with cards still in the air.
    const loop = pollLoop();
    expect(loop).toMatch(/phase=counting_down/);
    expect(loop.slice(0, loop.indexOf('STRAGGLER_NOW=yes'))).toMatch(/BREAK_RUNNING/);
  });

  it('leaves enough of the break for the cutover to land inside it', () => {
    expect(WF).toMatch(/MIN_BREAK_LEFT_S=(\d+)/);
    const floor = Number(WF.match(/MIN_BREAK_LEFT_S=(\d+)/)![1]);
    // docker stop -t 45, image start, liveness verify.
    expect(floor).toBeGreaterThanOrEqual(60);
    // The break is 300s; a floor at or above it could never be satisfied.
    expect(floor).toBeLessThan(300);
  });

  it('still requires production to be genuinely stale', () => {
    // The hatch trades a straggler's hand for shipping stranded code. That
    // trade is only worth making when code really is stranded.
    expect(WF).toMatch(/STALE_MIN=190/);
  });

  it('keeps the post-loop escalation as the fallback', () => {
    // The in-break path is additive. If it never fires, behaviour must be
    // exactly what shipped before it existed.
    const after = WF.slice(WF.indexOf('if [ "$READY" = "yes" ]; then exit 0; fi'));
    expect(after).toMatch(/BREAK NEVER OPENED/);
    expect(after).toMatch(/STALE_MIN/);
  });
});
